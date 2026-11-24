import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { playSinceSummary } from '../src/agent/context.js';
import { summarizeCampaign } from '../src/agent/summarize.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { setProviderForTests } from '../src/llm/index.js';
import type { ChatProvider, StopReason } from '../src/llm/types.js';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A utility model that always gives the same reply. */
function replying(text: string, stop: StopReason = 'end'): ChatProvider {
  return {
    name: 'scripted',
    async *stream(req) {
      yield { type: 'done', stop, content: text ? [{ type: 'text', text }] : [], usage, model: req.model };
    },
  };
}

// A summary replaces the play it covers, so a reply that is no summary must leave the play alone.
describe.skipIf(!process.env.TEST_DATABASE_URL)('the built-in chronicle (database)', () => {
  const tag = `ch${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let system = '';
  let host = '';
  let camp = '';

  const summaries = async () =>
    (await q1<{ n: number }>('SELECT count(*)::int AS n FROM summaries WHERE campaign_id = $1', [camp]))!.n;
  const unsummarised = async () =>
    (await q1<{ n: number }>(
      'SELECT count(*)::int AS n FROM messages WHERE campaign_id = $1 AND summary_id IS NULL',
      [camp],
    ))!.n;

  beforeAll(async () => {
    setConfigForTests(testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }));
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `sys-${tag}`,
    ]))!.id;
    host = (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, 'Host', 'x') RETURNING id`,
      [`host-${tag}`],
    ))!.id;
    camp = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, phase, started_at, opened_at)
       VALUES ($1, $2, $3, 'active', now(), now()) RETURNING id`,
      [system, host, `Chronicle ${tag}`],
    ))!.id;
    const session = (await q1<{ id: string }>(
      `INSERT INTO play_sessions (campaign_id, number) VALUES ($1, 1) RETURNING id`,
      [camp],
    ))!.id;
    // Twelve messages, so some are due once the most recent ones are kept verbatim.
    for (let i = 0; i < 12; i++) {
      await q(
        `INSERT INTO messages (campaign_id, session_id, kind, user_id, character_name, content)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        i % 2
          ? [camp, session, 'dm', null, null, `The wind howls through the pass, scene ${i}.`]
          : [camp, session, 'action', host, 'Thorn', `Thorn presses on, step ${i}.`],
      );
    }
  });

  afterEach(() => setProviderForTests());

  afterAll(async () => {
    await q('DELETE FROM campaigns WHERE id = $1', [camp]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await q('DELETE FROM users WHERE id = $1', [host]);
    await closeDb();
  });

  it.each([
    ['a declined request', replying('', 'refusal')],
    ['an empty reply', replying('')],
    [
      'a reply cut off by the token limit',
      replying('{"summary": "Thorn pressed on through the', 'max_tokens'),
    ],
    ['broken JSON', replying('{"summary": "Thorn pressed on through the pass and"')],
  ])('keeps the play when the model returns %s', async (_name, provider) => {
    setProviderForTests(provider);
    await expect(summarizeCampaign(camp)).rejects.toThrow();
    expect(await summaries()).toBe(0);
    expect(await unsummarised()).toBe(12);
  });

  it('stores a usable summary and folds the play it covers', async () => {
    setProviderForTests(
      replying(
        JSON.stringify({
          summary: 'Thorn pressed on through the howling pass, step after step, and the wind never let up.',
          memories: [{ kind: 'thread', content: 'The pass is still ahead', importance: 3 }],
        }),
      ),
    );
    await summarizeCampaign(camp);
    expect(await summaries()).toBe(1);
    // The most recent messages stay verbatim.
    expect(await unsummarised()).toBeGreaterThan(0);
    expect(await unsummarised()).toBeLessThan(12);
  });

  it('hands a new conversation all the play since the last summary', async () => {
    const play = await playSinceSummary(camp);
    // The summary covers the first four messages; everything after it is there, in full.
    expect(play).not.toContain('step 2.');
    expect(play).not.toContain('scene 3.');
    expect(play).toContain('step 4.');
    expect(play).toContain('scene 11.');
    // A tight budget keeps the end and says what it left out.
    const tight = await playSinceSummary(camp, 30);
    expect(tight).toMatch(/^\(\d+ earlier lines of play are not shown/);
    expect(tight).toContain('scene 11.');
    expect(tight).not.toContain('step 4.');
  });
});
