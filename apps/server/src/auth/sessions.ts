import type { Me, Role } from '@tavern/protocol';
import { config } from '../config.js';
import { q, q1 } from '../db/pool.js';
import { hmac, randomToken, sha256 } from '../security/crypto.js';

export const SESSION_COOKIE = 'tm_session';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  totpEnabled: boolean;
}

export interface AuthContext {
  sessionId: string;
  user: AuthUser;
}

interface SessionRow {
  session_id: string;
  stale: boolean;
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: Role;
  totp_enabled: boolean;
}

/** Create a session and return the opaque token for the cookie. Only its hash is stored. */
export async function createSession(userId: string, ip: string, userAgent: string | undefined): Promise<string> {
  const token = randomToken(32);
  await q(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [userId, sha256(token), config().SESSION_MAX_DAYS, ip, (userAgent ?? '').slice(0, 300)],
  );
  return token;
}

/** Look a cookie token up. Enforces revocation, absolute expiry, idle expiry and account status. */
export async function resolveSession(token: string | undefined): Promise<AuthContext | undefined> {
  if (!token || token.length > 128) return undefined;
  const row = await q1<SessionRow>(
    `SELECT s.id AS session_id,
            s.last_seen_at < now() - interval '60 seconds' AS stale,
            u.id, u.username, u.display_name, u.email, u.role,
            u.totp_enabled_at IS NOT NULL AS totp_enabled
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(hours => $2)
        AND u.status = 'active'`,
    [sha256(token), config().SESSION_IDLE_HOURS],
  );
  if (!row) return undefined;
  if (row.stale) {
    // Throttled so an active tab is one small write a minute, not one per request.
    void q('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]).catch(() => undefined);
  }
  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      totpEnabled: row.totp_enabled,
    },
  };
}

export async function revokeSession(sessionId: string, userId: string): Promise<boolean> {
  const rows = await q(
    'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
    [sessionId, userId],
  );
  return rows.length > 0;
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const rows = await q(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2) RETURNING id`,
    [userId, exceptSessionId ?? null],
  );
  return rows.length;
}

/** CSRF token bound to the session; the client echoes it in X-CSRF-Token. */
export function csrfToken(sessionId: string): string {
  return hmac('csrf', sessionId);
}

export function cookieOptions() {
  const cfg = config();
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: cfg.cookieSecure,
    maxAge: cfg.SESSION_MAX_DAYS * 86_400,
  };
}

export function toMe(auth: AuthContext): Me {
  const u = auth.user;
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    role: u.role,
    totpEnabled: u.totpEnabled,
    totpRequired: u.role === 'admin' && config().ADMIN_REQUIRE_TOTP && !u.totpEnabled,
    csrfToken: csrfToken(auth.sessionId),
  };
}
