import { q, q1 } from '../db/pool.js';
import { randomToken, sha256 } from '../security/crypto.js';

/** Recognisable in a leaked log or a pasted config, and easy to search for. */
export const TOKEN_PREFIX = 'tmc_';
/** Access tokens issued by signing in. */
export const ACCESS_PREFIX = 'tma_';
/** Live connections per account: signed-in ones and hand-made tokens together. */
export const MAX_TOKENS = 20;

export interface ConnectorUser {
  tokenId: string;
  userId: string;
  displayName: string;
  /** The campaign this client last opened, if it is still one the user owns. */
  campaignId: string | null;
}

export interface TokenRow {
  id: string;
  label: string;
  client_id: string | null;
  client_name: string | null;
  resource: string | null;
  created_at: Date;
  last_used_at: Date | null;
  campaign_name: string | null;
  scope_name: string | null;
}

const LIVE = `t.revoked_at IS NULL AND (t.refresh_expires_at IS NULL OR t.refresh_expires_at > now())`;

/** Make a token and return it. Only its hash is kept, so this is the one time it can be shown. */
export async function createToken(
  userId: string,
  label: string,
): Promise<{ id: string; token: string } | null> {
  const live = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM connector_tokens t WHERE t.user_id = $1 AND ${LIVE}`,
    [userId],
  );
  if ((live?.n ?? 0) >= MAX_TOKENS) return null;
  const token = TOKEN_PREFIX + randomToken(32);
  const row = await q1<{ id: string }>(
    'INSERT INTO connector_tokens (user_id, token_hash, label) VALUES ($1, $2, $3) RETURNING id',
    [userId, sha256(token), label],
  );
  return { id: row!.id, token };
}

/** Every live connection: signed-in clients and hand-made tokens, oldest first. */
export function listTokens(userId: string): Promise<TokenRow[]> {
  return q<TokenRow>(
    `SELECT t.id, t.label, t.client_id, o.name AS client_name, t.resource, t.created_at, t.last_used_at,
            c.name AS campaign_name, s.name AS scope_name
       FROM connector_tokens t
       LEFT JOIN campaigns c ON c.id = t.campaign_id
       LEFT JOIN oauth_clients o ON o.id = t.client_id
       LEFT JOIN campaigns s ON s.id::text = substring(t.resource from '/mcp/c/([0-9a-fA-F-]{36})$')
      WHERE t.user_id = $1 AND ${LIVE} ORDER BY t.created_at`,
    [userId],
  );
}

export async function revokeToken(userId: string, id: string): Promise<boolean> {
  const rows = await q(
    'UPDATE connector_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
    [id, userId],
  );
  return rows.length > 0;
}

/**
 * Look up the bearer token on a connector request made to `resource` (the
 * full address called). A revoked or expired token, or one whose account is
 * no longer active, finds nothing. A signed-in connection is valid only on
 * the address it was approved for; a hand-made token is valid on any. The
 * remembered campaign is dropped here if the user no longer owns it.
 */
export async function resolveToken(
  token: string | undefined,
  resource: string,
): Promise<ConnectorUser | undefined> {
  if (!token || token.length > 128) return undefined;
  if (!token.startsWith(TOKEN_PREFIX) && !token.startsWith(ACCESS_PREFIX)) return undefined;
  const row = await q1<{
    id: string;
    user_id: string;
    display_name: string;
    campaign_id: string | null;
    resource: string | null;
    owns: boolean;
    stale: boolean;
  }>(
    `SELECT t.id, t.user_id, u.display_name, t.campaign_id, t.resource,
            EXISTS (SELECT 1 FROM campaigns c WHERE c.id = t.campaign_id AND c.owner_id = t.user_id) AS owns,
            t.last_used_at IS NULL OR t.last_used_at < now() - interval '60 seconds' AS stale
       FROM connector_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND u.status = 'active'
        AND (t.expires_at IS NULL OR t.expires_at > now())`,
    [sha256(token)],
  );
  if (!row) return undefined;
  // Audience: a connection approved for one address cannot be used on another.
  if (row.resource !== null && row.resource !== resource) return undefined;
  if (row.stale) {
    void q('UPDATE connector_tokens SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => undefined);
  }
  return {
    tokenId: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    campaignId: row.owns ? row.campaign_id : null,
  };
}

export async function setTokenCampaign(tokenId: string, campaignId: string): Promise<void> {
  await q('UPDATE connector_tokens SET campaign_id = $2 WHERE id = $1', [tokenId, campaignId]);
}
