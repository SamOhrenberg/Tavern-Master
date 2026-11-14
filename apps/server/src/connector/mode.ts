import type { DmMode } from '@tavern/protocol';
import { q1 } from '../db/pool.js';

export type { DmMode };

/**
 * Who is every AI for a campaign. 'server' is the built-in agents on the
 * configured LLM; 'claude' is the owner's Claude, reaching the table through
 * the connector, and then the server calls no model for that campaign at all:
 * not for narration, the guide, uploaded sheets, documents or the chronicle.
 */
export const dmModeOf = (settings: { dm?: unknown } | null | undefined): DmMode =>
  settings?.dm === 'claude' ? 'claude' : 'server';

export async function dmMode(campaignId: string): Promise<DmMode> {
  const row = await q1<{ settings: { dm?: unknown } }>('SELECT settings FROM campaigns WHERE id = $1', [
    campaignId,
  ]);
  return dmModeOf(row?.settings);
}

/** A model call was about to be made for a campaign whose AI is Claude. */
export class ClaudeRunsThis extends Error {
  constructor() {
    super('Claude runs this campaign, so the server does not call a model for it.');
  }
}

/** Throws ClaudeRunsThis when the campaign's AI is Claude. Call before any model call made for a campaign. */
export async function requireServerAi(campaignId: string): Promise<void> {
  if ((await dmMode(campaignId)) === 'claude') throw new ClaudeRunsThis();
}
