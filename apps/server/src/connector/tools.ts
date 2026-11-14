import { z } from 'zod';
import { briefAndChanges, buildOpening, renderTurn, stateSnapshot } from '../agent/context.js';
import { systemRng } from '../agent/dice.js';
import { publicSummary } from '../agent/loop.js';
import { pgStore, type Actor, type TurnContext } from '../agent/store.js';
import { chronicleBacklog, saveChronicle } from '../agent/summarize.js';
import { dispatchTool, EDIT_SHEET, gmTools, TOOLS, ToolError } from '../agent/tools.js';
import { q, q1 } from '../db/pool.js';
import { log } from '../log.js';
import { infoOf, loadCampaign, openRoom, STATE_TOOLS, type Room } from '../realtime/room.js';
import type { DeskTurn } from './desk.js';
import { connectorGuide } from './instructions.js';
import { dmModeOf } from './mode.js';
import { setTokenCampaign, type ConnectorUser } from './tokens.js';

/** One tool call from the connector, with who is making it. */
export interface ConnectorCall {
  user: ConnectorUser;
  signal: AbortSignal;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  call(input: unknown, call: ConnectorCall): Promise<{ text: string; isError: boolean }>;
}

const jsonSchema = (schema: z.ZodType) => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return rest;
};

/** The longest a single take_turn waits before reporting back, inside the client's patience. */
const MAX_WAIT_SECONDS = 50;
const RECENT_MESSAGES = 12;

// ---------------------------------------------------------------- campaign

interface Table {
  id: string;
  name: string;
  phase: 'prep' | 'active';
  status: string;
  opened: boolean;
  systemId: string;
  gmSheets: boolean;
  room: Room;
}

/**
 * The campaign this client has open, checked again on every call: still
 * owned by the token's user, not archived, and set to be run from the app.
 */
async function openTable(user: ConnectorUser): Promise<Table> {
  if (!user.campaignId) throw new ToolError('No campaign is open. Call list_campaigns, then open_campaign.');
  const row = await q1<{
    name: string;
    phase: 'prep' | 'active';
    status: string;
    opened: boolean;
    system_id: string;
    settings: { dm?: unknown; sheets?: string };
  }>(
    `SELECT name, phase, status, opened_at IS NOT NULL AS opened, system_id, settings
       FROM campaigns WHERE id = $1`,
    [user.campaignId],
  );
  if (!row || row.status !== 'active') throw new ToolError('That campaign is archived. Open another one.');
  if (dmModeOf(row.settings) !== 'claude') {
    throw new ToolError(
      `"${row.name}" is run by the built-in DM. To run it from here, the owner opens the campaign in the app, ` +
        'then Manage → Dungeon Master → Claude app.',
    );
  }
  return {
    id: user.campaignId,
    name: row.name,
    phase: row.phase,
    status: row.status,
    opened: row.opened,
    systemId: row.system_id,
    gmSheets: row.settings.sheets === 'gm',
    room: await openRoom(user.campaignId),
  };
}

function requirePlay(t: Table): void {
  if (t.phase !== 'active') {
    throw new ToolError(
      'The campaign is still in the lobby. You can prepare (notebook, codex entries, scene), but turns start ' +
        'once the owner taps Begin the adventure in the app.',
    );
  }
}

/** Everyone at the table, so the state snapshot does not mark absent players as away. */
async function members(campaignId: string): Promise<Actor[]> {
  const [people, chars] = await Promise.all([
    q<{ id: string; display_name: string }>(
      `SELECT u.id, u.display_name FROM campaign_members m JOIN users u ON u.id = m.user_id WHERE m.campaign_id = $1`,
      [campaignId],
    ),
    pgStore.characters(campaignId),
  ]);
  return people.map((p) => ({
    userId: p.id,
    displayName: p.display_name,
    characterName: chars.find((c) => c.playerIds.includes(p.id))?.name ?? null,
  }));
}

async function recentPlay(campaignId: string): Promise<string> {
  const rows = await q<{
    kind: string;
    content: string;
    character_name: string | null;
    display_name: string | null;
  }>(
    `SELECT * FROM (
       SELECT m.id, m.kind, m.content, m.character_name, u.display_name
         FROM messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.campaign_id = $1 AND m.kind IN ('action', 'dm') ORDER BY m.id DESC LIMIT $2
     ) r ORDER BY r.id`,
    [campaignId, RECENT_MESSAGES],
  );
  return rows
    .map((r) =>
      r.kind === 'dm'
        ? `DM: ${r.content}`
        : `${r.display_name ?? 'AI companion'}${r.character_name ? ` (as ${r.character_name})` : ''}: ${r.content}`,
    )
    .join('\n\n');
}

async function chronicleNote(campaignId: string): Promise<string> {
  const due = await chronicleBacklog(campaignId).catch(() => null);
  return due
    ? `\n\nThe chronicle is due (${due.messages} messages unsummarised): call review_chronicle at the next lull.`
    : '';
}

function renderClaimed(t: DeskTurn, snapshot: string, note = ''): string {
  return [
    `Turn ${t.number} is yours to resolve.${note ? ` ${note}` : ''}`,
    snapshot,
    renderTurn(t.input),
    'Resolve every action with the tools, then post the scene with narrate. Keep your chat reply to the host to a line.',
  ].join('\n\n');
}

/** Where the turn being gathered stands, in words, for when no turn is ready yet. */
function describeWait(room: Room): string {
  const state = room.turnState();
  const name = (id: string) => state.seats.find((s) => s.id === id)?.name ?? 'someone';
  if (state.status === 'idle') {
    return (
      'No one has acted yet. Call take_turn again to keep waiting, or pass the host’s action if they want to ' +
      'start. Nobody in the app? The players need the campaign open to act.'
    );
  }
  if (state.status === 'collecting') {
    const waiting = state.expected.filter((id) => !state.acted.includes(id) && !state.passed.includes(id));
    const secs = state.deadline ? Math.max(0, Math.round((state.deadline - Date.now()) / 1000)) : null;
    return [
      `Turn ${state.number ?? ''} is gathering.`,
      state.acted.length ? `Acted: ${state.acted.map(name).join(', ')}.` : '',
      waiting.length ? `Waiting on: ${waiting.map(name).join(', ')}.` : '',
      secs !== null ? `It closes by itself in about ${secs}s.` : '',
      'Call take_turn again to keep waiting, or with close_now to resolve what is in.',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return 'The table is between turns. Call take_turn again in a moment.';
}

// ---------------------------------------------------------------- session tools

interface Spec<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  annotations: ToolAnnotations;
  run(input: z.infer<S>, call: ConnectorCall): Promise<string>;
}

function own<S extends z.ZodType>(spec: Spec<S>): ConnectorTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: jsonSchema(spec.schema),
    annotations: spec.annotations,
    async call(input, call) {
      const parsed = spec.schema.safeParse(input ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
          .join('; ');
        return { text: `Invalid arguments: ${issues}`, isError: true };
      }
      try {
        return { text: await spec.run(parsed.data, call), isError: false };
      } catch (err) {
        if (err instanceof ToolError) return { text: err.message, isError: true };
        throw err;
      }
    },
  };
}

const memory = z.object({
  kind: z.enum(['fact', 'thread', 'promise']).default('fact'),
  content: z.string().trim().min(3).max(400),
  importance: z.number().int().min(1).max(5).default(3),
});

export const SESSION_TOOLS: ConnectorTool[] = [
  own({
    name: 'list_campaigns',
    description: 'List the campaigns you own, with their phase and who runs their DM.',
    schema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(_input, { user }) {
      const rows = await q<{
        name: string;
        phase: string;
        system_name: string;
        settings: { dm?: unknown };
        opened: boolean;
      }>(
        `SELECT c.name, c.phase, s.name AS system_name, c.settings, c.opened_at IS NOT NULL AS opened
           FROM campaigns c
           JOIN campaign_members m ON m.campaign_id = c.id AND m.user_id = $1 AND m.role = 'owner'
           JOIN game_systems s ON s.id = c.system_id
          WHERE c.status = 'active' ORDER BY c.created_at`,
        [user.userId],
      );
      if (!rows.length)
        return 'You do not own any active campaigns. Create one in the Tavern Master app first.';
      return rows
        .map((r) => {
          const where =
            r.phase === 'prep' ? 'in the lobby' : r.opened ? 'in play' : 'ready for its opening scene';
          const dm =
            dmModeOf(r.settings) === 'claude'
              ? 'DM: this chat'
              : 'DM: built-in (switch it in the app to run it here)';
          return `- ${r.name} (${r.system_name}), ${where}. ${dm}`;
        })
        .join('\n');
    },
  }),

  own({
    name: 'open_campaign',
    description:
      'Open a campaign to run it. Returns your full DM instructions for it, your brief (notebook, durable facts, ' +
      'story so far), the party and world state, the latest play, and what to do next. Call this first in every chat.',
    schema: z.object({
      campaign: z.string().trim().min(1).max(80).describe('The campaign name (or its id)'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(input, { user }) {
      const owned = await q<{ id: string; name: string }>(
        `SELECT c.id, c.name FROM campaigns c
           JOIN campaign_members m ON m.campaign_id = c.id AND m.user_id = $1 AND m.role = 'owner'
          WHERE c.status = 'active' ORDER BY c.created_at`,
        [user.userId],
      );
      const want = input.campaign.toLowerCase();
      const hit =
        owned.find((c) => c.id === input.campaign) ??
        owned.find((c) => c.name.toLowerCase() === want) ??
        owned.find((c) => c.name.toLowerCase().startsWith(want));
      if (!hit) {
        throw new ToolError(
          `You own no active campaign called "${input.campaign}". Yours: ${owned.map((c) => c.name).join(', ') || 'none'}.`,
        );
      }
      await setTokenCampaign(user.tokenId, hit.id);
      user.campaignId = hit.id;
      const t = await openTable(user);
      const info = infoOf(t.id, await loadCampaign(t.id));
      const ctx: TurnContext = {
        campaignId: t.id,
        systemId: t.systemId,
        turnId: null,
        actors: await members(t.id),
        citations: [],
        rolls: [],
        stateChanged: false,
      };
      const [{ brief, changes }, snapshot, recent] = await Promise.all([
        briefAndChanges(t.id),
        stateSnapshot(ctx, pgStore),
        recentPlay(t.id),
      ]);

      let next: string;
      if (t.phase === 'prep') {
        next =
          'The campaign is still in the lobby: the players are making characters. You can prepare now with ' +
          'write_note, upsert_entity and set_scene. Turns start once the owner taps Begin the adventure in the app; ' +
          'after that, open the campaign again for the opening scene.';
      } else if (!t.opened) {
        const opening = await buildOpening(info, pgStore);
        const text = opening.messages[0]?.content.find((b) => b.type === 'text');
        next = `${text && 'text' in text ? text.text : ''}\n\nWhen the opening is ready, post it with narrate. Then call take_turn.`;
      } else if (t.room.desk.turn) {
        next = `Turn ${t.room.desk.turn.number} is already waiting for you. Call take_turn to pick it up.`;
      } else {
        next = 'Call take_turn to collect the next turn.';
      }

      return [
        `# ${info.name}`,
        `<dm_instructions>\n${connectorGuide(info)}\n</dm_instructions>`,
        brief ? `<brief>\n${brief}\n</brief>` : '',
        changes ? `<since_brief>\n${changes}\n</since_brief>` : '',
        snapshot,
        recent ? `<recent_play>\n${recent}\n</recent_play>` : '',
        `## What to do now\n${next}${await chronicleNote(t.id)}`,
      ]
        .filter(Boolean)
        .join('\n\n');
    },
  }),

  own({
    name: 'take_turn',
    description:
      'Collect the next gathered turn from the table. Waits up to wait_seconds for the players to act, then ' +
      'returns either the turn to resolve or who the table is still waiting on. Pass `action` to add the host’s ' +
      'own character action first, and close_now to stop waiting for the others.',
    schema: z.object({
      action: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .optional()
        .describe('What the host’s character does, if they play one'),
      character: z
        .string()
        .trim()
        .max(80)
        .optional()
        .describe('Which of the host’s characters acts, if they run several'),
      close_now: z.boolean().default(false).describe('Resolve the turn with the actions already in'),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(30),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(input, { user, signal }) {
      const t = await openTable(user);
      requirePlay(t);
      const room = t.room;
      const snapshotFor = async (turn: DeskTurn) => stateSnapshot(turn.ctx, pgStore);

      const held = room.desk.turn;
      if (held?.claimed) {
        const note = input.action
          ? 'You have not narrated it yet, so the host’s new action was not sent: narrate this turn, then send it.'
          : 'You claimed it earlier and have not narrated it yet.';
        return renderClaimed(held, await snapshotFor(held), note);
      }

      const notes: string[] = [];
      if (input.action) {
        const sent = await room.hostAction(
          { id: user.userId, displayName: user.displayName },
          input.action,
          input.character,
        );
        if ('error' in sent) throw new ToolError(sent.error);
        notes.push(
          sent.where === 'queued'
            ? `The host’s action (as ${sent.as}) is held for the turn after this one.`
            : `The host’s action is in, as ${sent.as}.`,
        );
      }
      if (input.close_now) room.force();

      const turn = await room.desk.waitForTurn(input.wait_seconds * 1000, signal);
      if (turn) {
        room.claimForOutsideDm();
        return renderClaimed(turn, await snapshotFor(turn), notes.join(' '));
      }
      return [...notes, describeWait(room)].join(' ');
    },
  }),

  own({
    name: 'narrate',
    description:
      'Post narration to the table. This is the only thing the players see. It answers the turn you took with ' +
      'take_turn, or, before the campaign has opened, it is the opening scene. Write it in full: the vivid ' +
      'narration, with [R#] citations and [[codex]] links as your instructions describe. Unrevealed secrets in ' +
      'it are blacked out before anyone sees them.',
    schema: z.object({
      text: z.string().trim().min(1).max(8000).describe('The narration, as the players will read it'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(input, { user }) {
      const t = await openTable(user);
      requirePlay(t);
      const done = await t.room.narrateFromOutside(input.text);
      const redacted =
        'redacted' in done && done.redacted
          ? ' Part of it named a secret the party has not discovered and was blacked out; call reveal_secret first when the story reveals one.'
          : '';
      switch (done.kind) {
        case 'turn':
          return `Posted turn ${done.number} to the table.${redacted}${await chronicleNote(t.id)} Call take_turn for the next one.`;
        case 'opening':
          return `Posted the opening scene.${redacted} Call take_turn to collect the players’ first turn.`;
        case 'nothing':
          throw new ToolError(
            done.turnWaiting
              ? 'A turn is waiting but you have not taken it. Call take_turn first, then narrate it.'
              : 'There is no turn to narrate. Call take_turn to collect the players’ next actions.',
          );
      }
    },
  }),

  own({
    name: 'review_chronicle',
    description:
      'Get the stretch of play that is due to be summarised, with instructions for the summary. Then store it with ' +
      'save_chronicle. Do this when a tool result says the chronicle is due.',
    schema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(_input, { user }) {
      const t = await openTable(user);
      const due = await chronicleBacklog(t.id, true);
      if (!due) return 'Nothing is due: the chronicle is up to date.';
      return `${due.text}\n\nWrite the summary and up to five durable memories, then call save_chronicle with through_message = ${due.throughId}.`;
    },
  }),

  own({
    name: 'save_chronicle',
    description:
      'Store the summary you wrote from review_chronicle. It replaces that stretch of play in your brief.',
    schema: z.object({
      through_message: z.number().int().positive().describe('The number review_chronicle gave you'),
      summary: z.string().trim().min(80).max(3000),
      memories: z.array(memory).max(5).default([]),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(input, { user }) {
      const t = await openTable(user);
      const n = await saveChronicle(t.id, input.through_message, input.summary, input.memories);
      return n
        ? `Stored. ${n} messages are now covered by the chronicle.`
        : 'That stretch was already summarised.';
    },
  }),
];

// ---------------------------------------------------------------- the GM's own tools

const READ_ONLY = new Set(['get_state', 'lookup_rules', 'recall', 'search_documents', 'search_setting']);

/**
 * The built-in DM's tools, unchanged: same validation, same rules about whose
 * character can be hurt or robbed, same records. They run against the turn the
 * client has claimed, and the table sees the same public notes about each call
 * as it does with the built-in DM.
 */
function gmTool(spec: (typeof TOOLS)[number]): ConnectorTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: jsonSchema(spec.schema),
    annotations: {
      readOnlyHint: READ_ONLY.has(spec.name),
      destructiveHint: false,
      openWorldHint: false,
    },
    async call(input, { user }) {
      let t: Table;
      try {
        t = await openTable(user);
      } catch (err) {
        if (err instanceof ToolError) return { text: err.message, isError: true };
        throw err;
      }
      if (spec.name === EDIT_SHEET.name && !t.gmSheets) {
        return {
          text: 'The players keep the character sheets at this table, so edit_sheet is not available.',
          isError: true,
        };
      }
      const opening = t.phase === 'active' && !t.opened;
      const { ctx, streamId } = t.room.outsideContext(t.systemId, opening);
      const out = await dispatchTool(
        spec.name,
        input,
        ctx,
        pgStore,
        systemRng,
        gmTools({ sheets: t.gmSheets }),
      );
      if (!out.isError) {
        if (streamId) {
          t.room.broadcast({
            type: 'dm_tool',
            turnId: streamId,
            tool: spec.name,
            summary: publicSummary(spec.name, input, out.content),
          });
        }
        if (STATE_TOOLS.has(spec.name)) t.room.broadcast({ type: 'state_changed' });
      }
      return { text: out.content, isError: out.isError };
    },
  };
}

export const CONNECTOR_TOOLS: ConnectorTool[] = [...SESSION_TOOLS, ...[...TOOLS, EDIT_SHEET].map(gmTool)];

export async function runConnectorTool(
  name: string,
  input: unknown,
  call: ConnectorCall,
): Promise<{ text: string; isError: boolean }> {
  const tool = CONNECTOR_TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `Unknown tool "${name.slice(0, 40)}".`, isError: true };
  try {
    return await tool.call(input, call);
  } catch (err) {
    log().error({ err, tool: name, tokenId: call.user.tokenId }, 'connector tool failed');
    return { text: 'Something went wrong on the server. Try again in a moment.', isError: true };
  }
}
