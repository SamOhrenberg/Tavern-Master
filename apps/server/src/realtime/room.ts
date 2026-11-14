import type { ServerMessage, SettingLore, TurnSeat, TurnState, UserRef } from '@tavern/protocol';
import type { WebSocket } from 'ws';
import { refreshBrief } from '../agent/brief.js';
import { resolveRefs } from '../agent/codex.js';
import { companionTurn, publicStory } from '../agent/companion.js';
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
import { maybeQueueSummary } from '../agent/summarize.js';
import { gmTools } from '../agent/tools.js';
import { config } from '../config.js';
import { DmDesk } from '../connector/desk.js';
import { dmMode, dmModeOf } from '../connector/mode.js';
import { q, q1 } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { LlmNotConfigured, resolveLlm } from '../llm/index.js';
import { budgetBlock, recordUsage } from '../llm/usage.js';
import { log } from '../log.js';
import { insertMessage } from './messages.js';
import { buildPlayerRoll, type RollRequest } from './rolls.js';
import { TurnCollector, type ClosedTurn, type CollectedAction } from './turns.js';

const SESSION_GAP_HOURS = 6;
export const STATE_TOOLS = new Set([
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

interface ActiveTurn {
  id: string;
  number: number;
  sessionId: string;
}

export interface CampaignRow {
  name: string;
  premise: string;
  settings: { tone?: string; sheets?: 'players' | 'gm'; dm?: string };
  owner_id: string;
  system_id: string;
  system_name: string;
  lore: SettingLore | null;
  lore_status: string;
}

export async function loadCampaign(campaignId: string): Promise<CampaignRow> {
  const row = await q1<CampaignRow>(
    `SELECT c.name, c.premise, c.settings, c.owner_id, c.system_id,
            s.name AS system_name, s.lore, s.lore_status
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
});

/** Find the open play session, or start a new one after a long gap. */
async function ensureSession(campaignId: string): Promise<string> {
  const open = await q1<{ id: string; fresh: boolean }>(
    `SELECT s.id,
            coalesce((SELECT max(created_at) FROM messages WHERE session_id = s.id), s.started_at)
              > now() - make_interval(hours => $2) AS fresh
       FROM play_sessions s WHERE s.campaign_id = $1 AND s.ended_at IS NULL ORDER BY s.number DESC LIMIT 1`,
    [campaignId, SESSION_GAP_HOURS],
  );
  if (open?.fresh) return open.id;
  if (open) await endSession(campaignId, open.id);
  const row = await q1<{ id: string }>(
    `INSERT INTO play_sessions (campaign_id, number)
     VALUES ($1, (SELECT coalesce(max(number), 0) + 1 FROM play_sessions WHERE campaign_id = $1)) RETURNING id`,
    [campaignId],
  );
  return row!.id;
}

export async function endSession(campaignId: string, sessionId: string): Promise<void> {
  await q('UPDATE play_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL', [sessionId]);
  // With an outside DM the server calls no model; that DM writes the chronicle itself.
  if ((await dmMode(campaignId)) === 'server') await enqueue('summarize_campaign', { campaignId, sessionId });
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

  constructor(
    readonly campaignId: string,
    windowMs: number,
  ) {
    this.collector = new TurnCollector({ windowMs, onClose: (closed) => void this.resolve(closed) });
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

  private errorTo(userId: string, code: string, message: string): void {
    const data = JSON.stringify({ type: 'error', code, message } satisfies ServerMessage);
    for (const [ws, u] of this.sockets) if (u.id === userId && ws.readyState === ws.OPEN) ws.send(data);
  }

  private tell(userId: string, message: string): void {
    this.errorTo(userId, 'not_allowed', message);
  }

  /**
   * A player rolls their own dice. The server rolls and is authoritative; the
   * client only animates the result. The roll threads into the open turn when
   * there is one, and is broadcast to the table but never sent to the DM.
   */
  roll(user: UserRef, req: RollRequest): Promise<void> {
    return this.run(async () => {
      const chars = await pgStore.characters(this.campaignId);
      const outcome = buildPlayerRoll(req, { userId: user.id, characters: chars });
      if (!outcome.ok) return this.errorTo(user.id, outcome.code, outcome.message);
      const ctx: TurnContext = {
        campaignId: this.campaignId,
        systemId: '',
        turnId: this.turn?.id ?? null,
        actors: [],
        citations: [],
        rolls: [],
        stateChanged: false,
      };
      const id = await pgStore.recordRoll(ctx, outcome.roll);
      this.broadcast({ type: 'roll', roll: { id, ...outcome.roll } });
    });
  }

  /**
   * Work out who the table is waiting on. Every player-run character with a
   * player connected is a seat, and so is a connected player who runs none.
   * AI-run party members have no seat: they act when the turn closes.
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
    for (const r of rows) {
      if (r.users.some((id) => here.some((u) => u.id === id)))
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
      this.broadcast({ type: 'presence', present: this.present() });
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

  action(user: UserRef, text: string, characterId?: string): Promise<void> {
    return this.run(async () => {
      const mine = this.seatsOf(user.id);
      let seat: TurnSeat | undefined;
      if (characterId) {
        seat = mine.find((s) => s.characterId === characterId);
        if (!seat) return this.tell(user.id, 'You do not run that character.');
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
      const mine = (await pgStore.characters(this.campaignId)).filter(
        (c) => c.controller === 'player' && c.playerIds.includes(user.id),
      );
      const want = characterName?.trim().toLowerCase();
      const pick = want
        ? mine.find((c) => c.name.toLowerCase() === want) ??
          mine.find((c) => c.name.toLowerCase().startsWith(want))
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
      const where = this.collector.phase === 'resolving' ? 'queued' : this.collector.phase === 'idle' ? 'opened' : 'added';
      await this.submit({ seat: seat.id, userId: user.id, text });
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

  /** Sit out with every character this player has not acted with yet. */
  pass(user: UserRef): void {
    let any = false;
    for (const seat of this.seatsOf(user.id)) any = this.collector.pass(seat.id) || any;
    if (any) this.broadcast({ type: 'turn', turn: this.turnState() });
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
    this.known = new Map(this.seats);
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
   * Party members with an AI of their own take their turn. Each is asked
   * separately and in parallel, sees only what its character could know, and
   * may pass. A companion that fails or times out simply sits the turn out.
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
    const [story, scene] = await Promise.all([
      publicStory(this.campaignId, turn.id),
      pgStore.scene(this.campaignId),
    ]);
    const replies = await Promise.all(
      chars.map((character) =>
        companionTurn({
          llm,
          campaign: info,
          character,
          story,
          scene,
          turn: input,
          signal: AbortSignal.timeout(45_000),
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
          log().warn(
            { err, campaignId: this.campaignId, character: character.name },
            'companion did not act',
          );
          return null;
        }),
      ),
    );
    const out: TurnAction[] = [];
    for (const [i, text] of replies.entries()) {
      if (!text) continue;
      const name = chars[i]!.name;
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

    const actors: Actor[] = people.map((p) => ({
      userId: p.id,
      displayName: p.display_name,
      characterName: chars.find((c) => c.playerIds.includes(p.id))?.name ?? null,
    }));
    const actions: TurnAction[] = closed.actions.flatMap((a) => {
      const p = byId.get(a.userId);
      if (!p) return [];
      const character = runs(a.userId, seatOf(a.seat)?.characterId);
      return [
        { userId: p.id, displayName: p.display_name, characterName: character?.name ?? null, text: a.text },
      ];
    });
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

    if (external) return this.awaitOutsideDm(turn, input, actors, campaign.system_id);

    this.broadcast({ type: 'dm_start', turnId: turn.id });
    const own = chars.filter((c) => c.controller === 'agent');
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
    const llm = await resolveLlm('narration', campaign.owner_id);
    const prompt = await buildPrompt(info, input, ctx, pgStore);

    const result = await runAgentTurn({
      llm,
      task: 'narration',
      tools: gmTools({ sheets: !!info.gmSheets }),
      system: prompt.system,
      messages: prompt.messages,
      ctx,
      store: pgStore,
      maxRounds: cfg.AGENT_MAX_TOOL_ROUNDS,
      maxTokens: cfg.LLM_MAX_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(240_000),
      onText: (text) => this.broadcast({ type: 'dm_delta', turnId: turn.id, text }),
      onTool: (tool, summary) => {
        this.broadcast({ type: 'dm_tool', turnId: turn.id, tool, summary });
        if (STATE_TOOLS.has(tool)) this.broadcast({ type: 'state_changed' });
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

    await this.publish(result.text, ctx, turn.sessionId, turn.id);
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
    const ok = await this.desk.handOff(
      { id: turn.id, number: turn.number, sessionId: turn.sessionId, input, ctx, claimed: false },
      minutes * 60_000,
    );
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
    if (turn && !before) this.broadcast({ type: 'dm_start', turnId: turn.id });
    return turn;
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
      const { redacted } = await this.publish(text, turn.ctx, turn.sessionId, turn.id);
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
    const { redacted } = await this.publish(text, ctx, sessionId, null);
    this.broadcast({ type: 'dm_end', turnId: OPENING, ok: true });
    this.broadcast({ type: 'state_changed' });
    await refreshBrief(this.campaignId).catch(() => undefined);
    return { kind: 'opening', redacted };
  }

  /** Store and send a finished piece of narration, with anything secret blacked out. */
  private async publish(
    text: string,
    ctx: TurnContext,
    sessionId: string,
    turnId: string | null,
  ): Promise<{ redacted: boolean }> {
    const entities = await pgStore.entities(this.campaignId);
    const secrets = entities.flatMap((e) => (e.secret && !e.secretRevealed ? [e.secret] : []));
    const safe = redactSecrets(text, secrets);
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
    if (refs.length) await pgStore.markFirstSeen(this.campaignId, [...new Set(refs.map((r) => r.entityId))], message.id);
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
      tools: gmTools({ sheets: !!info.gmSheets }),
      system: prompt.system,
      messages: prompt.messages,
      ctx,
      store: pgStore,
      // Planning takes more steps than resolving a turn does.
      maxRounds: Math.max(cfg.AGENT_MAX_TOOL_ROUNDS, 12),
      maxTokens: cfg.LLM_MAX_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(300_000),
      onText: (text) => this.broadcast({ type: 'dm_delta', turnId: OPENING, text }),
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
    const row = await q1<{ settings: { gatherWindowSeconds?: number } }>(
      'SELECT settings FROM campaigns WHERE id = $1',
      [campaignId],
    );
    const seconds = row?.settings.gatherWindowSeconds ?? config().DEFAULT_GATHER_WINDOW_SECONDS;
    // Another connection may have created it while we were reading.
    room = rooms.get(campaignId) ?? new Room(campaignId, seconds * 1000);
    rooms.set(campaignId, room);
  }
  return room;
}

/** Forget empty, idle rooms. */
export function closeRoomIfEmpty(campaignId: string): void {
  const room = rooms.get(campaignId);
  if (room && room.sockets.size === 0 && !room.busy) rooms.delete(campaignId);
}

/** Turns left open by a restart can never finish; mark them so history is honest. */
export async function failStaleTurns(): Promise<void> {
  await q(
    `UPDATE turns SET status = 'failed', close_reason = 'restart' WHERE status IN ('collecting', 'resolving')`,
  );
}
