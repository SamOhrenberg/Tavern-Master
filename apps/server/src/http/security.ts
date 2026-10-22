import type {} from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { resolveSession, csrfToken, SESSION_COOKIE, type AuthContext } from '../auth/sessions.js';
import { config } from '../config.js';
import { forbidden, tooMany, unauthorized } from '../errors.js';
import { safeEqual } from '../security/crypto.js';
import { RateLimiter } from '../security/ratelimit.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface Limiters {
  auth: RateLimiter;
  api: RateLimiter;
  llm: RateLimiter;
}

let limiters: Limiters | undefined;
export function rateLimiters(): Limiters {
  const cfg = config();
  limiters ??= {
    auth: new RateLimiter(cfg.RATE_LIMIT_AUTH_PER_15M, 15 * 60_000),
    api: new RateLimiter(cfg.RATE_LIMIT_API_PER_MIN, 60_000),
    llm: new RateLimiter(cfg.RATE_LIMIT_LLM_PER_MIN, 60_000),
  };
  return limiters;
}
export function resetRateLimitersForTests(): void {
  limiters = undefined;
}

/** Throw 429 when `key` is over the limit. `req.ip` already reflects trusted proxies only. */
export function enforceLimit(limiter: RateLimiter, key: string): void {
  const decision = limiter.take(key);
  if (!decision.ok) throw tooMany(decision.retryAfter);
}

/**
 * Is this browser origin allowed to make state-changing requests?
 * Same-origin requests always are; anything else must be listed explicitly.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, fetchSite?: string): boolean {
  const cfg = config();
  if (!origin) {
    // Non-browser clients send no Origin. Browsers that omit it still send
    // Sec-Fetch-Site, which must not say the request is cross-site.
    return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
  }
  if (origin === cfg.baseUrl.origin || cfg.CORS_ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function requireUser(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Admin routes need the admin role and, unless disabled by config, enrolled 2FA. */
export function requireAdmin(req: FastifyRequest): AuthContext {
  const auth = requireUser(req);
  if (auth.user.role !== 'admin') throw forbidden('Administrator access required');
  if (config().ADMIN_REQUIRE_TOTP && !auth.user.totpEnabled) {
    throw forbidden('Administrators must enable two-factor authentication first', 'totp_enrolment_required');
  }
  return auth;
}

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  const cfg = config();

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;

    // Strict CORS: only explicitly configured origins ever get CORS headers.
    if (origin && cfg.CORS_ALLOWED_ORIGINS.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
        reply.header('Access-Control-Allow-Headers', 'content-type,x-csrf-token');
        reply.header('Access-Control-Max-Age', '600');
        return reply.status(204).send();
      }
    }

    if (!req.url.startsWith('/api/')) return;

    enforceLimit(rateLimiters().api, `ip:${req.ip}`);
    req.auth = await resolveSession(req.cookies[SESSION_COOKIE]);

    if (!UNSAFE.has(req.method)) return;

    // CSRF layer 1: the request must come from our own origin.
    if (!originAllowed(origin, req.host, req.headers['sec-fetch-site'] as string | undefined)) {
      throw forbidden('Cross-site request blocked. Check BASE_URL matches the address you use.', 'bad_origin');
    }
    // CSRF layer 2: authenticated requests must echo the session-bound token,
    // which a cross-site page cannot read. Anonymous requests (login, register)
    // have no session to ride on and must be JSON, which a form cannot send.
    if (req.auth) {
      const sent = req.headers['x-csrf-token'];
      if (typeof sent !== 'string' || !safeEqual(sent, csrfToken(req.auth.sessionId))) {
        throw forbidden('Missing or invalid CSRF token', 'bad_csrf');
      }
    } else if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      throw forbidden('Unsupported content type', 'bad_content_type');
    }
  });
}
