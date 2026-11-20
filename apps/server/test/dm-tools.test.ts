import { beforeAll, describe, expect, it } from 'vitest';
import { stateSnapshot } from '../src/agent/context.js';
import { publicSummary } from '../src/agent/loop.js';
import { dispatchTool } from '../src/agent/tools.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { context, FakeStore } from './fake-store.js';

beforeAll(() => setConfigForTests(testConfig()));

describe('the DM’s tools for keeping the record straight', () => {
  it('rewrites only its newest narration', async () => {
    const store = new FakeStore();
    const ctx = context();
    const text = 'The goblin flees into the reeds, wounded but alive.';
    expect((await dispatchTool('correct_narration', { text }, ctx, store)).isError).toBe(true);
    store.narrations = ['The gate opens.', 'The goblin dies.'];
    const out = await dispatchTool('correct_narration', { text }, ctx, store);
    expect(out.isError).toBe(false);
    expect(store.narrations).toEqual(['The gate opens.', text]);
    expect(store.events.at(-1)?.tool).toBe('correct_narration');
  });

  it('keeps a creature’s stat block line by line, and reveals a hidden line when the party learns it', async () => {
    const store = new FakeStore();
    const ctx = context();
    const roach = { kind: 'creature', name: 'Dumpster Roach' };
    await dispatchTool(
      'upsert_entity',
      {
        ...roach,
        summary: 'A dog-sized cockroach that nests in the alley bins.',
        sheet: [
          { label: 'Armor Class', value: '12' },
          { label: 'Hit Points', value: '9 (2d8)', hidden: true },
          { label: 'Bite', value: '+2 to hit, 1d4+1 piercing' },
        ],
      },
      ctx,
      store,
    );
    // One line changes; the rest stay as they were, hidden or not.
    await dispatchTool(
      'upsert_entity',
      { ...roach, sheet: [{ label: 'armor class', value: '13' }] },
      ctx,
      store,
    );
    expect(store.ents[0]!.sheet).toEqual([
      { label: 'armor class', value: '13', hidden: false },
      { label: 'Hit Points', value: '9 (2d8)', hidden: true },
      { label: 'Bite', value: '+2 to hit, 1d4+1 piercing', hidden: false },
    ]);

    const out = await dispatchTool('reveal_secret', { ...roach, line: 'hit points' }, ctx, store);
    expect(out.isError).toBe(false);
    expect(out.content).toContain('9 (2d8)');
    expect(store.ents[0]!.sheet[1]!.hidden).toBe(false);
    expect(store.events.at(-1)?.summary).toBe('Learned about Dumpster Roach: hit points');
    expect((await dispatchTool('reveal_secret', { ...roach, line: 'Hit Points' }, ctx, store)).isError).toBe(
      true,
    );
  });

  it('removes a codex entry made by mistake, and says so when there is none', async () => {
    const store = new FakeStore();
    await store.upsertEntity('camp-1', { kind: 'npc', name: 'Vane' });
    const ctx = context();
    expect((await dispatchTool('delete_entity', { kind: 'npc', name: 'vane' }, ctx, store)).isError).toBe(
      false,
    );
    expect(store.ents).toEqual([]);
    expect((await dispatchTool('delete_entity', { kind: 'npc', name: 'Vane' }, ctx, store)).isError).toBe(
      true,
    );
  });

  it('clears a flag', async () => {
    const store = new FakeStore();
    const ctx = context();
    await dispatchTool('set_flag', { key: 'days_left', value: 3 }, ctx, store);
    expect((await dispatchTool('clear_flag', { key: 'days_left' }, ctx, store)).isError).toBe(false);
    expect(store.flagMap).toEqual({});
    expect((await dispatchTool('clear_flag', { key: 'days_left' }, ctx, store)).isError).toBe(true);
  });

  it('never names a removed entry to the players', () => {
    expect(
      publicSummary('delete_entity', { kind: 'npc', name: 'The Traitor' }, 'Removed npc: The Traitor'),
    ).toBe('Tidied the codex');
  });
});

describe('who is in the scene', () => {
  const setup = async () => {
    const store = new FakeStore();
    const ctx = context();
    for (const e of [
      { kind: 'npc', name: 'Mara Voss', aliases: ['the fence'] },
      { kind: 'creature', name: 'Dumpster Roach' },
      { kind: 'location', name: 'The Gilded Rat' },
    ])
      await dispatchTool('upsert_entity', e, ctx, store);
    const here = () => store.ents.filter((e) => e.inScene).map((e) => e.name);
    return { store, ctx, here };
  };

  it('puts exactly the people and creatures named in the scene, by name or other name', async () => {
    const { store, ctx, here } = await setup();
    const out = await dispatchTool(
      'set_scene',
      { description: 'The back room of the Gilded Rat.', present: ['the fence', 'dumpster roach'] },
      ctx,
      store,
    );
    expect(out.isError).toBe(false);
    expect(here()).toEqual(['Mara Voss', 'Dumpster Roach']);
    expect(store.sceneText).toBe('The back room of the Gilded Rat.');
    expect(out.content).toContain('Mara Voss, Dumpster Roach');

    // Someone leaves mid-scene: the description stays.
    await dispatchTool('set_scene', { present: ['Mara Voss'] }, ctx, store);
    expect(here()).toEqual(['Mara Voss']);
    expect(store.sceneText).toBe('The back room of the Gilded Rat.');

    // A new place without `present` keeps who is there, and says so.
    const moved = await dispatchTool('set_scene', { description: 'The river dock at night.' }, ctx, store);
    expect(here()).toEqual(['Mara Voss']);
    expect(moved.content).toContain('Mara Voss');

    await dispatchTool('set_scene', { present: [] }, ctx, store);
    expect(here()).toEqual([]);
  });

  it('changes nothing when a name is not a person or creature in the codex', async () => {
    const { store, ctx, here } = await setup();
    await dispatchTool('set_scene', { present: ['Mara Voss'] }, ctx, store);
    const out = await dispatchTool(
      'set_scene',
      { present: ['Dumpster Roach', 'Pip', 'The Gilded Rat'] },
      ctx,
      store,
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain('Pip, The Gilded Rat');
    expect(here()).toEqual(['Mara Voss']);
    expect((await dispatchTool('set_scene', {}, ctx, store)).isError).toBe(true);
  });

  it('tells the DM who is there every turn', async () => {
    const { store, ctx } = await setup();
    expect(await stateSnapshot(ctx, store)).toContain('<present>nobody but the party</present>');
    await dispatchTool('set_scene', { present: ['Mara Voss'] }, ctx, store);
    expect(await stateSnapshot(ctx, store)).toContain('<present>Mara Voss</present>');
  });
});
