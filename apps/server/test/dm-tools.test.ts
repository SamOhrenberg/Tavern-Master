import { beforeAll, describe, expect, it } from 'vitest';
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
