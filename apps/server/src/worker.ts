import { createServer } from 'node:http';
import { hostname } from 'node:os';
import pg from 'pg';
import { summarizeCampaign } from './agent/summarize.js';
import { config } from './config.js';
import { waitForSchema } from './db/migrate.js';
import { closeDb, waitForDb } from './db/pool.js';
import { claim, complete, fail, JOBS_CHANNEL, requeueStale, type Job } from './jobs/queue.js';
import { log } from './log.js';
import { embedder, internalToken } from './rules/embed.js';
import { ingestDocument } from './rules/ingest.js';
import { distilLore } from './rules/lore.js';
import { draftSheet } from './agent/sheet-drafter.js';
import { safeEqual } from './security/crypto.js';
import { ensureDataDirs, modelsDir, uploadsDir } from './storage.js';

const workerId = `${hostname()}:${process.pid}`;
let stopping = false;
let wake: (() => void) | undefined;

async function handle(job: Job): Promise<void> {
  const payload = job.payload as {
    documentId?: string;
    campaignId?: string;
    sessionId?: string;
    systemId?: string;
  };
  if (job.kind === 'ingest_document' && payload.documentId) {
    await ingestDocument(payload.documentId, embedder('worker'));
  } else if (job.kind === 'summarize_campaign' && payload.campaignId) {
    await summarizeCampaign(payload.campaignId, payload.sessionId);
  } else if (job.kind === 'distil_lore' && payload.systemId) {
    await distilLore(payload.systemId);
  } else if (job.kind === 'draft_sheet' && payload.systemId) {
    await draftSheet(payload.systemId);
  } else {
    throw new Error(`unknown job kind ${job.kind}`);
  }
}

async function drain(): Promise<void> {
  for (let job = await claim(workerId); job && !stopping; job = await claim(workerId)) {
    try {
      await handle(job);
      await complete(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retrying = await fail(job, message);
      log().warn({ err, job: job.id, kind: job.kind, retrying }, 'job failed');
    }
  }
}

/** Wake on NOTIFY, with a slow poll as a safety net for delayed jobs and dropped connections. */
async function listen(): Promise<void> {
  const connect = async () => {
    const client = new pg.Client({
      connectionString: config().DATABASE_URL,
      application_name: 'tavern-worker-listen',
    });
    client.on('notification', () => wake?.());
    client.on('error', () => undefined);
    client.on('end', () => {
      if (!stopping) setTimeout(() => void connect().catch(() => undefined), 5000);
    });
    await client.connect();
    await client.query(`LISTEN ${JOBS_CHANNEL}`);
  };
  await connect().catch((err) => log().warn({ err }, 'LISTEN failed; polling only'));
}

/**
 * Internal endpoint so the web process can embed search queries with the
 * model this process already holds in memory. Reachable only on the internal
 * network and guarded by a derived shared token.
 */
function serve(): void {
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/healthz') return json(200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/embed') return json(404, { error: 'not found' });
    if (!safeEqual(String(req.headers['x-internal-token'] ?? ''), internalToken()))
      return json(403, { error: 'forbidden' });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            texts?: unknown;
            kind?: unknown;
          };
          const texts = Array.isArray(body.texts)
            ? body.texts.filter((t): t is string => typeof t === 'string').slice(0, 32)
            : [];
          const emb = embedder('worker');
          if (!emb || !texts.length) return json(400, { error: 'nothing to embed' });
          json(200, {
            model: emb.model,
            vectors: await emb.embed(texts, body.kind === 'passage' ? 'passage' : 'query'),
          });
        } catch (err) {
          log().warn({ err }, 'embed request failed');
          json(500, { error: 'embedding failed' });
        }
      })();
    });
  });
  server.listen(config().WORKER_PORT, '0.0.0.0');
}

async function main(): Promise<void> {
  await waitForDb();
  // The web process owns migrations; wait until it has applied them.
  await waitForSchema();
  await ensureDataDirs(uploadsDir(), modelsDir()).catch(() => undefined);
  await requeueStale(0);
  serve();
  await listen();
  log().info({ workerId, embeddings: config().EMBEDDING_PROVIDER }, 'worker ready');

  if (config().EMBEDDING_PROVIDER === 'local') {
    // Load the model up front so the first search does not pay for the download.
    void embedder('worker')
      ?.embed(['warm up'], 'query')
      .then(() => log().info('embedding model loaded'))
      .catch((err) => log().warn({ err }, 'embedding model could not be loaded yet'));
  }

  while (!stopping) {
    await drain().catch((err) => log().error({ err }, 'job loop error'));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}

const stop = () => {
  stopping = true;
  wake?.();
  setTimeout(() => void closeDb().finally(() => process.exit(0)), 500).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

main().catch((err) => {
  log().fatal({ err }, 'worker failed to start');
  process.exit(1);
});
