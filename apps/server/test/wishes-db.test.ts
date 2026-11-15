import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshBrief, wishesSince } from '../src/agent/brief.js';
import { briefAndChanges } from '../src/agent/context.js';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { wishesNoteForTurn } from '../src/connector/tools.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { signedIn, type SignedIn } from './http.js';

// Wishes changed after the campaign began reach the GM without a new brief.
describe.skipIf(!process.env.TEST_DATABASE_URL)('wishes during play (database)', () => {
  const tag = `wsh${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let app: FastifyInstance;
  let system = '';
  let camp = '';
  let host = '';
  let ann = '';
  let asAnn: SignedIn;

  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;
  const stampOf = async () =>
    (await q1<{ wishes_at: Date | null }>(
      'SELECT wishes_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
      [camp, ann],
    ))!.wishes_at;

  beforeAll(async () => {
    setConfigForTests(testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }));
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `sys-${tag}`,
    ]))!.id;
    host = await user('Host');
    ann = await user('Ann');
    camp = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, phase, started_at, opened_at)
       VALUES ($1, $2, $3, 'active', now(), now()) RETURNING id`,
      [system, host, `Play ${tag}`],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      camp,
      host,
    ]);
    await q(`INSERT INTO campaign_members (campaign_id, user_id, wishes) VALUES ($1, $2, 'A heist.')`, [
      camp,
      ann,
    ]);
    app = await buildApp();
    asAnn = await signedIn(app, ann);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = $1', [camp]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`%-${tag}`]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await closeDb();
  });

  it('puts the wishes from before play in the brief, with nothing new after it', async () => {
    const brief = await refreshBrief(camp);
    expect(brief).toContain('Ann: "A heist."');
    expect((await briefAndChanges(camp)).changes).not.toContain('wishes');
  });

  it('tells the GM about wishes changed during play, without compiling the brief again', async () => {
    const res = await asAnn.put(`/api/campaigns/${camp}/wishes`, {
      wishes: 'A heist. And a dragon, please.',
    });
    expect(res.status).toBe(200);
    const { brief, changes } = await briefAndChanges(camp);
    expect(brief).not.toContain('dragon');
    expect(changes).toContain('Players updated their wishes for the story.');
    expect(changes).toContain('Ann: "A heist. And a dragon, please."');
  });

  it('stamps the change only when the words change', async () => {
    const first = await stampOf();
    await asAnn.put(`/api/campaigns/${camp}/wishes`, { wishes: 'A heist. And a dragon, please.' });
    expect(await stampOf()).toEqual(first);
  });

  it('shows Claude a wish saved while it was writing the previous scene', async () => {
    const sessionId = (await q1<{ id: string }>(
      `INSERT INTO play_sessions (campaign_id, number) VALUES ($1, 1) RETURNING id`,
      [camp],
    ))!.id;
    const turn = (n: number, closedMinutesAgo: number) =>
      q(
        `INSERT INTO turns (campaign_id, session_id, number, status, closed_at)
         VALUES ($1, $2, $3, 'done', now() - make_interval(mins => $4))`,
        [camp, sessionId, n, closedMinutesAgo],
      );
    await turn(1, 10);
    // Claude narrated turn 1 five minutes ago, after turn 1 closed ten minutes ago.
    await q(
      `INSERT INTO messages (campaign_id, kind, content, created_at) VALUES ($1, 'dm', 'Scene.', now() - interval '5 minutes')`,
      [camp],
    );
    const saved = (minutesAgo: number) =>
      q(
        `UPDATE campaign_members SET wishes = 'A dragon.', wishes_at = now() - make_interval(mins => $3)
          WHERE campaign_id = $1 AND user_id = $2`,
        [camp, ann, minutesAgo],
      );
    // Saved while Claude was still writing turn 1: after the turn closed, before the narration.
    await saved(7);
    expect(await wishesNoteForTurn(camp, 2)).toContain('Ann: "A dragon."');
    // Saved before turn 1 closed: Claude already saw it with turn 1.
    await saved(12);
    expect(await wishesNoteForTurn(camp, 2)).toBe('');
  });

  it('says so when a player clears their wishes, and lists only changes after a given moment', async () => {
    const before = new Date();
    expect(await wishesSince(camp, before, 'Since:')).toBe('');
    await asAnn.put(`/api/campaigns/${camp}/wishes`, { wishes: '' });
    expect(await wishesSince(camp, before, 'Since:')).toContain('Ann cleared their wishes');
  });
});
