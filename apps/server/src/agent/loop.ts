import type { ResolvedLlm } from '../llm/index.js';
import type { Usage } from '../llm/pricing.js';
import type { Block, Message, StreamEvent } from '../llm/types.js';
import type { Rng } from './dice.js';
import type { GameStore, TurnContext } from './store.js';
import { dispatchTool, toolDefs, TOOLS, type ToolSpec } from './tools.js';

export interface AgentRun {
  llm: ResolvedLlm;
  /** The tools this run may use. Defaults to the GM's standard set. */
  tools?: ToolSpec[];
  /** What the run is for, passed through to the provider as a label. */
  task?: string;
  system: { text: string; cache?: boolean }[];
  messages: Message[];
  ctx: TurnContext;
  store: GameStore;
  maxRounds: number;
  maxTokens: number;
  onText?: (text: string) => void;
  /** A short, player-safe line about a tool the DM just used. */
  onTool?: (tool: string, summary: string) => void;
  onUsage?: (usage: Usage, model: string) => Promise<void> | void;
  signal?: AbortSignal;
  rng?: Rng;
}

export interface AgentResult {
  text: string;
  refused: boolean;
  truncated: boolean;
  rounds: number;
  toolCalls: number;
}

const REFUSAL_TEXT =
  'The narrator falters and sets the scene aside. (The model declined to continue this thread; try approaching it differently.)';

/**
 * Sent once when a reply ends with nothing for the reader. Some models return
 * text written before a tool call as a hidden progress note, so a narration
 * written ahead of its bookkeeping can come back empty.
 */
const ASK_AGAIN =
  'Nothing you have written has reached the reader yet: text written before a tool call is not shown to them. Write your reply now, in full, with no more tool calls.';

/** What players may see about a tool call. Never includes hidden state. */
export function publicSummary(tool: string, input: unknown, result: string): string {
  switch (tool) {
    case 'roll_dice':
      return result;
    case 'lookup_rules':
      return `Consulted the rules: “${String((input as { query?: unknown })?.query ?? '').slice(0, 80)}”`;
    case 'get_state':
      return 'Reviewed the party';
    case 'reveal_secret':
      return 'A secret comes to light';
    case 'remember':
    case 'write_note':
      // What the GM writes down for itself is never shown.
      return 'Made a note for later';
    case 'recall':
      return 'Checked the chronicle';
    case 'search_documents':
      return 'Consulted the campaign documents';
    case 'search_setting':
      return 'Drew on the setting';
    case 'set_whereabouts':
      return 'Noted who is where';
    case 'correct_narration':
      return 'Corrected the last scene';
    case 'delete_entity':
      // A bookkeeping entry's name may be a secret, so the name is not shown.
      return 'Tidied the codex';
    case 'clear_flag':
      return 'Updated the story record';
    case 'request_roll':
      return `Asked ${String((input as { character?: unknown })?.character ?? 'a player').slice(0, 80)} for a roll`;
    case 'edit_sheet':
    case 'adjust_track':
      // The first line is the change; anything after it is a note for the GM alone.
      return result.split('\n')[0]!.slice(0, 160);
    case 'ask_ai':
      // The answer is the GM's to use in its narration, so it is not shown here.
      return `Asked ${String((input as { ai?: unknown })?.ai ?? 'another AI').slice(0, 40)} for help`;
    default:
      return result.slice(0, 160);
  }
}

/**
 * The DM's turn: call the model, run the tools it asks for, feed the results
 * back, and repeat until it writes its narration or the round limit is hit.
 * The conversation only ever grows by appending, and assistant content is
 * returned to the model untouched, which keeps the prompt cache valid and any
 * reasoning blocks intact for the rest of the turn.
 */
export async function runAgentTurn(run: AgentRun): Promise<AgentResult> {
  const { llm, ctx, store } = run;
  const messages = [...run.messages];
  const specs = run.tools ?? TOOLS;
  const tools = toolDefs(specs);
  const texts: string[] = [];
  let toolCalls = 0;
  let truncated = false;
  let askedAgain = false;

  /** Add a round, with the cache breakpoint moved to its newest message. */
  const append = (assistant: Block[], user: Block[]) => {
    for (const m of messages.slice(run.messages.length)) m.cache = false;
    messages.push({ role: 'assistant', content: assistant });
    messages.push({ role: 'user', content: user, cache: true });
  };

  for (let round = 1; round <= run.maxRounds; round++) {
    let done: Extract<StreamEvent, { type: 'done' }> | undefined;
    let roundText = '';
    for await (const ev of llm.provider.stream({
      model: llm.model,
      system: run.system,
      messages,
      tools,
      maxTokens: run.maxTokens,
      effort: llm.effort,
      signal: run.signal,
      task: run.task,
    })) {
      if (ev.type === 'text') {
        if (!roundText && texts.length) run.onText?.('\n\n');
        roundText += ev.text;
        run.onText?.(ev.text);
      } else {
        done = ev;
      }
    }
    if (!done) throw new Error('model stream ended without a result');
    await run.onUsage?.(done.usage, done.model);
    if (roundText.trim()) texts.push(roundText.trim());

    if (done.stop === 'refusal') {
      return { text: texts.join('\n\n') || REFUSAL_TEXT, refused: true, truncated, rounds: round, toolCalls };
    }
    if (done.stop === 'max_tokens') truncated = true;

    const calls = done.content.filter(
      (b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (done.stop !== 'tool_use' || calls.length === 0) {
      // Nothing for the reader at all (a hidden narration, or a reply cut off while thinking): ask once more.
      if (!texts.length && !askedAgain && round < run.maxRounds) {
        askedAgain = true;
        append(done.content, [
          // A call that was cut off is answered too, so the conversation stays well formed.
          ...calls.map((c): Block => ({
            type: 'tool_result',
            toolUseId: c.id,
            content: 'Not run: your reply was cut off before this call was finished.',
            isError: true,
          })),
          { type: 'text', text: ASK_AGAIN },
        ]);
        continue;
      }
      return { text: texts.join('\n\n'), refused: false, truncated, rounds: round, toolCalls };
    }

    const results: Block[] = [];
    for (const call of calls) {
      toolCalls++;
      const outcome = await dispatchTool(call.name, call.input, ctx, store, run.rng, specs);
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: outcome.content,
        isError: outcome.isError,
      });
      if (!outcome.isError) run.onTool?.(call.name, publicSummary(call.name, call.input, outcome.content));
    }
    if (round === run.maxRounds - 1) {
      results.push({
        type: 'text',
        text: 'You have one reply left this turn. Write the narration now without further tool calls.',
      });
    }

    append(done.content, results);
  }

  // Out of rounds while still asking for tools: use whatever was narrated.
  return {
    text:
      texts.join('\n\n') ||
      'The dust settles while the narrator gathers their thoughts. (The turn ran out of steps; try again.)',
    refused: false,
    truncated: true,
    rounds: run.maxRounds,
    toolCalls,
  };
}

/**
 * Last line of defence for hidden information: if narration quotes a secret
 * that has not been revealed through reveal_secret, the passage is blacked
 * out before the message is stored or broadcast. It catches verbatim leaks;
 * the prompt and the reveal tool are the first line.
 */
export function redactSecrets(text: string, unrevealed: string[]): { text: string; redacted: boolean } {
  let out = text;
  let redacted = false;
  for (const secret of unrevealed) {
    for (const clause of secret.split(/[.;!?\n]+/)) {
      const words = clause.trim().split(/\s+/).filter(Boolean);
      if (words.join(' ').length < 24) continue;
      const pattern = new RegExp(
        words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'),
        'gi',
      );
      if (pattern.test(out)) {
        redacted = true;
        out = out.replace(pattern, '▮▮▮');
      }
    }
  }
  return { text: out, redacted };
}

/** Keep only the citations the narration actually refers to. */
export function usedCitations<T extends { ref: string }>(text: string, citations: T[]): T[] {
  const refs = new Set([...text.matchAll(/\[(R\d+)\]/g)].map((m) => m[1]));
  return citations.filter((c) => refs.has(c.ref));
}
