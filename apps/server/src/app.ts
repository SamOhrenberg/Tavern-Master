import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.js';
import { connectorRoutes } from './connector/mcp.js';
import { onWorkChanged } from './connector/work.js';
import { q } from './db/pool.js';
import { HttpError } from './errors.js';
import { oauthRoutes } from './oauth/routes.js';
import { registerSecurity } from './http/security.js';
import { loggerOptions } from './log.js';
import { getRoom } from './realtime/room.js';
import { realtimeRoutes } from './realtime/ws.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { campaignRoutes } from './routes/campaigns.js';
import { friendRoutes } from './routes/friends.js';
import { partyRoutes } from './routes/party.js';
import { rulesRoutes } from './routes/rules.js';
import { summonRoutes } from './routes/summon.js';
import { systemRoutes } from './routes/systems.js';
import { securityHeaders } from './security/headers.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the built SPA lives: WEB_DIST in the image, the workspace build in dev. */
function webDist(): string | undefined {
  const candidates = [process.env.WEB_DIST, join(HERE, '..', '..', 'web', 'dist')].filter(
    Boolean,
  ) as string[];
  return candidates.find((p) => existsSync(join(p, 'index.html')));
}

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = config();
  const app = Fastify({
    logger: cfg.LOG_LEVEL === 'silent' ? false : loggerOptions(),
    // X-Forwarded-* is honoured only when the direct peer is a configured proxy.
    trustProxy: cfg.TRUSTED_PROXIES.length ? cfg.TRUSTED_PROXIES : false,
    bodyLimit: 256 * 1024,
    disableRequestLogging: cfg.LOG_LEVEL !== 'debug' && cfg.LOG_LEVEL !== 'trace',
    routerOptions: { maxParamLength: 128 },
  });

  // Work queued in this process reaches the room at once; other processes NOTIFY (see main.ts).
  onWorkChanged((campaignId) => void getRoom(campaignId)?.workChanged());

  const headers = securityHeaders(cfg);
  app.addHook('onRequest', async (_req, reply) => {
    reply.headers(headers);
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      if (
        err.status === 429 &&
        err.details &&
        typeof err.details === 'object' &&
        'retryAfter' in err.details
      ) {
        reply.header('Retry-After', String((err.details as { retryAfter: number }).retryAfter));
      }
      return reply
        .status(err.status)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    // Never leak internals: 5xx bodies are generic.
    const message = status >= 500 ? 'Something went wrong.' : err.message;
    return reply
      .status(status)
      .send({ error: { code: status >= 500 ? 'internal' : (err.code ?? 'bad_request'), message } });
  });

  app.get('/healthz', async (_req, reply) => {
    try {
      await q('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'degraded' });
    }
  });

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 4, fieldSize: 2048 },
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });
  await registerSecurity(app);

  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(adminRoutes);
  await app.register(friendRoutes);
  await app.register(systemRoutes);
  await app.register(campaignRoutes);
  await app.register(partyRoutes);
  await app.register(rulesRoutes);
  await app.register(summonRoutes);
  await app.register(realtimeRoutes);
  await app.register(connectorRoutes);
  await app.register(oauthRoutes);

  await registerSpa(app);
  return app;
}

async function registerSpa(app: FastifyInstance): Promise<void> {
  const root = webDist();
  app.setNotFoundHandler((req, reply) => {
    // Other /.well-known paths stay a plain 404: clients probe several
    // places for OAuth metadata, and the SPA shell there would look like a
    // broken answer. /oauth is the connector's sign-in, never the SPA.
    const isApi = ['/api/', '/ws/', '/mcp', '/.well-known/', '/oauth/'].some((p) => req.url.startsWith(p));
    if (root && req.method === 'GET' && !isApi) {
      // Client-side routes fall back to the SPA shell.
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });
  if (!root) return;
  await app.register(fastifyStatic, {
    root,
    index: ['index.html'],
    setHeaders(res, path) {
      // Vite fingerprints everything under /assets.
      res.header(
        'Cache-Control',
        path.includes('assets') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
}
