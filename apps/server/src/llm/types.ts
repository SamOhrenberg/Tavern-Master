import type { Usage } from './pricing.js';

/** A tool the model may call. `inputSchema` is JSON Schema. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  /**
   * Provider-specific content (for example reasoning blocks) that must be sent
   * back unchanged while a tool loop is in progress. Other providers drop it.
   */
  | { type: 'opaque'; provider: string; data: unknown };

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
  /** Ask the provider to cache the prompt up to the end of this message. */
  cache?: boolean;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatRequest {
  model: string;
  system: { text: string; cache?: boolean }[];
  messages: Message[];
  tools?: ToolDef[];
  maxTokens: number;
  effort?: Effort;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal';

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; stop: StopReason; content: Block[]; usage: Usage; model: string };

/**
 * The one interface every model backend implements. A request streams text as
 * it is written and always ends with exactly one `done` event.
 */
export interface ChatProvider {
  readonly name: string;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

/** Collect a stream into its final event (for calls that are not shown live). */
export async function complete(
  provider: ChatProvider,
  req: ChatRequest,
): Promise<Extract<StreamEvent, { type: 'done' }>> {
  for await (const ev of provider.stream(req)) {
    if (ev.type === 'done') return ev;
  }
  throw new Error(`${provider.name} stream ended without a result`);
}

export function textOf(content: Block[]): string {
  return content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
}
