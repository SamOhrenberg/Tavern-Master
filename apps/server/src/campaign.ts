import type { CampaignSettings, DmMode } from '@tavern/protocol';
import { q, q1, tx } from './db/pool.js';
import { badRequest, conflict } from './errors.js';
import { endSession, getRoom } from './realtime/room.js';

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
  status?: 'active' | 'archived';
}

/** Store a change to a campaign's own fields. Who runs it is handled by the caller around this. */
export async function updateCampaign(campaignId: string, patch: CampaignPatch): Promise<void> {
  const settings: Partial<CampaignSettings> = {};
  if (patch.tone !== undefined) settings.tone = patch.tone;
  if (patch.gatherWindowSeconds !== undefined) settings.gatherWindowSeconds = patch.gatherWindowSeconds;
  if (patch.sheets !== undefined) settings.sheets = patch.sheets;
  if (patch.dm !== undefined) settings.dm = patch.dm;
  await q(
    `UPDATE campaigns SET name = coalesce($2, name), premise = coalesce($3, premise),
                          status = coalesce($4, status), settings = settings || $5::jsonb WHERE id = $1`,
    [campaignId, patch.name ?? null, patch.premise ?? null, patch.status ?? null, JSON.stringify(settings)],
  );
  const room = getRoom(campaignId);
  if (room && patch.gatherWindowSeconds) room.collector.windowMs = patch.gatherWindowSeconds * 1000;
}

/**
 * Leave the lobby and begin. The DM plans the story and writes the opening
 * scene as soon as it can; nothing here waits for it. Throws when it has
 * already begun.
 */
export async function startCampaign(campaignId: string): Promise<void> {
  const rows = await q(
    `UPDATE campaigns SET phase = 'active', started_at = now()
      WHERE id = $1 AND phase = 'prep' AND status = 'active' RETURNING id`,
    [campaignId],
  );
  if (!rows.length) throw conflict('This campaign has already begun.');
  const room = getRoom(campaignId);
  room?.broadcast({ type: 'state_changed' });
  // A polling Claude hears about the opening at once.
  await room?.workChanged();
  void room?.maybeOpen();
}

/** Close the session in progress. Returns its number. */
export async function endCurrentSession(campaignId: string): Promise<number> {
  if (getRoom(campaignId)?.busy) throw conflict('Wait for the current turn to finish.');
  const open = await q1<{ id: string; number: number }>(
    'SELECT id, number FROM play_sessions WHERE campaign_id = $1 AND ended_at IS NULL',
    [campaignId],
  );
  if (!open) throw badRequest('There is no session in progress.');
  await endSession(campaignId, open.id);
  return open.number;
}
