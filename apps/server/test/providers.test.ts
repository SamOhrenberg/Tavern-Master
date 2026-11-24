import type Anthropic from '@anthropic-ai/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { setConfigForTests, testConfig } from '../src/config.js';
import { anthropicProvider, isAdaptiveModel } from '../src/llm/anthropic.js';
import { instanceAiConfigured, resolveLlm, setProviderForTests } from '../src/llm/index.js';
import { mockProvider } from '../src/llm/mock.js';
import { openAiProvider } from '../src/llm/openai.js';
import { costMicroUsd, priceFor } from '../src/llm/pricing.js';
import { complete, type ChatProvider, type ChatRequest, type StreamEvent } from '../src/llm/types.js';

beforeAll(() => setConfigForTests(testConfig()));

const request: ChatRequest = {
  model: 'claude-opus-5-5',
  system: [
    { text: 'Static rules', cache: true },
    { text: 'Campaign memory', cache: true },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'turn one' }] },
    {
      role: 'assistant',
      content: [
        { type: 'opaque', provider: 'anthropic', data: { type: 'thinking', thinking: 'hm', signature: 's' } },
        { type: 'tool_use', id: 'tu_1', name: 'roll_dice', input: { expression: 'd20' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: '= 9' }], cache: true },
  ],
  tools: [
    {
      name: 'roll_dice',
      description: 'Roll',
      inputSchema: { type: 'object', properties: { expression: { type: 'string' } } },
    },
  ],
  maxTokens: 500,
  effort: 'medium',
};

async function collect(provider: ChatProvider, req: ChatRequest = request): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of provider.stream(req)) out.push(ev);
  return out;
}

/** Stands in for the SDK client: yields stream events, then a final message. */
function fakeAnthropic(final: Record<string, unknown>, events: unknown[] = []) {
  const calls: { params: Record<string, unknown>; beta: boolean }[] = [];
  const make = (beta: boolean) => ({
    stream(params: Record<string, unknown>) {
      calls.push({ params, beta });
      return {
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
        finalMessage: async () => final,
      };
    },
  });
  const client = { messages: make(false), beta: { messages: make(true) } } as unknown as Pick<
    Anthropic,
    'messages' | 'beta'
  >;
  return { client, calls };
}

const finalMessage = {
  model: 'claude-opus-5-5',
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: 'let me roll', signature: 'sig' },
    { type: 'text', text: 'The goblin snarls.' },
    { type: 'tool_use', id: 'tu_2', name: 'roll_dice', input: { expression: '1d20+4' } },
  ],
  usage: {
    input_tokens: 120,
    output_tokens: 40,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 60,
  },
};

describe('anthropic provider', () => {
  it('maps a request to Messages API parameters', async () => {
    const { client, calls } = fakeAnthropic(finalMessage);
    await collect(anthropicProvider({ name: 'anthropic', client }));
    const p = calls[0]!.params as Record<string, any>;
    expect(calls[0]!.beta).toBe(false);
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.thinking).toEqual({ type: 'adaptive' });
    expect(p.output_config).toEqual({ effort: 'medium' });
    expect(p).not.toHaveProperty('temperature');
    expect(p).not.toHaveProperty('tool_choice');
    expect(p.system).toEqual([
      { type: 'text', text: 'Static rules', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Campaign memory', cache_control: { type: 'ephemeral' } },
    ]);
    expect(p.tools[0]).toMatchObject({ name: 'roll_dice', input_schema: { type: 'object' } });
    // Thinking is replayed verbatim; the cache marker lands on the last block only.
    expect(p.messages[1].content[0]).toEqual({ type: 'thinking', thinking: 'hm', signature: 's' });
    expect(p.messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: '= 9',
      is_error: undefined,
      cache_control: { type: 'ephemeral' },
    });
    expect(JSON.stringify(p).match(/cache_control/g)).toHaveLength(3);
  });

  it('streams text and normalises the final message', async () => {
    const { client } = fakeAnthropic(finalMessage, [
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The goblin ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'snarls.' } },
    ]);
    const events = await collect(anthropicProvider({ name: 'anthropic', client }));
    expect(events.filter((e) => e.type === 'text').map((e) => e.text)).toEqual(['The goblin ', 'snarls.']);
    const done = events.at(-1)!;
    expect(done).toMatchObject({
      type: 'done',
      stop: 'tool_use',
      usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 60 },
    });
    if (done.type !== 'done') throw new Error('unreachable');
    expect(done.content.map((b) => b.type)).toEqual(['opaque', 'text', 'tool_use']);
  });

  it('reports refusals and uses the fallback beta only when asked', async () => {
    const refusal = { ...finalMessage, stop_reason: 'refusal', content: [] };
    const plain = fakeAnthropic(refusal);
    expect(
      (await complete(anthropicProvider({ name: 'anthropic', client: plain.client }), request)).stop,
    ).toBe('refusal');

    const withFallback = fakeAnthropic(finalMessage);
    await collect(
      anthropicProvider({ name: 'anthropic', client: withFallback.client, refusalFallback: true }),
    );
    expect(withFallback.calls[0]!.beta).toBe(true);
    expect(withFallback.calls[0]!.params).toMatchObject({
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });

    // Haiku has no fallback target, so it stays on the standard endpoint.
    const haiku = fakeAnthropic(finalMessage);
    await collect(anthropicProvider({ name: 'anthropic', client: haiku.client, refusalFallback: true }), {
      ...request,
      model: 'claude-haiku-5-5',
    });
    expect(haiku.calls[0]!.beta).toBe(false);
  });

  it('leaves retries to the client where the platform has no server-side fallback', async () => {
    const onBedrock = fakeAnthropic(finalMessage);
    const provider = anthropicProvider({ name: 'bedrock', client: onBedrock.client, clientFallback: true });
    await collect(provider, { ...request, model: 'anthropic.claude-opus-5-5' });
    // The middleware acts on the beta surface; the request itself names no fallbacks.
    expect(onBedrock.calls[0]!.beta).toBe(true);
    expect(onBedrock.calls[0]!.params).not.toHaveProperty('fallbacks');
    await collect(provider, { ...request, model: 'anthropic.claude-haiku-5-5' });
    expect(onBedrock.calls[1]!.beta).toBe(false);
  });

  it('keeps only what the model that took over wrote after a mid-reply fallback', async () => {
    const switched = fakeAnthropic({
      ...finalMessage,
      content: [
        { type: 'thinking', thinking: '', signature: 'declined' },
        { type: 'text', text: 'The door ' },
        { type: 'tool_use', id: 'tu_declined', name: 'roll_dice', input: { expression: '1d20' } },
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
        { type: 'text', text: 'creaks open.' },
        { type: 'tool_use', id: 'tu_kept', name: 'roll_dice', input: { expression: '1d6' } },
      ],
    });
    const done = (await collect(anthropicProvider({ name: 'anthropic', client: switched.client }))).at(-1)!;
    if (done.type !== 'done') throw new Error('unreachable');
    // The text before the switch stands; the declined attempt's thinking and call are gone.
    expect(done.content.map((b) => b.type)).toEqual(['text', 'opaque', 'text', 'tool_use']);
    expect(done.content.filter((b) => b.type === 'tool_use').map((b) => b.id)).toEqual(['tu_kept']);
  });

  it('only sends adaptive thinking to models that support it', () => {
    expect(isAdaptiveModel('claude-opus-5-5')).toBe(true);
    expect(isAdaptiveModel('anthropic.claude-haiku-5-5')).toBe(true);
    expect(isAdaptiveModel('claude-sonnet-4-6')).toBe(true);
    expect(isAdaptiveModel('claude-haiku-4-5')).toBe(false);
  });
});

describe('openai-compatible provider', () => {
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });

  it('translates messages and tools and reassembles streamed tool calls', async () => {
    let sent: { url: string; body: Record<string, any>; auth: string | null } | undefined;
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent = {
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get('authorization'),
      };
      return sse([
        { model: 'gpt-x', choices: [{ delta: { content: 'Rolling' } }] },
        { choices: [{ delta: { content: '…' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_9', function: { name: 'roll_dice', arguments: '{"expres' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: 'sion":"2d6"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } },
        },
      ]);
    }) as typeof fetch;

    const provider = openAiProvider({
      baseUrl: 'https://llm.example/v1/',
      apiKey: 'sk-test-0000',
      fetchImpl,
    });
    const events = await collect(provider, { ...request, model: 'gpt-x' });

    expect(sent!.url).toBe('https://llm.example/v1/chat/completions');
    expect(sent!.auth).toBe('Bearer sk-test-0000');
    expect(sent!.body.messages).toEqual([
      { role: 'system', content: 'Static rules\n\nCampaign memory' },
      { role: 'user', content: 'turn one' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'tu_1',
            type: 'function',
            function: { name: 'roll_dice', arguments: '{"expression":"d20"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tu_1', content: '= 9' },
    ]);
    expect(sent!.body.tools[0]).toMatchObject({ type: 'function', function: { name: 'roll_dice' } });

    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join(''),
    ).toBe('Rolling…');
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      stop: 'tool_use',
      model: 'gpt-x',
      content: [
        { type: 'text', text: 'Rolling…' },
        { type: 'tool_use', id: 'call_9', name: 'roll_dice', input: { expression: '2d6' } },
      ],
      usage: { inputTokens: 20, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 },
    });
  });

  it('fails without leaking the response body', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"key sk-secret-123 invalid"}', { status: 401 })) as typeof fetch;
    await expect(
      collect(openAiProvider({ baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl })),
    ).rejects.toThrow('openai request failed with HTTP 401');
  });
});

describe('provider selection and pricing', () => {
  it('every provider satisfies the same contract', async () => {
    const providers: ChatProvider[] = [
      mockProvider(),
      anthropicProvider({
        name: 'bedrock',
        client: fakeAnthropic({ ...finalMessage, stop_reason: 'end_turn' }).client,
      }),
    ];
    for (const p of providers) {
      const events = await collect(p, { ...request, tools: undefined });
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(events.at(-1)!.type).toBe('done');
    }
  });

  it('has no built-in model with LLM_PROVIDER=none', async () => {
    setConfigForTests(testConfig({ LLM_PROVIDER: 'none' }));
    setProviderForTests();
    await expect(resolveLlm('narration')).rejects.toThrow('no built-in AI');
    expect(instanceAiConfigured()).toBe(false);
    setConfigForTests(testConfig());
    setProviderForTests();
    expect(instanceAiConfigured()).toBe(true);
  });

  it('picks a model per task from configuration', async () => {
    setProviderForTests(mockProvider());
    const narration = await resolveLlm('narration');
    const utility = await resolveLlm('utility');
    expect(narration).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', keySource: 'instance' });
    expect(utility).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    // Companions play on the narration model unless one is set for them.
    expect(await resolveLlm('companion')).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' });
    setConfigForTests(testConfig({ LLM_MODEL_COMPANION: 'claude-sonnet-5-5' }));
    expect(await resolveLlm('companion')).toMatchObject({ model: 'claude-sonnet-5-5' });
    // The guide chats cheaply; design work on a system reads its rulebooks with more thought.
    setConfigForTests(testConfig({ LLM_MODEL_PREP: 'claude-sonnet-5-5', LLM_EFFORT_NARRATION: 'low' }));
    expect(await resolveLlm('prep')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
    expect(await resolveLlm('design')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
    setConfigForTests(testConfig({ LLM_EFFORT_NARRATION: 'high' }));
    expect(await resolveLlm('design')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    setConfigForTests(testConfig());
    setProviderForTests();
  });

  it('prices usage including cache reads and writes', () => {
    expect(priceFor('anthropic.claude-opus-5-5')).toEqual(priceFor('claude-opus-5-5'));
    expect(priceFor('anthropic/claude-sonnet-5.5')?.input).toBe(2);
    const cost = costMicroUsd('claude-opus-5-5', {
      inputTokens: 2000,
      outputTokens: 1100,
      cacheReadTokens: 28_000,
      cacheWriteTokens: 6000,
    });
    // 2000×4 + 1100×20 + 28000×0.2 + 6000×5 micro-dollars
    expect(cost).toBe(65_600);
    // Writes to the one-hour cache cost twice the input price, not 1.25 times: 6000×8.
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 6000 };
    expect(costMicroUsd('claude-opus-5-5', usage, { longCache: true })).toBe(48_000);
    expect(
      costMicroUsd('some-local-model', {
        inputTokens: 1e6,
        outputTokens: 1e6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0);
  });
});
