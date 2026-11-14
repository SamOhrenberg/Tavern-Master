import { describe, expect, it } from 'vitest';
import { mockProvider } from '../src/llm/mock.js';
import type { Block, ChatProvider, ChatRequest, StreamEvent } from '../src/llm/types.js';
import { editLoreSchema, loreSchema, runLoreReader } from '../src/rules/lore.js';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A provider that replays a fixed sequence of tool-call rounds, one per model call. */
function scripted(rounds: Block[][]): ChatProvider {
  let i = 0;
  return {
    name: 'scripted',
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const content = rounds[Math.min(i++, rounds.length - 1)] ?? [];
      const isTool = content.some((b) => b.type === 'tool_use');
      yield { type: 'done', stop: isTool ? 'tool_use' : 'end', content, usage, model: req.model };
    },
  };
}

const deps = {
  model: 'mock',
  outline: 'Documents: The Carl Chronicles\n\nSections:\n  [0] A televised dungeon',
  search: async () => 'The System welcomes you to the Crawl.',
  read: async () => '[0] The System welcomes you to the Crawl.',
};

describe('setting lore distillation', () => {
  it('clamps a sloppy, oversized record into a small safe summary', () => {
    const parsed = loreSchema.safeParse({
      voice: 'x'.repeat(2000),
      pacing: 42, // wrong type → dropped to ''
      glossary: [
        ...Array.from({ length: 60 }, (_, n) => ({ term: `t${n}`, meaning: 'm', sounds_like: 's' })),
        { term: '', meaning: 'no term' }, // dropped
      ],
      presentation: ['boxed', '', 'announcements'],
      touchstones: Array.from({ length: 50 }, () => 'motif'),
      cautions: ['spoiler'],
      extra: 'ignored',
    });
    expect(parsed.success).toBe(true);
    const lore = parsed.data!;
    expect(lore.version).toBe(1);
    expect(lore.voice).toHaveLength(600); // truncated
    expect(lore.pacing).toBe('');
    expect(lore.glossary).toHaveLength(40); // capped
    expect(lore.glossary[0]).toEqual({ term: 't0', meaning: 'm', soundsLike: 's' });
    expect(lore.presentation).toEqual(['boxed', 'announcements']); // empties removed
    expect(lore.touchstones).toHaveLength(30); // capped
  });

  it('accepts a human edit in the protocol (camelCase) shape and clamps it', () => {
    const parsed = editLoreSchema.safeParse({
      voice: 'A hush over the ruins.',
      pacing: 'y'.repeat(2000), // truncated
      glossary: [
        { term: 'Crawl', meaning: 'the televised dungeon', soundsLike: 'the Crawl' },
        { term: '', meaning: 'no term' }, // dropped
      ],
      presentation: ['boxed', '', 'announcements'],
      touchstones: Array.from({ length: 50 }, () => 'motif'), // capped to 30
      cautions: ['the host is the villain'],
      version: 99, // ignored; always normalised to 1
    });
    expect(parsed.success).toBe(true);
    const lore = parsed.data!;
    expect(lore.version).toBe(1);
    expect(lore.pacing).toHaveLength(400);
    expect(lore.glossary).toEqual([
      { term: 'Crawl', meaning: 'the televised dungeon', soundsLike: 'the Crawl' },
    ]);
    expect(lore.presentation).toEqual(['boxed', 'announcements']);
    expect(lore.touchstones).toHaveLength(30);
    expect(lore.cautions).toEqual(['the host is the villain']);
  });

  it('drops a glossary soundsLike that is blank', () => {
    const lore = editLoreSchema.parse({ glossary: [{ term: 'System', meaning: 'the voice in the boxes' }] });
    expect(lore.glossary[0]).toEqual({ term: 'System', meaning: 'the voice in the boxes' });
    expect('soundsLike' in lore.glossary[0]!).toBe(false);
  });

  it('reads the material and records lore against the scripted model', async () => {
    let calls = 0;
    const out = await runLoreReader({
      provider: mockProvider(),
      ...deps,
      onUsage: () => {
        calls++;
      },
    });
    expect(out).toMatchObject({ ok: true });
    if (out.ok) {
      expect(out.lore.voice).toMatch(/broadcast/i);
      expect(out.lore.glossary[0]).toMatchObject({ term: 'the Crawl', soundsLike: 'the Crawl' });
      expect(out.lore.cautions.length).toBeGreaterThan(0);
    }
    expect(calls).toBe(2); // search, then save
  });

  it('gives up cleanly when the model calls cannot_distil', async () => {
    const provider = scripted([
      [
        {
          type: 'tool_use',
          id: 't1',
          name: 'cannot_distil',
          input: { reason: 'This is only a rules table.' },
        },
      ],
    ]);
    const out = await runLoreReader({ provider, ...deps });
    expect(out).toEqual({ ok: false, reason: 'This is only a rules table.' });
  });

  it('fails if the reader finishes without saving any lore', async () => {
    const provider = scripted([[{ type: 'text', text: 'Here are some thoughts, but no tool call.' }]]);
    const out = await runLoreReader({ provider, ...deps });
    expect(out).toMatchObject({ ok: false });
  });
});
