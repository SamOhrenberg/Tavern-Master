import type { GameSystem, OutsideAi } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { infoOf, loadCampaign } from '../src/realtime/room.js';
import { decryptSecret } from '../src/security/crypto.js';
import { signedIn, type SignedIn } from './http.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('other AIs and system instructions (database)', () => {
  const tag = `ai${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const aiName = `Gemini ${tag}`;
  let app: FastifyInstance;
  let system = '';
  let camp = '';
  let admin = '';
  let player = '';
  let asAdmin: SignedIn;
  let asPlayer: SignedIn;
  let aiId = '';

  const user = async (name: string, role = 'user') =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
      [`${name}-${tag}`, name, role],
    ))!.id;

  beforeAll(async () => {
    setConfigForTests(
      testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, ADMIN_REQUIRE_TOTP: 'false' }),
    );
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `Crawl ${tag}`,
    ]))!.id;
    admin = await user('Admin', 'admin');
    player = await user('Player');
    camp = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name) VALUES ($1, $2, $3) RETURNING id`,
      [system, player, `Floor ${tag}`],
    ))!.id;
    app = await buildApp();
    asAdmin = await signedIn(app, admin);
    asPlayer = await signedIn(app, player);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM outside_ais WHERE name = $1', [aiName]);
    await q('DELETE FROM campaigns WHERE id = $1', [camp]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`%-${tag}`]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await closeDb();
  });

  it('lets only admins add an AI, and never sends the key back', async () => {
    const body = {
      name: aiName,
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      apiKey: 'AIza-secret-9876',
      note: 'achievements',
    };
    expect((await asPlayer.post('/api/admin/outside-ais', body)).status).toBe(403);
    const made = await asAdmin.post<{ id: string }>('/api/admin/outside-ais', body);
    expect(made.status).toBe(200);
    aiId = made.body.id;
    expect((await asAdmin.post('/api/admin/outside-ais', body)).status).toBe(409);

    const list = await asAdmin.get<{ ais: OutsideAi[] }>('/api/admin/outside-ais');
    const ai = list.body.ais.find((a) => a.id === aiId)!;
    expect(ai).toMatchObject({ name: aiName, provider: 'gemini', keyHint: '…9876', note: 'achievements' });
    expect(list.raw).not.toContain('AIza-secret-9876');

    const row = await q1<{ api_key_enc: string }>('SELECT api_key_enc FROM outside_ais WHERE id = $1', [
      aiId,
    ]);
    expect(row!.api_key_enc).not.toContain('AIza');
    expect(decryptSecret(row!.api_key_enc)).toBe('AIza-secret-9876');
  });

  it('replaces the key without touching anything else', async () => {
    expect(
      (await asAdmin.patch(`/api/admin/outside-ais/${aiId}`, { apiKey: 'AIza-newer-1111' })).status,
    ).toBe(200);
    const list = await asAdmin.get<{ ais: OutsideAi[] }>('/api/admin/outside-ais');
    expect(list.body.ais.find((a) => a.id === aiId)).toMatchObject({
      keyHint: '…1111',
      model: 'gemini-2.5-pro',
    });
  });

  it('keeps system instructions for admins and hands them to the GM with the AIs', async () => {
    expect((await asPlayer.patch(`/api/systems/${system}`, { gmInstructions: 'x' })).status).toBe(403);
    const saved = await asAdmin.patch(`/api/systems/${system}`, {
      gmInstructions: `Ask ${aiName} to write every achievement.`,
    });
    expect(saved.status).toBe(200);

    const forAdmin = await asAdmin.get<{ systems: GameSystem[] }>('/api/systems');
    expect(forAdmin.body.systems.find((s) => s.id === system)!.gmInstructions).toContain('achievement');
    const forPlayer = await asPlayer.get<{ systems: GameSystem[] }>('/api/systems');
    expect(forPlayer.body.systems.find((s) => s.id === system)).not.toHaveProperty('gmInstructions');

    const info = infoOf(camp, await loadCampaign(camp));
    expect(info.gmInstructions).toBe(`Ask ${aiName} to write every achievement.`);
    expect(info.outsideAis).toContainEqual({ name: aiName, note: 'achievements' });
  });

  it('removes an AI', async () => {
    expect((await asAdmin.del(`/api/admin/outside-ais/${aiId}`)).status).toBe(200);
    const info = infoOf(camp, await loadCampaign(camp));
    expect(info.outsideAis?.some((a) => a.name === aiName)).toBe(false);
  });
});
