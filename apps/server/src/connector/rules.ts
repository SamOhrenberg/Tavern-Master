import { z } from 'zod';
import { replayWindow, searchPublicDocuments } from '../agent/builder.js';
import { escapeXml } from '../agent/context.js';
import { systemRng } from '../agent/dice.js';
import {
  askers,
  deskContext,
  deskLines,
  loadDeskCampaign,
  postDeskAnswer,
  rulesDeskSystem,
  saidLine,
} from '../agent/rules-desk.js';
import {
  isHomebrew,
  KIND_LABEL,
  recordedLine,
  recordRuling,
  retireRuling,
  retireSchema,
  rulingsBlock,
  rulingSchema,
} from '../agent/rulings.js';
import { pgStore, type Actor } from '../agent/store.js';
import { dispatchTool } from '../agent/tools.js';
import { registerWork } from './handlers.js';
import { heldRequest } from './guide.js';
import { openTable, own, ToolError, workIdSchema, type ConnectorTool, type Table } from './toolkit.js';
import { addTools, addTurnNote, gmVariant, setRequestContext } from './tools.js';
import { currentWork, finishWork, queueWork, setWorkPayload, type WorkItem } from './work.js';

/**
 * The rules desk, answered by Claude. A player's message at the desk is
 * stored and queued as one request per campaign; Claude picks it up with
 * wait_for_work, may check the record and put a mistake right with the GM
 * tools the desk allows, records what the table settles with record_ruling,
 * and answers with reply_rules. The gate keeps everything else (narration,
 * the notebook, codex secrets) out of reach while it holds the request.
 *
 * Rulings also travel with every turn Claude is handed, and the host can
 * record one directly when talking to Claude as co-DM.
 */

const actorsOf = (item: WorkItem): Actor[] => (item.payload.actors as Actor[] | undefined) ?? [];

/** Who a ruling is credited to: the last player waiting at the desk, else the host. */
const requesterOf = (item: WorkItem | null, t: Table): string =>
  (item && (actorsOf(item).at(-1)?.userId ?? item.requestedBy)) || t.ownerId;

registerWork('rules', {
  label: () => 'Players waiting at the rules desk',

  async prepare(item) {
    // Nothing to answer if the desk's last word is already the GM's.
    const lines = await deskLines(item.campaignId);
    if (lines.at(-1)?.role !== 'user') return null;
    const payload = { actors: askers(lines) };
    await setWorkPayload(item.id, payload);
    return { ...item, payload };
  },

  async render(item, t) {
    const c = await loadDeskCampaign(t.id);
    if (!c) throw new ToolError('That campaign no longer exists.');
    if (!c.homebrew)
      throw new ToolError('This campaign’s system is no longer homebrew. Drop the request with skip_work.');
    const lines = await deskLines(t.id);
    const conversation = replayWindow(lines)
      .map((l) =>
        l.role === 'assistant' ? `  <gm>${escapeXml(l.content)}</gm>` : `  ${saidLine(l, c.owner_id)}`,
      )
      .join('\n');
    const waiting = actorsOf(item)
      .map((a) => a.displayName)
      .join(', ');
    return {
      text: [
        `Rules desk request ${item.id}. ${waiting || 'A player'} ${actorsOf(item).length > 1 ? 'are' : 'is'} waiting at the rules desk, out of character.`,
        `<rules_desk_role>\n${rulesDeskSystem(c, { forClaude: true })}\n</rules_desk_role>`,
        await deskContext(t.id),
        `<conversation>\n${conversation}\n</conversation>`,
        `Check and fix with the tools the desk allows, keep what is settled with record_ruling (work_id ${item.id}), ` +
          `then answer with reply_rules (work_id ${item.id}). The whole table reads it: nothing from your notebook, ` +
          'unrevealed secrets or DM-only documents.',
      ].join('\n\n'),
    };
  },

  async skipped(_item, reason, t) {
    await postDeskAnswer(t.id, `Claude could not answer this one: ${reason}`);
    t.room.broadcast({ type: 'rules' });
  },
});

// The desk's tool calls act for the players waiting there, so a fix cannot take from someone who is not.
setRequestContext('rules', (t, held) => t.room.requestContext(held.id, t.systemId, actorsOf(held)));

// The desk is shared by the whole table: a document search reads only what everyone may read.
gmVariant('search_documents', (input, t, held) => {
  if (held.kind !== 'rules') return null;
  const ctx = t.room.requestContext(held.id, t.systemId, actorsOf(held));
  return dispatchTool('search_documents', input, ctx, pgStore, systemRng, [searchPublicDocuments]);
});

// Every turn Claude is handed carries the rulings, so they survive a long or compacted conversation.
addTurnNote((t) => rulingsBlock(t.id));

/** The request Claude holds for the desk, if it passed one; else null for the host's own word. */
async function deskRequest(t: Table, workId: string | undefined): Promise<WorkItem | null> {
  if (workId) return heldRequest(t, workId, 'rules');
  if (await currentWork(t.id)) throw new ToolError('Pass the work_id of the rules desk request you hold.');
  return null;
}

async function requireHomebrew(t: Table): Promise<void> {
  if (!(await isHomebrew(t.id))) {
    throw new ToolError(
      'This campaign’s system is not homebrew, so it keeps no rulings. An admin can mark the system ' +
        'homebrew in the app’s rules library.',
    );
  }
}

const deskWorkId = workIdSchema
  .optional()
  .describe('The rules desk request you are answering. Leave it out when the host tells you directly.');

export const RULES_TOOLS: ConnectorTool[] = [
  own({
    name: 'reply_rules',
    description:
      'Answer at the rules desk. The whole table reads it in the app as the GM’s next message. Out of ' +
      'character, friendly and brief; say in a line what you recorded or fixed.',
    schema: z.object({
      work_id: workIdSchema,
      text: z.string().trim().min(1).max(4000).describe('Your answer to the table'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['rules'],
    async run(input, call) {
      const t = await openTable(call);
      const item = await heldRequest(t, input.work_id, 'rules');
      const { message, redacted } = await postDeskAnswer(t.id, input.text);
      t.room.dropRequestContext(item.id);
      await finishWork(item.id, { messageId: message.id });
      t.room.broadcast({ type: 'rules' });
      // Someone wrote while Claude worked: that is waiting next.
      const later = (await deskLines(t.id)).at(-1)?.role === 'user';
      if (later) {
        await queueWork({ campaignId: t.id, kind: 'rules', subjectId: t.id, requestedBy: item.requestedBy });
      }
      return `Sent.${redacted ? ' Part of it named a secret and was blacked out.' : ''}${later ? ' Someone wrote again meanwhile; it is waiting for you.' : ''} Call wait_for_work.`;
    },
  }),

  own({
    name: 'record_ruling',
    description:
      'Keep something settled with the table, so it is followed on every turn from now on: a house rule, ' +
      'direction for the campaign, or a correction of a call you got wrong. Only for what is agreed. To change ' +
      'a ruling, retire it and record the new version. At the rules desk pass its work_id; when the host tells ' +
      'you directly, leave work_id out.',
    schema: rulingSchema.extend({ work_id: deskWorkId }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['free', 'rules'],
    async run(input, call) {
      const t = await openTable(call);
      await requireHomebrew(t);
      const item = await deskRequest(t, input.work_id);
      const r = await recordRuling(t.id, {
        kind: input.kind,
        content: input.content,
        requestedBy: requesterOf(item, t),
      });
      t.room.broadcast({ type: 'rules' });
      return recordedLine(r);
    },
  }),

  own({
    name: 'retire_ruling',
    description:
      'Take a ruling out of force, when the table (or the host, telling you directly) agrees to drop or ' +
      'replace it. The ids are in the <rulings> list of a rules desk request, or in <house_rulings>.',
    schema: retireSchema.extend({ work_id: deskWorkId }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    during: ['free', 'rules'],
    async run(input, call) {
      const t = await openTable(call);
      await requireHomebrew(t);
      const item = await deskRequest(t, input.work_id);
      const r = await retireRuling(t.id, input.ruling, requesterOf(item, t));
      if (!r) throw new ToolError('There is no ruling in force with that id.');
      t.room.broadcast({ type: 'rules' });
      return `Retired. ${KIND_LABEL[r.kind]}: ${r.content}`;
    },
  }),
];

addTools(...RULES_TOOLS);
