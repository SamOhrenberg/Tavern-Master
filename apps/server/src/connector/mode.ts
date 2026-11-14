import { q1 } from '../db/pool.js';

/**
 * Who runs a campaign's Dungeon Master. 'server' is the built-in agent loop
 * on the configured LLM; 'claude' is an outside client, the Claude app,
 * reaching the table through the connector, so the server never calls a
 * model for play at all.
 */
export type DmMode = 'server' | 'claude';

export const dmModeOf = (settings: { dm?: unknown } | null | undefined): DmMode =>
  settings?.dm === 'claude' ? 'claude' : 'server';

export async function dmMode(campaignId: string): Promise<DmMode> {
  const row = await q1<{ settings: { dm?: unknown } }>('SELECT settings FROM campaigns WHERE id = $1', [
    campaignId,
  ]);
  return dmModeOf(row?.settings);
}
