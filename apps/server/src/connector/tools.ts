import { z } from 'zod';
import { briefAndChanges, buildOpening, renderTurn, stateSnapshot } from '../agent/context.js';
import { systemRng } from '../agent/dice.js';
import { publicSummary } from '../agent/loop.js';
import { pgStore, type TurnContext } from '../agent/store.js';
import { dispatchTool, EDIT_SHEET, gmTools, TOOLS } from '../agent/tools.js';
import { config } from '../config.js';
import { q, q1 } from '../db/pool.js';
import { log } from '../log.js';
import { getRoom, infoOf, loadCampaign, STATE_TOOLS, type Room } from '../realtime/room.js';
import type { DeskTurn } from './desk.js';
import { handlerFor, type WorkView } from './handlers.js';
import { connectorGuide } from './instructions.js';
import { dmModeOf } from './mode.js';
import { setTokenCampaign } from './tokens.js';
import {
  campaignOf,
  gateAllows,
  jsonSchema,
  members,
  openTable,
  own,
  requirePlay,
  ToolError,
  workIdSchema,
  type ConnectorCall,
  type ConnectorTool,
  type Gate,
  type Table,
  type ToolOutput,
} from './toolkit.js';
import {
  claimNext,
  currentWork,
  dropWork,
  failWork,
  getWork,
  lastFinishedAt,
  openWork,
  releaseStale,
  type WorkItem,
} from './work.js';

export type { ConnectorCall, ConnectorTool } from './toolkit.js';

const RECENT_MESSAGES = 12;

// ---------------------------------------------------------------- what Claude is shown

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

/** What the outside DM already did for a turn, so a turn handed out again is not resolved twice. */
async function alreadyApplied(turnId: string): Promise<string[]> {
  const rows = await q<{ summary: string }>(
    'SELECT summary FROM state_events WHERE turn_id = $1 ORDER BY id',
    [turnId],
  );
  return rows.map((r) => r.summary);
}

/** Extra lines a turn carries, added by later features (own-AI companions that have not acted). */
type TurnNote = (t: Table, turn: DeskTurn) => Promise<string>;
const turnNotes: TurnNote[] = [];
export function addTurnNote(note: TurnNote): void {
  turnNotes.push(note);
}

async function renderClaimed(t: Table, turn: DeskTurn, note = ''): Promise<string> {
  const [snapshot, applied, extra] = await Promise.all([
    stateSnapshot(turn.ctx, pgStore),
    alreadyApplied(turn.id),
    Promise.all(turnNotes.map((n) => n(t, turn))),
  ]);
  return [
    `Turn ${turn.number} is yours to resolve.${note ? ` ${note}` : ''}`,
    snapshot,
    renderTurn(turn.input),
    applied.length
      ? `Already applied this turn (do not repeat):\n${applied.map((s) => `- ${s}`).join('\n')}`
      : '',
    ...extra,
    'Resolve every action with the tools, then post the scene with narrate.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The opening-scene instructions, for a campaign that has begun but has no opening yet. */
async function openingText(t: Table): Promise<string> {
  const info = infoOf(t.id, await loadCampaign(t.id));
  const opening = await buildOpening(info, pgStore);
  const block = opening.messages[0]?.content.find((b) => b.type === 'text');
  return `${block && 'text' in block ? block.text : ''}\n\nPost it with narrate.`;
}

/** Where the turn being gathered stands, in words, for when there is nothing to hand out. */
function describeWait(room: Room): string {
  const state = room.turnState();
  const name = (id: string) => state.seats.find((s) => s.id === id)?.name ?? 'someone';
  if (state.status === 'idle') return 'No one has acted yet.';
  if (state.status === 'collecting') {
    const waiting = state.expected.filter((id) => !state.acted.includes(id) && !state.passed.includes(id));
    const secs = state.deadline ? Math.max(0, Math.round((state.deadline - Date.now()) / 1000)) : null;
    return [
      `Turn ${state.number ?? ''} is gathering.`,
      state.acted.length ? `Acted: ${state.acted.map(name).join(', ')}.` : '',
      waiting.length ? `Waiting on: ${waiting.map(name).join(', ')}.` : '',
      secs !== null ? `It closes by itself in about ${secs}s, or now with close_turn.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return 'The table is between turns.';
}

/** Minutes since the table last did anything: a player spoke, or Claude finished a request. */
async function quietMinutes(campaignId: string): Promise<number> {
  const row = await q1<{ at: Date | null }>(
    `SELECT max(created_at) AS at FROM messages WHERE campaign_id = $1 AND kind IN ('action', 'ooc')`,
    [campaignId],
  );
  const finished = await lastFinishedAt(campaignId);
  const last = Math.max(row?.at?.getTime() ?? 0, finished?.getTime() ?? 0);
  return last ? Math.floor((Date.now() - last) / 60_000) : Number.POSITIVE_INFINITY;
}

/** The list of what is open for Claude, for open_campaign. */
async function waitingBlock(t: Table): Promise<string> {
  const lines: string[] = [];
  if (t.phase === 'active' && !t.opened) lines.push('- The opening scene.');
  const turn = t.room.desk.turn;
  if (turn)
    lines.push(`- Turn ${turn.number}${turn.claimed ? ', claimed by you and not yet narrated' : ''}.`);
  for (const item of await openWork(t.id)) {
    lines.push(
      `- ${handlerFor(item.kind).label(item)} (${item.kind}, id ${item.id})${item.status === 'claimed' ? ', claimed by you' : ''}.`,
    );
  }
  return lines.length ? `<waiting>\n${lines.join('\n')}\n</waiting>` : '';
}

/** Show Claude a request, preparing it first when it was just claimed. Null when it turned out moot. */
async function viewWork(t: Table, item: WorkItem, fresh: boolean): Promise<WorkView | null> {
  const handler = handlerFor(item.kind);
  let current: WorkItem | null = item;
  if (fresh && handler.prepare) {
    try {
      current = await handler.prepare(item, t);
    } catch (err) {
      log().warn({ err, workId: item.id, kind: item.kind }, 'could not prepare DM work');
      await failWork(item.id, 'The server could not prepare this request.');
      return null;
    }
    if (!current) {
      await dropWork(item.id);
      return null;
    }
  }
  return handler.render(current, t);
}

/** Steps 5 to 7 of wait_for_work: the opening, a gathered turn, or the next request. */
async function nextThing(t: Table): Promise<ToolOutput | null> {
  if (t.phase === 'active' && !t.opened) {
    const still = await q1<{ opened: boolean }>(
      'SELECT opened_at IS NOT NULL AS opened FROM campaigns WHERE id = $1',
      [t.id],
    );
    if (!still?.opened) return { text: await openingText(t), isError: false };
  }
  if (t.phase === 'active' && t.room.desk.turn) {
    const turn = t.room.claimForOutsideDm();
    if (turn) return { text: await renderClaimed(t, turn), isError: false };
  }
  // A moot request is dropped and the next one tried, a few times at most.
  for (let i = 0; i < 5; i++) {
    const next = await claimNext(t.id);
    if (!next) return null;
    const view = await viewWork(t, next.item, next.fresh);
    if (view) return { text: view.text, images: view.images, isError: false };
  }
  return null;
}

/** Everything Claude needs to run a campaign, as open_campaign (and create_campaign) return it. */
export async function campaignBrief(t: Table): Promise<string> {
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
  const [{ brief, changes }, snapshot, recent, waiting] = await Promise.all([
    briefAndChanges(t.id),
    stateSnapshot(ctx, pgStore),
    recentPlay(t.id),
    waitingBlock(t),
  ]);

  let next: string;
  if (t.phase === 'prep') {
    next =
      'The campaign is still in the lobby: the players are making characters. You can prepare now with ' +
      'write_note, upsert_entity and set_scene, and help build the party with save_character. Turns start ' +
      'once it begins (begin_adventure, or Begin the adventure in the app).';
  } else if (!t.opened) {
    next = `${await openingText(t)}`;
  } else if (t.room.desk.turn) {
    next = `Turn ${t.room.desk.turn.number} is waiting for you.`;
  } else {
    next = 'The table is in play.';
  }

  return [
    `# ${info.name}`,
    `<dm_instructions>\n${connectorGuide(info)}\n</dm_instructions>`,
    brief ? `<brief>\n${brief}\n</brief>` : '',
    changes ? `<since_brief>\n${changes}\n</since_brief>` : '',
    snapshot,
    recent ? `<recent_play>\n${recent}\n</recent_play>` : '',
    waiting,
    `## What to do now\n${next}\n\nCall wait_for_work.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------- session tools

export const SESSION_TOOLS: ConnectorTool[] = [
  own({
    name: 'list_campaigns',
    description: 'List the campaigns you own, with their phase, who runs them and how much is waiting.',
    schema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    during: ['any'],
    async run(_input, { user }) {
      const rows = await q<{
        name: string;
        phase: string;
        system_name: string;
        settings: { dm?: unknown };
        opened: boolean;
        waiting: number;
      }>(
        `SELECT c.name, c.phase, s.name AS system_name, c.settings, c.opened_at IS NOT NULL AS opened,
                (SELECT count(*)::int FROM dm_work w
                  WHERE w.campaign_id = c.id AND w.status IN ('waiting', 'claimed')) AS waiting
           FROM campaigns c
           JOIN campaign_members m ON m.campaign_id = c.id AND m.user_id = $1 AND m.role = 'owner'
           JOIN game_systems s ON s.id = c.system_id
          WHERE c.status = 'active' ORDER BY c.created_at`,
        [user.userId],
      );
      if (!rows.length)
        return 'You do not own any active campaigns. Create one with list_systems and create_campaign, or in the Tavern Master app.';
      return rows
        .map((r) => {
          const where =
            r.phase === 'prep' ? 'in the lobby' : r.opened ? 'in play' : 'ready for its opening scene';
          const dm =
            dmModeOf(r.settings) === 'claude'
              ? `DM: you. waiting: ${r.waiting}`
              : 'DM: built-in AI (switch it in the app to run it here)';
          return `- ${r.name} (${r.system_name}), ${where}. ${dm}`;
        })
        .join('\n');
    },
  }),

  own({
    name: 'open_campaign',
    description:
      'Open a campaign to run it. Returns your full instructions for it, your brief (notebook, durable facts, ' +
      'story so far), the party and world state, the latest play, what is waiting for you, and what to do next. ' +
      'Call this first in every conversation.',
    schema: z.object({
      campaign: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .optional()
        .describe('The campaign name (or its id). Optional when this connection is for one campaign.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    during: ['any'],
    async run(input, call) {
      const { user } = call;
      if (call.pinned) {
        const pinned = await q1<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [
          call.campaignId,
        ]);
        const want = input.campaign?.toLowerCase();
        if (want && want !== call.campaignId && !pinned?.name.toLowerCase().startsWith(want)) {
          throw new ToolError(`This connection is for "${pinned?.name ?? 'one campaign'}" only.`);
        }
      } else {
        if (!input.campaign) throw new ToolError('Say which campaign: call list_campaigns to see yours.');
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
      }
      return campaignBrief(await openTable(call));
    },
  }),

  own({
    name: 'wait_for_work',
    description:
      'Get the next thing that needs you at this table: a gathered turn, the opening scene, a player waiting on ' +
      'the character guide, an uploaded sheet to read, a document to catalogue, or the chronicle. Waits up to ' +
      'wait_seconds when nothing is ready. Handle what it returns, then call it again.',
    schema: z.object({
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .optional()
        .describe('How long to wait for something to arrive. Defaults to the longest the server allows.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['any'],
    async run(input, call) {
      const t = await openTable(call);
      const room = t.room;
      await releaseStale(t.id);

      // Something already in hand comes back first, so nothing is left half done.
      const held = room.desk.turn;
      if (held?.claimed) {
        return renderClaimed(t, held, 'You claimed this turn earlier and have not narrated it.');
      }
      const work = await currentWork(t.id);
      if (work) {
        const view = await viewWork(t, work, false);
        if (view) return view;
      }

      const ready = await nextThing(t);
      if (ready) return ready;

      const max = config().CONNECTOR_MAX_WAIT_SECONDS;
      const wait = Math.min(input.wait_seconds ?? max, max);
      if (wait > 0) {
        room.touchDm('start');
        try {
          await room.desk.waitForTurn(wait * 1000, call.signal);
        } finally {
          room.touchDm('end');
        }
        const fresh = await openTable(call);
        const after = await nextThing(fresh);
        if (after) return after;
      }

      const players = room.present().length;
      const quiet = await quietMinutes(t.id);
      const quietText = Number.isFinite(quiet) ? `Quiet for ${quiet} min.` : 'Nothing has happened yet.';
      const empty =
        players === 0 && quiet >= config().CONNECTOR_IDLE_MINUTES
          ? ' The table is empty. Stop calling wait_for_work and tell the host in one line.'
          : '';
      const lobby = t.phase === 'prep' ? 'The campaign is in the lobby.' : describeWait(room);
      return `Nothing for you yet. ${lobby} Players connected: ${players}. ${quietText}${empty}`;
    },
  }),

  own({
    name: 'host_action',
    description:
      'Send what the host’s own character does to the table, as if they had typed it in the app. Use this when ' +
      'the host, talking to you, describes their character acting.',
    schema: z.object({
      action: z.string().trim().min(1).max(2000).describe('What the host’s character does'),
      character: z
        .string()
        .trim()
        .max(80)
        .optional()
        .describe('Which of the host’s characters acts, if they run several'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['free'],
    async run(input, call) {
      const t = await openTable(call);
      requirePlay(t);
      const sent = await t.room.hostAction(
        { id: call.user.userId, displayName: call.user.displayName },
        input.action,
        input.character,
      );
      if ('error' in sent) throw new ToolError(sent.error);
      return sent.where === 'queued'
        ? `The host’s action (as ${sent.as}) is held for the turn after this one.`
        : `The host’s action is in, as ${sent.as}. ${describeWait(t.room)}`;
    },
  }),

  own({
    name: 'close_turn',
    description: 'Stop waiting for the rest of the table and resolve the turn with the actions already in.',
    schema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['free'],
    async run(_input, call) {
      const t = await openTable(call);
      requirePlay(t);
      if (t.room.turnState().status !== 'collecting') return `Nothing to close. ${describeWait(t.room)}`;
      t.room.force();
      return 'The turn is closed. Call wait_for_work to take it.';
    },
  }),

  own({
    name: 'narrate',
    description:
      'Post narration to the table. This is the only thing the players see. It answers the turn you took with ' +
      'wait_for_work, or, before the campaign has opened, it is the opening scene. Write it in full: the vivid ' +
      'narration, with [R#] citations and [[codex]] links as your instructions describe. Unrevealed secrets in ' +
      'it are blacked out before anyone sees them.',
    schema: z.object({
      text: z.string().trim().min(1).max(8000).describe('The narration, as the players will read it'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    during: ['free'],
    async run(input, call) {
      const t = await openTable(call);
      requirePlay(t);
      const done = await t.room.narrateFromOutside(input.text);
      const redacted =
        'redacted' in done && done.redacted
          ? ' Part of it named a secret the party has not discovered and was blacked out; call reveal_secret first when the story reveals one.'
          : '';
      switch (done.kind) {
        case 'turn':
          await afterNarration(t.id);
          return `Posted turn ${done.number} to the table.${redacted} Call wait_for_work.`;
        case 'opening':
          return `Posted the opening scene.${redacted} Call wait_for_work.`;
        case 'nothing':
          throw new ToolError(
            done.turnWaiting
              ? 'A turn is waiting but you have not taken it. Call wait_for_work first, then narrate it.'
              : 'There is no turn to narrate. Call wait_for_work for the next one.',
          );
      }
    },
  }),

  own({
    name: 'skip_work',
    description:
      'Drop a request you cannot or should not do, with a reason the player who asked will read. Use it for ' +
      'an unreadable sheet, a request that makes no sense, or one you were handed by mistake.',
    schema: z.object({
      work_id: workIdSchema,
      reason: z.string().trim().min(3).max(200).describe('Why, in a sentence the player can read'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['any'],
    async run(input, call) {
      const t = await openTable(call);
      const item = await getWork(input.work_id);
      if (!item || item.campaignId !== t.id) throw new ToolError('There is no such request at this table.');
      if (item.status !== 'waiting' && item.status !== 'claimed')
        throw new ToolError('That request is already settled.');
      await failWork(item.id, input.reason);
      await handlerFor(item.kind)
        .skipped?.(item, input.reason, t)
        .catch((err) => log().warn({ err, workId: item.id }, 'could not report a skipped request'));
      return 'Dropped. Call wait_for_work.';
    },
  }),
];

/** Hooks run after a turn is narrated (the chronicle queues itself here). */
const narrationHooks: ((campaignId: string) => Promise<void>)[] = [];
export function afterNarrationHook(fn: (campaignId: string) => Promise<void>): void {
  narrationHooks.push(fn);
}
async function afterNarration(campaignId: string): Promise<void> {
  for (const hook of narrationHooks)
    await hook(campaignId).catch((err) => log().warn({ err, campaignId }, 'after-narration hook failed'));
}

// ---------------------------------------------------------------- the GM's own tools

const READ_ONLY = new Set(['get_state', 'lookup_rules', 'recall', 'search_documents', 'search_setting']);
/** GM tools that also help a guide request: rolling and reading the rules. */
const GUIDE_TOO = new Set(['roll_dice', 'lookup_rules', 'search_documents']);

/** Replaces a GM tool while a request of some kind is held, e.g. a table-only document search for the guide. */
type Variant = (
  input: unknown,
  t: Table,
  held: WorkItem,
) => Promise<{ content: string; isError: boolean }> | null;
const variants = new Map<string, Variant>();
export function gmVariant(name: string, variant: Variant): void {
  variants.set(name, variant);
}

/** The context a GM tool call runs in for a request Claude holds, e.g. the guide's dice. */
type RequestContext = (t: Table, held: WorkItem) => TurnContext | null;
let requestContext: RequestContext = () => null;
export function setRequestContext(fn: RequestContext): void {
  requestContext = fn;
}

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
    during: GUIDE_TOO.has(spec.name) ? ['free', 'guide'] : ['free'],
    async call(input, call) {
      let t: Table;
      try {
        t = await openTable(call);
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
      const held = await currentWork(t.id);
      if (held) {
        const variant = variants.get(spec.name)?.(input, t, held);
        if (variant) {
          const out = await variant;
          return { text: out.content, isError: out.isError };
        }
      }
      const opening = t.phase === 'active' && !t.opened;
      const reqCtx = held ? requestContext(t, held) : null;
      const { ctx, streamId } = reqCtx
        ? { ctx: reqCtx, streamId: null }
        : t.room.outsideContext(t.systemId, opening);
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

const extraTools: ConnectorTool[] = [];
/** Tools for a kind of request, registered by the module that handles it. */
export function addTools(...tools: ConnectorTool[]): void {
  extraTools.push(...tools);
}

export function connectorTools(): ConnectorTool[] {
  return [...SESSION_TOOLS, ...extraTools, ...[...TOOLS, EDIT_SHEET].map(gmTool)];
}

const refusal = (held: WorkItem) =>
  `Finish the open request first (${held.kind}, id ${held.id}), or skip it with skip_work.`;

async function campaignName(id: string): Promise<string | null> {
  return (await q1<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [id]))?.name ?? null;
}

export async function runConnectorTool(
  name: string,
  input: unknown,
  call: ConnectorCall,
): Promise<ToolOutput> {
  const tool = connectorTools().find((t) => t.name === name);
  if (!tool) return { text: `Unknown tool "${name.slice(0, 40)}".`, isError: true };
  let out: ToolOutput;
  try {
    out = await gated(tool, input, call);
  } catch (err) {
    log().error({ err, tool: name, tokenId: call.user.tokenId }, 'connector tool failed');
    out = { text: 'Something went wrong on the server. Try again in a moment.', isError: true };
  }
  // On the account-wide address another chat may have opened a different campaign since.
  if (!call.pinned) {
    const id = campaignOf(call);
    const label = id ? await campaignName(id).catch(() => null) : null;
    if (label) out = { ...out, text: `[${label}]\n${out.text}` };
  }
  return out;
}

async function gated(tool: ConnectorTool, input: unknown, call: ConnectorCall): Promise<ToolOutput> {
  const id = campaignOf(call);
  if (id && !tool.during.includes('any')) {
    const held = await currentWork(id);
    const turnClaimed = !!getRoom(id)?.desk.turn?.claimed;
    if (!gateAllows(tool.during, held?.kind ?? null, turnClaimed)) {
      if (held) return { text: refusal(held), isError: true };
      return {
        text: tool.during.includes('turn')
          ? 'This tool works only while you hold a turn. Call wait_for_work.'
          : `This tool belongs to a request you do not hold. Call wait_for_work.`,
        isError: true,
      };
    }
  }
  return tool.call(input, call);
}

export type { Gate };
