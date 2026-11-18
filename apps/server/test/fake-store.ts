import type { RuleHit, SheetSchema } from '@tavern/protocol';
import { EMPTY_SCHEMA } from '../src/sheet-schema.js';
import type {
  CharRow,
  EntityRow,
  GameStore,
  NoteRow,
  RecallHit,
  RollAsk,
  StateEventInput,
  TurnContext,
} from '../src/agent/store.js';

/** In-memory GameStore for tests. Rules are keyed by system so scoping can be asserted. */
export class FakeStore implements GameStore {
  chars: CharRow[] = [];
  ents: EntityRow[] = [];
  flagMap: Record<string, unknown> = {};
  sceneText = '';
  memories: string[] = [];
  pages: NoteRow[] = [];
  events: StateEventInput[] = [];
  searches: { systemId: string; query: string }[] = [];
  docSearches: { campaignId: string; query: string; tableOnly: boolean }[] = [];
  rules: Record<string, RuleHit[]> = {};
  /** Campaign documents. `gmOnly` ones are left out of table-only searches. */
  docs: (RuleHit & { gmOnly?: boolean })[] = [];
  /** Setting/flavour material, keyed by system. */
  settingDocs: Record<string, RuleHit[]> = {};
  settingSearches: { systemId: string; query: string }[] = [];
  record: RecallHit[] = [];

  async searchRules(systemId: string, query: string, k: number) {
    this.searches.push({ systemId, query });
    return (this.rules[systemId] ?? []).slice(0, k);
  }
  async searchDocuments(campaignId: string, query: string, k: number, tableOnly: boolean) {
    this.docSearches.push({ campaignId, query, tableOnly });
    return this.docs.filter((d) => !(tableOnly && d.gmOnly)).slice(0, k);
  }
  async searchSetting(systemId: string, query: string, k: number) {
    this.settingSearches.push({ systemId, query });
    return (this.settingDocs[systemId] ?? []).slice(0, k);
  }
  async characters() {
    return this.chars.map((c) => ({
      ...c,
      conditions: [...c.conditions],
      inventory: c.inventory.map((i) => ({ ...i })),
      sheet: { ...c.sheet },
    }));
  }
  async saveCharacter(c: CharRow) {
    // Vitals and inventory only, like the real store.
    this.chars = this.chars.map((x) =>
      x.id === c.id
        ? { ...x, hp: c.hp, tempHp: c.tempHp, conditions: c.conditions, inventory: c.inventory }
        : x,
    );
  }
  async setWhereabouts(_campaignId: string, places: { id: string; place: string }[]) {
    for (const p of places)
      this.chars = this.chars.map((x) => (x.id === p.id ? { ...x, whereabouts: p.place } : x));
  }
  /** Tests that care about field shapes set one; otherwise every value is free-form. */
  schema: SheetSchema = EMPTY_SCHEMA;
  async sheetSchema() {
    return this.schema;
  }
  async saveSheet(c: CharRow) {
    this.chars = this.chars.map((x) =>
      x.id === c.id ? { ...x, sheet: c.sheet, maxHp: c.maxHp, hp: Math.min(x.hp, c.maxHp) } : x,
    );
  }
  async entities() {
    return this.ents;
  }
  async upsertEntity(
    _campaignId: string,
    e: {
      kind: EntityRow['kind'];
      name: string;
      aliases?: string[];
      summary?: string;
      article?: string;
      status?: string;
      secret?: string;
      articleSecret?: string;
    },
  ) {
    const found = this.ents.find((x) => x.kind === e.kind && x.name.toLowerCase() === e.name.toLowerCase());
    if (found) {
      Object.assign(found, {
        aliases: e.aliases ?? found.aliases,
        summary: e.summary ?? found.summary,
        article: e.article ?? found.article,
        status: e.status ?? found.status,
        secret: e.secret ?? found.secret,
        articleSecret: e.articleSecret ?? found.articleSecret,
      });
      return { id: found.id, created: false };
    }
    const id = `e${this.ents.length + 1}`;
    this.ents.push({
      id,
      kind: e.kind,
      name: e.name,
      aliases: e.aliases ?? [],
      summary: e.summary ?? '',
      article: e.article ?? '',
      status: e.status ?? '',
      secret: e.secret ?? null,
      articleSecret: e.articleSecret ?? null,
      secretRevealed: false,
      firstSeenAt: null,
      inCodex: true,
    });
    return { id, created: true };
  }
  async markFirstSeen(_campaignId: string, entityIds: string[], _messageId: number) {
    for (const e of this.ents)
      if (entityIds.includes(e.id) && !e.firstSeenAt) e.firstSeenAt = '2026-01-01T00:00:00.000Z';
  }
  async revealSecret(_campaignId: string, kind: EntityRow['kind'], name: string) {
    const found = this.ents.find(
      (x) => x.kind === kind && x.name.toLowerCase() === name.toLowerCase() && x.secret,
    );
    if (!found) return undefined;
    found.secretRevealed = true;
    return found.secret ?? undefined;
  }
  async flags() {
    return this.flagMap;
  }
  /** The DM's narrations, newest last, for correct_narration. */
  narrations: string[] = [];
  async deleteEntity(_campaignId: string, kind: EntityRow['kind'], name: string) {
    const before = this.ents.length;
    this.ents = this.ents.filter((x) => !(x.kind === kind && x.name.toLowerCase() === name.toLowerCase()));
    return this.ents.length < before;
  }
  async clearFlag(_campaignId: string, key: string) {
    if (!(key in this.flagMap)) return false;
    delete this.flagMap[key];
    return true;
  }
  async amendLastNarration(_campaignId: string, text: string) {
    if (!this.narrations.length) return null;
    this.narrations[this.narrations.length - 1] = text;
    return { id: this.narrations.length, redacted: false };
  }
  async setFlag(_campaignId: string, key: string, value: unknown) {
    this.flagMap[key] = value;
  }
  async scene() {
    return this.sceneText;
  }
  async setScene(_campaignId: string, text: string) {
    this.sceneText = text;
  }
  async remember(_campaignId: string, m: { content: string }) {
    this.memories.push(m.content);
  }
  async notes() {
    return this.pages;
  }
  async writeNote(_campaignId: string, title: string, content: string) {
    const at = this.pages.findIndex((p) => p.title.toLowerCase() === title.toLowerCase());
    if (!content.trim()) {
      if (at >= 0) this.pages.splice(at, 1);
      return 'removed' as const;
    }
    const page = { title, content, updatedAt: new Date() };
    if (at >= 0) {
      this.pages[at] = page;
      return 'updated' as const;
    }
    this.pages.push(page);
    return 'created' as const;
  }
  async recall(_campaignId: string, _query: string, k: number) {
    return this.record.slice(0, k);
  }
  asks: (RollAsk & { turnId: string | null })[] = [];
  async requestRoll(ctx: TurnContext, req: RollAsk) {
    this.asks = this.asks.filter((a) => a.characterId !== req.characterId);
    this.asks.push({ ...req, turnId: ctx.turnId });
    return `ask-${this.asks.length}`;
  }
  async recordRoll() {
    return `roll-${Math.random().toString(36).slice(2, 8)}`;
  }
  async recordEvent(_ctx: TurnContext, ev: StateEventInput) {
    this.events.push(ev);
  }
}

/** A party member. Pass `playerIds` for one a player runs, or `controller` for an AI-run one. */
export function character(over: Partial<CharRow> & Pick<CharRow, 'id' | 'name'>): CharRow {
  return {
    kind: 'pc',
    controller: 'player',
    playerIds: [],
    hp: 10,
    maxHp: 10,
    tempHp: 0,
    conditions: [],
    inventory: [],
    sheet: {},
    persona: '',
    whereabouts: '',
    ...over,
  };
}

export function context(over: Partial<TurnContext> = {}): TurnContext {
  return {
    campaignId: 'camp-1',
    systemId: 'sys-a',
    turnId: null,
    actors: [{ userId: 'u-ann', displayName: 'Ann', characterName: 'Thorn' }],
    citations: [],
    rolls: [],
    stateChanged: false,
    ...over,
  };
}

export function hit(chunkId: number, text: string, document = 'Core Rules'): RuleHit {
  return { chunkId, document, heading: 'Combat', page: 12, text, score: 1 };
}
