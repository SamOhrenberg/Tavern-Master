import { rm } from 'node:fs/promises';
import { q, q1 } from './db/pool.js';
import { uploadPath } from './storage.js';

/**
 * Pictures of the people and creatures on the NPCs tab. They sit in their own
 * table, keyed by entry, so a story rewind (which re-inserts every entry from
 * a snapshot) leaves them as the owners chose them.
 */

/**
 * Where the app loads an entry's picture from. The storage name changes with
 * every upload, so part of it doubles as a cache-buster and the picture can be
 * cached for good.
 */
export function npcPortraitUrl(campaignId: string, entityId: string, portrait: string): string {
  return `/api/campaigns/${campaignId}/entities/${entityId}/portrait?v=${portrait.slice(0, 12)}`;
}

async function dropFile(portrait: string | null | undefined): Promise<void> {
  if (portrait) await rm(uploadPath(portrait), { force: true });
}

/** Set an entry's picture (null removes it), and remove the file it replaces. */
export async function setNpcPortrait(
  campaignId: string,
  entityId: string,
  portrait: string | null,
): Promise<void> {
  const old = await q1<{ portrait: string }>(
    'SELECT portrait FROM npc_portraits WHERE entity_id = $1 AND campaign_id = $2',
    [entityId, campaignId],
  );
  if (portrait) {
    await q(
      `INSERT INTO npc_portraits (entity_id, campaign_id, portrait) VALUES ($1, $2, $3)
       ON CONFLICT (entity_id) DO UPDATE SET portrait = EXCLUDED.portrait, updated_at = now()`,
      [entityId, campaignId, portrait],
    );
  } else {
    await q('DELETE FROM npc_portraits WHERE entity_id = $1 AND campaign_id = $2', [entityId, campaignId]);
  }
  if (old && old.portrait !== portrait) await dropFile(old.portrait);
}

/**
 * Remove the pictures of entries that no longer exist: after an entry is
 * deleted, or a rewind took the story back to before it was made. Call it
 * once the change is committed.
 */
export async function sweepNpcPortraits(campaignId: string): Promise<void> {
  const gone = await q<{ portrait: string }>(
    `DELETE FROM npc_portraits p
      WHERE p.campaign_id = $1
        AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = p.entity_id AND e.campaign_id = $1)
      RETURNING p.portrait`,
    [campaignId],
  );
  for (const g of gone) await dropFile(g.portrait);
}
