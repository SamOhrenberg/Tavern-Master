import { parse as parseQuery } from 'node:querystring';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { enforceLimit, rateLimiters, requireUser } from '../http/security.js';
import { approveRequest, authorize, denyRequest, describeRequest } from './authorize.js';
import { acceptableRedirect, registerClient } from './clients.js';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.js';
import { exchangeCode, OAuthError, refresh, revokeByToken } from './token.js';

/**
 * Signing in to the connector. Discovery, registration, authorize, token and
 * revoke live outside /api: Claude's servers and CLIs call them, never with
 * the browser's cookie, so the session and CSRF hook does not run for them.
 * Only approving a request uses the session, and that lives under /api.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Readable from any origin, holding no cookies, and loadable cross-origin despite the global header. */
function open(reply: FastifyReply): FastifyReply {
  return reply
    .header('Access-Control-Allow-Origin', '*')
    .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    .header('Access-Control-Allow-Headers', 'content-type, authorization, mcp-protocol-version')
    .header('Cross-Origin-Resource-Policy', 'cross-origin');
}

const oauthError = (reply: FastifyReply, status: number, error: string, description?: string) =>
  open(reply)
    .status(status)
    .header('Cache-Control', 'no-store')
    .send({ error, ...(description ? { error_description: description } : {}) });

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // The token and revoke endpoints take form bodies, as RFC 6749 says.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16 * 1024 },
    (_req, body, done) => {
      try {
        done(null, parseQuery(body as string));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  const preflight = (_req: FastifyRequest, reply: FastifyReply) => open(reply).status(204).send();

  // ---- discovery
  const resourceDoc = (path: string) => (_req: FastifyRequest, reply: FastifyReply) =>
    open(reply).send(protectedResourceMetadata(path));
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(path, resourceDoc('/mcp'));
    app.options(path, preflight);
  }
  app.get<{ Params: { campaignId: string } }>(
    '/.well-known/oauth-protected-resource/mcp/c/:campaignId',
    (req, reply) => {
      // Only the shape is checked: nothing about a campaign is revealed here.
      if (!UUID.test(req.params.campaignId)) return open(reply).status(404).send({ error: 'not_found' });
      return open(reply).send(protectedResourceMetadata(`/mcp/c/${req.params.campaignId.toLowerCase()}`));
    },
  );
  app.options('/.well-known/oauth-protected-resource/mcp/c/:campaignId', preflight);
  app.get('/.well-known/oauth-authorization-server', (_req, reply) =>
    open(reply).send(authorizationServerMetadata()),
  );
  app.options('/.well-known/oauth-authorization-server', preflight);

  // ---- registration (RFC 7591): public clients only
  app.options('/oauth/register', preflight);
  app.post('/oauth/register', async (req, reply) => {
    enforceLimit(rateLimiters().auth, `oauth:${req.ip}`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(acceptableRedirect))
      return oauthError(
        reply,
        400,
        'invalid_redirect_uri',
        'Redirect URIs must be https, or http to localhost.',
      );
    const name =
      typeof body.client_name === 'string' && body.client_name.trim()
        ? body.client_name.trim().slice(0, 80)
        : 'MCP client';
    const client = await registerClient(name, uris as string[]);
    return open(reply)
      .status(201)
      .header('Cache-Control', 'no-store')
      .send({
        client_id: client.id,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
  });

  // ---- authorize: store the request, then the app's approval screen
  app.get('/oauth/authorize', async (req, reply) => {
    const to = await authorize((req.query ?? {}) as Record<string, unknown>);
    return reply.header('Cache-Control', 'no-store').redirect(to, 302);
  });

  // ---- token
  app.options('/oauth/token', preflight);
  app.post('/oauth/token', async (req, reply) => {
    enforceLimit(rateLimiters().auth, `oauth:${req.ip}`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const grant = body.grant_type;
      const out =
        grant === 'authorization_code'
          ? await exchangeCode(body)
          : grant === 'refresh_token'
            ? await refresh(body)
            : null;
      if (!out) return oauthError(reply, 400, 'unsupported_grant_type');
      return open(reply).header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(out);
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(reply, 400, err.code, err.message);
      throw err;
    }
  });

  // ---- revoke (RFC 7009): always 200
  app.options('/oauth/revoke', preflight);
  app.post('/oauth/revoke', async (req, reply) => {
    enforceLimit(rateLimiters().auth, `oauth:${req.ip}`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    await revokeByToken(typeof body.token === 'string' ? body.token : undefined);
    return open(reply).status(200).header('Cache-Control', 'no-store').send({});
  });

  // ---- approval, by the signed-in host (session and CSRF apply)
  const idParam = z.object({ id: z.string().uuid() });
  app.get<{ Params: { id: string } }>('/api/oauth/requests/:id', async (req) => {
    const auth = requireUser(req);
    const { id } = parse(idParam, req.params);
    return { request: await describeRequest(id, auth.user.id) };
  });
  app.post<{ Params: { id: string } }>('/api/oauth/requests/:id/approve', async (req) => {
    const auth = requireUser(req);
    const { id } = parse(idParam, req.params);
    return { redirect: await approveRequest(id, auth.user.id, req.ip) };
  });
  app.post<{ Params: { id: string } }>('/api/oauth/requests/:id/deny', async (req) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    return { redirect: await denyRequest(id) };
  });
}
