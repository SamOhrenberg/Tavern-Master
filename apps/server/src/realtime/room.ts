import type {
  DmMode,
  DmStatus,
  RollKind,
  ServerMessage,
  SettingLore,
  TurnSeat,
  TurnState,
  UserRef,
} from '@tavern/protocol';
import type { WebSocket } from 'ws';
import { refreshBrief } from '../agent/brief.js';
import { resolveRefs } from '../agent/codex.js';
import { companionOrder, companionTurn, knownEntries, publicStory } from '../agent/companion.js';
import {
  buildOpening,
  buildPrompt,
  COMPANION_LABEL,
  type CampaignInfo,
  type TurnAction,
  type TurnInput,
} from '../agent/context.js';
import { redactSecrets, runAgentTurn, usedCitations } from '../agent/loop.js';
import { pgStore, type Actor, type CharRow, type TurnContext } from '../agent/store.js';
import { maybeQueueSummary, queueChronicleIfDue } from '../agent/summarize.js';
import { gmTools } from '../agent/tools.js';
import { config } from '../config.js';
import { DmDesk } from '../connector/desk.js';
import { dmMode, dmModeOf } from '../connector/mode.js';
import { presenceOf } from '../connector/presence.js';
import { queueWork } from '../connector/work.js';
import { q, q1, tx } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { LlmNotConfigured, resolveLlm } from '../llm/index.js';
import { polishNarration } from '../llm/polish.js';
import { budgetBlock, recordUsage } from '../llm/usage.js';
import { log } from '../log.js';
import { conflict } from '../errors.js';
import { snapshotState } from '../rewind.js';
import { getMessage, insertMessage } from './messages.js';
import { buildPlayerRoll } from './rolls.js';
import { TurnCollector, type ClosedTurn, type CollectedAction } from './turns.js';

/** Seat ids for a line a player spoke for a companion start with this. */
const VOICED = 'v:';

const SESSION_GAP_HOURS = 6;
/**
 * DM tools that change a message already posted. The one message is sent again,
 * the way a host's edit is, so nobody's screen reloads and loses its place.
 */
export const HISTORY_TOOLS = new Set(['correct_narration']);
export const STATE_TOOLS = new Set([
  'request_roll',
  'delete_entity',
  'update_character',
  'modify_inventory',
  'edit_sheet',
  'upsert_entity',
  'reveal_secret',
  'set_flag',
  'set_scene',
]);
/** Stands in for a turn id while the DM writes the opening scene. */
const OPENING = 'opening';
/** A room kept open only for an outside DM is forgotten after this long without a call. */
const DM_IDLE_MS = 15 * 60_000;
/** dm_seen_at is written at most this often. */
const SEEN_WRITE_MS = 30_000;
/** Longest one own-AI companion may take over its action. */
const COMPANION_TIMEOUT_MS = 45_000;
/** Longest all of them together may take; companions after that sit the turn out. */
const COMPANIONS_BUDGET_MS = 120_000;

/** How long after a connector call an outside DM still counts as listening. */
const listenMs = () => (config().CONNECTOR_MAX_WAIT_SECONDS + 25) * 1000;
const claimTimeoutMs = () => config().CONNECTOR_CLAIM_TIMEOUT_MINUTES * 60_000;

/** What the database says about a campaign's outside DM, for when no room is open. */
interface DmFacts {
  seenAt: Date | null;
  openWork: number;
  workClaimed: boolean;
  needsOpening: boolean;
}

async function loadDmFacts(campaignId: string): Promise<DmFacts> {
  const row = await q1<{
    seen: Date | null;
    open: number;
    claimed: boolean;
    needs_opening: boolean;
  }>(
    `SELECT c.dm_seen_at AS seen,
            c.phase = 'active' AND c.status = 'active' AND c.opened_at IS NULL AS needs_opening,
            (SELECT count(*)::int FROM dm_work w
              WHERE w.campaign_id = c.id AND w.status IN ('waiting', 'claimed')) AS open,
            EXISTS (SELECT 1 FROM dm_work w WHERE w.campaign_id = c.id AND w.status = 'claimed') AS claimed
       FROM campaigns c WHERE c.id = $1`,
    [campaignId],
  );
  return {
    seenAt: row?.seen ?? null,
    openWork: row?.open ?? 0,
    workClaimed: row?.claimed ?? false,
    needsOpening: row?.needs_opening ?? false,
  };
}

interface ActiveTurn {
  id: string;
  number: number;
  sessionId: string;
}

export interface CampaignRow {
  name: string;
  premise: string;
  settings: { tone?: string; sheets?: 'players' | 'gm'; dm?: string; polishWith?: string };
  owner_id: string;
  system_id: string;
  system_name: string;
  lore: SettingLore | null;
  lore_status: string;
  homebrew: boolean;
  gm_instructions: string;
  outside_ais: { name: string; note: string }[];
}

/** The outside AI a campaign polishes its narration with ('' for none), and its tone. */
async function polishSettings(campaignId: string): Promise<{ with: string; tone: string }> {
  const row = await q1<{ settings: CampaignRow['settings'] }>(
    'SELECT settings FROM campaigns WHERE id = $1',
    [campaignId],
  );
  return { with: row?.settings.polishWith?.trim() ?? '', tone: row?.settings.tone ?? '' };
}

/** What the people at the table wrote this turn, as opposed to AI companions. */
function playerLines(input: TurnInput): string[] {
  return input.actions.filter((a) => a.userId).map((a) => a.text);
}

export async function loadCampaign(campaignId: string): Promise<CampaignRow> {
  const row = await q1<CampaignRow>(
    `SELECT c.name, c.premise, c.settings, c.owner_id, c.system_id,
            s.name AS system_name, s.lore, s.lore_status, s.homebrew, s.gm_instructions,
            (SELECT coalesce(json_agg(json_build_object('name', a.name, 'note', a.note) ORDER BY lower(a.name)), '[]')
               FROM outside_ais a) AS outside_ais
       FROM campaigns c JOIN game_systems s ON s.id = c.system_id WHERE c.id = $1`,
    [campaignId],
  );
  if (!row) throw new Error('campaign not found');
  return row;
}

export const infoOf = (id: string, c: CampaignRow): CampaignInfo => ({
  id,
  name: c.name,
  premise: c.premise,
  tone: c.settings.tone ?? '',
  systemName: c.system_name,
  gmSheets: c.settings.sheets === 'gm',
  // Only lean on the voice once it has actually been read.
  lore: c.lore_status === 'ready' ? c.lore : null,
  homebrew: c.homebrew,
  gmInstructions: c.gm_instructions,
  outsideAis: c.outside_ais,
  polishWith: c.settings.polishWith?.trim() || undefined,
});

/** Find the open play session, or start the first or next one. A session ends only through endSession. */
async function ensureSession(campaignId: string): Promise<string> {
  const open = await q1<{ id: string }>(
    'SELECT id FROM play_sessions WHERE campaign_id = $1 AND ended_at IS NULL ORDER BY number DESC LIMIT 1',
    [campaignId],
  );
  if (open) return open.id;
  const row = await q1<{ id: string }>(
    `INSERT INTO play_sessions (campaign_id, number)
     VALUES ($1, (SELECT coalesce(max(number), 0) + 1 FROM play_sessions WHERE campaign_id = $1)) RETURNING id`,
    [campaignId],
  );
  return row!.id;
}

/**
 * Close a session and have it chronicled. With `rest` the table also goes
 * to the recap: play stops until everyone has readied up and the host
 * starts the next session. All of that is one change, so a failure leaves
 * the session open rather than half closed.
 */
export async function endSession(
  campaignId: string,
  sessionId: string,
  opts: { rest?: boolean } = {},
): Promise<void> {
  await tx(async (client) => {
    await q(
      'UPDATE play_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL',
      [sessionId],
      client,
    );
    if (opts.rest) {
      await q('UPDATE campaigns SET resting_since = now() WHERE id = $1', [campaignId], client);
      await q('UPDATE campaign_members SET ready_at = NULL WHERE campaign_id = $1', [campaignId], client);
    }
  });
  if ((await dmMode(campaignId)) === 'server') {
    await enqueue('summarize_campaign', { campaignId, sessionId });
    return;
  }
  // With Claude the server calls no model: Claude summarises the session, and whatever else is due.
  await queueWork({ campaignId, kind: 'chronicle', subjectId: `session:${sessionId}` });
  await queueChronicleIfDue(campaignId);
}

/**
 * A session left open and untouched for SESSION_GAP_HOURS is over: the table
 * went home without ending it. It is closed and sent to the recap like any
 * other, so a return the next week starts with the recap and the ready check.
 */
export async function endIfStale(campaignId: string): Promise<boolean> {
  const stale = await q1<{ id: string }>(
    `SELECT s.id FROM play_sessions s
      WHERE s.campaign_id = $1 AND s.ended_at IS NULL
        AND greatest(coalesce((SELECT max(created_at) FROM messages WHERE session_id = s.id), s.started_at),
                     coalesce(s.resumed_at, s.started_at))
              <= now() - make_interval(hours => $2)
      ORDER BY s.number DESC LIMIT 1`,
    [campaignId, SESSION_GAP_HOURS],
  );
  if (!stale) return false;
  await endSession(campaignId, stale.id, { rest: true });
  return true;
}

/** Between sessions: the host ended one and play waits for the next. */
export async function isResting(campaignId: string): Promise<boolean> {
  const row = await q1<{ resting: boolean }>(
    'SELECT resting_since IS NOT NULL AS resting FROM campaigns WHERE id = $1',
    [campaignId],
  );
  return row?.resting ?? false;
}

/** Open the next session and say so at the table. Returns its number. */
export async function beginSession(campaignId: string): Promise<number> {
  const sessionId = await ensureSession(campaignId);
  const row = await q1<{ number: number }>('SELECT number FROM play_sessions WHERE id = $1', [sessionId]);
  const message = await insertMessage({
    campaignId,
    sessionId,
    turnId: null,
    kind: 'system',
    userId: null,
    content: `Session ${row!.number} begins.`,
  });
  getRoom(campaignId)?.broadcast({ type: 'message', message });
  return row!.number;
}

/** What became of narration sent in by an outside DM. */
export type OutsideNarration =
  | { kind: 'turn'; number: number; redacted: boolean }
  | { kind: 'opening'; redacted: boolean }
  | { kind: 'nothing'; turnWaiting: boolean };

/** One campaign's live table: who is connected, the turn being gathered, and the DM's reply in flight. */
export class Room {
  readonly sockets = new Map<WebSocket, UserRef>();
  readonly collector: TurnCollector;
  private turn: ActiveTurn | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** Seats whose players are connected right now. */
  private seats = new Map<string, TurnSeat>();
  /** Every seat seen during the current turn, so one that acted and left can still be named. */
  private known = new Map<string, TurnSeat>();
  private opening = false;
  /** Turns waiting for a DM outside the server, when the campaign has one. */
  readonly desk = new DmDesk();
  /** Context for an outside DM's tool calls made outside a turn (planning, the opening scene). */
  private loose: TurnContext | null = null;

  /** Who is this campaign's AI. */
  mode: DmMode;
  /** wait_for_work calls open right now. */
  private polls = 0;
  /** Epoch ms of the last connector call, 0 until the first one. */
  private lastCallAt = 0;
  private lastSeenWrite = 0;
  private dmFacts: DmFacts = { seenAt: null, openWork: 0, workClaimed: false, needsOpening: false };
  private lastBroadcastStatus = '';
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private claimWatch: ReturnType<typeof setInterval> | null = null;
  /** Called when an abandoned claim is released, so the connector can release its own claims too. */
  onClaimsReleased: (() => Promise<void>) | null = null;

  constructor(
    readonly campaignId: string,
    windowMs: number,
    mode: DmMode = 'server',
  ) {
    this.collector = new TurnCollector({ windowMs, onClose: (closed) => void this.resolve(closed) });
    this.mode = mode;
  }

  // ------------------------------------------------------------ presence of an outside DM

  /** Start from what the database knows. */
  seed(facts: DmFacts): void {
    this.dmFacts = facts;
    this.lastBroadcastStatus = this.statusKey(this.dmStatus());
  }

  /** Where this campaign's AI is right now. */
  dmStatus(): DmStatus {
    const f = this.dmFacts;
    return presenceOf({
      mode: this.mode,
      polls: this.polls,
      lastCallAt: this.lastCallAt,
      claimed: !!this.desk.turn?.claimed || f.workClaimed,
      seenAt: f.seenAt,
      waiting: (this.desk.turn ? 1 : 0) + f.openWork + (f.needsOpening ? 1 : 0),
      now: Date.now(),
      listenMs: listenMs(),
    });
  }

  private statusKey(s: DmStatus): string {
    return `${s.mode}:${s.state}:${s.waiting}`;
  }

  /** Tell the table where its AI is, when that changed. */
  private statusMaybeChanged(): void {
    const s = this.dmStatus();
    const key = this.statusKey(s);
    if (key === this.lastBroadcastStatus) return;
    this.lastBroadcastStatus = key;
    this.broadcast({ type: 'dm_status', dm: s });
  }

  /** The campaign switched between the built-in AI and Claude. */
  setMode(mode: DmMode): Promise<void> {
    this.mode = mode;
    if (mode === 'server') this.stopClaimWatch();
    return this.workChanged();
  }

  /**
   * The outside DM called a tool for this campaign. `poll` marks the start
   * and end of a wait_for_work call, during which it counts as listening.
   */
  touchDm(poll?: 'start' | 'end'): void {
    // Coming back after a long silence: whatever it held is released first.
    this.checkAbandoned();
    const now = Date.now();
    this.lastCallAt = now;
    if (poll === 'start') this.polls++;
    else if (poll === 'end') this.polls = Math.max(0, this.polls - 1);
    this.dmFacts.seenAt = new Date(now);
    if (now - this.lastSeenWrite > SEEN_WRITE_MS) {
      this.lastSeenWrite = now;
      void q('UPDATE campaigns SET dm_seen_at = now() WHERE id = $1', [this.campaignId]).catch((err) =>
        log().warn({ err, campaignId: this.campaignId }, 'could not record DM presence'),
      );
    }
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => this.statusMaybeChanged(), listenMs() + 50);
    this.presenceTimer.unref?.();
    this.statusMaybeChanged();
  }

  /** Recount what is waiting for the outside DM, wake anyone polling, and tell the table. */
  async workChanged(): Promise<void> {
    try {
      this.dmFacts = { ...(await loadDmFacts(this.campaignId)), seenAt: this.dmFacts.seenAt };
    } catch (err) {
      log().warn({ err, campaignId: this.campaignId }, 'could not count DM work');
    }
    this.desk.poke();
    this.statusMaybeChanged();
  }

  /** How long since the outside DM last called, in ms. */
  get dmIdleFor(): number {
    return this.lastCallAt ? Date.now() - this.lastCallAt : Number.POSITIVE_INFINITY;
  }

  /** No poll open and no call for a while: nothing keeps this room alive for the outside DM. */
  get dmGone(): boolean {
    return this.polls === 0 && this.dmIdleFor > DM_IDLE_MS;
  }

  /**
   * A turn or request claimed and then left alone past the claim timeout goes
   * back to waiting, so the next call hands it out again and players see that
   * nobody is working on it.
   */
  checkAbandoned(): void {
    if (!this.lastCallAt || Date.now() - this.lastCallAt < claimTimeoutMs()) return;
    const turn = this.desk.turn;
    const releasedTurn = !!turn?.claimed;
    if (turn?.claimed) {
      turn.claimed = false;
      this.broadcast({ type: 'dm_end', turnId: turn.id, ok: false });
    }
    this.stopClaimWatch();
    if (releasedTurn || this.dmFacts.workClaimed) {
      log().info({ campaignId: this.campaignId }, 'released a claim the outside DM abandoned');
      this.dmFacts.workClaimed = false;
      void (this.onClaimsReleased?.() ?? Promise.resolve())
        .then(() => this.workChanged())
        .catch(() => undefined);
    }
    this.statusMaybeChanged();
  }

  /** Contexts for requests Claude holds (a guide chat's dice), by work id. */
  private requests = new Map<string, TurnContext>();

  /** The context tool calls for one request run in, made on first use and kept until it is finished. */
  requestContext(workId: string, systemId: string, actors: Actor[]): TurnContext {
    let ctx = this.requests.get(workId);
    if (!ctx) {
      ctx = {
        campaignId: this.campaignId,
        systemId,
        turnId: null,
        actors,
        citations: [],
        rolls: [],
        stateChanged: false,
      };
      this.requests.set(workId, ctx);
    }
    return ctx;
  }

  /** The request is finished; its context goes with it. Returns it one last time. */
  dropRequestContext(workId: string): TurnContext | undefined {
    const ctx = this.requests.get(workId);
    this.requests.delete(workId);
    return ctx;
  }

  /** For tests: pretend the last connector call was this long ago. */
  ageLastCallForTests(ms: number): void {
    this.lastCallAt = Date.now() - ms;
  }

  private startClaimWatch(): void {
    if (this.claimWatch) return;
    this.claimWatch = setInterval(() => {
      if (!this.desk.turn?.claimed) return this.stopClaimWatch();
      this.checkAbandoned();
    }, 60_000);
    this.claimWatch.unref?.();
  }

  private stopClaimWatch(): void {
    if (this.claimWatch) clearInterval(this.claimWatch);
    this.claimWatch = null;
  }

  /** The owner gives a turn that is waiting for the outside DM back to the table. */
  releaseDesk(): boolean {
    this.stopClaimWatch();
    return this.desk.drop();
  }

  /** Stop the room's timers; it is being forgotten. */
  dispose(): void {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.stopClaimWatch();
  }

  /** Run room work one step at a time so database writes keep their order. */
  private run(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain
      .then(fn)
      .catch((err) => log().error({ err, campaignId: this.campaignId }, 'room step failed'));
    return this.chain;
  }

  /** Like `run`, but hands the step's result (or failure) back to the caller. */
  private runFor<T>(fn: () => Promise<T>): Promise<T> {
    const out = this.chain.then(fn);
    this.chain = out.then(
      () => undefined,
      (err) => log().error({ err, campaignId: this.campaignId }, 'room step failed'),
    );
    return out;
  }

  /**
   * Change the story's past: rewind, or start a session over. Waits for the
   * table's queue, refuses while the DM is writing, and drops a turn still
   * being gathered (its actions are among what goes).
   */
  rewrite<T>(fn: () => Promise<T>): Promise<T> {
    return this.runFor(async () => {
      if (this.collector.phase === 'resolving' || this.opening || this.desk.turn) {
        throw conflict('Wait for the Dungeon Master to finish writing first.', 'dm_busy');
      }
      this.collector.reset();
      this.turn = null;
      this.known = new Map(this.seats);
      const out = await fn();
      this.broadcast({ type: 'history_changed' });
      this.broadcast({ type: 'state_changed' });
      this.broadcast({ type: 'turn', turn: this.turnState() });
      return out;
    });
  }

  /**
   * Run `fn` only while the table is quiet: after everything already queued,
   * and refused while a turn is being gathered or the DM is writing. Nothing
   * can open a turn between this check and `fn`, because actions wait in the
   * same queue.
   */
  whenQuiet<T>(fn: () => Promise<T>): Promise<T> {
    return this.runFor(async () => {
      if (this.collector.phase !== 'idle' || this.opening || this.desk.turn) {
        throw conflict('Wait for the current turn to finish.', 'dm_busy');
      }
      return fn();
    });
  }

  /** The DM rewrote its latest scene: show everyone that one message as it now reads. */
  async announceCorrection(): Promise<void> {
    const last = await q1<{ id: number }>(
      `SELECT id FROM messages WHERE campaign_id = $1 AND kind = 'dm' ORDER BY id DESC LIMIT 1`,
      [this.campaignId],
    );
    const message = last ? await getMessage(last.id) : undefined;
    if (message) this.broadcast({ type: 'message', message });
  }

  /** An action not yet resolved was edited: the DM gets the new words. */
  editPending(messageId: number, text: string): 'ok' | 'resolving' | 'none' {
    return this.collector.editAction(messageId, text);
  }

  present(): UserRef[] {
    const seen = new Map<string, UserRef>();
    for (const u of this.sockets.values()) seen.set(u.id, u);
    return [...seen.values()];
  }

  turnState(): TurnState {
    const snap = this.collector.snapshot(this.turn?.number ?? null);
    const ids = new Set([...snap.expected, ...snap.acted, ...snap.passed]);
    return { ...snap, seats: [...ids].flatMap((id) => this.known.get(id) ?? []) };
  }

  get busy(): boolean {
    return this.collector.phase !== 'idle';
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  /** Send a message to one person's connections only. */
  tellUser(userId: string, msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws, u] of this.sockets) if (u.id === userId && ws.readyState === ws.OPEN) ws.send(data);
  }

  private errorTo(userId: string, code: string, message: string): void {
    this.tellUser(userId, { type: 'error', code, message });
  }

  private tell(userId: string, message: string): void {
    this.errorTo(userId, 'not_allowed', message);
  }

  /**
   * A player makes a roll the DM asked for (request_roll). Players roll only
   * when asked, and only for a character they run; the server rolls the
   * expression the DM set, whatever the client sends, and the client only
   * animates the result. The result joins the turn as that character's action,
   * opening one if none is open, so the DM reads it next turn.
   */
  roll(user: UserRef, requestId: string): Promise<void> {
    return this.run(async () => {
      if (await this.resting(user)) return;
      const ask = await q1<{ character_id: string; expression: string; reason: string; kind: RollKind }>(
        `SELECT character_id, expression, reason, kind FROM roll_requests
          WHERE id = $1 AND campaign_id = $2 AND status = 'pending'`,
        [requestId, this.campaignId],
      );
      if (!ask) return this.tell(user.id, 'The DM is not waiting on that roll any more.');
      const chars = await pgStore.characters(this.campaignId);
      const outcome = buildPlayerRoll(
        { expression: ask.expression, reason: ask.reason, kind: ask.kind, characterId: ask.character_id },
        { userId: user.id, characters: chars },
      );
      if (!outcome.ok) return this.errorTo(user.id, outcome.code, outcome.message);
      const seat = this.seatsOf(user.id).find((s) => s.characterId === ask.character_id);
      if (!seat) return this.tell(user.id, 'Rejoin the table and try again.');
      // Claimed before anything is posted, so a double tap cannot roll twice.
      const claimed = await q1(
        `UPDATE roll_requests SET status = 'rolled', closed_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`,
        [requestId],
      );
      if (!claimed) return this.tell(user.id, 'That roll has already been made.');
      const r = outcome.roll;
      const faces = r.dice.map((d) => (d.kept ? String(d.value) : `~${d.value}~`)).join(', ');
      // While the DM is resolving, the line waits for the next turn, and so does the roll.
      const held = this.collector.phase === 'resolving';
      await this.submit({
        seat: seat.id,
        userId: user.id,
        text: `${seat.name} rolls ${r.reason || r.kind}: ${r.total} (${r.expression}: ${faces}).`,
      });
      const ctx: TurnContext = {
        campaignId: this.campaignId,
        systemId: '',
        turnId: held ? null : (this.turn?.id ?? null),
        actors: [],
        citations: [],
        rolls: [],
        stateChanged: false,
      };
      const id = await pgStore.recordRoll(ctx, r);
      await q('UPDATE roll_requests SET roll_id = $2 WHERE id = $1', [requestId, id]);
      this.broadcast({ type: 'roll', roll: { id, ...r } });
      this.broadcast({ type: 'state_changed' });
    });
  }

  /** Close the rolls the DM asked for that nobody made. Returns what they were. */
  private async dropOpenRolls(): Promise<NonNullable<TurnInput['missedRolls']>> {
    const rows = await q<{ name: string; expression: string; reason: string }>(
      `UPDATE roll_requests r SET status = 'dropped', closed_at = now()
         FROM characters c
        WHERE c.id = r.character_id AND r.campaign_id = $1 AND r.status = 'pending'
        RETURNING c.name, r.expression, r.reason`,
      [this.campaignId],
    );
    if (rows.length) this.broadcast({ type: 'state_changed' });
    return rows.map((r) => ({ characterName: r.name, expression: r.expression, reason: r.reason }));
  }

  /**
   * Work out who the table is waiting on. Every player-run character with a
   * player connected is a seat, and so is a connected player who runs none.
   * When the table waits until everyone is ready (no gather window), every
   * player-run character is a seat whether its player is here or not: away
   * means not done yet, and leaving does not end anyone's turn. The owner can
   * still send the turn early with Go now. AI-run party members have no seat:
   * they act when the turn closes.
   */
  private async syncSeats(): Promise<void> {
    const here = this.present();
    const rows = await q<{ id: string; name: string; users: string[] }>(
      `SELECT c.id, c.name, array_agg(p.user_id::text ORDER BY p.user_id) AS users
         FROM characters c JOIN character_players p ON p.character_id = c.id
        WHERE c.campaign_id = $1 AND c.controller = 'player'
        GROUP BY c.id, c.name, c.created_at ORDER BY c.created_at, c.id`,
      [this.campaignId],
    );
    const seats = new Map<string, TurnSeat>();
    const waitForEveryone = this.collector.windowMs === 0;
    for (const r of rows) {
      if (waitForEveryone || r.users.some((id) => here.some((u) => u.id === id)))
        seats.set(r.id, { id: r.id, name: r.name, userIds: r.users, characterId: r.id });
    }
    for (const u of here) {
      if (![...seats.values()].some((s) => s.userIds.includes(u.id)))
        seats.set(`u:${u.id}`, { id: `u:${u.id}`, name: u.displayName, userIds: [u.id], characterId: null });
    }
    this.seats = seats;
    for (const [id, seat] of seats) this.known.set(id, seat);
    this.collector.setPresent(seats.keys());
  }

  join(ws: WebSocket, user: UserRef): Promise<void> {
    this.sockets.set(ws, user);
    return this.run(async () => {
      await this.syncSeats();
      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'hello',
            you: user,
            present: this.present(),
            turn: this.turnState(),
            dm: this.dmStatus(),
          } satisfies ServerMessage),
        );
      }
      this.broadcast({ type: 'presence', present: this.present() });
      this.broadcast({ type: 'turn', turn: this.turnState() });
    });
  }

  leave(ws: WebSocket): void {
    if (!this.sockets.delete(ws)) return;
    void this.run(async () => {
      await this.syncSeats();
      await this.unreadIfGone();
      this.broadcast({ type: 'presence', present: this.present() });
      this.broadcast({ type: 'turn', turn: this.turnState() });
    });
  }

  /**
   * Between sessions, being ready means being here. A player who tapped ready
   * and then left the app is no longer ready, so the host cannot start the
   * next session without them by mistake.
   */
  private async unreadIfGone(): Promise<void> {
    if (!(await isResting(this.campaignId))) return;
    const here = this.present().map((u) => u.id);
    const gone = await q(
      `UPDATE campaign_members SET ready_at = NULL
        WHERE campaign_id = $1 AND ready_at IS NOT NULL AND NOT (user_id = ANY($2::uuid[])) RETURNING user_id`,
      [this.campaignId, here],
    );
    if (gone.length) this.broadcast({ type: 'state_changed' });
  }

  /** The gather window changed: with none, the table waits on players who are away too. */
  setGatherWindow(ms: number): void {
    this.collector.windowMs = ms;
    void this.run(async () => {
      await this.syncSeats();
      this.broadcast({ type: 'turn', turn: this.turnState() });
    });
  }

  /** Characters were added, removed or handed to someone else. */
  partyChanged(): void {
    void this.run(async () => {
      await this.syncSeats();
      this.broadcast({ type: 'turn', turn: this.turnState() });
    });
    this.broadcast({ type: 'state_changed' });
  }

  /** Drop every connection of a user (removed from the campaign, session revoked). */
  kick(userId: string): void {
    for (const [ws, u] of this.sockets) if (u.id === userId) ws.close(4403, 'access removed');
  }

  private seatsOf(userId: string): TurnSeat[] {
    return [...this.seats.values()].filter((s) => s.userIds.includes(userId));
  }

  /**
   * Any player may speak for a companion (a party member the GM or its own AI
   * runs) without taking it over. That line gets a seat of its own, keyed by
   * who wrote it, which the table never waits on.
   */
  private async voicedSeat(user: UserRef, characterId: string): Promise<TurnSeat | undefined> {
    const companion = (await pgStore.characters(this.campaignId)).find(
      (c) => c.id === characterId && c.controller !== 'player',
    );
    if (!companion) return undefined;
    const seat: TurnSeat = {
      id: `${VOICED}${user.id}:${companion.id}`,
      name: companion.name,
      userIds: [user.id],
      characterId: companion.id,
    };
    this.known.set(seat.id, seat);
    return seat;
  }

  /** Between sessions nobody acts. Tells the player why and returns true when that is so. */
  private async resting(user: UserRef): Promise<boolean> {
    if (await endIfStale(this.campaignId)) {
      this.broadcast({ type: 'state_changed' });
      this.tell(
        user.id,
        'It has been a while, so the last session was wrapped up. Read the recap and ready up; play resumes when the host starts the next one.',
      );
      return true;
    }
    if (await isResting(this.campaignId)) {
      this.tell(
        user.id,
        'The session has ended. Ready up on the recap, and play resumes when the host starts the next one.',
      );
      return true;
    }
    return false;
  }

  action(user: UserRef, text: string, characterId?: string): Promise<void> {
    return this.run(async () => {
      if (await this.resting(user)) return;
      const mine = this.seatsOf(user.id);
      let seat: TurnSeat | undefined;
      if (characterId) {
        seat = mine.find((s) => s.characterId === characterId) ?? (await this.voicedSeat(user, characterId));
        if (!seat) return this.tell(user.id, 'You cannot speak for that character.');
      } else {
        // No character named: the first of theirs that has not acted yet.
        seat = mine.find((s) => !this.collector.hasActed(s.id)) ?? mine[0];
      }
      if (!seat) return this.tell(user.id, 'Rejoin the table and try again.');
      await this.submit({ seat: seat.id, userId: user.id, text });
    });
  }

  /**
   * An action from the campaign owner typed into their outside DM client
   * rather than the app. They need not be connected: the seat is made for
   * this one action, so the table never waits on it. Returns a problem to
   * report, or what happened to the action.
   */
  hostAction(
    user: Pick<UserRef, 'id' | 'displayName'>,
    text: string,
    characterName?: string,
  ): Promise<{ error: string } | { where: 'opened' | 'added' | 'queued'; as: string }> {
    return this.runFor(async () => {
      if (await endIfStale(this.campaignId)) this.broadcast({ type: 'state_changed' });
      if (await isResting(this.campaignId)) {
        return { error: 'The session has ended. The host resumes play from the recap screen in the app.' };
      }
      const mine = (await pgStore.characters(this.campaignId)).filter(
        (c) => c.controller === 'player' && c.playerIds.includes(user.id),
      );
      const want = characterName?.trim().toLowerCase();
      const pick = want
        ? (mine.find((c) => c.name.toLowerCase() === want) ??
          mine.find((c) => c.name.toLowerCase().startsWith(want)))
        : (mine.find((c) => !this.collector.hasActed(c.id)) ?? mine[0]);
      if (want && !pick) {
        return {
          error: `You do not run a character called "${characterName}". Yours: ${mine.map((c) => c.name).join(', ') || 'none'}.`,
        };
      }
      const seat: TurnSeat = pick
        ? { id: pick.id, name: pick.name, userIds: pick.playerIds, characterId: pick.id }
        : { id: `u:${user.id}`, name: user.displayName, userIds: [user.id], characterId: null };
      this.known.set(seat.id, seat);
      const where =
        this.collector.phase === 'resolving'
          ? 'queued'
          : this.collector.phase === 'idle'
            ? 'opened'
            : 'added';
      await this.submit({ seat: seat.id, userId: user.id, text });
      // The host's seat is never waited on; it is finished as soon as it is sent.
      if (this.collector.finish(seat.id)) this.broadcast({ type: 'turn', turn: this.turnState() });
      return { where, as: seat.name };
    });
  }

  private async submit(action: CollectedAction): Promise<void> {
    const where = this.collector.submit(action);
    if (where === 'opened') {
      const sessionId = await ensureSession(this.campaignId);
      const row = await q1<{ id: string; number: number }>(
        `INSERT INTO turns (campaign_id, session_id, number)
         VALUES ($1, $2, (SELECT coalesce(max(number), 0) + 1 FROM turns WHERE campaign_id = $1)) RETURNING id, number`,
        [this.campaignId, sessionId],
      );
      this.turn = { id: row!.id, number: row!.number, sessionId };
    }
    const turn = where === 'queued' ? null : this.turn;
    if (action.messageId) {
      // A held action joining its turn now that the previous one is resolved.
      await q('UPDATE messages SET turn_id = $2, session_id = $3 WHERE id = $1', [
        action.messageId,
        turn?.id ?? null,
        turn?.sessionId ?? null,
      ]);
    } else {
      const seat = this.known.get(action.seat);
      const message = await insertMessage({
        campaignId: this.campaignId,
        sessionId: turn?.sessionId ?? null,
        turnId: turn?.id ?? null,
        kind: 'action',
        userId: action.userId,
        characterName: seat?.characterId ? seat.name : null,
        content: action.text,
      });
      action.messageId = message.id;
      this.broadcast({ type: 'message', message });
    }
    // A line spoken for a companion is finished as soon as it is sent.
    if (where !== 'queued' && action.seat.startsWith(VOICED)) this.collector.finish(action.seat);
    this.broadcast({ type: 'turn', turn: this.turnState() });
  }

  ooc(user: UserRef, text: string): Promise<void> {
    return this.run(async () => {
      // Table talk is stored and shown to players but never sent to the model.
      const message = await insertMessage({
        campaignId: this.campaignId,
        sessionId: this.turn?.sessionId ?? null,
        turnId: null,
        kind: 'ooc',
        userId: user.id,
        content: text,
      });
      this.broadcast({ type: 'message', message });
    });
  }

  /** This player is finished with the turn: every character of theirs is done, or sits it out. */
  done(user: UserRef): void {
    let any = false;
    for (const seat of this.seatsOf(user.id)) any = this.collector.finish(seat.id) || any;
    if (any) this.broadcast({ type: 'turn', turn: this.turnState() });
  }

  /**
   * This player sits the turn out, and says so in the story: each of their
   * seats that has not acted gets "<name> does nothing this turn.", and then
   * every seat of theirs is done. Works with no turn open, too: the line opens
   * one, so a player can hand the scene back to the DM and the companions
   * without having to think of something to do. Seats that already acted are
   * simply done.
   */
  pass(user: UserRef): Promise<void> {
    return this.run(async () => {
      if (await this.resting(user)) return;
      if (this.collector.phase === 'resolving') {
        return this.tell(user.id, 'The DM is already working on this turn. Pass on the next one.');
      }
      const mine = this.seatsOf(user.id);
      if (!mine.length) return this.tell(user.id, 'Rejoin the table and try again.');
      for (const seat of mine) {
        if (this.collector.hasActed(seat.id)) continue;
        await this.submit({ seat: seat.id, userId: user.id, text: `${seat.name} does nothing this turn.` });
        // The first line may have completed the turn already (a table of one).
        if (this.collector.phase !== 'collecting') break;
      }
      let any = false;
      for (const seat of mine) any = this.collector.finish(seat.id) || any;
      if (any) this.broadcast({ type: 'turn', turn: this.turnState() });
    });
  }

  force(): void {
    this.collector.force();
  }

  private async system(text: string, turn: ActiveTurn | null): Promise<void> {
    const message = await insertMessage({
      campaignId: this.campaignId,
      sessionId: turn?.sessionId ?? null,
      turnId: turn?.id ?? null,
      kind: 'system',
      userId: null,
      content: text,
    });
    this.broadcast({ type: 'message', message });
  }

  /** Give the floor back, and start the next turn with anything sent meanwhile. */
  private async release(): Promise<void> {
    this.turn = null;
    const held = this.collector.resolved();
    const before = this.known;
    this.known = new Map(this.seats);
    // Seats made for one line (a voiced companion, the host's own action) carry over with it.
    for (const a of held) {
      const seat = before.get(a.seat);
      if (seat && !this.known.has(a.seat)) this.known.set(a.seat, seat);
    }
    this.broadcast({ type: 'turn', turn: this.turnState() });
    for (const action of held) await this.submit(action);
  }

  /** A gathered turn goes to the DM. Runs outside the step queue so chat keeps flowing meanwhile. */
  private async resolve(closed: ClosedTurn): Promise<void> {
    let turn: ActiveTurn | null = null;
    await this.run(async () => {
      turn = this.turn;
      if (!turn) return;
      await q(`UPDATE turns SET status = 'resolving', closed_at = now(), close_reason = $2 WHERE id = $1`, [
        turn.id,
        closed.reason,
      ]);
      // The world as it stands before this turn, so the story can be rewound to here.
      await snapshotState(this.campaignId, turn.id);
      this.broadcast({ type: 'turn', turn: this.turnState() });
    });
    const active = turn as ActiveTurn | null;
    let ok = false;
    try {
      if (!active) throw new Error('turn closed without a record');
      ok = await this.narrate(active, closed);
    } catch (err) {
      log().error({ err, campaignId: this.campaignId }, 'turn failed');
      const reason =
        err instanceof LlmNotConfigured
          ? `No AI model is configured yet. ${err.message}`
          : 'The Dungeon Master could not respond just now.';
      await this.system(`${reason} Your actions were kept; act again to retry.`, active).catch(
        () => undefined,
      );
    }
    await this.run(async () => {
      if (active) {
        await q(`UPDATE turns SET status = $2 WHERE id = $1`, [active.id, ok ? 'done' : 'failed']);
        this.broadcast({ type: 'dm_end', turnId: active.id, ok });
      }
      await this.release();
    });
    if (ok && (await dmMode(this.campaignId).catch(() => 'server')) === 'server')
      void maybeQueueSummary(this.campaignId).catch((err) => log().warn({ err }, 'could not queue summary'));
  }

  /**
   * Party members with an AI of their own take their turn, one after another
   * (see companionOrder), so each sees what the players and the companions
   * before it did and can play along instead of off on its own. Each is a
   * separate call that knows only what its character could, and may pass. A
   * companion that fails or runs out of time simply sits the turn out.
   */
  private async companions(
    turn: ActiveTurn,
    info: CampaignInfo,
    ownerId: string,
    chars: CharRow[],
    input: TurnInput,
    payers: string[],
  ): Promise<TurnAction[]> {
    const llm = await resolveLlm('companion', ownerId);
    const [story, scene, party, entities] = await Promise.all([
      publicStory(this.campaignId, turn.id),
      pgStore.scene(this.campaignId),
      pgStore.characters(this.campaignId),
      pgStore.entities(this.campaignId),
    ]);
    const known = knownEntries(entities);
    const out: TurnAction[] = [];
    // One at a time keeps the table waiting longer, so the whole round has a budget too.
    const until = Date.now() + COMPANIONS_BUDGET_MS;
    for (const character of companionOrder(input, chars)) {
      const left = Math.min(COMPANION_TIMEOUT_MS, until - Date.now());
      if (left < 5_000) {
        log().warn({ campaignId: this.campaignId, character: character.name }, 'companion out of time');
        continue;
      }
      const text = await companionTurn({
        llm,
        campaign: info,
        character,
        story,
        scene,
        party,
        known,
        // The turn so far: the players' actions, then each companion that went before this one.
        turn: { ...input, actions: [...input.actions, ...out] },
        signal: AbortSignal.timeout(left),
        onUsage: (usage, model) =>
          recordUsage({
            task: 'companion',
            provider: llm.provider.name,
            model,
            keySource: llm.keySource,
            campaignId: this.campaignId,
            userIds: payers,
            usage,
          }),
      }).catch((err) => {
        log().warn({ err, campaignId: this.campaignId, character: character.name }, 'companion did not act');
        return null;
      });
      if (!text) continue;
      const name = character.name;
      const message = await insertMessage({
        campaignId: this.campaignId,
        sessionId: turn.sessionId,
        turnId: turn.id,
        kind: 'action',
        userId: null,
        characterName: name,
        content: text,
        meta: { ai: true },
      });
      this.broadcast({ type: 'message', message });
      out.push({ userId: '', displayName: COMPANION_LABEL, characterName: name, text });
    }
    return out;
  }

  private async narrate(turn: ActiveTurn, closed: ClosedTurn): Promise<boolean> {
    const cfg = config();
    const campaign = await loadCampaign(this.campaignId);
    const info = infoOf(this.campaignId, campaign);
    const chars = await pgStore.characters(this.campaignId);

    const seatOf = (id: string) => this.known.get(id);
    const participantIds = [
      ...new Set([
        ...closed.actions.map((a) => a.userId),
        ...closed.passed.flatMap((id) => seatOf(id)?.userIds ?? []),
      ]),
    ];
    // Only current members count: someone removed mid-turn is dropped here.
    const people = await q<{ id: string; display_name: string }>(
      `SELECT u.id, u.display_name FROM campaign_members m JOIN users u ON u.id = m.user_id
        WHERE m.campaign_id = $1 AND u.id = ANY($2::uuid[])`,
      [this.campaignId, participantIds],
    );
    const byId = new Map(people.map((p) => [p.id, p]));
    // Checked against the party as it is now, in case a character changed hands mid-turn.
    const runs = (userId: string, characterId: string | null | undefined) =>
      chars.find((c) => c.id === characterId && c.controller === 'player' && c.playerIds.includes(userId));
    // A companion a player spoke for this turn.
    const companionOf = (seatId: string) =>
      seatId.startsWith(VOICED)
        ? chars.find((c) => c.id === seatOf(seatId)?.characterId && c.controller !== 'player')
        : undefined;

    const actors: Actor[] = people.map((p) => ({
      userId: p.id,
      displayName: p.display_name,
      characterName: chars.find((c) => c.playerIds.includes(p.id))?.name ?? null,
    }));
    const actions: TurnAction[] = closed.actions.flatMap((a) => {
      const p = byId.get(a.userId);
      if (!p) return [];
      const voiced = companionOf(a.seat);
      if (voiced) {
        return [
          {
            userId: p.id,
            displayName: p.display_name,
            characterName: voiced.name,
            text: a.text,
            voiced: true,
          },
        ];
      }
      const character = runs(a.userId, seatOf(a.seat)?.characterId);
      return [
        { userId: p.id, displayName: p.display_name, characterName: character?.name ?? null, text: a.text },
      ];
    });
    // Companions a player already spoke for do not also act on their own this turn.
    const spokenFor = actions.flatMap((a) => (a.voiced && a.characterName ? [a.characterName] : []));
    const actingIds = [...new Set(actions.map((a) => a.userId))];
    if (!actions.length) return false;

    const external = dmModeOf(campaign.settings) === 'claude';
    // An outside DM spends none of the server's tokens.
    const blocked = external ? null : await budgetBlock(this.campaignId, actingIds);
    if (blocked) {
      await this.system(blocked, turn);
      return false;
    }

    const input: TurnInput = {
      number: turn.number,
      actions,
      passed: closed.passed.flatMap((id) => {
        const seat = seatOf(id);
        const names = (seat?.userIds ?? []).flatMap((u) => byId.get(u)?.display_name ?? []);
        return seat && names.length
          ? [{ displayName: names.join(' & '), characterName: seat.characterId ? seat.name : null }]
          : [];
      }),
    };
    // The DM moves on: rolls it asked for and nobody made are dropped, and it is told which.
    const missed = await this.dropOpenRolls();
    if (missed.length) input.missedRolls = missed;

    if (external) return this.awaitOutsideDm(turn, input, actors, campaign.system_id);

    this.broadcast({ type: 'dm_start', turnId: turn.id });
    const own = chars.filter((c) => c.controller === 'agent' && !spokenFor.includes(c.name));
    if (own.length) {
      // They react to what the players are doing, so they see the turn as gathered so far.
      const more = await this.companions(turn, info, campaign.owner_id, own, input, actingIds).catch(
        (err) => {
          log().warn({ err, campaignId: this.campaignId }, 'companions skipped');
          return [];
        },
      );
      input.actions = [...actions, ...more];
    }

    const ctx: TurnContext = {
      campaignId: this.campaignId,
      systemId: campaign.system_id,
      turnId: turn.id,
      actors,
      citations: [],
      rolls: [],
      stateChanged: false,
    };
    const polishing = !!campaign.settings.polishWith;
    const llm = await resolveLlm('narration', campaign.owner_id);
    const prompt = await buildPrompt(info, input, ctx, pgStore);

    const result = await runAgentTurn({
      llm,
      task: 'narration',
      tools: gmTools({ sheets: !!info.gmSheets, askAi: !!info.outsideAis?.length }),
      system: prompt.system,
      messages: prompt.messages,
      ctx,
      store: pgStore,
      maxRounds: cfg.AGENT_MAX_TOOL_ROUNDS,
      maxTokens: cfg.LLM_MAX_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(240_000),
      // A draft that is about to be polished is not shown as it is written: the table would watch it change.
      onText: polishing ? undefined : (text) => this.broadcast({ type: 'dm_delta', turnId: turn.id, text }),
      onTool: (tool, summary) => {
        this.broadcast({ type: 'dm_tool', turnId: turn.id, tool, summary });
        if (STATE_TOOLS.has(tool)) this.broadcast({ type: 'state_changed' });
        if (HISTORY_TOOLS.has(tool)) void this.announceCorrection().catch(() => undefined);
      },
      onUsage: (usage, model) =>
        recordUsage({
          task: 'narration',
          provider: llm.provider.name,
          model,
          keySource: llm.keySource,
          campaignId: this.campaignId,
          userIds: actingIds,
          usage,
        }),
    });

    await this.publish(result.text, ctx, turn.sessionId, turn.id, playerLines(input));
    return true;
  }

  /**
   * Leave the gathered turn on the desk for the outside DM and wait for its
   * narration. AI-run companions are not asked separately here: that needs
   * the server's model, so the outside DM plays them along with everyone else.
   */
  private async awaitOutsideDm(
    turn: ActiveTurn,
    input: TurnInput,
    actors: Actor[],
    systemId: string,
  ): Promise<boolean> {
    const ctx: TurnContext = {
      campaignId: this.campaignId,
      systemId,
      turnId: turn.id,
      actors,
      citations: [],
      rolls: [],
      stateChanged: false,
    };
    const minutes = config().CONNECTOR_TURN_TIMEOUT_MINUTES;
    const handed = this.desk.handOff(
      {
        id: turn.id,
        number: turn.number,
        sessionId: turn.sessionId,
        input,
        ctx,
        claimed: false,
        // A player already spoke for these this turn.
        companionsActed: input.actions.flatMap((a) => (a.voiced && a.characterName ? [a.characterName] : [])),
      },
      minutes * 60_000,
    );
    this.statusMaybeChanged();
    const ok = await handed;
    this.stopClaimWatch();
    this.statusMaybeChanged();
    if (!ok) {
      await this.system(
        'The Dungeon Master did not pick this turn up in time. Your actions were kept; act again to retry.',
        turn,
      );
    }
    return ok;
  }

  /**
   * The outside DM takes the waiting turn. Players see the DM start work on
   * it, the same as with the built-in DM. Returns null when nothing is waiting.
   */
  claimForOutsideDm() {
    const before = this.desk.turn?.claimed;
    const turn = this.desk.claim();
    if (turn && !before) {
      this.broadcast({ type: 'dm_start', turnId: turn.id });
      this.startClaimWatch();
      this.statusMaybeChanged();
    }
    return turn;
  }

  /**
   * A companion with an AI of its own acted in the turn the outside DM holds:
   * post its action to the table and add it to the turn, so the DM reads it
   * the next time it is handed the turn. `text` null means it passed.
   * Returns false when no turn is claimed or the companion already acted.
   */
  companionActed(name: string, text: string | null): Promise<boolean> {
    return this.runFor(async () => {
      const turn = this.desk.turn;
      if (!turn?.claimed) return false;
      const acted = (turn.companionsActed ??= []);
      if (acted.includes(name)) return false;
      acted.push(name);
      if (!text) return true;
      const message = await insertMessage({
        campaignId: this.campaignId,
        sessionId: turn.sessionId,
        turnId: turn.id,
        kind: 'action',
        userId: null,
        characterName: name,
        content: text,
        meta: { ai: true },
      });
      this.broadcast({ type: 'message', message });
      turn.input.actions.push({ userId: '', displayName: COMPANION_LABEL, characterName: name, text });
      return true;
    });
  }

  /**
   * The context an outside DM's tool call runs in: the claimed turn's, or a
   * standing one for work between turns (planning, the opening scene), which
   * is cleared each time narration is posted. Also says which stream, if
   * any, players should see the call in.
   */
  outsideContext(systemId: string, opening: boolean): { ctx: TurnContext; streamId: string | null } {
    const turn = this.desk.turn;
    if (turn?.claimed) return { ctx: turn.ctx, streamId: turn.id };
    this.loose ??= {
      campaignId: this.campaignId,
      systemId,
      turnId: null,
      actors: [],
      citations: [],
      rolls: [],
      stateChanged: false,
    };
    return { ctx: this.loose, streamId: opening ? OPENING : null };
  }

  /**
   * Narration from the outside DM. It answers the claimed turn if there is
   * one; otherwise, if the campaign has not opened yet, it is the opening
   * scene. Anything else is refused, so it cannot talk over a turn in progress.
   */
  async narrateFromOutside(text: string): Promise<OutsideNarration> {
    const turn = this.desk.turn;
    if (turn?.claimed) {
      const { redacted } = await this.publish(
        text,
        turn.ctx,
        turn.sessionId,
        turn.id,
        playerLines(turn.input),
      );
      this.loose = null;
      // resolve() picks up from here: marks the turn done and gives the floor back.
      this.desk.complete();
      return { kind: 'turn', number: turn.number, redacted };
    }
    const claimed = await q1(
      `UPDATE campaigns SET opened_at = now()
        WHERE id = $1 AND phase = 'active' AND status = 'active' AND opened_at IS NULL RETURNING id`,
      [this.campaignId],
    );
    if (!claimed) return { kind: 'nothing', turnWaiting: !!turn };
    const sessionId = await ensureSession(this.campaignId);
    const ctx = this.loose ?? {
      campaignId: this.campaignId,
      systemId: '',
      turnId: null,
      actors: [],
      citations: [],
      rolls: [],
      stateChanged: false,
    };
    this.loose = null;
    this.dmFacts.needsOpening = false;
    const { redacted } = await this.publish(text, ctx, sessionId, null);
    this.broadcast({ type: 'dm_end', turnId: OPENING, ok: true });
    this.statusMaybeChanged();
    this.broadcast({ type: 'state_changed' });
    await refreshBrief(this.campaignId).catch(() => undefined);
    return { kind: 'opening', redacted };
  }

  /**
   * Store and send a finished piece of narration, with anything secret blacked
   * out and, when the campaign names an AI to polish with, rewritten by it for
   * style. `said` is what the players wrote this turn; their words are kept as
   * they are (see polishNarration).
   */
  private async publish(
    text: string,
    ctx: TurnContext,
    sessionId: string,
    turnId: string | null,
    said: string[] = [],
  ): Promise<{ redacted: boolean }> {
    const [entities, polish] = await Promise.all([
      pgStore.entities(this.campaignId),
      polishSettings(this.campaignId),
    ]);
    const secrets = entities.flatMap((e) => (e.secret && !e.secretRevealed ? [e.secret] : []));
    const safe = redactSecrets(text, secrets);
    // Redacted first, so the other AI never sees a secret and cannot reword one past the redaction.
    if (polish.with && safe.text.trim()) {
      this.broadcast({
        type: 'dm_tool',
        turnId: turnId ?? OPENING,
        tool: 'polish',
        summary: `${polish.with} is polishing the narration`,
      });
      safe.text = (await polishNarration(polish.with, safe.text, said, polish.tone)).text;
    }
    // Resolve [[name]] codex markers against the known world, after redaction so a
    // marker inside a withheld passage is gone before it can resolve.
    const { content, refs } = resolveRefs(safe.text || '…', entities);
    const message = await insertMessage({
      campaignId: this.campaignId,
      sessionId,
      turnId,
      kind: 'dm',
      userId: null,
      content,
      meta: {
        citations: usedCitations(safe.text, ctx.citations),
        rolls: ctx.rolls,
        ...(refs.length ? { refs } : {}),
        ...(safe.redacted ? { redacted: true } : {}),
      },
    });
    // The first narration that names an entry records when the party met it.
    if (refs.length)
      await pgStore.markFirstSeen(this.campaignId, [...new Set(refs.map((r) => r.entityId))], message.id);
    this.broadcast({ type: 'message', message });
    if (ctx.stateChanged) this.broadcast({ type: 'state_changed' });
    return { redacted: safe.redacted };
  }

  /**
   * The first thing that happens in a campaign: the DM plans the story in
   * its notebook and writes the opening scene. Claimed in the database, so
   * it runs once however many people are connected, and a failure leaves the
   * table free to simply start playing.
   */
  async maybeOpen(): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    try {
      // An outside DM writes the opening when it next opens the campaign.
      if ((await dmMode(this.campaignId)) === 'claude') return;
      const claimed = await q1(
        `UPDATE campaigns SET opened_at = now()
          WHERE id = $1 AND phase = 'active' AND status = 'active' AND opened_at IS NULL RETURNING id`,
        [this.campaignId],
      );
      // Someone acting before the opening could start takes precedence.
      if (!claimed || !this.collector.hold()) return;
      this.broadcast({ type: 'turn', turn: this.turnState() });
      let ok = false;
      try {
        ok = await this.open();
      } catch (err) {
        log().error({ err, campaignId: this.campaignId }, 'opening failed');
        const reason =
          err instanceof LlmNotConfigured
            ? `No AI model is configured yet. ${err.message}`
            : 'The Dungeon Master could not prepare an opening scene.';
        await this.system(`${reason} Say what your character does to begin.`, null).catch(() => undefined);
      }
      await this.run(async () => {
        this.broadcast({ type: 'dm_end', turnId: OPENING, ok });
        await this.release();
      });
    } finally {
      this.opening = false;
    }
  }

  private async open(): Promise<boolean> {
    const cfg = config();
    const campaign = await loadCampaign(this.campaignId);
    const info = infoOf(this.campaignId, campaign);
    const blocked = await budgetBlock(this.campaignId, [campaign.owner_id]);
    if (blocked) {
      await this.system(blocked, null);
      return false;
    }
    const sessionId = await ensureSession(this.campaignId);
    const ctx: TurnContext = {
      campaignId: this.campaignId,
      systemId: campaign.system_id,
      turnId: null,
      actors: [],
      citations: [],
      rolls: [],
      stateChanged: false,
    };
    const llm = await resolveLlm('narration', campaign.owner_id);
    const prompt = await buildOpening(info, pgStore);

    this.broadcast({ type: 'dm_start', turnId: OPENING });
    const result = await runAgentTurn({
      llm,
      task: 'opening',
      // The same tools as every later turn, so the first turn reuses this call's cached prefix.
      tools: gmTools({ sheets: !!info.gmSheets, askAi: !!info.outsideAis?.length }),
      system: prompt.system,
      messages: prompt.messages,
      ctx,
      store: pgStore,
      // Planning takes more steps than resolving a turn does.
      maxRounds: Math.max(cfg.AGENT_MAX_TOOL_ROUNDS, 12),
      maxTokens: cfg.LLM_MAX_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(300_000),
      onText: campaign.settings.polishWith
        ? undefined
        : (text) => this.broadcast({ type: 'dm_delta', turnId: OPENING, text }),
      onTool: (tool, summary) => this.broadcast({ type: 'dm_tool', turnId: OPENING, tool, summary }),
      onUsage: (usage, model) =>
        recordUsage({
          task: 'opening',
          provider: llm.provider.name,
          model,
          keySource: llm.keySource,
          campaignId: this.campaignId,
          userIds: [campaign.owner_id],
          usage,
        }),
    });
    await this.publish(result.text, ctx, sessionId, null);
    this.broadcast({ type: 'state_changed' });
    // Fold the plan it just wrote into the brief, so turn one reads it from the cached part.
    await refreshBrief(this.campaignId).catch(() => undefined);
    return true;
  }
}

const rooms = new Map<string, Room>();

export function getRoom(campaignId: string): Room | undefined {
  return rooms.get(campaignId);
}

export async function openRoom(campaignId: string): Promise<Room> {
  let room = rooms.get(campaignId);
  if (!room) {
    const row = await q1<{ settings: { gatherWindowSeconds?: number; dm?: unknown } }>(
      'SELECT settings FROM campaigns WHERE id = $1',
      [campaignId],
    );
    const seconds = row?.settings.gatherWindowSeconds ?? config().DEFAULT_GATHER_WINDOW_SECONDS;
    const facts = await loadDmFacts(campaignId);
    // Another connection may have created it while we were reading.
    room = rooms.get(campaignId);
    if (!room) {
      room = new Room(campaignId, seconds * 1000, dmModeOf(row?.settings));
      room.seed(facts);
      rooms.set(campaignId, room);
      roomOpened?.(room);
    }
  }
  return room;
}

let roomOpened: ((room: Room) => void) | null = null;
/** Run for every room as it opens, e.g. to wire the connector's work queue into it. */
export function onRoomOpened(fn: (room: Room) => void): void {
  roomOpened = fn;
}

/** Where a campaign's AI is, from the open room or, without one, from the database. */
export async function dmStatusOf(campaignId: string, mode: DmMode): Promise<DmStatus> {
  const room = rooms.get(campaignId);
  if (room) return room.dmStatus();
  const f = await loadDmFacts(campaignId);
  return presenceOf({
    mode,
    polls: 0,
    lastCallAt: 0,
    claimed: f.workClaimed,
    seenAt: f.seenAt,
    waiting: f.openWork + (f.needsOpening ? 1 : 0),
    now: Date.now(),
    listenMs: listenMs(),
  });
}

/** Forget empty, idle rooms: no players, no turn in progress, and no outside DM around. */
export function closeRoomIfEmpty(campaignId: string): void {
  const room = rooms.get(campaignId);
  if (room && room.sockets.size === 0 && !room.busy && !room.desk.turn && room.dmGone) {
    room.dispose();
    rooms.delete(campaignId);
  }
}

/** Close every room nobody is using. Rooms opened only by the connector would otherwise linger. */
export function sweepRooms(): void {
  for (const id of [...rooms.keys()]) closeRoomIfEmpty(id);
}

/** Turns left open by a restart can never finish; mark them so history is honest. */
export async function failStaleTurns(): Promise<void> {
  await q(
    `UPDATE turns SET status = 'failed', close_reason = 'restart' WHERE status IN ('collecting', 'resolving')`,
  );
}
