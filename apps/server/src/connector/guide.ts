import { z } from 'zod';
import {
  builderSystem,
  controlOf,
  loadBuilderCampaign,
  replayWindow,
  savedLine,
  saveFromThread,
  searchPublicDocuments,
  sheetBlock,
} from '../agent/builder.js';
import { escapeXml } from '../agent/context.js';
import { systemRng } from '../agent/dice.js';
import { redactSecrets } from '../agent/loop.js';
import { draftSchema } from '../agent/sheets.js';
import { pgStore } from '../agent/store.js';
import { dispatchTool } from '../agent/tools.js';
import { q, q1 } from '../db/pool.js';
import type { Control } from '../party.js';
import { registerWork } from './handlers.js';
import { own, openTable, ToolError, workIdSchema, type ConnectorTool, type Table } from './toolkit.js';
import { addTools, gmVariant, setRequestContext } from './tools.js';
import { currentWork, finishWork, queueWork, type WorkItem, type WorkKind } from './work.js';

/**
 * The character guide, played by Claude. A player's message to the guide is
 * stored and queued; Claude picks it up with wait_for_work, writes the sheet
 * with save_character and answers with reply_guide. While it holds a guide
 * request the tool gate allows nothing that could touch the story, so a
 * player's words can never make the DM's own tools run.
 */

interface ThreadRow {
  id: string;
  campaign_id: string;
  user_id: string;
  character_id: string | null;
  intent: Partial<Control>;
  display_name: string;
}

async function loadThread(threadId: string): Promise<ThreadRow | undefined> {
  return q1<ThreadRow>(
    `SELECT t.id, t.campaign_id, t.user_id, t.character_id, t.intent, u.display_name
       FROM builder_threads t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
    [threadId],
  );
}

interface Line {
  role: 'user' | 'assistant';
  content: string;
  created_at: Date;
}

const threadLines = (threadId: string) =>
  q<Line>('SELECT role, content, created_at FROM builder_messages WHERE thread_id = $1 ORDER BY id', [
    threadId,
  ]);

/** The request Claude holds, if it is this one and of this kind; otherwise a ToolError. */
export async function heldRequest(t: Table, workId: string, kind: WorkKind): Promise<WorkItem> {
  const held = await currentWork(t.id);
  if (!held || held.id !== workId || held.kind !== kind) {
    throw new ToolError(`You do not hold ${kind} request ${workId}. Call wait_for_work.`);
  }
  return held;
}

async function characterName(characterId: string | null): Promise<string | null> {
  if (!characterId) return null;
  return (
    (await q1<{ name: string }>('SELECT name FROM characters WHERE id = $1', [characterId]))?.name ?? null
  );
}

registerWork('guide', {
  label: () => 'A player waiting on the character guide',

  async prepare(item) {
    // Nothing to answer if the chat is gone or its last word is already the guide's.
    const lines = await threadLines(item.subjectId);
    return lines.at(-1)?.role === 'user' ? item : null;
  },

  async render(item) {
    const thread = await loadThread(item.subjectId);
    if (!thread) throw new ToolError('That conversation no longer exists. Drop it with skip_work.');
    const campaign = await loadBuilderCampaign(thread.campaign_id);
    if (!campaign) throw new ToolError('That campaign no longer exists.');
    const control = controlOf(thread.intent, thread.user_id);
    const name = await characterName(thread.character_id);
    const building = name ?? (control.kind === 'npc' ? 'a companion' : 'a character');
    const conversation = replayWindow(await threadLines(thread.id))
      .map((l) =>
        l.role === 'assistant'
          ? `  <guide>${escapeXml(l.content)}</guide>`
          : `  <player>${escapeXml(l.content)}</player>`,
      )
      .join('\n');
    return {
      text: [
        `Guide request ${item.id}. ${thread.display_name} is building ${building} and is waiting in the app.`,
        'For this request you are their guide, not their Dungeon Master.',
        `<guide_role>\n${builderSystem(campaign, control, { forClaude: true })}\n</guide_role>`,
        await sheetBlock(thread.character_id),
        `<conversation>\n${conversation}\n</conversation>`,
        `Write to the sheet with save_character (work_id ${item.id}) as things are decided, then answer the ` +
          `player with reply_guide (work_id ${item.id}). Use nothing from your notebook, secrets or DM-only documents.`,
      ].join('\n\n'),
    };
  },

  async skipped(item, reason, t) {
    await postReply(t, item, `Claude could not answer this one: ${reason}`);
  },
});

/** Store a guide reply, tell the player it is there, and settle the request. */
async function postReply(t: Table, item: WorkItem, text: string, rolls: unknown[] = []): Promise<number> {
  const row = await q1<{ id: number }>(
    `INSERT INTO builder_messages (thread_id, role, content, meta) VALUES ($1, 'assistant', $2, $3) RETURNING id`,
    [item.subjectId, text, JSON.stringify(rolls.length ? { rolls } : {})],
  );
  await q('UPDATE builder_threads SET updated_at = now() WHERE id = $1', [item.subjectId]);
  if (item.requestedBy) t.room.tellUser(item.requestedBy, { type: 'guide', threadId: item.subjectId });
  return row!.id;
}

// The guide's dice roll in a context of its own, which is never shown to the table.
setRequestContext('guide', (t, held) => t.room.requestContext(held.id, t.systemId, []));

// While guiding, a document search reads only what the whole table may read.
gmVariant('search_documents', (input, t, held) => {
  if (held.kind !== 'guide') return null;
  const ctx = t.room.requestContext(held.id, t.systemId, []);
  return dispatchTool('search_documents', input, ctx, pgStore, systemRng, [searchPublicDocuments]);
});

const saveSchema = draftSchema.extend({
  work_id: workIdSchema.optional().describe('The guide request you are answering, if any'),
  character: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe('Outside a guide request: the party member to change. Leave it out to create a new one.'),
  played_by: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe(
      'Outside a guide request, for a new character: "me" (the host, the default), "dm", or a player’s name',
    ),
  companion: z
    .boolean()
    .optional()
    .describe(
      'Outside a guide request, for a new character: true for a companion rather than a player character',
    ),
});

/** Host-side saving outside a guide request, filled in by the campaign setup tools. */
let hostSave: ((input: z.infer<typeof saveSchema>, t: Table) => Promise<string>) | null = null;
export function setHostSave(fn: typeof hostSave): void {
  hostSave = fn;
}

export const GUIDE_TOOLS: ConnectorTool[] = [
  own({
    name: 'reply_guide',
    description:
      'Answer the player in a guide request. They read this in the app as the guide’s next message. Write it ' +
      'as the guide: warm, brief, a few short paragraphs at most.',
    schema: z.object({
      work_id: workIdSchema,
      text: z.string().trim().min(1).max(4000).describe('Your reply to the player'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['guide'],
    async run(input, call) {
      const t = await openTable(call);
      const item = await heldRequest(t, input.work_id, 'guide');
      const entities = await pgStore.entities(t.id);
      const secrets = entities.flatMap((e) => (e.secret && !e.secretRevealed ? [e.secret] : []));
      const safe = redactSecrets(input.text, secrets);
      const ctx = t.room.dropRequestContext(item.id);
      const messageId = await postReply(t, item, safe.text || '…', ctx?.rolls ?? []);
      await finishWork(item.id, { messageId });
      // The player kept typing while Claude worked: answer that next.
      const later = (await threadLines(item.subjectId)).filter(
        (l) => l.role === 'user' && item.claimedAt && l.created_at > item.claimedAt,
      );
      if (later.length) {
        await queueWork({
          campaignId: t.id,
          kind: 'guide',
          subjectId: item.subjectId,
          requestedBy: item.requestedBy,
        });
      }
      return `Sent.${safe.redacted ? ' Part of it named a secret and was blacked out.' : ''}${later.length ? ' They wrote again meanwhile; it is waiting for you.' : ''} Call wait_for_work.`;
    },
  }),

  own({
    name: 'save_character',
    description:
      'Write to a character sheet. Send only what is new or changed; everything else on the sheet is kept. ' +
      'In a guide request pass its work_id: the sheet is the player’s, saved as them. Outside a request you ' +
      'build with the host: name a party member to change it, or leave character out to create one.',
    schema: saveSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['free', 'guide'],
    async run(input, call) {
      const t = await openTable(call);
      const { work_id, character: _c, played_by: _p, companion: _k, ...patch } = input;
      if (!work_id) {
        if (await currentWork(t.id)) throw new ToolError('Pass the work_id of the guide request you hold.');
        if (!hostSave) throw new ToolError('Building characters outside a guide request is not available.');
        return hostSave(input, t);
      }
      await heldRequest(t, work_id, 'guide');
      const item = (await currentWork(t.id))!;
      const out = await saveFromThread(item.subjectId, patch);
      t.room.partyChanged();
      return savedLine(out);
    },
  }),
];

addTools(...GUIDE_TOOLS);
