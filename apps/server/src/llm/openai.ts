import type { Block, ChatProvider, ChatRequest, StopReason, StreamEvent } from './types.js';

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface Chunk {
  model?: string;
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

function toMessages(req: ChatRequest): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  const system = req.system
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  for (const m of req.messages) {
    const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    if (m.role === 'assistant') {
      const calls = m.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [
              {
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
              },
            ]
          : [],
      );
      if (text || calls.length)
        out.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        });
    } else {
      // Tool results must directly follow the assistant message that asked for them.
      for (const b of m.content) {
        if (b.type === 'tool_result')
          out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
      }
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

/** Yield the JSON payloads of a server-sent event stream. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data && data !== '[DONE]') yield data;
      }
    }
  }
}

export interface OpenAiOptions {
  name?: string;
  baseUrl: string;
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
}

/**
 * Chat Completions over plain HTTP. Covers OpenAI, OpenRouter, Ollama, vLLM,
 * LiteLLM and anything else that speaks the same wire format.
 */
export function openAiProvider(opts: OpenAiOptions): ChatProvider {
  const name = opts.name ?? 'openai';
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name,
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const res = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: req.model,
          messages: toMessages(req),
          max_completion_tokens: req.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.inputSchema },
                })),
              }
            : {}),
        }),
        signal: req.signal,
      });
      if (!res.ok || !res.body) {
        // The body can echo request details; keep only the status.
        throw new Error(`${name} request failed with HTTP ${res.status}`);
      }

      let text = '';
      let finish: string | null = null;
      let model = req.model;
      let usage: Chunk['usage'] = null;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      for await (const data of sse(res.body)) {
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data) as Chunk;
        } catch {
          continue;
        }
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        if (choice.delta?.content) {
          text += choice.delta.content;
          yield { type: 'text', text: choice.delta.content };
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
      }

      const content: Block[] = [];
      if (text) content.push({ type: 'text', text });
      for (const [index, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        let input: unknown;
        try {
          input = c.args ? JSON.parse(c.args) : {};
        } catch {
          // Leave it to tool validation to report the bad arguments to the model.
          input = { _unparsed: c.args };
        }
        content.push({ type: 'tool_use', id: c.id || `call_${index}`, name: c.name, input });
      }
      const stop: StopReason =
        calls.size > 0
          ? 'tool_use'
          : finish === 'length'
            ? 'max_tokens'
            : finish === 'content_filter'
              ? 'refusal'
              : 'end';
      const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      yield {
        type: 'done',
        stop,
        content,
        model,
        usage: {
          inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
          outputTokens: usage?.completion_tokens ?? 0,
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}
