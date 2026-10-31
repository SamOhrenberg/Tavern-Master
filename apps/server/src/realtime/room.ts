import type { ServerMessage, TurnState, UserRef } from '@tavern/protocol';
import type { WebSocket } from 'ws';
import { buildPrompt, type TurnAction } from '../agent/context.js';
import { redactSecrets, runAgentTurn, usedCitations } from '../agent/loop.js';
import { pgStore, type Actor, type TurnContext } from '../agent/store.js';
import { maybeQueueSummary } from '../agent/summarize.js';
import { config } from '../config.js';
import { q, q1 } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { LlmNotConfigured, resolveLlm } from '../llm/index.js';
import { budgetBlock, recordUsage } from '../llm/usage.js';
import { log } from '../log.js';
import { insertMessage } from './messages.js';
import { TurnCollector, type ClosedTurn, type CollectedAction } from './turns.js';

const SESSION_GAP_HOURS = 6;
const STATE_TOOLS = new Set([
  'update_character',
  'modify_inventory',
  'upsert_entity',
  'reveal_secret',
  'set_flag',
  'set_scene',
]);

interface ActiveTurn {
  id: string;
  number: number;
  sessionId: string;
}

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
  await enqueue('summarize_campaign', { campaignId, sessionId });
}

/** One campaign's live table: who is connected, the turn being gathered, and the DM's reply in flight. */
export class Room {
  readonly sockets = new Map<WebSocket, UserRef>();
  readonly collector: TurnCollector;
  private turn: ActiveTurn | null = null;
  private chain: Promise<void> = Promise.resolve();

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

  present(): UserRef[] {
    const seen = new Map<string, UserRef>();
    for (const u of this.sockets.values()) seen.set(u.id, u);
    return [...seen.values()];
  }

  turnState(): TurnState {
    return this.collector.snapshot(this.turn?.number ?? null);
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

  join(ws: WebSocket, user: UserRef): void {
    this.sockets.set(ws, user);
    this.collector.setPresent(this.present().map((u) => u.id));
    ws.send(
      JSON.stringify({
        type: 'hello',
        you: user,
        present: this.present(),
        turn: this.turnState(),
      } satisfies ServerMessage),
    );
    this.broadcast({ type: 'presence', present: this.present() });
  }

  leave(ws: WebSocket): void {
    if (!this.sockets.delete(ws)) return;
    this.collector.setPresent(this.present().map((u) => u.id));
    this.broadcast({ type: 'presence', present: this.present() });
    this.broadcast({ type: 'turn', turn: this.turnState() });
  }

  /** Drop every connection of a user (removed from the campaign, session revoked). */
  kick(userId: string): void {
    for (const [ws, u] of this.sockets) if (u.id === userId) ws.close(4403, 'access removed');
  }

  action(user: UserRef, text: string): Promise<void> {
    return this.run(() => this.submit({ userId: user.id, text }));
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
      const character = await q1<{ name: string }>(
        'SELECT name FROM characters WHERE campaign_id = $1 AND user_id = $2',
        [this.campaignId, action.userId],
      );
      const message = await insertMessage({
        campaignId: this.campaignId,
        sessionId: turn?.sessionId ?? null,
        turnId: turn?.id ?? null,
        kind: 'action',
        userId: action.userId,
        characterName: character?.name ?? null,
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

  pass(user: UserRef): void {
    if (this.collector.pass(user.id)) this.broadcast({ type: 'turn', turn: this.turnState() });
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
      this.turn = null;
      const held = this.collector.resolved();
      this.broadcast({ type: 'turn', turn: this.turnState() });
      for (const action of held) await this.submit(action);
    });
    if (ok)
      void maybeQueueSummary(this.campaignId).catch((err) => log().warn({ err }, 'could not queue summary'));
  }

  private async narrate(turn: ActiveTurn, closed: ClosedTurn): Promise<boolean> {
    const cfg = config();
    const campaign = await q1<{
      name: string;
      premise: string;
      settings: { tone?: string };
      owner_id: string;
      system_id: string;
      system_name: string;
    }>(
      `SELECT c.name, c.premise, c.settings, c.owner_id, c.system_id, s.name AS system_name
         FROM campaigns c JOIN game_systems s ON s.id = c.system_id WHERE c.id = $1`,
      [this.campaignId],
    );
    if (!campaign) throw new Error('campaign not found');

    const participantIds = [...new Set([...closed.actions.map((a) => a.userId), ...closed.passed])];
    const people = await q<{ id: string; display_name: string; character: string | null }>(
      `SELECT u.id, u.display_name, ch.name AS character
         FROM campaign_members m JOIN users u ON u.id = m.user_id
         LEFT JOIN characters ch ON ch.campaign_id = m.campaign_id AND ch.user_id = m.user_id
        WHERE m.campaign_id = $1 AND u.id = ANY($2::uuid[])`,
      [this.campaignId, participantIds],
    );
    const byId = new Map(people.map((p) => [p.id, p]));
    // Only current members count: someone removed mid-turn is dropped here.
    const actors: Actor[] = people.map((p) => ({
      userId: p.id,
      displayName: p.display_name,
      characterName: p.character,
    }));
    const actions: TurnAction[] = closed.actions.flatMap((a) => {
      const p = byId.get(a.userId);
      return p
        ? [{ userId: p.id, displayName: p.display_name, characterName: p.character, text: a.text }]
        : [];
    });
    const actingIds = [...new Set(actions.map((a) => a.userId))];
    if (!actions.length) return false;

    const blocked = await budgetBlock(this.campaignId, actingIds);
    if (blocked) {
      await this.system(blocked, turn);
      return false;
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
    const prompt = await buildPrompt(
      {
        id: this.campaignId,
        name: campaign.name,
        premise: campaign.premise,
        tone: campaign.settings.tone ?? '',
        systemName: campaign.system_name,
      },
      {
        number: turn.number,
        actions,
        passed: closed.passed.flatMap((id) => {
          const p = byId.get(id);
          return p ? [{ displayName: p.display_name, characterName: p.character }] : [];
        }),
      },
      ctx,
      pgStore,
    );

    this.broadcast({ type: 'dm_start', turnId: turn.id });
    const result = await runAgentTurn({
      llm,
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

    const secrets = (await pgStore.entities(this.campaignId)).flatMap((e) =>
      e.secret && !e.secretRevealed ? [e.secret] : [],
    );
    const safe = redactSecrets(result.text, secrets);
    const message = await insertMessage({
      campaignId: this.campaignId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      kind: 'dm',
      userId: null,
      content: safe.text || '…',
      meta: {
        citations: usedCitations(safe.text, ctx.citations),
        rolls: ctx.rolls,
        ...(safe.redacted ? { redacted: true } : {}),
      },
    });
    this.broadcast({ type: 'message', message });
    if (ctx.stateChanged) this.broadcast({ type: 'state_changed' });
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
