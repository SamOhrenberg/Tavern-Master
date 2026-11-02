import type { RuleHit } from '@tavern/protocol';
import type { CharRow, EntityRow, GameStore, StateEventInput, TurnContext } from '../src/agent/store.js';

/** In-memory GameStore for tests. Rules are keyed by system so scoping can be asserted. */
export class FakeStore implements GameStore {
  chars: CharRow[] = [];
  ents: EntityRow[] = [];
  flagMap: Record<string, unknown> = {};
  sceneText = '';
  memories: string[] = [];
  events: StateEventInput[] = [];
  searches: { systemId: string; query: string }[] = [];
  rules: Record<string, RuleHit[]> = {};

  async searchRules(systemId: string, query: string, k: number) {
    this.searches.push({ systemId, query });
    return (this.rules[systemId] ?? []).slice(0, k);
  }
  async characters() {
    return this.chars.map((c) => ({
      ...c,
      conditions: [...c.conditions],
      inventory: c.inventory.map((i) => ({ ...i })),
    }));
  }
  async saveCharacter(c: CharRow) {
    this.chars = this.chars.map((x) => (x.id === c.id ? { ...c } : x));
  }
  async entities() {
    return this.ents;
  }
  async upsertEntity(
    _campaignId: string,
    e: { kind: EntityRow['kind']; name: string; summary?: string; status?: string; secret?: string },
  ) {
    const found = this.ents.find((x) => x.kind === e.kind && x.name.toLowerCase() === e.name.toLowerCase());
    if (found) {
      Object.assign(found, {
        summary: e.summary ?? found.summary,
        status: e.status ?? found.status,
        secret: e.secret ?? found.secret,
      });
      return { id: found.id, created: false };
    }
    const id = `e${this.ents.length + 1}`;
    this.ents.push({
      id,
      kind: e.kind,
      name: e.name,
      summary: e.summary ?? '',
      status: e.status ?? '',
      secret: e.secret ?? null,
      secretRevealed: false,
    });
    return { id, created: true };
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
  async recordRoll() {
    return `roll-${Math.random().toString(36).slice(2, 8)}`;
  }
  async recordEvent(_ctx: TurnContext, ev: StateEventInput) {
    this.events.push(ev);
  }
}

export function character(over: Partial<CharRow> & Pick<CharRow, 'id' | 'userId' | 'name'>): CharRow {
  return { hp: 10, maxHp: 10, tempHp: 0, conditions: [], inventory: [], sheet: {}, ...over };
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
