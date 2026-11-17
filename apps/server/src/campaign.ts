import type { CampaignSettings, DmMode } from '@tavern/protocol';
import { q, q1, tx } from './db/pool.js';
import { badRequest, conflict } from './errors.js';
import { beginSession, endSession, getRoom, openRoom, type Room } from './realtime/room.js';
import { snapshotState } from './rewind.js';

/**
 * Creating, changing, beginning and pausing a campaign. Shared by the REST
 * routes the app calls and by the connector tools Claude calls, so both
 * paths do exactly the same thing.
 */

export interface NewCampaign {
  ownerId: string;
  systemId: string;
  name: string;
  premise: string;
  tone: string;
  sheets: 'players' | 'gm';
  dm: DmMode;
}

export async function insertCampaign(c: NewCampaign): Promise<string> {
  return tx(async (client) => {
    const row = await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, premise, settings) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        c.systemId,
        c.ownerId,
        c.name,
        c.premise,
        JSON.stringify({ tone: c.tone, sheets: c.sheets, dm: c.dm }),
      ],
      client,
    );
    await client.query(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      row!.id,
      c.ownerId,
    ]);
    return row!.id;
  });
}

export interface CampaignPatch {
  name?: string;
  premise?: string;
  tone?: string;
  gatherWindowSeconds?: number;
  sheets?: 'players' | 'gm';
  dm?: DmMode;
  /** The outside AI that polishes the DM's narration, or '' for none. */
  polishWith?: string;
  status?: 'active' | 'archived';
}

/** Store a change to a campaign's own fields. Who runs it is handled by the caller around this. */
export async function updateCampaign(campaignId: string, patch: CampaignPatch): Promise<void> {
  const settings: Partial<CampaignSettings> = {};
  if (patch.tone !== undefined) settings.tone = patch.tone;
  if (patch.gatherWindowSeconds !== undefined) settings.gatherWindowSeconds = patch.gatherWindowSeconds;
  if (patch.sheets !== undefined) settings.sheets = patch.sheets;
  if (patch.dm !== undefined) settings.dm = patch.dm;
  if (patch.polishWith !== undefined) settings.polishWith = patch.polishWith;
  await q(
    `UPDATE campaigns SET name = coalesce($2, name), premise = coalesce($3, premise),
                          status = coalesce($4, status), settings = settings || $5::jsonb WHERE id = $1`,
    [campaignId, patch.name ?? null, patch.premise ?? null, patch.status ?? null, JSON.stringify(settings)],
  );
  const room = getRoom(campaignId);
  if (room && patch.gatherWindowSeconds !== undefined)
    room.collector.windowMs = patch.gatherWindowSeconds * 1000;
}

/**
 * The players (everyone but the host) who have not marked themselves ready, by
 * name. Given the open room, a player who is ready but not connected also
 * counts as not ready (used between sessions, where ready means present).
 */
export async function notReady(campaignId: string, here?: Room): Promise<string[]> {
  const rows = await q<{ id: string; display_name: string; ready: boolean }>(
    `SELECT u.id, u.display_name, m.ready_at IS NOT NULL AS ready
       FROM campaign_members m JOIN users u ON u.id = m.user_id
      WHERE m.campaign_id = $1 AND m.role <> 'owner' ORDER BY m.joined_at`,
    [campaignId],
  );
  const present = here ? new Set(here.present().map((u) => u.id)) : null;
  return rows.filter((r) => !r.ready || (present && !present.has(r.id))).map((r) => r.display_name);
}

const nameList = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * Leave the lobby and begin. The DM plans the story and writes the opening
 * scene as soon as it can; nothing here waits for it. Throws when it has
 * already begun, or while any player has not marked themselves ready.
 */
export async function startCampaign(campaignId: string): Promise<void> {
  // One statement, so a player who takes their ready back cannot slip between the check and the start.
  const rows = await q(
    `UPDATE campaigns SET phase = 'active', started_at = now()
      WHERE id = $1 AND phase = 'prep' AND status = 'active'
        AND NOT EXISTS (SELECT 1 FROM campaign_members m
                         WHERE m.campaign_id = $1 AND m.role <> 'owner' AND m.ready_at IS NULL)
      RETURNING id`,
    [campaignId],
  );
  if (!rows.length) {
    const waiting = await notReady(campaignId);
    const phase = await q1<{ phase: string }>('SELECT phase FROM campaigns WHERE id = $1', [campaignId]);
    if (phase?.phase === 'prep' && waiting.length) {
      throw conflict(
        `Everyone has to be ready first. Waiting for ${nameList(waiting)} to ready up.`,
        'not_ready',
      );
    }
    throw conflict('This campaign has already begun.');
  }
  // The world before the opening scene, so the first session can be started over.
  await snapshotState(campaignId, null);
  const room = getRoom(campaignId);
  room?.broadcast({ type: 'state_changed' });
  // A polling Claude hears about the opening at once.
  await room?.workChanged();
  void room?.maybeOpen();
}

/**
 * Close the session in progress and send the table to the recap. Returns its
 * number. It goes through the table's queue, so it is refused while a turn is
 * being gathered or the DM is writing, and nothing can start a turn between
 * that check and the end of the session.
 */
export async function endCurrentSession(campaignId: string): Promise<number> {
  const room = await openRoom(campaignId);
  const number = await room.whenQuiet(async () => {
    const open = await q1<{ id: string; number: number }>(
      'SELECT id, number FROM play_sessions WHERE campaign_id = $1 AND ended_at IS NULL',
      [campaignId],
    );
    if (!open) throw badRequest('There is no session in progress.');
    // Between sessions: the table sees the recap, and everyone readies up again.
    await endSession(campaignId, open.id, { rest: true });
    return open.number;
  });
  room.broadcast({ type: 'state_changed' });
  return number;
}

/**
 * Start the next session from the recap. Like beginning the campaign, it
 * waits for every player to be ready, and ready means here: someone who
 * tapped ready and then left the app is not counted. The host may start
 * `anyway` without whoever is not ready or not here (they stay in the
 * campaign and join the table when they come back).
 * Returns the new session's number.
 */
export async function resumeSession(campaignId: string, opts: { anyway?: boolean } = {}): Promise<number> {
  const room = await openRoom(campaignId);
  const waiting = await notReady(campaignId, room);
  if (waiting.length && !opts.anyway) {
    const resting = await q1('SELECT 1 FROM campaigns WHERE id = $1 AND resting_since IS NOT NULL', [
      campaignId,
    ]);
    if (resting) {
      throw conflict(
        `Everyone has to be ready first. Waiting for ${nameList(waiting)} to ready up.`,
        'not_ready',
      );
    }
  }
  // Still one statement for the readiness itself, so a player cannot slip in between.
  const rows = await q(
    `UPDATE campaigns SET resting_since = NULL
      WHERE id = $1 AND resting_since IS NOT NULL
        AND ($2::boolean OR NOT EXISTS (SELECT 1 FROM campaign_members m
                         WHERE m.campaign_id = $1 AND m.role <> 'owner' AND m.ready_at IS NULL))
      RETURNING id`,
    [campaignId, !!opts.anyway],
  );
  if (!rows.length) {
    const again = await notReady(campaignId, room);
    const resting = await q1('SELECT 1 FROM campaigns WHERE id = $1 AND resting_since IS NOT NULL', [
      campaignId,
    ]);
    if (resting && again.length) {
      throw conflict(
        `Everyone has to be ready first. Waiting for ${nameList(again)} to ready up.`,
        'not_ready',
      );
    }
    throw conflict('No session has ended, so there is nothing to resume.');
  }
  const number = await beginSession(campaignId);
  getRoom(campaignId)?.broadcast({ type: 'state_changed' });
  return number;
}
