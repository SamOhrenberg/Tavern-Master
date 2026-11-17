import type { NotifyCategory, PushPayload, QuietHours } from '@tavern/protocol';
import { q } from '../db/pool.js';

/**
 * Quiet hours: a daily stretch, in someone's own time zone, when their
 * notifications are held instead of sent. When it ends they get one summary
 * per campaign: how many things happened, and the most important of them.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A stored value as quiet hours, or null when it is missing or malformed. */
export function quietOf(stored: unknown): QuietHours | null {
  if (!stored || typeof stored !== 'object') return null;
  const { start, end, timeZone } = stored as Record<string, unknown>;
  if (typeof start !== 'string' || typeof end !== 'string' || typeof timeZone !== 'string') return null;
  if (!HHMM.test(start) || !HHMM.test(end) || !validTimeZone(timeZone)) return null;
  return { start, end, timeZone };
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether `now` falls inside these quiet hours, in their own time zone. */
export function inQuietHours(quiet: QuietHours | null, now = new Date()): boolean {
  if (!quiet) return false;
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: quiet.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return false;
  }
  const at =
    Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 +
    Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  // An end before the start runs past midnight.
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/** Of these people, who is in their quiet hours right now. */
export async function quietNow(userIds: string[], now = new Date()): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await q<{ id: string; notify_quiet: unknown }>(
    'SELECT id, notify_quiet FROM users WHERE id = ANY($1::uuid[]) AND notify_quiet IS NOT NULL',
    [userIds],
  );
  return new Set(rows.filter((r) => inQuietHours(quietOf(r.notify_quiet), now)).map((r) => r.id));
}

/**
 * Which held notification a summary leads with: the one that asks something
 * of you beats news, and news beats chatter. Ties go to the newer one.
 */
const RANK: Record<NotifyCategory, number> = {
  chat: 0,
  actions: 1,
  narration: 2,
  sessions: 3,
  invites: 3,
  waiting: 4,
  rolls: 5,
};

/** Keep a notification for after quiet hours, folded into what is already held for the same tag. */
export async function hold(userIds: string[], payload: PushPayload): Promise<void> {
  if (!userIds.length) return;
  await q(
    `INSERT INTO push_held (user_id, tag, payload)
     SELECT u, $2, $3::jsonb FROM unnest($1::uuid[]) AS u
     ON CONFLICT (user_id, tag) DO UPDATE
       SET count = push_held.count + 1,
           payload = CASE WHEN $4::int >= coalesce(($5::jsonb ->> (push_held.payload ->> 'category'))::int, 0)
                          THEN EXCLUDED.payload ELSE push_held.payload END`,
    [userIds, payload.tag, JSON.stringify(payload), RANK[payload.category], JSON.stringify(RANK)],
  );
}

/** You opened the campaign: what was held for it is already on your screen. */
export async function dropHeld(userId: string, tag: string): Promise<void> {
  await q('DELETE FROM push_held WHERE user_id = $1 AND tag = $2', [userId, tag]);
}

/**
 * Take what is held for everyone whose quiet hours are over, as one
 * notification per campaign. Each row is deleted as it is taken, so two
 * sweeps cannot send it twice.
 */
export async function takeReleased(
  now = new Date(),
): Promise<{ userId: string; payload: PushPayload; count: number }[]> {
  const waiting = await q<{ user_id: string; notify_quiet: unknown }>(
    `SELECT DISTINCT h.user_id, u.notify_quiet FROM push_held h JOIN users u ON u.id = h.user_id`,
  );
  const due = waiting.filter((r) => !inQuietHours(quietOf(r.notify_quiet), now)).map((r) => r.user_id);
  if (!due.length) return [];
  const rows = await q<{ user_id: string; payload: PushPayload; count: number }>(
    'DELETE FROM push_held WHERE user_id = ANY($1::uuid[]) RETURNING user_id, payload, count',
    [due],
  );
  return rows.map((r) => ({ userId: r.user_id, payload: r.payload, count: r.count }));
}
