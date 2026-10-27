import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import type { Config } from '../config.js';
import type { Block, ChatProvider, ChatRequest, StopReason, StreamEvent } from './types.js';

type MessageParam = Anthropic.Messages.MessageParam;
type ContentParam = Anthropic.Messages.ContentBlockParam;

const EPHEMERAL = { type: 'ephemeral' } as const;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Models with adaptive thinking and the effort parameter (4.6 and later). */
export function isAdaptiveModel(model: string): boolean {
  return /claude-(fable|mythos|opus|sonnet|haiku)-(4-[6-9]|[5-9])/.test(model);
}

/** Models that can hand a declined request to another model on the first-party API. */
function supportsFallback(model: string): boolean {
  return /^claude-(fable-5|opus-5|sonnet-5-5)/.test(model);
}

function toContent(blocks: Block[], provider: string, cacheLast: boolean): ContentParam[] {
  const out: ContentParam[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      if (b.text) out.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') {
      out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    } else if (b.type === 'tool_result') {
      out.push({ type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError });
    } else if (b.provider === provider) {
      // Reasoning blocks go back exactly as they arrived.
      out.push(b.data as ContentParam);
    }
  }
  const last = out[out.length - 1];
  if (cacheLast && last && last.type !== 'thinking' && last.type !== 'redacted_thinking') {
    (last as { cache_control?: typeof EPHEMERAL }).cache_control = EPHEMERAL;
  }
  return out;
}

function mapStop(reason: string | null): StopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'max_tokens';
  if (reason === 'refusal') return 'refusal';
  return 'end';
}

export interface AnthropicOptions {
  /** Shown in usage records: anthropic, bedrock or foundry. */
  name: string;
  client: Pick<Anthropic, 'messages' | 'beta'>;
  /** Let the API retry a declined request on another model (first-party API only). */
  refusalFallback?: boolean;
}

/** Claude through the Messages API. Bedrock and Foundry reuse it with their own client. */
export function anthropicProvider(opts: AnthropicOptions): ChatProvider {
  const { name, client } = opts;
  return {
    name,
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const messages: MessageParam[] = req.messages
        .map((m) => ({ role: m.role, content: toContent(m.content, name, !!m.cache) }))
        .filter((m) => m.content.length > 0);
      const adaptive = isAdaptiveModel(req.model);
      const params: Anthropic.Messages.MessageStreamParams = {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system
          .filter((s) => s.text)
          .map((s) => ({
            type: 'text' as const,
            text: s.text,
            ...(s.cache ? { cache_control: EPHEMERAL } : {}),
          })),
        messages,
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
              })),
            }
          : {}),
        ...(adaptive ? { thinking: { type: 'adaptive' as const } } : {}),
        ...(adaptive && req.effort ? { output_config: { effort: req.effort } } : {}),
      };

      const useFallback = !!opts.refusalFallback && supportsFallback(req.model);
      const stream = useFallback
        ? client.beta.messages.stream(
            { ...(params as object), betas: [FALLBACK_BETA], fallbacks: 'default' } as Parameters<
              typeof client.beta.messages.stream
            >[0],
            { signal: req.signal },
          )
        : client.messages.stream(params, { signal: req.signal });

      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          yield { type: 'text', text: ev.delta.text };
        }
      }
      const final = await stream.finalMessage();
      const content: Block[] = [];
      for (const b of final.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use')
          content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        else content.push({ type: 'opaque', provider: name, data: b });
      }
      yield {
        type: 'done',
        stop: mapStop(final.stop_reason),
        content,
        model: final.model,
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
          cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}

type ProviderEnv = Pick<
  Config,
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_REFUSAL_FALLBACK'
  | 'AWS_REGION'
  | 'AWS_BEARER_TOKEN_BEDROCK'
  | 'AWS_ACCESS_KEY_ID'
  | 'AWS_SECRET_ACCESS_KEY'
  | 'AWS_SESSION_TOKEN'
  | 'ANTHROPIC_FOUNDRY_RESOURCE'
  | 'ANTHROPIC_FOUNDRY_API_KEY'
>;

export function firstPartyProvider(apiKey: string, refusalFallback: boolean): ChatProvider {
  return anthropicProvider({
    name: 'anthropic',
    client: new Anthropic({ apiKey, maxRetries: 2 }),
    refusalFallback,
  });
}

export function bedrockProvider(cfg: ProviderEnv): ChatProvider {
  const client = new AnthropicBedrockMantle({
    awsRegion: cfg.AWS_REGION,
    ...(cfg.AWS_BEARER_TOKEN_BEDROCK
      ? { apiKey: cfg.AWS_BEARER_TOKEN_BEDROCK }
      : cfg.AWS_ACCESS_KEY_ID
        ? {
            awsAccessKey: cfg.AWS_ACCESS_KEY_ID,
            awsSecretAccessKey: cfg.AWS_SECRET_ACCESS_KEY,
            awsSessionToken: cfg.AWS_SESSION_TOKEN,
          }
        : {}),
  });
  return anthropicProvider({ name: 'bedrock', client: client as unknown as Anthropic });
}

export function foundryProvider(cfg: ProviderEnv): ChatProvider {
  const client = new AnthropicFoundry({
    resource: cfg.ANTHROPIC_FOUNDRY_RESOURCE,
    apiKey: cfg.ANTHROPIC_FOUNDRY_API_KEY,
  });
  return anthropicProvider({ name: 'foundry', client: client as unknown as Anthropic });
}
