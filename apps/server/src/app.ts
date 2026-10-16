import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { q } from './db/pool.js';
import { HttpError } from './errors.js';
import { loggerOptions } from './log.js';
import { securityHeaders } from './security/headers.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the built SPA lives: WEB_DIST in the image, the workspace build in dev. */
function webDist(): string | undefined {
  const candidates = [process.env.WEB_DIST, join(HERE, '..', '..', 'web', 'dist')].filter(Boolean) as string[];
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

  const headers = securityHeaders(cfg);
  app.addHook('onRequest', async (_req, reply) => {
    reply.headers(headers);
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      if (err.status === 429 && err.details && typeof err.details === 'object' && 'retryAfter' in err.details) {
        reply.header('Retry-After', String((err.details as { retryAfter: number }).retryAfter));
      }
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    // Never leak internals: 5xx bodies are generic.
    const message = status >= 500 ? 'Something went wrong.' : err.message;
    return reply.status(status).send({ error: { code: status >= 500 ? 'internal' : (err.code ?? 'bad_request'), message } });
  });

  app.get('/healthz', async (_req, reply) => {
    try {
      await q('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'degraded' });
    }
  });

  await registerSpa(app);
  return app;
}

async function registerSpa(app: FastifyInstance): Promise<void> {
  const root = webDist();
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api/') || req.url.startsWith('/ws/');
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
      res.header('Cache-Control', path.includes('assets') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}
