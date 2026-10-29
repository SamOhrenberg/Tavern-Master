import type { Citation, DiceRoll, EntityKind, InventoryItem, RuleHit } from '@tavern/protocol';
import { q, q1 } from '../db/pool.js';
import { searchRules } from '../rules/retrieve.js';

/** A player taking part in the turn being resolved. Built by the server, never by the model. */
export interface Actor {
  userId: string;
  displayName: string;
  characterName: string | null;
}

/**
 * Everything a tool is allowed to know about where it is running. Tools take
 * the campaign, system and acting players from here; none of these can be
 * supplied or overridden by tool arguments.
 */
export interface TurnContext {
  campaignId: string;
  systemId: string;
  turnId: string | null;
  actors: Actor[];
  /** Rules passages retrieved this turn, addressable as R1, R2… */
  citations: Citation[];
  rolls: DiceRoll[];
  stateChanged: boolean;
}

export interface CharRow {
  id: string;
  userId: string;
  name: string;
  hp: number;
  maxHp: number;
  tempHp: number;
  conditions: string[];
  inventory: InventoryItem[];
  sheet: Record<string, unknown>;
}

export interface EntityRow {
  id: string;
  kind: EntityKind;
  name: string;
  summary: string;
  status: string;
  secret: string | null;
  secretRevealed: boolean;
}

export interface EntityInput {
  kind: EntityKind;
  name: string;
  summary?: string;
  status?: string;
  secret?: string;
}

export interface StateEventInput {
  tool: string;
  targetType?: string;
  targetId?: string;
  summary: string;
  diff?: Record<string, unknown>;
}

/** The persistence the DM's tools need. Tests swap in an in-memory version. */
export interface GameStore {
  searchRules(systemId: string, query: string, k: number): Promise<RuleHit[]>;
  characters(campaignId: string): Promise<CharRow[]>;
  /** Writes vitals and inventory only. Name, sheet and private notes are not writable here. */
  saveCharacter(c: CharRow): Promise<void>;
  entities(campaignId: string): Promise<EntityRow[]>;
  upsertEntity(campaignId: string, e: EntityInput): Promise<{ id: string; created: boolean }>;
  revealSecret(campaignId: string, kind: EntityKind, name: string): Promise<string | undefined>;
  flags(campaignId: string): Promise<Record<string, unknown>>;
  setFlag(campaignId: string, key: string, value: unknown): Promise<void>;
  scene(campaignId: string): Promise<string>;
  setScene(campaignId: string, text: string): Promise<void>;
  remember(
    campaignId: string,
    m: { kind: 'fact' | 'thread' | 'promise'; content: string; importance: number },
  ): Promise<void>;
  recordRoll(ctx: TurnContext, roll: Omit<DiceRoll, 'id'>): Promise<string>;
  recordEvent(ctx: TurnContext, ev: StateEventInput): Promise<void>;
}

interface CharDb {
  id: string;
  user_id: string;
  name: string;
  hp: number;
  max_hp: number;
  temp_hp: number;
  conditions: string[];
  inventory: InventoryItem[];
  sheet: Record<string, unknown>;
}

export const pgStore: GameStore = {
  searchRules: (systemId, query, k) => searchRules(systemId, query, k),

  async characters(campaignId) {
    const rows = await q<CharDb>(
      `SELECT id, user_id, name, hp, max_hp, temp_hp, conditions, inventory, sheet
         FROM characters WHERE campaign_id = $1 ORDER BY created_at`,
      [campaignId],
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      hp: r.hp,
      maxHp: r.max_hp,
      tempHp: r.temp_hp,
      conditions: r.conditions,
      inventory: r.inventory,
      sheet: r.sheet,
    }));
  },

  async saveCharacter(c) {
    await q(
      `UPDATE characters SET hp = $2, temp_hp = $3, conditions = $4, inventory = $5, updated_at = now() WHERE id = $1`,
      [c.id, c.hp, c.tempHp, JSON.stringify(c.conditions), JSON.stringify(c.inventory)],
    );
  },

  async entities(campaignId) {
    const rows = await q(
      `SELECT id, kind, name, summary, status, secret, secret_revealed FROM entities
        WHERE campaign_id = $1 ORDER BY kind, name`,
      [campaignId],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      summary: r.summary,
      status: r.status,
      secret: r.secret,
      secretRevealed: r.secret_revealed,
    }));
  },

  async upsertEntity(campaignId, e) {
    const row = await q1<{ id: string; created: boolean }>(
      `INSERT INTO entities (campaign_id, kind, name, summary, status, secret)
       VALUES ($1, $2, $3, coalesce($4, ''), coalesce($5, ''), $6)
       ON CONFLICT (campaign_id, kind, lower(name)) DO UPDATE
         SET summary = coalesce($4, entities.summary), status = coalesce($5, entities.status),
             secret = coalesce($6, entities.secret), updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [campaignId, e.kind, e.name, e.summary ?? null, e.status ?? null, e.secret ?? null],
    );
    return row!;
  },

  async revealSecret(campaignId, kind, name) {
    const row = await q1<{ secret: string | null }>(
      `UPDATE entities SET secret_revealed = true, updated_at = now()
        WHERE campaign_id = $1 AND kind = $2 AND lower(name) = lower($3) AND secret IS NOT NULL RETURNING secret`,
      [campaignId, kind, name],
    );
    return row?.secret ?? undefined;
  },

  async flags(campaignId) {
    const rows = await q<{ key: string; value: unknown }>(
      'SELECT key, value FROM flags WHERE campaign_id = $1 ORDER BY key',
      [campaignId],
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  async setFlag(campaignId, key, value) {
    await q(
      `INSERT INTO flags (campaign_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (campaign_id, key) DO UPDATE SET value = $3, updated_at = now()`,
      [campaignId, key, JSON.stringify(value)],
    );
  },

  async scene(campaignId) {
    return (
      (await q1<{ scene: string }>('SELECT scene FROM campaigns WHERE id = $1', [campaignId]))?.scene ?? ''
    );
  },

  async setScene(campaignId, text) {
    await q('UPDATE campaigns SET scene = $2 WHERE id = $1', [campaignId, text]);
  },

  async remember(campaignId, m) {
    await q('INSERT INTO memories (campaign_id, kind, content, importance) VALUES ($1, $2, $3, $4)', [
      campaignId,
      m.kind,
      m.content,
      m.importance,
    ]);
  },

  async recordRoll(ctx, roll) {
    const row = await q1<{ id: string }>(
      `INSERT INTO dice_rolls (campaign_id, turn_id, expression, detail, total, reason, character_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        ctx.campaignId,
        ctx.turnId,
        roll.expression,
        JSON.stringify(roll.dice),
        roll.total,
        roll.reason,
        roll.character,
      ],
    );
    return row!.id;
  },

  async recordEvent(ctx, ev) {
    await q(
      `INSERT INTO state_events (campaign_id, turn_id, actor, tool, target_type, target_id, summary, diff)
       VALUES ($1, $2, 'dm', $3, $4, $5, $6, $7)`,
      [
        ctx.campaignId,
        ctx.turnId,
        ev.tool,
        ev.targetType ?? null,
        ev.targetId ?? null,
        ev.summary,
        JSON.stringify(ev.diff ?? {}),
      ],
    );
  },
};
