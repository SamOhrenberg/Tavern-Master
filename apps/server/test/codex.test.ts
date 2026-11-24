import { describe, expect, it } from 'vitest';
import {
  entityMatches,
  fullEntity,
  mergeStatLines,
  playerVisible,
  resolveRefs,
  scopeEntity,
} from '../src/agent/codex.js';
import type { EntityRow } from '../src/agent/store.js';

const row = (over: Partial<EntityRow> = {}): EntityRow => ({
  id: 'e1',
  kind: 'npc',
  name: 'Captain Vane',
  aliases: ['The Grey Wolf'],
  summary: 'A privateer who drinks at the Salt Hound.',
  article: 'Vane runs the harbour trade and owes the party a favour.',
  status: 'ally',
  secret: 'Secretly working for the Syndicate.',
  articleSecret: 'His manifest lists the stolen crown.',
  secretRevealed: false,
  firstSeenAt: '2026-11-12T00:00:00.000Z',
  inCodex: true,
  sheet: [],
  hidden: false,
  inScene: false,
  ...over,
});

describe('scopeEntity', () => {
  it('ships player-visible fields and withholds unrevealed secrets from everyone', () => {
    const e = scopeEntity(row());
    expect(e.name).toBe('Captain Vane');
    expect(e.aliases).toEqual(['The Grey Wolf']);
    expect(e.article).toContain('harbour trade');
    expect(e.firstSeenAt).toBe('2026-11-12T00:00:00.000Z');
    expect(e.secret).toBeUndefined();
    expect(e.articleSecret).toBeUndefined();
    expect(e.secretRevealed).toBe(false);
  });

  it('ships the secret and its article extension once revealed', () => {
    const e = scopeEntity(row({ secretRevealed: true }));
    expect(e.secret).toBe('Secretly working for the Syndicate.');
    expect(e.articleSecret).toBe('His manifest lists the stolen crown.');
  });

  it('omits an absent article extension even when revealed', () => {
    const e = scopeEntity(row({ secretRevealed: true, articleSecret: null }));
    expect(e.secret).toBeDefined();
    expect(e.articleSecret).toBeUndefined();
  });

  it('never ships a secret on an entry that has none', () => {
    const e = scopeEntity(row({ secret: null, articleSecret: null, secretRevealed: true }));
    expect(e.secret).toBeUndefined();
    expect(e.articleSecret).toBeUndefined();
  });
});

describe('entityMatches', () => {
  it('matches on name, alias, summary and article, case-insensitively', () => {
    expect(entityMatches(row(), 'vane')).toBe(true);
    expect(entityMatches(row(), 'grey wolf')).toBe(true);
    expect(entityMatches(row(), 'salt hound')).toBe(true);
    expect(entityMatches(row(), 'harbour')).toBe(true);
  });

  it('does not match on hidden fields', () => {
    expect(entityMatches(row(), 'syndicate')).toBe(false);
    expect(entityMatches(row(), 'stolen crown')).toBe(false);
  });

  it('an empty query matches everything', () => {
    expect(entityMatches(row(), '')).toBe(true);
    expect(entityMatches(row(), '   ')).toBe(true);
  });
});

describe('resolveRefs', () => {
  const world = [
    row({ id: 'e1', name: 'Captain Vane', aliases: ['The Grey Wolf'] }),
    row({ id: 'e2', kind: 'location', name: 'Salt Hound', aliases: [] }),
    row({ id: 'e3', kind: 'term', name: 'Hidden Vault', aliases: [], inCodex: false }),
  ];

  it('keeps a marker that hits by name and records the ref', () => {
    const { content, refs } = resolveRefs('You meet [[Captain Vane]] at dusk.', world);
    expect(content).toBe('You meet [[Captain Vane]] at dusk.');
    expect(refs).toEqual([{ text: 'Captain Vane', entityId: 'e1', name: 'Captain Vane', kind: 'npc' }]);
  });

  it('resolves an alias to its canonical entry, case-insensitively', () => {
    const { refs } = resolveRefs('A shadow — [[the grey wolf]] — watches.', world);
    expect(refs).toEqual([{ text: 'the grey wolf', entityId: 'e1', name: 'Captain Vane', kind: 'npc' }]);
  });

  it('strips a marker that matches nothing back to plain text', () => {
    const { content, refs } = resolveRefs('The [[Nowhere Inn]] is quiet.', world);
    expect(content).toBe('The Nowhere Inn is quiet.');
    expect(refs).toEqual([]);
  });

  it('does not resolve an entry kept out of the codex', () => {
    const { content, refs } = resolveRefs('Beyond the [[Hidden Vault]].', world);
    expect(content).toBe('Beyond the Hidden Vault.');
    expect(refs).toEqual([]);
  });

  it('dedupes repeats but links every occurrence', () => {
    const { content, refs } = resolveRefs('[[Captain Vane]] nods. [[Captain Vane]] leaves.', world);
    expect(content).toBe('[[Captain Vane]] nods. [[Captain Vane]] leaves.');
    expect(refs).toHaveLength(1);
  });
});

describe('stat blocks for people and creatures', () => {
  const sheet = [
    { label: 'Armor Class', value: '13', hidden: false },
    { label: 'True name', value: 'Mordath the Unbound', hidden: true },
  ];

  it('sends players only the lines they have learned, and owners everything', () => {
    expect(scopeEntity(row({ sheet })).sheet).toEqual([{ label: 'Armor Class', value: '13' }]);
    const full = fullEntity(row({ sheet, hidden: true }));
    expect(full.sheet).toEqual(sheet);
    expect(full).toMatchObject({ hidden: true, secret: 'Secretly working for the Syndicate.' });
  });

  it('keeps planned entries the party has not met away from players', () => {
    expect(playerVisible(row())).toBe(true);
    expect(playerVisible(row({ hidden: true }))).toBe(false);
    expect(playerVisible(row({ inCodex: false }))).toBe(false);
  });

  it('merges changes by label: replaces, adds, removes, and keeps whether a line is hidden', () => {
    expect(
      mergeStatLines(sheet, [
        { label: 'true NAME', value: 'Mordath' },
        { label: 'Armor Class', value: '' },
        { label: 'Speed', value: '30 ft.' },
        { label: '  ', value: 'ignored' },
      ]),
    ).toEqual([
      { label: 'true NAME', value: 'Mordath', hidden: true },
      { label: 'Speed', value: '30 ft.', hidden: false },
    ]);
  });
});
