import type {
  CharacterController,
  CharacterKind,
  Citation,
  DiceRoll,
  EntityKind,
  HpChange,
  InventoryItem,
  RollKind,
  RuleHit,
  SheetSchema,
  StatLineFull,
} from '@tavern/protocol';
import { q, q1 } from '../db/pool.js';
import { campaignSchema, inventoryOf } from '../sheet-schema.js';
import { editMessage } from '../realtime/messages.js';
import { redactSecrets } from './loop.js';
import { mergeStatLines, readStatLines } from './codex.js';
import { npcPortraitUrl, sweepNpcPortraits } from '../npc-portraits.js';
import { keywordQuery, searchCampaignDocs, searchRules, searchSetting } from '../rules/retrieve.js';

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
  /** Party hit point changes made this turn, shown with the narration. */
  hp?: HpChange[];
  stateChanged: boolean;
  /** Requests sent to other AIs with ask_ai during this turn. */
  outsideAsks?: number;
}

export interface CharRow {
  id: string;
  name: string;
  kind: CharacterKind;
  controller: CharacterController;
  /** The players who run it; empty for AI-run characters. */
  playerIds: string[];
  hp: number;
  maxHp: number;
  tempHp: number;
  conditions: string[];
  inventory: InventoryItem[];
  sheet: Record<string, unknown>;
  persona: string;
  /** Where they are while the party is split up. Empty: with the party, in the current scene. */
  whereabouts: string;
  /** Storage name of the character's picture, if it has one. */
  portrait?: string | null;
  /** Who added them to the party. A player looks after a companion they made. */
  createdBy?: string | null;
}

export interface EntityRow {
  id: string;
  kind: EntityKind;
  name: string;
  aliases: string[];
  summary: string;
  article: string;
  status: string;
  secret: string | null;
  articleSecret: string | null;
  secretRevealed: boolean;
  firstSeenAt: string | null;
  inCodex: boolean;
  /** The stat block of a person or creature; hidden lines are spoilers. */
  sheet: StatLineFull[];
  /** Planned: the party has not met it yet. */
  hidden: boolean;
  /** Where to load its picture from; absent when it has none. */
  portrait?: string;
}

export interface EntityInput {
  kind: EntityKind;
  name: string;
  aliases?: string[];
  summary?: string;
  article?: string;
  status?: string;
  secret?: string;
  articleSecret?: string;
  /** Stat block lines to set, add or (with an empty value) remove, by label. */
  sheet?: { label: string; value: string; hidden?: boolean }[];
  hidden?: boolean;
}

export interface StateEventInput {
  tool: string;
  targetType?: string;
  targetId?: string;
  summary: string;
  diff?: Record<string, unknown>;
}

export interface NoteRow {
  title: string;
  content: string;
  updatedAt: Date;
}

/** One thing found in the campaign's own history. */
export interface RecallHit {
  where: string;
  text: string;
}

/** A roll the DM asks a player to make for their character. */
export interface RollAsk {
  characterId: string;
  expression: string;
  reason: string;
  kind: RollKind;
  /** What the roll must reach to succeed; null when it decides no pass or fail. */
  target?: number | null;
  /** Success means the target or lower. */
  under?: boolean;
}

/** The persistence the GM's tools need. Tests swap in an in-memory version. */
export interface GameStore {
  /** Library rulebooks of one system, plus that campaign's own house-rule documents. */
  searchRules(systemId: string, query: string, k: number, campaignId?: string): Promise<RuleHit[]>;
  /** Documents uploaded to this campaign. `tableOnly` leaves out anything marked for the GM alone. */
  searchDocuments(campaignId: string, query: string, k: number, tableOnly: boolean): Promise<RuleHit[]>;
  /** The system's setting/flavour material: voice and colour, never rules. */
  searchSetting(systemId: string, query: string, k: number): Promise<RuleHit[]>;
  characters(campaignId: string): Promise<CharRow[]>;
  /** Writes vitals and inventory only. Name, sheet and private notes are not writable here. */
  saveCharacter(c: CharRow): Promise<void>;
  /** Writes the sheet fields and maximum hit points: edit_sheet when the GM keeps the sheets, and adjust_track. */
  saveSheet(c: CharRow): Promise<void>;
  /** What a character sheet holds in this campaign: the version of its system's sheet it is on. */
  sheetSchema(campaignId: string): Promise<SheetSchema>;
  /** Set where party members are. An empty place puts them back with the party. */
  setWhereabouts(campaignId: string, places: { id: string; place: string }[]): Promise<void>;
  entities(campaignId: string): Promise<EntityRow[]>;
  upsertEntity(campaignId: string, e: EntityInput): Promise<{ id: string; created: boolean }>;
  revealSecret(campaignId: string, kind: EntityKind, name: string): Promise<string | undefined>;
  /** Show the players one hidden line of an entry's stat block. Returns its value, or undefined if there is no such hidden line. */
  revealLine(campaignId: string, kind: EntityKind, name: string, label: string): Promise<string | undefined>;
  /** Remove an entry. False when there is none by that name. */
  deleteEntity(campaignId: string, kind: EntityKind, name: string): Promise<boolean>;
  /** Remove a story flag. False when it was not set. */
  clearFlag(campaignId: string, key: string): Promise<boolean>;
  /**
   * Replace the text of the DM's newest narration (codex links worked out
   * again, and unrevealed secrets blacked out as in any narration). Returns its
   * message id, or null when nothing has been narrated.
   */
  amendLastNarration(campaignId: string, text: string): Promise<{ id: number; redacted: boolean } | null>;
  /** Stamp when players first met these entries, the first time each is referenced. */
  markFirstSeen(campaignId: string, entityIds: string[], messageId: number): Promise<void>;
  flags(campaignId: string): Promise<Record<string, unknown>>;
  setFlag(campaignId: string, key: string, value: unknown): Promise<void>;
  scene(campaignId: string): Promise<string>;
  setScene(campaignId: string, text: string): Promise<void>;
  remember(
    campaignId: string,
    m: { kind: 'fact' | 'thread' | 'promise'; content: string; importance: number },
  ): Promise<void>;
  notes(campaignId: string): Promise<NoteRow[]>;
  /** Create or replace a notebook page. Empty content removes it. */
  writeNote(campaignId: string, title: string, content: string): Promise<'created' | 'updated' | 'removed'>;
  /** Search what was actually said and done in past play. */
  recall(campaignId: string, query: string, k: number): Promise<RecallHit[]>;
  recordRoll(ctx: TurnContext, roll: Omit<DiceRoll, 'id'>): Promise<string>;
  /**
   * Ask the players of a player-run character to make a roll. Replaces any
   * request that character still has open. Returns the request's id.
   */
  requestRoll(ctx: TurnContext, req: RollAsk): Promise<string>;
  recordEvent(ctx: TurnContext, ev: StateEventInput): Promise<void>;
}

interface CharDb {
  id: string;
  name: string;
  kind: CharacterKind;
  controller: CharacterController;
  player_ids: string[];
  hp: number;
  max_hp: number;
  temp_hp: number;
  conditions: string[];
  inventory: InventoryItem[];
  sheet: Record<string, unknown>;
  persona: string;
  whereabouts: string;
  portrait: string | null;
  created_by: string | null;
}

export const MAX_NOTES = 24;

export const pgStore: GameStore = {
  searchRules: (systemId, query, k, campaignId) => searchRules(systemId, query, k, undefined, campaignId),
  searchDocuments: (campaignId, query, k, tableOnly) => searchCampaignDocs(campaignId, query, k, tableOnly),
  searchSetting: (systemId, query, k) => searchSetting(systemId, query, k),
  sheetSchema: (campaignId) => campaignSchema(campaignId),

  async characters(campaignId) {
    // A sheet with its own inventory list holds the inventory there.
    const schema = await campaignSchema(campaignId);
    const rows = await q<CharDb>(
      `SELECT c.id, c.name, c.kind, c.controller, c.hp, c.max_hp, c.temp_hp, c.conditions, c.inventory,
              c.sheet, c.persona, c.whereabouts, c.portrait, c.created_by::text AS created_by,
              coalesce((SELECT array_agg(p.user_id::text ORDER BY p.user_id)
                          FROM character_players p WHERE p.character_id = c.id), '{}') AS player_ids
         FROM characters c WHERE c.campaign_id = $1 ORDER BY c.created_at, c.id`,
      [campaignId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      controller: r.controller,
      playerIds: r.controller === 'player' ? r.player_ids : [],
      hp: r.hp,
      maxHp: r.max_hp,
      tempHp: r.temp_hp,
      conditions: r.conditions,
      inventory: inventoryOf(schema, r.sheet, r.inventory),
      sheet: r.sheet,
      persona: r.persona,
      whereabouts: r.whereabouts,
      portrait: r.portrait,
      createdBy: r.created_by,
    }));
  },

  async setWhereabouts(campaignId, places) {
    for (const p of places) {
      await q('UPDATE characters SET whereabouts = $3 WHERE id = $1 AND campaign_id = $2', [
        p.id,
        campaignId,
        p.place,
      ]);
    }
  },

  async saveCharacter(c) {
    await q(
      `UPDATE characters SET hp = $2, temp_hp = $3, conditions = $4, inventory = $5, updated_at = now() WHERE id = $1`,
      [c.id, c.hp, c.tempHp, JSON.stringify(c.conditions), JSON.stringify(c.inventory)],
    );
  },

  async saveSheet(c) {
    await q(
      `UPDATE characters SET sheet = $2, max_hp = $3, hp = least(hp, $3), updated_at = now() WHERE id = $1`,
      [c.id, JSON.stringify(c.sheet), c.maxHp],
    );
  },

  async entities(campaignId) {
    const rows = await q(
      `SELECT id, kind, name, aliases, summary, article, status, secret, article_secret,
              secret_revealed, first_seen_message_id, in_codex, sheet, hidden,
              (SELECT m.created_at FROM messages m WHERE m.id = entities.first_seen_message_id) AS first_seen_at,
              (SELECT p.portrait FROM npc_portraits p WHERE p.entity_id = entities.id) AS portrait
         FROM entities
        WHERE campaign_id = $1 ORDER BY kind, name`,
      [campaignId],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      aliases: Array.isArray(r.aliases) ? r.aliases : [],
      summary: r.summary,
      article: r.article,
      status: r.status,
      secret: r.secret,
      articleSecret: r.article_secret,
      secretRevealed: r.secret_revealed,
      firstSeenAt: r.first_seen_at ? r.first_seen_at.toISOString() : null,
      inCodex: r.in_codex,
      sheet: readStatLines(r.sheet),
      hidden: r.hidden,
      ...(r.portrait ? { portrait: npcPortraitUrl(campaignId, r.id, r.portrait) } : {}),
    }));
  },

  async upsertEntity(campaignId, e) {
    // Stat block lines merge into what is there, so the DM can change one line at a time.
    let sheet: StatLineFull[] | null = null;
    if (e.sheet) {
      const had = await q1<{ sheet: unknown }>(
        'SELECT sheet FROM entities WHERE campaign_id = $1 AND kind = $2 AND lower(name) = lower($3)',
        [campaignId, e.kind, e.name],
      );
      sheet = mergeStatLines(readStatLines(had?.sheet), e.sheet);
    }
    const row = await q1<{ id: string; created: boolean }>(
      `INSERT INTO entities (campaign_id, kind, name, aliases, summary, article, status, secret, article_secret, sheet, hidden)
       VALUES ($1, $2, $3, coalesce($4, '[]'::jsonb), coalesce($5, ''), coalesce($6, ''), coalesce($7, ''), $8, $9,
               coalesce($10, '[]'::jsonb), coalesce($11, false))
       ON CONFLICT (campaign_id, kind, lower(name)) DO UPDATE
         SET aliases = coalesce($4, entities.aliases), summary = coalesce($5, entities.summary),
             article = coalesce($6, entities.article), status = coalesce($7, entities.status),
             secret = coalesce($8, entities.secret), article_secret = coalesce($9, entities.article_secret),
             sheet = coalesce($10, entities.sheet), hidden = coalesce($11, entities.hidden),
             updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [
        campaignId,
        e.kind,
        e.name,
        e.aliases ? JSON.stringify(e.aliases) : null,
        e.summary ?? null,
        e.article ?? null,
        e.status ?? null,
        e.secret ?? null,
        e.articleSecret ?? null,
        sheet ? JSON.stringify(sheet) : null,
        e.hidden ?? null,
      ],
    );
    return row!;
  },

  async revealLine(campaignId, kind, name, label) {
    const row = await q1<{ id: string; sheet: unknown }>(
      'SELECT id, sheet FROM entities WHERE campaign_id = $1 AND kind = $2 AND lower(name) = lower($3)',
      [campaignId, kind, name],
    );
    if (!row) return undefined;
    const lines = readStatLines(row.sheet);
    const line = lines.find((l) => l.hidden && l.label.toLowerCase() === label.trim().toLowerCase());
    if (!line) return undefined;
    line.hidden = false;
    await q('UPDATE entities SET sheet = $2, updated_at = now() WHERE id = $1', [
      row.id,
      JSON.stringify(lines),
    ]);
    return line.value;
  },

  async revealSecret(campaignId, kind, name) {
    const row = await q1<{ secret: string | null }>(
      `UPDATE entities SET secret_revealed = true, updated_at = now()
        WHERE campaign_id = $1 AND kind = $2 AND lower(name) = lower($3) AND secret IS NOT NULL RETURNING secret`,
      [campaignId, kind, name],
    );
    return row?.secret ?? undefined;
  },

  async markFirstSeen(campaignId, entityIds, messageId) {
    if (entityIds.length === 0) return;
    await q(
      // Named in narration: the party has met it, so a planned entry is shown from now on.
      `UPDATE entities SET first_seen_message_id = coalesce(first_seen_message_id, $3), hidden = false
        WHERE campaign_id = $1 AND id = ANY($2::uuid[])
          AND (first_seen_message_id IS NULL OR hidden)`,
      [campaignId, entityIds, messageId],
    );
  },

  async flags(campaignId) {
    const rows = await q<{ key: string; value: unknown }>(
      'SELECT key, value FROM flags WHERE campaign_id = $1 ORDER BY key',
      [campaignId],
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  async deleteEntity(campaignId, kind, name) {
    const rows = await q(
      'DELETE FROM entities WHERE campaign_id = $1 AND kind = $2 AND lower(name) = lower($3) RETURNING id',
      [campaignId, kind, name],
    );
    if (rows.length) await sweepNpcPortraits(campaignId);
    return rows.length > 0;
  },

  async clearFlag(campaignId, key) {
    const rows = await q('DELETE FROM flags WHERE campaign_id = $1 AND key = $2 RETURNING key', [
      campaignId,
      key,
    ]);
    return rows.length > 0;
  },

  async amendLastNarration(campaignId, text) {
    const last = await q1<{ id: number }>(
      `SELECT id FROM messages WHERE campaign_id = $1 AND kind = 'dm' ORDER BY id DESC LIMIT 1`,
      [campaignId],
    );
    if (!last) return null;
    // The same check every narration goes through: an unrevealed secret is blacked out, and a
    // codex entry the rewrite names counts as met from here.
    const entities = await this.entities(campaignId);
    const secrets = entities.flatMap((e) => (e.secret && !e.secretRevealed ? [e.secret] : []));
    const safe = redactSecrets(text, secrets);
    const message = await editMessage(last.id, safe.text || '…', entities, { redacted: safe.redacted });
    const refs = [...new Set((message.refs ?? []).map((r) => r.entityId))];
    if (refs.length) await this.markFirstSeen(campaignId, refs, last.id);
    return { id: last.id, redacted: safe.redacted };
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

  async notes(campaignId) {
    const rows = await q<{ title: string; content: string; updated_at: Date }>(
      'SELECT title, content, updated_at FROM gm_notes WHERE campaign_id = $1 ORDER BY created_at',
      [campaignId],
    );
    return rows.map((r) => ({ title: r.title, content: r.content, updatedAt: r.updated_at }));
  },

  async writeNote(campaignId, title, content) {
    if (!content.trim()) {
      await q('DELETE FROM gm_notes WHERE campaign_id = $1 AND lower(title) = lower($2)', [
        campaignId,
        title,
      ]);
      return 'removed';
    }
    const row = await q1<{ created: boolean }>(
      `INSERT INTO gm_notes (campaign_id, title, content) VALUES ($1, $2, $3)
       ON CONFLICT (campaign_id, lower(title)) DO UPDATE SET content = $3, updated_at = now()
       RETURNING (xmax = 0) AS created`,
      [campaignId, title, content],
    );
    return row?.created ? 'created' : 'updated';
  },

  async recall(campaignId, query, k) {
    const tsq = keywordQuery(query);
    if (!tsq) return [];
    // The predicate matches the partial index on messages exactly.
    const rows = await q<{
      kind: 'action' | 'dm';
      who: string | null;
      turn: number | null;
      session: number | null;
      snippet: string;
    }>(
      `SELECT hit.kind, hit.who, t.number AS turn, s.number AS session,
              ts_headline('english', hit.content, to_tsquery('english', $2),
                          'MaxFragments=2, MaxWords=45, MinWords=20, StartSel="", StopSel="", FragmentDelimiter=" … "')
                AS snippet
         FROM (SELECT m.id, m.kind, m.content, m.turn_id, m.session_id,
                      coalesce(m.character_name, u.display_name) AS who
                 FROM messages m LEFT JOIN users u ON u.id = m.user_id
                WHERE m.campaign_id = $1 AND m.kind IN ('action', 'dm')
                  AND to_tsvector('english', m.content) @@ to_tsquery('english', $2)
                ORDER BY ts_rank_cd(to_tsvector('english', m.content), to_tsquery('english', $2)) DESC, m.id DESC
                LIMIT $3) hit
         LEFT JOIN turns t ON t.id = hit.turn_id
         LEFT JOIN play_sessions s ON s.id = hit.session_id
        ORDER BY hit.id`,
      [campaignId, tsq, k],
    );
    return rows.map((r) => ({
      where: [
        r.session ? `session ${r.session}` : '',
        r.turn ? `turn ${r.turn}` : '',
        r.kind === 'dm' ? 'narration' : (r.who ?? 'a player'),
      ]
        .filter(Boolean)
        .join(', '),
      text: r.snippet,
    }));
  },

  async requestRoll(ctx, req) {
    // One open request per character: a new one replaces what it was asked before.
    await q(
      `UPDATE roll_requests SET status = 'dropped', closed_at = now()
        WHERE campaign_id = $1 AND character_id = $2 AND status = 'pending'`,
      [ctx.campaignId, req.characterId],
    );
    const row = await q1<{ id: string }>(
      // Hidden until the narration that asks for it is posted (see Room.publish).
      `INSERT INTO roll_requests (campaign_id, character_id, expression, reason, kind, turn_id, shown, target, roll_under)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8) RETURNING id`,
      [
        ctx.campaignId,
        req.characterId,
        req.expression,
        req.reason,
        req.kind,
        ctx.turnId,
        req.target ?? null,
        req.under ?? false,
      ],
    );
    return row!.id;
  },

  async recordRoll(ctx, roll) {
    const row = await q1<{ id: string }>(
      `INSERT INTO dice_rolls (campaign_id, turn_id, expression, detail, total, reason, character_name, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        ctx.campaignId,
        ctx.turnId,
        roll.expression,
        JSON.stringify(roll.dice),
        roll.total,
        roll.reason,
        roll.character,
        roll.kind,
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
