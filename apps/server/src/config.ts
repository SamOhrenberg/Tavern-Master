import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);
const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // --- http ---
  HOST: z.string().default('0.0.0.0'),
  PORT: int(8080, 1, 65535),
  BASE_URL: z.string().url().default('http://localhost:8080'),
  TRUSTED_PROXIES: list,
  CORS_ALLOWED_ORIGINS: list,

  // --- storage ---
  DATABASE_URL: z.string().min(1),
  DATA_DIR: z.string().default('/data'),

  // --- secrets ---
  SECRET_KEY: z.string().min(32, 'SECRET_KEY must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY must be at least 32 characters'),

  // --- accounts ---
  OPEN_REGISTRATION: bool,
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: optional,
  ADMIN_REQUIRE_TOTP: z
    .string()
    .optional()
    .transform((v) => v === undefined || !['0', 'false', 'no', 'off'].includes(v.toLowerCase())),
  SESSION_IDLE_HOURS: int(72, 1),
  SESSION_MAX_DAYS: int(30, 1),
  LOGIN_LOCKOUT_THRESHOLD: int(8, 1),
  LOGIN_LOCKOUT_MINUTES: int(15, 1),

  // --- rate limits ---
  RATE_LIMIT_AUTH_PER_15M: int(20, 1),
  RATE_LIMIT_API_PER_MIN: int(300, 1),
  RATE_LIMIT_LLM_PER_MIN: int(20, 1),

  // --- uploads / ingestion ---
  MAX_UPLOAD_MB: int(50, 1, 1024),
  MAX_PDF_PAGES: int(1500, 1),
  PARSE_TIMEOUT_SECONDS: int(180, 5),
  PARSE_MEMORY_MB: int(512, 128),

  // --- llm ---
  LLM_PROVIDER: z.enum(['anthropic', 'bedrock', 'foundry', 'openai', 'mock', 'none']).default('anthropic'),
  LLM_MODEL_NARRATION: z.string().default('claude-opus-5-5'),
  LLM_MODEL_UTILITY: z.string().default('claude-haiku-5-5'),
  LLM_EFFORT_NARRATION: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  LLM_EFFORT_UTILITY: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  // AI-run companions and the character-building guide. Empty means "the
  // utility model" and "the narration model" respectively.
  LLM_MODEL_COMPANION: optional,
  LLM_MODEL_PREP: optional,
  LLM_CACHE_TTL: z.enum(['5m', '1h']).default('5m'),
  LLM_MAX_OUTPUT_TOKENS: int(16000, 256),
  LLM_PRICES_JSON: optional,
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_REFUSAL_FALLBACK: z.enum(['default', 'off']).default('default'),
  AWS_REGION: optional,
  AWS_BEARER_TOKEN_BEDROCK: optional,
  AWS_ACCESS_KEY_ID: optional,
  AWS_SECRET_ACCESS_KEY: optional,
  AWS_SESSION_TOKEN: optional,
  ANTHROPIC_FOUNDRY_RESOURCE: optional,
  ANTHROPIC_FOUNDRY_API_KEY: optional,
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_API_KEY: optional,

  // --- embeddings ---
  EMBEDDING_PROVIDER: z.enum(['local', 'openai', 'none']).default('local'),
  EMBEDDING_MODEL: z.string().default('Xenova/bge-small-en-v1.5'),
  EMBEDDING_BASE_URL: z.string().default('https://api.openai.com/v1'),
  EMBEDDING_API_KEY: optional,
  WORKER_URL: z.string().default('http://worker:8081'),
  WORKER_PORT: int(8081, 1, 65535),

  // --- agent ---
  AGENT_MAX_TOOL_ROUNDS: int(8, 1, 30),
  SUMMARY_TRIGGER_TOKENS: int(6000, 500),
  SUMMARY_KEEP_MESSAGES: int(8, 2),
  // Notes written since the GM's brief was compiled ride in the uncached tail
  // of the prompt; past this many tokens the brief is rebuilt instead.
  BRIEF_REFRESH_TOKENS: int(1200, 100),
  ARC_AFTER_SESSIONS: int(10, 4),
  MEMORY_CONSOLIDATE_AT: int(40, 10),
  MAX_CAMPAIGN_DOCUMENTS: int(20, 0),
  DEFAULT_GATHER_WINDOW_SECONDS: int(60, 5, 600),
  // With the Claude app as DM, how long a gathered turn waits for it before
  // the table is given the floor back.
  CONNECTOR_TURN_TIMEOUT_MINUTES: int(120, 5, 1440),
  // The longest one wait_for_work call blocks. Keep it under the reverse proxy's read timeout.
  CONNECTOR_MAX_WAIT_SECONDS: int(50, 10, 600),
  // A turn or request Claude claimed and then left alone this long goes back to waiting.
  CONNECTOR_CLAIM_TIMEOUT_MINUTES: int(10, 2, 120),
  // With no players connected and nothing to do for this long, Claude is told to stop polling.
  CONNECTOR_IDLE_MINUTES: int(10, 1, 240),
  // The largest uploaded sheet photo handed to Claude as an image.
  CONNECTOR_IMAGE_MAX_BYTES: int(3_000_000, 100_000),
  // Signing in from Claude: how long an access token lasts, and how long an unused connection stays signed in.
  OAUTH_ACCESS_TOKEN_MINUTES: int(60, 5, 1440),
  OAUTH_REFRESH_TOKEN_DAYS: int(90, 1, 365),

  // --- budgets (tokens per rolling 24h; 0 disables) ---
  USER_DAILY_TOKEN_BUDGET: int(8_000_000),
  CAMPAIGN_DAILY_TOKEN_BUDGET: int(6_000_000),
});

export type Config = z.infer<typeof schema> & {
  baseUrl: URL;
  cookieSecure: boolean;
  isProd: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  const baseUrl = new URL(c.BASE_URL);
  return { ...c, baseUrl, cookieSecure: baseUrl.protocol === 'https:', isProd: c.NODE_ENV === 'production' };
}

let cached: Config | undefined;
/** Process-wide config, parsed once. Tests call `setConfigForTests`. */
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
export function setConfigForTests(c: Config): void {
  cached = c;
}

/** A complete config for unit tests; no real services are contacted. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://unused',
    SECRET_KEY: 'test-secret-key-test-secret-key-0123',
    ENCRYPTION_KEY: 'test-encryption-key-test-encryption-0123',
    LLM_PROVIDER: 'mock',
    EMBEDDING_PROVIDER: 'none',
    DATA_DIR: process.env.TEST_DATA_DIR ?? './.test-data',
    ...overrides,
  });
}
