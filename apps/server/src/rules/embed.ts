import { config } from '../config.js';
import { hmac } from '../security/crypto.js';
import { modelsDir } from '../storage.js';

export type EmbedKind = 'query' | 'passage';

export interface Embedder {
  /** Stored next to every vector so chunks from different models never mix. */
  model: string;
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

/** pgvector literal. */
export function toVector(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** Shared secret for web → worker calls, derived so nothing extra is configured. */
export function internalToken(): string {
  return hmac('internal', 'worker');
}

// bge models expect this instruction in front of search queries only.
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

interface Extractor {
  (texts: string[], opts: { pooling: 'mean'; normalize: boolean }): Promise<{ tolist(): number[][] }>;
}

/** In-process CPU embeddings. Only the worker loads this (about 150 MB resident). */
export function localEmbedder(): Embedder {
  const model = config().EMBEDDING_MODEL;
  let extractor: Promise<Extractor> | undefined;
  const load = async (): Promise<Extractor> => {
    const tf = await import('@huggingface/transformers');
    tf.env.cacheDir = modelsDir();
    tf.env.allowLocalModels = false;
    return (await tf.pipeline('feature-extraction', model, { dtype: 'q8' })) as unknown as Extractor;
  };
  return {
    model,
    async embed(texts, kind) {
      extractor ??= load();
      const run = await extractor.catch((err) => {
        extractor = undefined; // retry the download next time
        throw err;
      });
      const prefix = kind === 'query' && /bge/i.test(model) ? BGE_QUERY_PREFIX : '';
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const batch = texts.slice(i, i + 16).map((t) => prefix + t.slice(0, 4000));
        out.push(...(await run(batch, { pooling: 'mean', normalize: true })).tolist());
      }
      return out;
    },
  };
}

/** Any OpenAI-compatible /embeddings endpoint. */
export function openaiEmbedder(): Embedder {
  const cfg = config();
  return {
    model: cfg.EMBEDDING_MODEL,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 64) {
        const res = await fetch(`${cfg.EMBEDDING_BASE_URL.replace(/\/$/, '')}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.EMBEDDING_API_KEY ?? ''}`,
          },
          body: JSON.stringify({ model: cfg.EMBEDDING_MODEL, input: texts.slice(i, i + 64) }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`embedding request failed with HTTP ${res.status}`);
        const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
        out.push(...json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
      }
      return out;
    },
  };
}

/** The web process asks the worker, which already has the model in memory. */
export function workerEmbedder(): Embedder {
  const cfg = config();
  return {
    model: cfg.EMBEDDING_MODEL,
    async embed(texts, kind) {
      const res = await fetch(`${cfg.WORKER_URL.replace(/\/$/, '')}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': internalToken() },
        body: JSON.stringify({ texts, kind }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`worker embed failed with HTTP ${res.status}`);
      return ((await res.json()) as { vectors: number[][] }).vectors;
    },
  };
}

const cache = new Map<string, Embedder | undefined>();
/** The embedder for this process, or undefined when embeddings are disabled (keyword search only). */
export function embedder(role: 'web' | 'worker'): Embedder | undefined {
  if (cache.has(role)) return cache.get(role);
  const provider = config().EMBEDDING_PROVIDER;
  const e =
    provider === 'none'
      ? undefined
      : provider === 'openai'
        ? openaiEmbedder()
        : role === 'worker'
          ? localEmbedder()
          : workerEmbedder();
  cache.set(role, e);
  return e;
}
