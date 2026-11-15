import type { CampaignDetail } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { createToken } from '../src/connector/tokens.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { mcpClient, signedIn, type SignedIn } from './http.js';

// The lobby's ready check: the host cannot begin until every player has readied up.
describe.skipIf(!process.env.TEST_DATABASE_URL)('ready check (database)', () => {
  const tag = `rdy${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let app: FastifyInstance;
  let system = '';
  let camp = '';
  let host = '';
  let ann = '';
  let bob = '';
  let asHost: SignedIn;
  let asAnn: SignedIn;
  let asBob: SignedIn;
  let claude: ReturnType<typeof mcpClient>;

  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;

  beforeAll(async () => {
    setConfigForTests(testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }));
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `sys-${tag}`,
    ]))!.id;
    host = await user('Host');
    ann = await user('Ann');
    bob = await user('Bob');
    // Run by Claude, so beginning queues the opening for Claude instead of calling a model.
    camp = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, settings) VALUES ($1, $2, $3, '{"dm":"claude"}') RETURNING id`,
      [system, host, `Lobby ${tag}`],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      camp,
      host,
    ]);
    await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2), ($1, $3)', [
      camp,
      ann,
      bob,
    ]);
    app = await buildApp();
    asHost = await signedIn(app, host);
    asAnn = await signedIn(app, ann);
    asBob = await signedIn(app, bob);
    const { token } = (await createToken(host, 'ready'))!;
    claude = mcpClient(app, token, `/mcp/c/${camp}`);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = $1', [camp]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`%-${tag}`]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await closeDb();
  });

  const readiness = async () => {
    const res = await asHost.get<{ campaign: CampaignDetail }>(`/api/campaigns/${camp}`);
    return Object.fromEntries(res.body.campaign.members.map((m) => [m.displayName, m.ready]));
  };

  it('starts everyone not ready', async () => {
    expect(await readiness()).toEqual({ Host: false, Ann: false, Bob: false });
  });

  it('will not let a player ready up before they have a character', async () => {
    const res = await asAnn.put<{ error: { code: string } }>(`/api/campaigns/${camp}/ready`, { ready: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('no_character');
    expect(await readiness()).toMatchObject({ Ann: false });
    for (const who of [ann, bob]) {
      const ch = (await q1<{ id: string }>(
        `INSERT INTO characters (campaign_id, name, hp, max_hp) VALUES ($1, 'Hero', 10, 10) RETURNING id`,
        [camp],
      ))!.id;
      await q('INSERT INTO character_players (character_id, campaign_id, user_id) VALUES ($1, $2, $3)', [
        ch,
        camp,
        who,
      ]);
    }
  });

  it('will not begin until every player is ready, and says who is missing', async () => {
    const res = await asHost.post<{ error: { code: string; message: string } }>(
      `/api/campaigns/${camp}/start`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_ready');
    expect(res.body.error.message).toContain('Ann and Bob');

    expect((await asAnn.put(`/api/campaigns/${camp}/ready`, { ready: true })).status).toBe(200);
    const again = await asHost.post<{ error: { message: string } }>(`/api/campaigns/${camp}/start`);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('Waiting for Bob');
    expect(again.body.error.message).not.toContain('Ann');
  });

  it('lets a player take it back', async () => {
    expect((await asBob.put(`/api/campaigns/${camp}/ready`, { ready: true })).status).toBe(200);
    expect((await asBob.put(`/api/campaigns/${camp}/ready`, { ready: false })).status).toBe(200);
    expect(await readiness()).toMatchObject({ Ann: true, Bob: false });
  });

  it('holds Claude to the same rule', async () => {
    const open = await claude.call('open_campaign', { campaign: `Lobby ${tag}` });
    expect(open.text).toContain('not ready yet: Bob');
    const begin = await claude.call('begin_adventure');
    expect(begin.isError).toBe(true);
    expect(begin.text).toContain('Waiting for Bob');
  });

  it('begins once everyone is ready, and then readiness is settled', async () => {
    expect((await asBob.put(`/api/campaigns/${camp}/ready`, { ready: true })).status).toBe(200);
    expect((await asHost.post(`/api/campaigns/${camp}/start`)).status).toBe(200);
    expect((await asAnn.put(`/api/campaigns/${camp}/ready`, { ready: false })).status).toBe(409);
  });
});
