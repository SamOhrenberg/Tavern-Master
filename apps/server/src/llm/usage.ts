import type { UsageTotals } from '@tavern/protocol';
import { config } from '../config.js';
import { q, q1 } from '../db/pool.js';
import { costMicroUsd, type Usage } from './pricing.js';

export interface UsageRecord {
  task: string;
  provider: string;
  model: string;
  keySource: 'instance' | 'byo';
  campaignId: string | null;
  /** The call is split evenly between these users (the players acting in the turn). */
  userIds: string[];
  usage: Usage;
}

/** Store one LLM call. With several actors each gets an equal share so totals still add up. */
export async function recordUsage(r: UsageRecord): Promise<void> {
  const users: (string | null)[] = r.userIds.length ? r.userIds : [null];
  const n = users.length;
  // The one-hour cache is asked for only on the Anthropic API, and its writes cost more.
  const longCache = r.provider === 'anthropic' && config().LLM_CACHE_TTL === '1h';
  const cost = costMicroUsd(r.model, r.usage, { longCache });
  const share = (v: number, i: number) => Math.floor(v / n) + (i < v % n ? 1 : 0);
  for (let i = 0; i < n; i++) {
    await q(
      `INSERT INTO usage_events (user_id, campaign_id, task, provider, model, key_source,
                                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        users[i],
        r.campaignId,
        r.task,
        r.provider,
        r.model,
        r.keySource,
        share(r.usage.inputTokens, i),
        share(r.usage.outputTokens, i),
        share(r.usage.cacheReadTokens, i),
        share(r.usage.cacheWriteTokens, i),
        share(cost, i),
      ],
    );
  }
}

interface TotalsRow {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
}
const SUMS = `coalesce(sum(input_tokens), 0)::bigint AS input, coalesce(sum(output_tokens), 0)::bigint AS output,
              coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read,
              coalesce(sum(cache_write_tokens), 0)::bigint AS cache_write,
              coalesce(sum(cost_micro_usd), 0)::bigint AS cost`;

export function toTotals(r: TotalsRow | undefined): UsageTotals {
  return {
    inputTokens: r?.input ?? 0,
    outputTokens: r?.output ?? 0,
    cacheReadTokens: r?.cache_read ?? 0,
    cacheWriteTokens: r?.cache_write ?? 0,
    costUsd: (r?.cost ?? 0) / 1e6,
  };
}

export async function usageTotals(f: {
  userId?: string;
  campaignId?: string;
  hours: number;
}): Promise<UsageTotals> {
  const row = await q1<TotalsRow>(
    `SELECT ${SUMS} FROM usage_events
      WHERE at > now() - make_interval(hours => $1)
        AND ($2::uuid IS NULL OR user_id = $2) AND ($3::uuid IS NULL OR campaign_id = $3)`,
    [f.hours, f.userId ?? null, f.campaignId ?? null],
  );
  return toTotals(row);
}

export async function usageByUser(hours: number) {
  return q<TotalsRow & { id: string; username: string; display_name: string }>(
    `SELECT u.id, u.username, u.display_name, ${SUMS}
       FROM usage_events e JOIN users u ON u.id = e.user_id
      WHERE e.at > now() - make_interval(hours => $1) GROUP BY u.id ORDER BY cost DESC`,
    [hours],
  );
}

export async function usageByCampaign(hours: number) {
  return q<TotalsRow & { id: string; name: string }>(
    `SELECT c.id, c.name, ${SUMS}
       FROM usage_events e JOIN campaigns c ON c.id = e.campaign_id
      WHERE e.at > now() - make_interval(hours => $1) GROUP BY c.id ORDER BY cost DESC`,
    [hours],
  );
}

const tokens = (t: UsageTotals) => t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

/**
 * Hard stop before a turn is sent to the model. Budgets are tokens per rolling
 * 24 hours; a per-row override wins over the instance default and 0 disables.
 * Returns a player-facing reason when the turn must not run.
 */
export async function budgetBlock(campaignId: string, userIds: string[]): Promise<string | undefined> {
  const cfg = config();
  const camp = await q1<{ daily_token_budget: number | null }>(
    'SELECT daily_token_budget FROM campaigns WHERE id = $1',
    [campaignId],
  );
  const campLimit = camp?.daily_token_budget ?? cfg.CAMPAIGN_DAILY_TOKEN_BUDGET;
  if (campLimit > 0 && tokens(await usageTotals({ campaignId, hours: 24 })) >= campLimit) {
    return 'This campaign has used its token budget for the last 24 hours. Play resumes as older usage ages out.';
  }
  for (const userId of userIds) {
    const user = await q1<{ daily_token_budget: number | null; display_name: string }>(
      'SELECT daily_token_budget, display_name FROM users WHERE id = $1',
      [userId],
    );
    const limit = user?.daily_token_budget ?? cfg.USER_DAILY_TOKEN_BUDGET;
    if (limit > 0 && tokens(await usageTotals({ userId, hours: 24 })) >= limit) {
      return `${user?.display_name ?? 'A player'} has used their token budget for the last 24 hours.`;
    }
  }
  return undefined;
}
