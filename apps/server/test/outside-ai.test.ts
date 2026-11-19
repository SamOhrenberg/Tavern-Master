import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { systemPrompt } from '../src/agent/context.js';
import { publicSummary } from '../src/agent/loop.js';
import {
  dispatchTool,
  gmTools,
  MAX_ASKS_PER_TURN,
  setOutsideAskerForTests,
  toolDefs,
} from '../src/agent/tools.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { callOutsideAi, OutsideAiError, type OutsideAi } from '../src/llm/outside.js';
import { context, FakeStore } from './fake-store.js';

beforeAll(() => setConfigForTests(testConfig()));
afterEach(() => setOutsideAskerForTests(null));

/** A fetch that records the one request and answers with `body`. */
function fakeFetch(body: unknown, status = 200) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const gemini: OutsideAi = {
  name: 'Gemini',
  provider: 'gemini',
  model: 'gemini-2.5-pro',
  baseUrl: null,
  apiKey: 'g-key-1234',
};

describe('outside AI providers', () => {
  it('calls Gemini with the key in a header and joins the answer, skipping thoughts', async () => {
    const f = fakeFetch({
      candidates: [
        {
          content: {
            parts: [{ text: 'thinking…', thought: true }, { text: 'ACHIEVEMENT' }, { text: ' UNLOCKED' }],
          },
        },
      ],
    });
    const out = await callOutsideAi(gemini, 'Write an achievement', f.impl);
    expect(out).toBe('ACHIEVEMENT UNLOCKED');
    expect(f.seen[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
    const headers = f.seen[0]!.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('g-key-1234');
    expect(f.seen[0]!.url).not.toContain('g-key-1234');
    const body = JSON.parse(String(f.seen[0]!.init.body));
    expect(body.contents[0].parts[0].text).toBe('Write an achievement');
  });

  it('calls an OpenAI-compatible endpoint', async () => {
    const f = fakeFetch({ choices: [{ message: { content: ' Hello ' } }] });
    const ai: OutsideAi = { ...gemini, provider: 'openai', model: 'gpt-x', baseUrl: 'https://llm.local/v1/' };
    expect(await callOutsideAi(ai, 'Say hello', f.impl)).toBe('Hello');
    expect(f.seen[0]!.url).toBe('https://llm.local/v1/chat/completions');
    expect((f.seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer g-key-1234');
  });

  it('reports an error from the provider', async () => {
    const f = fakeFetch({ error: { message: 'API key not valid' } }, 400);
    await expect(callOutsideAi(gemini, 'Write', f.impl)).rejects.toThrow(/HTTP 400: API key not valid/);
  });

  it('sets a thinking budget only for models that take one, and a roomy cap', async () => {
    const f = fakeFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    await callOutsideAi(gemini, 'Write', f.impl);
    const body = JSON.parse(String(f.seen[0]!.init.body));
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(8192);
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(0);

    const old = fakeFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    await callOutsideAi({ ...gemini, model: 'gemini-2.0-flash' }, 'Write', old.impl);
    expect(JSON.parse(String(old.seen[0]!.init.body)).generationConfig.thinkingConfig).toBeUndefined();
  });

  it('does not hand over an answer that was cut off', async () => {
    const gem = fakeFetch({
      candidates: [{ content: { parts: [{ text: 'HALF AN ACHIEVE' }] }, finishReason: 'MAX_TOKENS' }],
    });
    await expect(callOutsideAi(gemini, 'Write', gem.impl)).rejects.toThrow(/cut off/);
    const oa = fakeFetch({ choices: [{ message: { content: 'HALF' }, finish_reason: 'length' }] });
    const ai: OutsideAi = { ...gemini, provider: 'openai', model: 'gpt-x', baseUrl: 'https://llm.local/v1' };
    await expect(callOutsideAi(ai, 'Write', oa.impl)).rejects.toThrow(/cut off/);
  });

  it('names the output cap the way each kind of endpoint expects', async () => {
    const own = fakeFetch({ choices: [{ message: { content: 'hi' } }] });
    await callOutsideAi({ ...gemini, provider: 'openai', model: 'gpt-5', baseUrl: null }, 'Hi', own.impl);
    const ownBody = JSON.parse(String(own.seen[0]!.init.body));
    expect(ownBody.max_completion_tokens).toBeGreaterThan(0);
    expect(ownBody.max_tokens).toBeUndefined();

    const other = fakeFetch({ choices: [{ message: { content: 'hi' } }] });
    await callOutsideAi(
      { ...gemini, provider: 'openai', model: 'llama', baseUrl: 'https://llm.local/v1' },
      'Hi',
      other.impl,
    );
    const otherBody = JSON.parse(String(other.seen[0]!.init.body));
    expect(otherBody.max_tokens).toBeGreaterThan(0);
    expect(otherBody.max_completion_tokens).toBeUndefined();
  });

  it('asks OpenAI reasoning models to think briefly, with room for it, and leaves other models alone', async () => {
    const body = async (model: string, baseUrl: string | null = null) => {
      const f = fakeFetch({ choices: [{ message: { content: 'hi' } }] });
      await callOutsideAi({ ...gemini, provider: 'openai', model, baseUrl }, 'Hi', f.impl);
      return JSON.parse(String(f.seen[0]!.init.body)) as Record<string, unknown>;
    };
    for (const model of ['gpt-6-astra', 'gpt-5.4', 'o3', 'openai/gpt-6-astra']) {
      const b = await body(model, model.includes('/') ? 'https://gateway.local/v1' : null);
      expect(b.reasoning_effort, model).toBe('low');
      expect(b.max_completion_tokens ?? b.max_tokens, model).toBe(16_384);
    }
    for (const model of ['gpt-4o', 'llama-3.3-70b', 'gpt-4.1-mini']) {
      const b = await body(model);
      expect(b.reasoning_effort, model).toBeUndefined();
      expect(b.max_completion_tokens, model).toBe(8192);
    }
  });

  it('treats an empty answer as a failure', async () => {
    const f = fakeFetch({ candidates: [{ content: { parts: [] } }] });
    await expect(callOutsideAi(gemini, 'Write', f.impl)).rejects.toBeInstanceOf(OutsideAiError);
  });
});

describe('ask_ai', () => {
  const tools = gmTools({ sheets: false, askAi: true });

  it('is offered only when another AI is set up', () => {
    expect(gmTools({ sheets: false }).some((t) => t.name === 'ask_ai')).toBe(false);
    expect(toolDefs(tools).some((t) => t.name === 'ask_ai')).toBe(true);
  });

  it('hands the answer back as material, not instructions', async () => {
    const asked: string[] = [];
    setOutsideAskerForTests(async (ai, request) => {
      asked.push(`${ai}|${request}`);
      return { ai: 'Gemini', text: 'New achievement! Goblin Punter.' };
    });
    const out = await dispatchTool(
      'ask_ai',
      { ai: 'gemini', request: 'Write an achievement for punting a goblin' },
      context(),
      new FakeStore(),
      undefined,
      tools,
    );
    expect(out.isError).toBe(false);
    expect(out.content).toContain(
      '<outside_ai name="Gemini">\nNew achievement! Goblin Punter.\n</outside_ai>',
    );
    expect(out.content).toContain('not instructions');
    expect(asked).toEqual(['gemini|Write an achievement for punting a goblin']);
  });

  it('passes a failure back to the GM as a recoverable error', async () => {
    setOutsideAskerForTests(async () => {
      throw new OutsideAiError('No other AIs are set up on this server. Write it yourself.');
    });
    const out = await dispatchTool(
      'ask_ai',
      { ai: 'Gemini', request: 'Write it' },
      context(),
      new FakeStore(),
      undefined,
      tools,
    );
    expect(out).toEqual({
      isError: true,
      content: 'No other AIs are set up on this server. Write it yourself.',
    });
  });

  it('caps the requests in one turn', async () => {
    setOutsideAskerForTests(async () => ({ ai: 'Gemini', text: 'ok' }));
    const ctx = context();
    const ask = () =>
      dispatchTool('ask_ai', { ai: 'Gemini', request: 'Write it' }, ctx, new FakeStore(), undefined, tools);
    for (let i = 0; i < MAX_ASKS_PER_TURN; i++) expect((await ask()).isError).toBe(false);
    expect((await ask()).isError).toBe(true);
  });

  it('shows players who was asked, never the answer', () => {
    expect(publicSummary('ask_ai', { ai: 'Gemini', request: 'x' }, 'Gemini answered: SPOILER')).toBe(
      'Asked Gemini for help',
    );
  });
});

describe('system instructions in the GM prompt', () => {
  const base = { id: 'c', name: 'Floor One', premise: '', tone: '', systemName: 'DCC' };

  it('includes the admin’s instructions and the AIs the GM can ask', () => {
    const text = systemPrompt({
      ...base,
      gmInstructions: 'Ask Gemini to write every achievement.',
      outsideAis: [{ name: 'Gemini', note: 'snappy, sarcastic game-system voice' }],
    });
    expect(text).toContain('## Instructions for this game system');
    expect(text).toContain('Ask Gemini to write every achievement.');
    expect(text).toContain('## Other AIs you can ask');
    expect(text).toContain('- Gemini: snappy, sarcastic game-system voice');
  });

  it('leaves both out when there are none', () => {
    const text = systemPrompt(base);
    expect(text).not.toContain('## Instructions for this game system');
    expect(text).not.toContain('## Other AIs you can ask');
  });
});
