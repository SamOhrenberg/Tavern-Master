import { q, q1 } from '../db/pool.js';
import { randomToken, sha256 } from '../security/crypto.js';

/** Recognisable in a leaked log or a pasted config, and easy to search for. */
export const TOKEN_PREFIX = 'tmc_';
const MAX_TOKENS = 10;

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
  created_at: Date;
  last_used_at: Date | null;
  campaign_name: string | null;
}

/** Make a token and return it. Only its hash is kept, so this is the one time it can be shown. */
export async function createToken(
  userId: string,
  label: string,
): Promise<{ id: string; token: string } | null> {
  const live = await q1<{ n: number }>(
    'SELECT count(*)::int AS n FROM connector_tokens WHERE user_id = $1 AND revoked_at IS NULL',
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

export function listTokens(userId: string): Promise<TokenRow[]> {
  return q<TokenRow>(
    `SELECT t.id, t.label, t.created_at, t.last_used_at, c.name AS campaign_name
       FROM connector_tokens t LEFT JOIN campaigns c ON c.id = t.campaign_id
      WHERE t.user_id = $1 AND t.revoked_at IS NULL ORDER BY t.created_at`,
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
 * Look up the bearer token on a connector request. A revoked token, or one
 * whose account is no longer active, finds nothing. The remembered campaign
 * is dropped here if the user no longer owns it.
 */
export async function resolveToken(token: string | undefined): Promise<ConnectorUser | undefined> {
  if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 128) return undefined;
  const row = await q1<{
    id: string;
    user_id: string;
    display_name: string;
    campaign_id: string | null;
    owns: boolean;
    stale: boolean;
  }>(
    `SELECT t.id, t.user_id, u.display_name, t.campaign_id,
            EXISTS (SELECT 1 FROM campaign_members m
                     WHERE m.campaign_id = t.campaign_id AND m.user_id = t.user_id AND m.role = 'owner') AS owns,
            t.last_used_at IS NULL OR t.last_used_at < now() - interval '60 seconds' AS stale
       FROM connector_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND u.status = 'active'`,
    [sha256(token)],
  );
  if (!row) return undefined;
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
