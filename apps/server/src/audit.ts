import { q } from './db/pool.js';
import { log } from './log.js';

export interface AuditEntry {
  actorId?: string | null;
  targetType?: string;
  targetId?: string;
  ip?: string;
  /** Never put secrets here: this is stored and shown to admins. */
  meta?: Record<string, unknown>;
}

/** Append to the audit log. Failures are logged, never thrown: auditing must not break a login. */
export async function audit(action: string, entry: AuditEntry = {}): Promise<void> {
  try {
    await q(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, ip, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.actorId ?? null,
        action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.ip ?? null,
        JSON.stringify(entry.meta ?? {}),
      ],
    );
  } catch (err) {
    log().error({ err, action }, 'failed to write audit log');
  }
}
