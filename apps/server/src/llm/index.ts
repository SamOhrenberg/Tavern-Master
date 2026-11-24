import { config } from '../config.js';
import { q1 } from '../db/pool.js';
import { log } from '../log.js';
import { decryptSecret } from '../security/crypto.js';
import { bedrockProvider, firstPartyProvider, foundryProvider } from './anthropic.js';
import { mockProvider } from './mock.js';
import { openAiProvider } from './openai.js';
import type { ChatProvider, Effort } from './types.js';

/**
 * narration: the GM. utility: summaries, cataloguing, reading uploaded sheets.
 * companion: a party member with its own AI. prep: the character-building guide.
 * design: work on a game system from its rulebooks, done once and kept (drafting
 * its sheet, distilling its setting's voice, the workshop with the admins).
 */
export type LlmTask = 'narration' | 'utility' | 'companion' | 'prep' | 'design';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const atLeast = (effort: Effort, floor: Effort): Effort =>
  EFFORTS.indexOf(effort) < EFFORTS.indexOf(floor) ? floor : effort;

export interface ResolvedLlm {
  provider: ChatProvider;
  model: string;
  effort: Effort;
  keySource: 'instance' | 'byo';
}

/** Raised when no usable model is configured; the message is safe to show players. */
export class LlmNotConfigured extends Error {}

// BYO keys only ever talk to these fixed endpoints. Users cannot supply a URL,
// so a key form can never be used to make the server call an internal address.
const BYO_BASE_URL = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
} as const;

let instance: ChatProvider | undefined;
let override: ChatProvider | undefined;

/** Swap in a scripted provider (tests). Pass nothing to restore. */
export function setProviderForTests(p?: ChatProvider): void {
  override = p;
  instance = undefined;
}

function instanceProvider(): ChatProvider {
  if (override) return override;
  if (instance) return instance;
  const cfg = config();
  switch (cfg.LLM_PROVIDER) {
    case 'mock':
      instance = mockProvider();
      break;
    case 'anthropic':
      if (!cfg.ANTHROPIC_API_KEY) throw new LlmNotConfigured('The server has no ANTHROPIC_API_KEY set.');
      instance = firstPartyProvider(
        cfg.ANTHROPIC_API_KEY,
        cfg.ANTHROPIC_REFUSAL_FALLBACK === 'default',
        cfg.LLM_CACHE_TTL === '1h',
      );
      break;
    case 'bedrock':
      instance = bedrockProvider(cfg);
      break;
    case 'foundry':
      if (!cfg.ANTHROPIC_FOUNDRY_RESOURCE)
        throw new LlmNotConfigured('ANTHROPIC_FOUNDRY_RESOURCE is not set.');
      instance = foundryProvider(cfg);
      break;
    case 'openai':
      instance = openAiProvider({ baseUrl: cfg.OPENAI_BASE_URL, apiKey: cfg.OPENAI_API_KEY });
      break;
    case 'none':
      throw new LlmNotConfigured('This server has no built-in AI. Run the campaign with Claude.');
  }
  return instance!;
}

/** Whether the server itself has a model it can call, before any user's own key. */
export function instanceAiConfigured(): boolean {
  if (override) return true;
  const cfg = config();
  switch (cfg.LLM_PROVIDER) {
    case 'none':
      return false;
    case 'anthropic':
      return !!cfg.ANTHROPIC_API_KEY;
    case 'foundry':
      return !!cfg.ANTHROPIC_FOUNDRY_RESOURCE;
    default:
      return true;
  }
}

/**
 * Whether a campaign this user owns could run on a built-in model: the
 * server has one, or the user stored a key of their own.
 */
export async function builtInAiFor(userId: string): Promise<boolean> {
  if (instanceAiConfigured()) return true;
  const row = await q1('SELECT 1 FROM user_api_keys WHERE user_id = $1 AND enabled', [userId]);
  return !!row;
}

interface KeyRow {
  provider: 'anthropic' | 'openai' | 'openrouter';
  key_enc: string;
  model_narration: string | null;
  model_utility: string | null;
}

/**
 * Pick the backend and model for a task. If the campaign owner stored their
 * own key it pays for their campaign; otherwise the instance configuration is
 * used. Narration and utility work (summaries) get separate models.
 */
export async function resolveLlm(task: LlmTask, ownerId?: string | null): Promise<ResolvedLlm> {
  const cfg = config();
  // Companions and the guide write a few sentences at a time; low effort keeps them cheap.
  // Design work reads rulebooks closely and is done once, so it is worth more thought.
  const effort: Effort =
    task === 'narration'
      ? cfg.LLM_EFFORT_NARRATION
      : task === 'utility'
        ? cfg.LLM_EFFORT_UTILITY
        : task === 'design'
          ? atLeast(cfg.LLM_EFFORT_NARRATION, 'medium')
          : 'low';
  // Tasks that fall back to the narration model when nothing more specific is set.
  // Companions are among them: playing a character well, blind, needs a capable model.
  const heavy = task !== 'utility';
  const defaultModel =
    task === 'companion'
      ? (cfg.LLM_MODEL_COMPANION ?? cfg.LLM_MODEL_NARRATION)
      : task === 'prep' || task === 'design'
        ? (cfg.LLM_MODEL_PREP ?? cfg.LLM_MODEL_NARRATION)
        : heavy
          ? cfg.LLM_MODEL_NARRATION
          : cfg.LLM_MODEL_UTILITY;

  if (ownerId && !override && cfg.LLM_PROVIDER !== 'mock') {
    const row = await q1<KeyRow>(
      'SELECT provider, key_enc, model_narration, model_utility FROM user_api_keys WHERE user_id = $1 AND enabled',
      [ownerId],
    );
    if (row) {
      try {
        const apiKey = decryptSecret(row.key_enc);
        const chosen = heavy ? row.model_narration : row.model_utility;
        if (row.provider === 'anthropic') {
          const fallbackModel = heavy ? 'claude-opus-5-5' : 'claude-haiku-5-5';
          return {
            provider: firstPartyProvider(
              apiKey,
              cfg.ANTHROPIC_REFUSAL_FALLBACK === 'default',
              cfg.LLM_CACHE_TTL === '1h',
            ),
            model: chosen ?? (defaultModel.startsWith('claude-') ? defaultModel : fallbackModel),
            effort,
            keySource: 'byo',
          };
        }
        if (chosen) {
          return {
            provider: openAiProvider({ name: row.provider, baseUrl: BYO_BASE_URL[row.provider], apiKey }),
            model: chosen,
            effort,
            keySource: 'byo',
          };
        }
      } catch (err) {
        // e.g. ENCRYPTION_KEY was rotated. Fall back rather than break play.
        log().warn({ err }, 'stored API key could not be used; using the instance key');
      }
    }
  }

  const provider = instanceProvider();
  // Bedrock names Claude models with a vendor prefix.
  const model =
    provider.name === 'bedrock' && defaultModel.startsWith('claude-')
      ? `anthropic.${defaultModel}`
      : defaultModel;
  return { provider, model, effort, keySource: 'instance' };
}
