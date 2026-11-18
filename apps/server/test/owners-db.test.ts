import type { CampaignDetail, GameSystem, SystemOwner } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { signedIn, type SignedIn } from './http.js';

// Co-owners of a campaign, and players an admin trusts with one game system.
describe.skipIf(!process.env.TEST_DATABASE_URL)('owners (database)', () => {
  const tag = `ow${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let otherSystem = '';
  let campaign = '';
  let admin = '';
  let host = '';
  let ann = '';
  let bob = '';
  let asAdmin: SignedIn;
  let asHost: SignedIn;
  let asAnn: SignedIn;
  let asBob: SignedIn;
  const camp = () => `/api/campaigns/${campaign}`;

  beforeAll(async () => {
    setConfigForTests(
      testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, ADMIN_REQUIRE_TOTP: 'false' }),
    );
    await migrate();
    const make = async (name: string, role = 'user') =>
      (await q1<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
        [`${name}-${tag}`, name, role],
      ))!.id;
    admin = await make('Admin', 'admin');
    host = await make('Host');
    ann = await make('Ann');
    bob = await make('Bob');
    const sys = async (name: string) =>
      (await q1<{ id: string }>(
        `INSERT INTO game_systems (slug, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [`${name}-${tag}`, name, admin],
      ))!.id;
    system = await sys('Owned Rules');
    otherSystem = await sys('Other Rules');
    campaign = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name) VALUES ($1, $2, 'Shared Table') RETURNING id`,
      [system, host],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      campaign,
      host,
    ]);
    for (const m of [ann, bob])
      await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [campaign, m]);
    app = await buildApp();
    asAdmin = await signedIn(app, admin);
    asHost = await signedIn(app, host);
    asAnn = await signedIn(app, ann);
    asBob = await signedIn(app, bob);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = $1', [campaign]);
    await q('DELETE FROM game_systems WHERE id = ANY($1::uuid[])', [[system, otherSystem]]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[admin, host, ann, bob]]);
    await closeDb();
  });

  it('lets only the host make a player an owner', async () => {
    expect((await asAnn.put(`${camp()}/members/${bob}/role`, { role: 'owner' })).status).toBe(403);
    expect((await asHost.put(`${camp()}/members/${host}/role`, { role: 'player' })).status).toBe(400);
    expect((await asHost.put(`${camp()}/members/${ann}/role`, { role: 'owner' })).status).toBe(200);
    const { body } = await asAnn.get<{ campaign: CampaignDetail }>(camp());
    expect(body.campaign.role).toBe('owner');
    expect(body.campaign.ownerId).toBe(host);
    // A co-owner cannot make owners either.
    expect((await asAnn.put(`${camp()}/members/${bob}/role`, { role: 'owner' })).status).toBe(403);
  });

  it('gives a co-owner the owner routes, but keeps the host’s own to the host', async () => {
    expect((await asAnn.patch(camp(), { tone: 'Grim' })).status).toBe(200);
    expect((await asBob.patch(camp(), { tone: 'Silly' })).status).toBe(403);
    // Who runs the table is the host's AI or Claude, so only the host switches it.
    expect((await asAnn.patch(camp(), { dm: 'claude' })).status).toBe(403);
    expect((await asAnn.get(`${camp()}/connector`)).status).toBe(403);
    expect((await asAnn.del(camp())).status).toBe(403);
  });

  it('lets a co-owner remove players but not the host or another owner, and leave', async () => {
    expect((await asAnn.del(`${camp()}/members/${host}`)).status).toBe(400);
    await asHost.put(`${camp()}/members/${bob}/role`, { role: 'owner' });
    expect((await asAnn.del(`${camp()}/members/${bob}`)).status).toBe(403);
    await asHost.put(`${camp()}/members/${bob}/role`, { role: 'player' });
    expect((await asAnn.del(`${camp()}/members/${bob}`)).status).toBe(200);
    await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [campaign, bob]);
    // A co-owner may leave, which the host may not.
    expect((await asAnn.del(`${camp()}/members/${ann}`)).status).toBe(200);
    expect((await asHost.del(`${camp()}/members/${host}`)).status).toBe(400);
  });

  it('lets an admin make a player an owner of one system, and only that one', async () => {
    const owners = `/api/systems/${system}/owners`;
    expect((await asHost.put(`${owners}/${ann}`, {})).status).toBe(403);
    expect((await asAdmin.put(`${owners}/${admin}`, {})).status).toBe(400);
    expect((await asAdmin.put(`${owners}/${ann}`, {})).status).toBe(200);

    const list = await asAnn.get<{ owners: SystemOwner[] }>(owners);
    expect(list.body.owners.map((o) => o.id)).toEqual([ann]);
    const { body } = await asAnn.get<{ systems: GameSystem[] }>('/api/systems');
    expect(body.systems.find((s) => s.id === system)).toMatchObject({ canEdit: true, gmInstructions: '' });
    expect(body.systems.find((s) => s.id === otherSystem)?.canEdit).toBe(false);

    // An owner shapes their system as an admin would; not another, and cannot delete it or add owners.
    expect((await asAnn.patch(`/api/systems/${system}`, { gmInstructions: 'Be kind.' })).status).toBe(200);
    expect((await asAnn.patch(`/api/systems/${otherSystem}`, { homebrew: true })).status).toBe(403);
    expect((await asAnn.get(`/api/systems/${system}/workshop`)).status).toBe(200);
    expect((await asAnn.get(`/api/systems/${otherSystem}/workshop`)).status).toBe(403);
    expect((await asAnn.put(`${owners}/${bob}`, {})).status).toBe(403);
    expect((await asAnn.del(`/api/systems/${system}`)).status).toBe(403);
    expect((await asBob.get(owners)).status).toBe(403);

    expect((await asAdmin.del(`${owners}/${ann}`)).status).toBe(200);
    expect((await asAnn.patch(`/api/systems/${system}`, { homebrew: true })).status).toBe(403);
  });
});
