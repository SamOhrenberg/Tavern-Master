import { q, q1 } from '../db/pool.js';
import { log } from '../log.js';
import { decryptSecret } from '../security/crypto.js';

/**
 * Other AIs the GM can ask for help with one piece of writing, e.g. Gemini for
 * achievement announcements. An admin adds them with their own API keys; the
 * GM reaches them only through the ask_ai tool, and only the text it writes
 * into that call is sent.
 */
export type OutsideProvider = 'gemini' | 'openai';

export interface OutsideAi {
  name: string;
  provider: OutsideProvider;
  model: string;
  baseUrl: string | null;
  apiKey: string;
}

/** What the GM is told about an AI it can ask. */
export interface OutsideAiListing {
  name: string;
  note: string;
}

export class OutsideAiError extends Error {}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_BASE = 'https://api.openai.com/v1';
/**
 * Gemini 2.5 and later count their thinking against the output cap, and the Pro
 * models cannot turn it off, so the cap leaves room for both.
 */
const MAX_OUTPUT_TOKENS = 8192;
/**
 * OpenAI's reasoning models (the o-series, GPT-5 and later, such as
 * gpt-6-astra), by name, also behind a gateway that prefixes it ("openai/…").
 * Their reasoning counts against the output cap, so they get more room and are
 * asked to think briefly: polishing prose or writing an announcement needs
 * little of it, and a long think is slow, costly and can crowd out the answer.
 * "low" is the lowest effort every one of them accepts.
 */
const OPENAI_REASONING = /(^|\/)(o\d|gpt-([5-9]|\d{2,}))/i;
const REASONING_OUTPUT_TOKENS = 16_384;
/** Tokens Gemini may spend thinking. Pro models take a minimum of 128 and clamp lower values. */
const GEMINI_THINKING_BUDGET = 1024;
const TIMEOUT_MS = 90_000;
/** Longest answer handed back to the GM. */
export const MAX_ANSWER_CHARS = 6000;

const SYSTEM =
  'You are helping the Game Master of a tabletop role-playing game with one piece of writing. ' +
  'Do exactly what the request asks, in the voice and format it asks for. Reply with only the ' +
  'requested text: no preamble, no explanation, no follow-up questions.';

export async function listOutsideAis(): Promise<OutsideAiListing[]> {
  return q<OutsideAiListing>('SELECT name, note FROM outside_ais ORDER BY lower(name)');
}

export async function findOutsideAi(name: string): Promise<OutsideAi | null> {
  const row = await q1<{
    name: string;
    provider: OutsideProvider;
    model: string;
    base_url: string | null;
    api_key_enc: string;
  }>('SELECT name, provider, model, base_url, api_key_enc FROM outside_ais WHERE lower(name) = lower($1)', [
    name.trim(),
  ]);
  if (!row) return null;
  return {
    name: row.name,
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    apiKey: decryptSecret(row.api_key_enc),
  };
}

async function failure(res: Response): Promise<OutsideAiError> {
  const body = await res.text().catch(() => '');
  let detail = '';
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string };
    detail = typeof json.error === 'string' ? json.error : (json.error?.message ?? '');
  } catch {
    // not JSON
  }
  return new OutsideAiError(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
}

/** Send one request to an outside AI and return its text. `fetchImpl` is for tests. */
export async function callOutsideAi(
  ai: OutsideAi,
  request: string,
  fetchImpl: typeof fetch = fetch,
  opts: { system?: string; timeoutMs?: number; maxChars?: number } = {},
): Promise<string> {
  const system = opts.system ?? SYSTEM;
  const maxChars = opts.maxChars ?? MAX_ANSWER_CHARS;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  let text: string;
  let cut = false;
  if (ai.provider === 'gemini') {
    const res = await fetchImpl(`${GEMINI_BASE}/models/${encodeURIComponent(ai.model)}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': ai.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: request }] }],
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // Older models refuse a thinking setting outright, so only the 2.5 family gets one.
          ...(/^gemini-2\.5/i.test(ai.model)
            ? { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } }
            : {}),
        },
      }),
    });
    if (!res.ok) throw await failure(res);
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    if (json.promptFeedback?.blockReason)
      throw new OutsideAiError(`it declined the request (${json.promptFeedback.blockReason})`);
    const candidate = json.candidates?.[0];
    text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('');
    // Cut off by the cap: half an answer must not pass for a whole one.
    if (candidate?.finishReason === 'MAX_TOKENS') cut = true;
    else if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT')
      throw new OutsideAiError(`it declined the request (${candidate.finishReason})`);
  } else {
    const base = (ai.baseUrl || OPENAI_BASE).replace(/\/+$/, '');
    // OpenAI's own newer models reject max_tokens; other compatible servers mostly still want it.
    const cap = base === OPENAI_BASE ? 'max_completion_tokens' : 'max_tokens';
    const reasoning = OPENAI_REASONING.test(ai.model);
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify({
        model: ai.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: request },
        ],
        [cap]: reasoning ? REASONING_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
        ...(reasoning ? { reasoning_effort: 'low' } : {}),
      }),
    });
    if (!res.ok) throw await failure(res);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
    };
    text = json.choices?.[0]?.message?.content ?? '';
    if (json.choices?.[0]?.finish_reason === 'length') cut = true;
  }
  text = text.trim();
  if (cut) {
    throw new OutsideAiError(
      text ? 'its answer was cut off before the end' : 'it ran out of room before it wrote anything',
    );
  }
  if (!text) throw new OutsideAiError('it returned nothing');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Ask the outside AI with this name. Throws OutsideAiError with a message
 * fit for the GM to read when it is unknown, unreachable or says no.
 */
export async function askOutsideAi(name: string, request: string): Promise<{ ai: string; text: string }> {
  const ai = await findOutsideAi(name);
  if (!ai) {
    const known = (await listOutsideAis()).map((a) => a.name);
    throw new OutsideAiError(
      known.length
        ? `No AI named "${name}". You can ask: ${known.join(', ')}.`
        : 'No other AIs are set up on this server. Write it yourself.',
    );
  }
  try {
    return { ai: ai.name, text: await callOutsideAi(ai, request) };
  } catch (err) {
    if (err instanceof OutsideAiError) {
      throw new OutsideAiError(`${ai.name} could not answer: ${err.message}. Write it yourself.`);
    }
    log().warn({ err, ai: ai.name }, 'outside AI request failed');
    throw new OutsideAiError(`${ai.name} could not be reached. Write it yourself.`);
  }
}
