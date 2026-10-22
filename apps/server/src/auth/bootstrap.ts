import { audit } from '../audit.js';
import { config } from '../config.js';
import { q, q1 } from '../db/pool.js';
import { log } from '../log.js';
import { createInvite } from './invites.js';
import { hashPassword } from './password.js';

/**
 * Make sure the instance can be administered after first boot.
 * With ADMIN_PASSWORD set, the admin account is created directly. Otherwise a
 * single-use admin invite code is printed to the log.
 */
export async function ensureAdmin(): Promise<void> {
  const cfg = config();
  const existing = await q1<{ n: number }>('SELECT count(*)::int AS n FROM users');
  if ((existing?.n ?? 0) > 0) return;

  if (cfg.ADMIN_PASSWORD) {
    if (cfg.ADMIN_PASSWORD.length < 12) {
      throw new Error('ADMIN_PASSWORD must be at least 12 characters');
    }
    const username = cfg.ADMIN_USERNAME.toLowerCase();
    const hash = await hashPassword(cfg.ADMIN_PASSWORD);
    const row = await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'admin') ON CONFLICT (username) DO NOTHING RETURNING id`,
      [username, cfg.ADMIN_USERNAME, hash],
    );
    if (row) {
      await audit('user.bootstrap_admin', { targetType: 'user', targetId: row.id });
      log().warn(`Created administrator "${username}" from ADMIN_PASSWORD. You can now remove it from .env.`);
    }
    return;
  }

  // Only one outstanding setup invite at a time.
  await q(`UPDATE invites SET revoked_at = now() WHERE note = 'first-run setup' AND revoked_at IS NULL`);
  const invite = await createInvite({ role: 'admin', note: 'first-run setup', maxUses: 1, expiresInDays: 2, createdBy: null });
  log().warn(`No users exist yet. Register the first administrator with this one-time invite code: ${invite.code}`);
}
