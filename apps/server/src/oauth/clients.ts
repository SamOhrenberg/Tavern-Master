import { q, q1 } from '../db/pool.js';
import { randomToken } from '../security/crypto.js';

/**
 * Clients that registered themselves (RFC 7591). Every client is public and
 * proves itself with PKCE, so registration stores only a name and where the
 * client may be sent back to.
 */

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A redirect URI a client may register: https with no fragment, or plain http to this computer. */
export function acceptableRedirect(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > 500) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || raw.includes('#')) return false;
  if (url.protocol === 'https:') return !!url.hostname;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

const isLoopback = (url: URL) => url.protocol === 'http:' && LOOPBACK.has(url.hostname);

/**
 * Whether `uri` is one the client registered: an exact match, except that a
 * loopback address may use any port (CLIs pick a free one each time).
 */
export function redirectMatches(client: OAuthClient, uri: string): boolean {
  if (client.redirectUris.includes(uri)) return true;
  let want: URL;
  try {
    want = new URL(uri);
  } catch {
    return false;
  }
  if (!isLoopback(want)) return false;
  return client.redirectUris.some((r) => {
    try {
      const have = new URL(r);
      return (
        isLoopback(have) &&
        have.hostname === want.hostname &&
        have.pathname === want.pathname &&
        have.search === want.search
      );
    } catch {
      return false;
    }
  });
}

export async function registerClient(name: string, redirectUris: string[]): Promise<OAuthClient> {
  const id = `tmo_${randomToken(24)}`;
  await q('INSERT INTO oauth_clients (id, name, redirect_uris) VALUES ($1, $2, $3)', [
    id,
    name,
    JSON.stringify(redirectUris),
  ]);
  return { id, name, redirectUris };
}

export async function getClient(id: string): Promise<OAuthClient | null> {
  if (!id || id.length > 80) return null;
  const row = await q1<{ id: string; name: string; redirect_uris: string[] }>(
    'SELECT id, name, redirect_uris FROM oauth_clients WHERE id = $1',
    [id],
  );
  return row ? { id: row.id, name: row.name, redirectUris: row.redirect_uris } : null;
}

/** Forget sign-ins nobody finished: stale requests and codes, and clients that never got a connection. */
export async function sweepOAuth(): Promise<void> {
  await q('DELETE FROM oauth_requests WHERE expires_at < now()');
  await q(`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'`);
  await q(
    `DELETE FROM oauth_clients c WHERE c.created_at < now() - interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM connector_tokens t WHERE t.client_id = c.id)`,
  );
}
