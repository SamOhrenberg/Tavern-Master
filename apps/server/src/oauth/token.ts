import { config } from '../config.js';
import { MAX_TOKENS } from '../connector/tokens.js';
import { q, q1, tx } from '../db/pool.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { SCOPE } from './metadata.js';

/**
 * The token endpoint. A signed-in connection is a row in connector_tokens
 * with an access token that expires and a refresh token that rotates on
 * every use. Replaying a code, or a refresh token that was already rotated
 * out, revokes the connection it made: someone else has it.
 */

export class OAuthError extends Error {
  constructor(
    readonly code: 'invalid_grant' | 'invalid_request' | 'unsupported_grant_type' | 'invalid_client',
    message: string,
  ) {
    super(message);
  }
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const str = (v: unknown) => (typeof v === 'string' && v.length <= 2000 ? v : undefined);

function fresh(): { access: string; refresh: string; accessSeconds: number; refreshDays: number } {
  const cfg = config();
  return {
    access: `tma_${randomToken(32)}`,
    refresh: `tmr_${randomToken(32)}`,
    accessSeconds: cfg.OAUTH_ACCESS_TOKEN_MINUTES * 60,
    refreshDays: cfg.OAUTH_REFRESH_TOKEN_DAYS,
  };
}

const answer = (t: ReturnType<typeof fresh>): TokenResponse => ({
  access_token: t.access,
  token_type: 'Bearer',
  expires_in: t.accessSeconds,
  refresh_token: t.refresh,
  scope: SCOPE,
});

const revoke = (id: string) =>
  q('UPDATE connector_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);

export async function exchangeCode(body: Record<string, unknown>): Promise<TokenResponse> {
  const code = str(body.code);
  const verifier = str(body.code_verifier);
  const clientId = str(body.client_id);
  const redirectUri = str(body.redirect_uri);
  if (!code || !verifier || !clientId || !redirectUri)
    throw new OAuthError('invalid_request', 'code, code_verifier, client_id and redirect_uri are required');

  const row = await q1<{
    client_id: string;
    user_id: string;
    redirect_uri: string;
    code_challenge: string;
    resource: string;
    expired: boolean;
    used: boolean;
    token_id: string | null;
    client_name: string;
  }>(
    `SELECT k.client_id, k.user_id, k.redirect_uri, k.code_challenge, k.resource, k.expires_at < now() AS expired,
            k.used_at IS NOT NULL AS used, k.token_id, c.name AS client_name
       FROM oauth_codes k JOIN oauth_clients c ON c.id = k.client_id WHERE k.code_hash = $1`,
    [sha256(code)],
  );
  if (!row || row.expired) throw new OAuthError('invalid_grant', 'The code is unknown or has expired.');
  if (row.used) {
    if (row.token_id) await revoke(row.token_id);
    throw new OAuthError('invalid_grant', 'The code was already used.');
  }
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri)
    throw new OAuthError('invalid_grant', 'The code was issued to another client or redirect URI.');
  if (sha256(verifier).toString('base64url') !== row.code_challenge)
    throw new OAuthError('invalid_grant', 'The code verifier does not match.');
  const resource = str(body.resource);
  if (resource && resource !== row.resource)
    throw new OAuthError('invalid_grant', 'The code was issued for another resource.');

  const live = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM connector_tokens
      WHERE user_id = $1 AND revoked_at IS NULL AND (refresh_expires_at IS NULL OR refresh_expires_at > now())`,
    [row.user_id],
  );
  if ((live?.n ?? 0) >= MAX_TOKENS)
    throw new OAuthError(
      'invalid_grant',
      'This account has the most connections allowed. Disconnect one first.',
    );

  const t = fresh();
  return tx(async (client) => {
    // Mark the code used first, so two exchanges racing for it cannot both succeed.
    const claimed = await q1(
      `UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL RETURNING code_hash`,
      [sha256(code)],
      client,
    );
    if (!claimed) throw new OAuthError('invalid_grant', 'The code was already used.');
    const made = await q1<{ id: string }>(
      `INSERT INTO connector_tokens (user_id, token_hash, label, client_id, resource, expires_at,
                                     refresh_hash, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7, now() + make_interval(days => $8))
       RETURNING id`,
      [
        row.user_id,
        sha256(t.access),
        row.client_name.slice(0, 60),
        row.client_id,
        row.resource,
        t.accessSeconds,
        sha256(t.refresh),
        t.refreshDays,
      ],
      client,
    );
    await client.query('UPDATE oauth_codes SET token_id = $2 WHERE code_hash = $1', [sha256(code), made!.id]);
    await client.query('UPDATE oauth_clients SET last_used_at = now() WHERE id = $1', [row.client_id]);
    return answer(t);
  });
}

export async function refresh(body: Record<string, unknown>): Promise<TokenResponse> {
  const token = str(body.refresh_token);
  const clientId = str(body.client_id);
  if (!token || !clientId)
    throw new OAuthError('invalid_request', 'refresh_token and client_id are required');
  const hash = sha256(token);
  const row = await q1<{ id: string; client_id: string; expired: boolean }>(
    `SELECT id, client_id, refresh_expires_at < now() AS expired FROM connector_tokens
      WHERE refresh_hash = $1 AND revoked_at IS NULL`,
    [hash],
  );
  if (!row) {
    // A refresh token that was rotated out came back: whoever holds it is not the client.
    const replayed = await q1<{ id: string }>(
      'SELECT id FROM connector_tokens WHERE prev_refresh_hash = $1',
      [hash],
    );
    if (replayed) await revoke(replayed.id);
    throw new OAuthError('invalid_grant', 'The refresh token is unknown or was already used.');
  }
  if (row.client_id !== clientId)
    throw new OAuthError('invalid_grant', 'The refresh token belongs to another client.');
  if (row.expired) throw new OAuthError('invalid_grant', 'The connection has expired. Sign in again.');
  const t = fresh();
  const rotated = await q(
    `UPDATE connector_tokens
        SET prev_refresh_hash = refresh_hash, refresh_hash = $2, token_hash = $3,
            expires_at = now() + make_interval(secs => $4), refresh_expires_at = now() + make_interval(days => $5)
      WHERE id = $1 AND refresh_hash = $6 AND revoked_at IS NULL RETURNING id`,
    [row.id, sha256(t.refresh), sha256(t.access), t.accessSeconds, t.refreshDays, hash],
  );
  if (!rotated.length) throw new OAuthError('invalid_grant', 'The refresh token was already used.');
  return answer(t);
}

/** RFC 7009: end the connection an access or refresh token belongs to. Unknown tokens are fine. */
export async function revokeByToken(token: string | undefined): Promise<void> {
  if (!token || token.length > 200) return;
  const hash = sha256(token);
  await q(
    `UPDATE connector_tokens SET revoked_at = now()
      WHERE (token_hash = $1 OR refresh_hash = $1) AND revoked_at IS NULL`,
    [hash],
  );
}
