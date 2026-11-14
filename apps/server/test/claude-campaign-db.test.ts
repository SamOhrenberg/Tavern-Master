import type { CampaignDetail, CampaignSummary, ServerMeta } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { createToken } from '../src/connector/tokens.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { getRoom } from '../src/realtime/room.js';
import { mcpClient, signedIn, type SignedIn } from './http.js';

// The app around a campaign run by Claude: the choice at creation, presence, the setup routes.
describe.skipIf(!process.env.TEST_DATABASE_URL)('Claude campaigns over HTTP (database)', () => {
  const tag = `h${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let host = '';
  let as: SignedIn;
  const made: string[] = [];

  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;

  const boot = async (overrides: Record<string, string> = {}) => {
    await app?.close();
    setConfigForTests(testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, ...overrides }));
    app = await buildApp();
    as = await signedIn(app, host);
  };

  beforeAll(async () => {
    setConfigForTests(testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }));
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `sys-${tag}`,
    ]))!.id;
    host = await user('Host');
    await boot();
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [made]);
    await q('DELETE FROM users WHERE id = $1', [host]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await closeDb();
  });

  const create = async (body: Record<string, unknown>) => {
    const res = await as.post<{ id?: string; error?: { message: string } }>('/api/campaigns', {
      name: `Camp ${made.length} ${tag}`,
      systemId: system,
      ...body,
    });
    if (res.body.id) made.push(res.body.id);
    return res;
  };

  it('tells the client what this server can do', async () => {
    const meta = await as.get<ServerMeta>('/api/meta');
    expect(meta.status).toBe(200);
    expect(meta.body.builtInAi).toBe(true);
    expect(meta.body.connectorUrl).toMatch(/\/mcp$/);
    expect(meta.body.claudeConnected).toBe(false);
  });

  it('creates a campaign run by whichever AI was chosen, and says so', async () => {
    const claude = await create({ dm: 'claude' });
    expect(claude.status).toBe(200);
    const list = await as.get<{ campaigns: CampaignSummary[] }>('/api/campaigns');
    expect(list.body.campaigns.find((c) => c.id === claude.body.id)?.dm).toBe('claude');
    const detail = await as.get<{ campaign: CampaignDetail }>(`/api/campaigns/${claude.body.id}`);
    expect(detail.body.campaign.settings.dm).toBe('claude');
    expect(detail.body.campaign.dmStatus).toMatchObject({ mode: 'claude', state: 'never' });
    // With built-in AI available the default stays the built-in one.
    const plain = await create({});
    const back = await as.get<{ campaign: CampaignDetail }>(`/api/campaigns/${plain.body.id}`);
    expect(back.body.campaign.dm).toBe('server');
    expect(back.body.campaign.dmStatus.state).toBe('listening');
  });

  it('shows whether Claude is at the table', async () => {
    const res = await create({ dm: 'claude' });
    const id = res.body.id!;
    const status = async () =>
      (await as.get<{ campaign: CampaignDetail }>(`/api/campaigns/${id}`)).body.campaign.dmStatus;
    expect(await status()).toMatchObject({ state: 'never', lastSeenAt: null });

    const { token } = (await createToken(host, 'presence'))!;
    const claude = mcpClient(app, token);
    expect((await claude.call('open_campaign', { campaign: id })).isError).toBe(false);
    const here = await status();
    expect(here.state).toBe('listening');
    expect(here.lastSeenAt).toBeTruthy();
    expect((await as.get<ServerMeta>('/api/meta')).body.claudeConnected).toBe(true);

    // Gone quiet past the listening window.
    getRoom(id)!.ageLastCallForTests(5 * 60_000);
    expect((await status()).state).toBe('away');

    // Nothing is waiting, so there is nothing to give back.
    expect((await as.post(`/api/campaigns/${id}/desk/release`)).status).toBe(409);
  });

  it('runs every campaign with Claude on a server with no built-in AI', async () => {
    await boot({ LLM_PROVIDER: 'none' });
    expect((await as.get<ServerMeta>('/api/meta')).body.builtInAi).toBe(false);
    const res = await create({});
    expect(res.status).toBe(200);
    const detail = await as.get<{ campaign: CampaignDetail }>(`/api/campaigns/${res.body.id}`);
    expect(detail.body.campaign.dm).toBe('claude');
    const refused = await create({ dm: 'server' });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.message).toContain('no built-in AI');
    const patched = await as.patch(`/api/campaigns/${res.body.id}`, { dm: 'server' });
    expect(patched.status).toBe(400);
    await boot();
  });
});
