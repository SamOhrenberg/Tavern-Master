import type { DmMode, DmStatus } from '@tavern/protocol';

/** What the room knows about an outside DM at one moment. */
export interface PresenceFacts {
  mode: DmMode;
  /** wait_for_work calls open right now. */
  polls: number;
  /** Epoch ms of the last connector call for this campaign, 0 if none since the room opened. */
  lastCallAt: number;
  /** A turn or a request is claimed and not yet finished. */
  claimed: boolean;
  /** When the campaign last saw its outside DM, from the database. */
  seenAt: Date | null;
  waiting: number;
  now: number;
  /** How long after a call Claude still counts as listening. */
  listenMs: number;
}

export const SERVER_STATUS: DmStatus = { mode: 'server', state: 'listening', lastSeenAt: null, waiting: 0 };

/**
 * Where a campaign's AI is. The built-in DM is always listening. Claude is
 * working while it holds something, listening while it polls or has just
 * called, away once it has been seen and gone quiet, and never before its
 * first call.
 */
export function presenceOf(f: PresenceFacts): DmStatus {
  if (f.mode === 'server') return SERVER_STATUS;
  const lastSeenAt = f.seenAt?.toISOString() ?? (f.lastCallAt ? new Date(f.lastCallAt).toISOString() : null);
  const state: DmStatus['state'] = f.claimed
    ? 'working'
    : f.polls > 0 || (f.lastCallAt > 0 && f.now - f.lastCallAt < f.listenMs)
      ? 'listening'
      : lastSeenAt
        ? 'away'
        : 'never';
  return { mode: 'claude', state, lastSeenAt, waiting: f.waiting };
}
