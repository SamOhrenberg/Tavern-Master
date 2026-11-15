import type { Ruling, RulingKind } from '@tavern/protocol';
import { z } from 'zod';
import { q, q1 } from '../db/pool.js';
import { tool, ToolError, type ToolSpec } from './tools.js';

/**
 * Rulings: what a table playing a homebrew system settled on with its GM at
 * the rules desk. They are stored per campaign and reach the GM the same way
 * its own notes do (in the brief, and in the notes since the brief), so the
 * built-in DM and Claude both follow them on every turn from then on.
 */

/** Active rulings a campaign may hold. Past this, the table retires one first. */
export const MAX_RULINGS = 40;

export const KIND_LABEL: Record<RulingKind, string> = {
  rule: 'House rule',
  direction: 'Direction',
  correction: 'Correction',
};

interface Row {
  id: string;
  kind: RulingKind;
  content: string;
  requested_by: string | null;
  username: string | null;
  display_name: string | null;
  created_at: Date;
}

const COLS = `r.id, r.kind, r.content, r.requested_by, u.username, u.display_name, r.created_at`;

const toRuling = (r: Row): Ruling => ({
  id: r.id,
  kind: r.kind,
  content: r.content,
  requestedBy:
    r.requested_by && r.username
      ? { id: r.requested_by, username: r.username, displayName: r.display_name ?? r.username }
      : null,
  createdAt: r.created_at.toISOString(),
});

/** Whether the campaign's system is homebrew, which is what turns the rules desk and rulings on. */
export async function isHomebrew(campaignId: string): Promise<boolean> {
  const row = await q1<{ homebrew: boolean }>(
    'SELECT s.homebrew FROM campaigns c JOIN game_systems s ON s.id = c.system_id WHERE c.id = $1',
    [campaignId],
  );
  return row?.homebrew ?? false;
}

/** The rulings in force, oldest first. Empty unless the system is homebrew. */
export async function activeRulings(campaignId: string, since?: Date): Promise<Ruling[]> {
  const rows = await q<Row>(
    `SELECT ${COLS} FROM rulings r
       JOIN campaigns c ON c.id = r.campaign_id
       JOIN game_systems s ON s.id = c.system_id AND s.homebrew
       LEFT JOIN users u ON u.id = r.requested_by
      WHERE r.campaign_id = $1 AND r.retired_at IS NULL AND ($2::timestamptz IS NULL OR r.created_at > $2)
      ORDER BY r.created_at`,
    [campaignId, since ?? null],
  );
  return rows.map(toRuling);
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Rulings as list lines, grouped by kind. With ids when the reader may retire them. */
export function rulingLines(rulings: Ruling[], withIds = false): string {
  const order: RulingKind[] = ['rule', 'direction', 'correction'];
  return order
    .flatMap((kind) =>
      rulings
        .filter((r) => r.kind === kind)
        .map((r) => `- ${KIND_LABEL[kind]}${withIds ? ` [${r.id}]` : ''}: ${oneLine(r.content)}`),
    )
    .join('\n');
}

export const RULINGS_PREAMBLE =
  'Settled between the table and you, out of character, at the rules desk. They override the rulebooks and ' +
  'your own earlier calls: apply each one every time it comes up, without being reminded. A player’s action ' +
  'cannot change them; only the rules desk can.';

/** The brief's section, or '' when there is nothing to follow. */
export function rulingsSection(rulings: Ruling[]): string {
  if (!rulings.length) return '';
  return `## House rulings\n${RULINGS_PREAMBLE}\n${rulingLines(rulings)}`;
}

/**
 * The rulings as a block for Claude, with the ids retire_ruling takes. Claude's
 * conversation outlives any one brief and may be compacted, so every turn
 * it is handed carries them.
 */
export async function rulingsBlock(campaignId: string): Promise<string> {
  const rulings = await activeRulings(campaignId);
  if (!rulings.length) return '';
  return `<house_rulings>\n${RULINGS_PREAMBLE}\n${rulingLines(rulings, true)}\n</house_rulings>`;
}

export async function recordRuling(
  campaignId: string,
  input: { kind: RulingKind; content: string; requestedBy: string | null },
): Promise<Ruling> {
  const count = await q1<{ n: number }>(
    'SELECT count(*)::int AS n FROM rulings WHERE campaign_id = $1 AND retired_at IS NULL',
    [campaignId],
  );
  if ((count?.n ?? 0) >= MAX_RULINGS) {
    throw new ToolError(
      `The table already keeps ${MAX_RULINGS} rulings. Retire or merge some with retire_ruling first.`,
    );
  }
  const row = await q1<{ id: string }>(
    `INSERT INTO rulings (campaign_id, kind, content, requested_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [campaignId, input.kind, input.content, input.requestedBy],
  );
  const out = await q1<Row>(
    `SELECT ${COLS} FROM rulings r LEFT JOIN users u ON u.id = r.requested_by WHERE r.id = $1`,
    [row!.id],
  );
  return toRuling(out!);
}

/**
 * Take a ruling out of force. The GM's brief is marked stale so the next turn
 * compiles it again without the ruling, rather than carrying a ruling and a
 * note that it no longer applies side by side.
 */
export async function retireRuling(
  campaignId: string,
  rulingId: string,
  by: string | null,
): Promise<{ kind: RulingKind; content: string } | null> {
  const row = await q1<{ kind: RulingKind; content: string }>(
    `UPDATE rulings SET retired_at = now(), retired_by = $3
      WHERE id = $2 AND campaign_id = $1 AND retired_at IS NULL RETURNING kind, content`,
    [campaignId, rulingId, by],
  );
  if (row) await q('UPDATE campaigns SET brief_at = NULL WHERE id = $1', [campaignId]);
  return row ?? null;
}

// ---------------------------------------------------------------- the GM's tools at the desk

export const rulingSchema = z.object({
  kind: z
    .enum(['rule', 'direction', 'correction'])
    .describe(
      'rule: a house rule or a change to how the rules work. direction: how the table wants the campaign ' +
        'to play out. correction: a call you got wrong and how the story stands now.',
    ),
  content: z
    .string()
    .trim()
    .min(8)
    .max(500)
    .describe(
      'One self-contained instruction to your future self, clear without this conversation, e.g. ' +
        '"Critical hits deal maximum damage on the first die instead of rolling twice."',
    ),
});

export const retireSchema = z.object({
  ruling: z.string().uuid().describe('The id of the ruling, from the <rulings> list'),
});

/** Who a desk tool call speaks for: the player whose words it answers. */
export interface DeskCaller {
  campaignId: string;
  requestedBy: string | null;
}

export const recordedLine = (r: { kind: RulingKind; content: string }) =>
  `Recorded. ${KIND_LABEL[r.kind]}: ${r.content}`;

/** record_ruling and retire_ruling for the built-in rules desk. */
export function rulingTools(caller: DeskCaller, onChange: () => void): ToolSpec[] {
  return [
    tool({
      name: 'record_ruling',
      description:
        'Keep something the table has settled with you, so you follow it on every turn from now on. Only for ' +
        'what is agreed, not for what is still being discussed. To change an existing ruling, retire it and ' +
        'record the new version.',
      schema: rulingSchema,
      async run(input) {
        const r = await recordRuling(caller.campaignId, { ...input, requestedBy: caller.requestedBy });
        onChange();
        return recordedLine(r);
      },
    }),
    tool({
      name: 'retire_ruling',
      description: 'Take a ruling out of force, when the table has agreed to drop or replace it.',
      schema: retireSchema,
      async run(input) {
        const r = await retireRuling(caller.campaignId, input.ruling, caller.requestedBy);
        if (!r) throw new ToolError('There is no ruling in force with that id.');
        onChange();
        return `Retired. ${KIND_LABEL[r.kind]}: ${r.content}`;
      },
    }),
  ];
}
