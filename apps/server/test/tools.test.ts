import { beforeAll, describe, expect, it } from 'vitest';
import { redactSecrets, runAgentTurn, usedCitations } from '../src/agent/loop.js';
import { dispatchTool, toolDefs } from '../src/agent/tools.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import type { ResolvedLlm } from '../src/llm/index.js';
import { mockProvider } from '../src/llm/mock.js';
import { ZERO_USAGE } from '../src/llm/pricing.js';
import type { Block, ChatProvider, ChatRequest, StreamEvent } from '../src/llm/types.js';
import { character, context, FakeStore, hit } from './fake-store.js';

beforeAll(() => setConfigForTests(testConfig()));

/** A model that replays a fixed list of responses and records what it was sent. */
function scripted(steps: Block[][]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return {
    name: 'scripted',
    requests,
    async *stream(req): AsyncIterable<StreamEvent> {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const content = steps[Math.min(i++, steps.length - 1)]!;
      for (const b of content) if (b.type === 'text') yield { type: 'text', text: b.text };
      const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end';
      yield { type: 'done', stop, content, usage: ZERO_USAGE, model: req.model };
    },
  };
}
const llm = (provider: ChatProvider): ResolvedLlm => ({
  provider,
  model: 'test-model',
  effort: 'low',
  keySource: 'instance',
});
const call = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input });
const userTurn = (text: string) => [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }];

describe('tool dispatch', () => {
  it('rolls dice on the server and records the roll', async () => {
    const ctx = context();
    const out = await dispatchTool(
      'roll_dice',
      { expression: '1d20+2', reason: 'Longsword to hit', character: 'Thorn', kind: 'attack' },
      ctx,
      new FakeStore(),
      () => 15,
    );
    expect(out).toEqual({
      isError: false,
      content: 'Rolled for Thorn (Longsword to hit): 1d20+2 → [15] +2 = 17',
    });
    expect(ctx.rolls).toHaveLength(1);
    expect(ctx.rolls[0]).toMatchObject({ total: 17, character: 'Thorn', expression: '1d20+2', kind: 'attack' });
  });

  it('defaults a roll with no kind to "other"', async () => {
    const ctx = context();
    await dispatchTool('roll_dice', { expression: '1d6', reason: 'something' }, ctx, new FakeStore(), () => 4);
    expect(ctx.rolls[0]).toMatchObject({ kind: 'other' });
  });

  it('reports bad arguments and unknown tools to the model instead of throwing', async () => {
    const store = new FakeStore();
    expect((await dispatchTool('roll_dice', { expression: 'lots' }, context(), store)).isError).toBe(true);
    expect(
      (await dispatchTool('roll_dice', { expression: 'banana', reason: 'x' }, context(), store)).content,
    ).toMatch(/Could not read/);
    expect(await dispatchTool('drop_database', {}, context(), store)).toEqual({
      isError: true,
      content: 'Unknown tool "drop_database".',
    });
  });

  it('scopes rules lookup to the campaign system, whatever the model sends', async () => {
    const store = new FakeStore();
    store.rules = {
      'sys-a': [hit(1, 'Roll a d20 and add your attack bonus.')],
      'sys-b': [hit(9, 'Roll 2d6 under your skill.', 'Other Game')],
    };
    const ctx = context({ systemId: 'sys-a' });
    const out = await dispatchTool(
      'lookup_rules',
      { query: 'attack roll', systemId: 'sys-b', system_id: 'sys-b' },
      ctx,
      store,
    );
    expect(store.searches).toEqual([{ systemId: 'sys-a', query: 'attack roll' }]);
    expect(out.content).toContain('[R1] Core Rules — Combat — p. 12');
    expect(out.content).not.toContain('Other Game');
    expect(ctx.citations).toMatchObject([{ ref: 'R1', chunkId: 1 }]);

    // The same passage keeps its number when it comes back a second time.
    await dispatchTool('lookup_rules', { query: 'attack again' }, ctx, store);
    expect(ctx.citations).toHaveLength(1);
  });

  it('draws on setting material for colour without minting a citation', async () => {
    const store = new FakeStore();
    store.settingDocs = {
      'sys-a': [hit(5, 'The System welcomes you to the Crawl.', 'Carl Chronicles')],
      'sys-b': [hit(9, 'A different world entirely.', 'Other Book')],
    };
    const ctx = context({ systemId: 'sys-a' });
    const out = await dispatchTool('search_setting', { query: 'the crawl', systemId: 'sys-b' }, ctx, store);
    expect(store.settingSearches).toEqual([{ systemId: 'sys-a', query: 'the crawl' }]);
    expect(out.content).toContain('Crawl');
    expect(out.content).not.toContain('Other Book');
    // Flavour, not rules: no [R#] marker is minted.
    expect(out.content).not.toMatch(/\[R\d+\]/);
    expect(ctx.citations).toHaveLength(0);
  });

  it('applies damage through temp HP and clamps hit points', async () => {
    const store = new FakeStore();
    store.chars = [character({ id: 'c1', playerIds: ['u-ann'], name: 'Thorn', hp: 8, maxHp: 10, tempHp: 3 })];
    const ctx = context();
    await dispatchTool(
      'update_character',
      { character: 'thorn', hp_delta: -5, add_conditions: ['Prone'] },
      ctx,
      store,
    );
    expect(store.chars[0]).toMatchObject({ hp: 6, tempHp: 0, conditions: ['Prone'] });
    await dispatchTool(
      'update_character',
      { character: 'Thorn', hp_delta: 50, remove_conditions: ['prone'] },
      ctx,
      store,
    );
    expect(store.chars[0]).toMatchObject({ hp: 10, conditions: [] });
    expect(ctx.stateChanged).toBe(true);
    expect(store.events.map((e) => e.tool)).toEqual(['update_character', 'update_character']);
  });

  it('will not kill or rob a character whose player is not in the turn', async () => {
    const store = new FakeStore();
    store.chars = [
      character({ id: 'c1', playerIds: ['u-ann'], name: 'Thorn', inventory: [{ name: 'Rope', qty: 1 }] }),
      character({
        id: 'c2',
        playerIds: ['u-bob'],
        name: 'Mira',
        hp: 7,
        inventory: [{ name: 'Gold', qty: 50 }],
      }),
    ];
    const ctx = context(); // only Ann is acting

    const hurt = await dispatchTool('update_character', { character: 'Mira', hp_delta: -100 }, ctx, store);
    expect(store.chars[1]!.hp).toBe(1);
    expect(hurt.content).toContain('cannot drop below 1 HP');

    const theft = await dispatchTool(
      'modify_inventory',
      { character: 'Mira', remove: [{ name: 'Gold', qty: 50 }] },
      ctx,
      store,
    );
    expect(theft.isError).toBe(true);
    expect(store.chars[1]!.inventory).toEqual([{ name: 'Gold', qty: 50 }]);

    // Ann's own character can spend her own things, and loot can be handed out.
    await dispatchTool(
      'modify_inventory',
      { character: 'Thorn', remove: [{ name: 'rope', qty: 1 }], add: [{ name: 'Torch', qty: 2 }] },
      ctx,
      store,
    );
    expect(store.chars[0]!.inventory).toEqual([{ name: 'Torch', qty: 2 }]);
    const short = await dispatchTool(
      'modify_inventory',
      { character: 'Thorn', remove: [{ name: 'Torch', qty: 3 }] },
      ctx,
      store,
    );
    expect(short.isError).toBe(true);
  });

  it('exposes no way to rename a character or touch private notes', () => {
    const update = toolDefs().find((t) => t.name === 'update_character')!;
    const props = Object.keys((update.inputSchema as { properties: object }).properties);
    expect(props.sort()).toEqual(['add_conditions', 'character', 'hp_delta', 'remove_conditions', 'temp_hp']);
    for (const t of toolDefs()) {
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/campaign|system_id|systemId|private/i);
    }
  });

  it('keeps secrets out of the event log until revealed', async () => {
    const store = new FakeStore();
    const ctx = context();
    await dispatchTool(
      'upsert_entity',
      {
        kind: 'npc',
        name: 'Innkeeper Bram',
        summary: 'Jovial host',
        secret: 'Bram poisons travellers for the cult.',
      },
      ctx,
      store,
    );
    expect(JSON.stringify(store.events)).not.toContain('poisons');
    expect((await dispatchTool('reveal_secret', { kind: 'npc', name: 'Nobody' }, ctx, store)).isError).toBe(
      true,
    );
    const out = await dispatchTool('reveal_secret', { kind: 'npc', name: 'innkeeper bram' }, ctx, store);
    expect(out.content).toContain('Bram poisons travellers');
    expect(store.ents[0]!.secretRevealed).toBe(true);
  });
});

describe('agent loop with a mocked model', () => {
  it('runs requested tools, feeds results back and returns the narration', async () => {
    const store = new FakeStore();
    store.chars = [character({ id: 'c1', playerIds: ['u-ann'], name: 'Thorn' })];
    const provider = scripted([
      [
        { type: 'text', text: 'Thorn lunges.' },
        call('t1', 'roll_dice', { expression: '1d20', reason: 'attack', character: 'Thorn' }),
        call('t2', 'update_character', { character: 'Thorn', hp_delta: -3 }),
      ],
      [{ type: 'text', text: 'The blade bites deep.' }],
    ]);
    const deltas: string[] = [];
    const toolsSeen: string[] = [];
    const ctx = context();
    const result = await runAgentTurn({
      llm: llm(provider),
      system: [{ text: 'You are the DM.', cache: true }],
      messages: userTurn('<turn n="1"><action player="Ann" character="Thorn">I attack</action></turn>'),
      ctx,
      store,
      maxRounds: 4,
      maxTokens: 1000,
      rng: () => 12,
      onText: (t) => deltas.push(t),
      onTool: (name) => toolsSeen.push(name),
    });

    expect(result).toMatchObject({
      text: 'Thorn lunges.\n\nThe blade bites deep.',
      rounds: 2,
      toolCalls: 2,
      refused: false,
    });
    expect(deltas.join('')).toBe('Thorn lunges.\n\nThe blade bites deep.');
    expect(toolsSeen).toEqual(['roll_dice', 'update_character']);
    expect(store.chars[0]!.hp).toBe(7);
    expect(ctx.rolls[0]!.total).toBe(12);

    // Second request: assistant content replayed untouched, results appended, cache point moved.
    const second = provider.requests[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toMatchObject({ role: 'assistant' });
    expect(second.messages[1]!.content).toHaveLength(3);
    expect(second.messages[2]!.cache).toBe(true);
    expect(second.messages[2]!.content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 't1',
      content: expect.stringContaining('= 12'),
    });
    expect(second.messages[2]!.content[1]).toMatchObject({
      type: 'tool_result',
      toolUseId: 't2',
      isError: false,
    });
  });

  it('returns tool errors to the model so it can correct itself', async () => {
    const provider = scripted([
      [call('t1', 'roll_dice', { expression: 'd0', reason: 'x' })],
      [{ type: 'text', text: 'Never mind.' }],
    ]);
    const result = await runAgentTurn({
      llm: llm(provider),
      system: [],
      messages: userTurn('go'),
      ctx: context(),
      store: new FakeStore(),
      maxRounds: 4,
      maxTokens: 100,
    });
    expect(result.text).toBe('Never mind.');
    expect(provider.requests[1]!.messages[2]!.content[0]).toMatchObject({
      type: 'tool_result',
      isError: true,
    });
  });

  it('stops a model that never stops calling tools', async () => {
    const provider = scripted([[call('t', 'get_state', {})]]);
    const result = await runAgentTurn({
      llm: llm(provider),
      system: [],
      messages: userTurn('go'),
      ctx: context(),
      store: new FakeStore(),
      maxRounds: 3,
      maxTokens: 100,
    });
    expect(provider.requests).toHaveLength(3);
    expect(result).toMatchObject({ truncated: true, toolCalls: 3 });
    expect(result.text).toMatch(/ran out of steps/);
  });

  it('plays a whole two-player turn with the built-in mock DM', async () => {
    const store = new FakeStore();
    store.rules = { 'sys-a': [hit(4, 'To attack, roll a d20 and add the relevant modifier.')] };
    const ctx = context({
      actors: [
        { userId: 'u-ann', displayName: 'Ann', characterName: 'Thorn' },
        { userId: 'u-bob', displayName: 'Bob', characterName: 'Mira' },
      ],
    });
    const turn =
      '<turn n="1">\n  <action player="Ann" character="Thorn">I swing at the goblin</action>\n  <action player="Bob" character="Mira">I cast a ward</action>\n</turn>';
    const result = await runAgentTurn({
      llm: llm(mockProvider()),
      system: [],
      messages: userTurn(turn),
      ctx,
      store,
      maxRounds: 4,
      maxTokens: 1000,
      rng: () => 14,
    });

    expect(result.text).toContain('**Thorn**');
    expect(result.text).toContain('**Mira**');
    expect(result.text).toContain('**14**');
    expect(ctx.rolls.map((r) => r.character)).toEqual(['Thorn', 'Mira']);
    expect(usedCitations(result.text, ctx.citations)).toMatchObject([{ ref: 'R1', chunkId: 4 }]);
    expect(store.searches[0]!.systemId).toBe('sys-a');
  });
});

describe('narration safety nets', () => {
  it('blacks out unrevealed secrets quoted in narration', () => {
    const secret = 'The innkeeper is secretly the cult leader. He keeps the key under the third barrel.';
    const out = redactSecrets(
      'Bram smiles. Somehow you sense the  Innkeeper is secretly the cult leader, yet say nothing.',
      [secret],
    );
    expect(out.redacted).toBe(true);
    expect(out.text).not.toMatch(/cult leader/i);
    expect(redactSecrets('Bram smiles and pours another ale.', [secret])).toEqual({
      text: 'Bram smiles and pours another ale.',
      redacted: false,
    });
  });

  it('keeps only citations the text refers to', () => {
    const cites = [{ ref: 'R1' }, { ref: 'R2' }, { ref: 'R3' }];
    expect(usedCitations('As written [R2], and also [R3].', cites)).toEqual([{ ref: 'R2' }, { ref: 'R3' }]);
  });
});
