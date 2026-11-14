import type { ConnectRequest } from '@tavern/protocol';
import { audit } from '../audit.js';
import { q, q1 } from '../db/pool.js';
import { forbidden, notFound } from '../errors.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { getClient, redirectMatches } from './clients.js';
import { parseResource, resourceFor } from './metadata.js';

/**
 * The authorize step. A client sends the browser here; the request is stored
 * and the browser goes on to the app's approval screen, where the signed-in
 * host approves or denies. The client is sent back only to a redirect URI it
 * registered, and never at all when the client or the URI is unknown.
 */

const REQUEST_MINUTES = 10;
const CODE_MINUTES = 5;

/** Where to send the browser for an /oauth/authorize call. */
export async function authorize(params: Record<string, unknown>): Promise<string> {
  const str = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : undefined);
  const clientId = str('client_id') ?? '';
  const redirectUri = str('redirect_uri') ?? '';
  const state = str('state');

  const client = await getClient(clientId);
  if (!client) return '/connect?error=bad_client';
  if (!redirectUri || !redirectMatches(client, redirectUri)) return '/connect?error=bad_redirect';

  const back = (error: string) => withParams(redirectUri, { error, ...(state ? { state } : {}) });
  const challenge = str('code_challenge');
  if (str('response_type') !== 'code') return back('unsupported_response_type');
  if (!challenge || str('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))
    return back('invalid_request');
  const resource = str('resource') ?? resourceFor('/mcp');
  if (!parseResource(resource)) return back('invalid_target');

  const row = await q1<{ id: string }>(
    `INSERT INTO oauth_requests (client_id, redirect_uri, state, code_challenge, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) RETURNING id`,
    [client.id, redirectUri, state ?? null, challenge, resource, REQUEST_MINUTES],
  );
  return `/connect?request=${row!.id}`;
}

export function withParams(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

interface RequestRow {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  resource: string;
}

async function loadRequest(id: string): Promise<RequestRow> {
  const row = /^[0-9a-f-]{36}$/i.test(id)
    ? await q1<RequestRow>(
        `SELECT r.id, r.client_id, c.name AS client_name, r.redirect_uri, r.state, r.code_challenge, r.resource
           FROM oauth_requests r JOIN oauth_clients c ON c.id = r.client_id
          WHERE r.id = $1 AND r.expires_at > now()`,
        [id],
      )
    : undefined;
  if (!row) throw notFound('This request has expired. Start again from Claude.');
  return row;
}

/** A request for one campaign's address may be approved only by that campaign's owner. */
async function campaignOf(row: RequestRow, userId: string): Promise<{ id: string; name: string } | null> {
  const target = parseResource(row.resource);
  if (!target?.campaignId) return null;
  const owned = await q1<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM campaigns c
       JOIN campaign_members m ON m.campaign_id = c.id AND m.user_id = $2 AND m.role = 'owner'
      WHERE c.id = $1`,
    [target.campaignId, userId],
  );
  if (!owned) throw forbidden('You do not own the campaign this connection is for.');
  return owned;
}

/** What the approval screen shows. */
export async function describeRequest(id: string, userId: string): Promise<ConnectRequest> {
  const row = await loadRequest(id);
  const campaign = await campaignOf(row, userId);
  return {
    id: row.id,
    clientName: row.client_name.slice(0, 80),
    redirectHost: new URL(row.redirect_uri).hostname,
    campaign,
  };
}

/** The host approved: issue a one-time code and say where to send the browser. */
export async function approveRequest(id: string, userId: string, ip: string): Promise<string> {
  const row = await loadRequest(id);
  await campaignOf(row, userId);
  const deleted = await q('DELETE FROM oauth_requests WHERE id = $1 RETURNING id', [row.id]);
  if (!deleted.length) throw notFound('This request has expired. Start again from Claude.');
  const code = randomToken(32);
  await q(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))`,
    [sha256(code), row.client_id, userId, row.redirect_uri, row.code_challenge, row.resource, CODE_MINUTES],
  );
  await audit('connector.signin_approved', {
    actorId: userId,
    ip,
    targetType: 'oauth_client',
    targetId: row.client_id,
    meta: { resource: row.resource },
  });
  return withParams(row.redirect_uri, { code, ...(row.state ? { state: row.state } : {}) });
}

/** The host said no. */
export async function denyRequest(id: string): Promise<string> {
  const row = await loadRequest(id);
  await q('DELETE FROM oauth_requests WHERE id = $1', [row.id]);
  return withParams(row.redirect_uri, { error: 'access_denied', ...(row.state ? { state: row.state } : {}) });
}
