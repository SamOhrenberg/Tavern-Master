import type { Entity, EntityFull, GameState } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { signedIn, type SignedIn } from './http.js';

// The NPCs tab: owners keep people and creatures by hand; players see only what is not a spoiler.
describe.skipIf(!process.env.TEST_DATABASE_URL)('NPCs and creatures (database)', () => {
  const tag = `np${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let campaign = '';
  let host = '';
  let ann = '';
  let asHost: SignedIn;
  let asAnn: SignedIn;
  const camp = () => `/api/campaigns/${campaign}`;
  const playerView = async () =>
    (await asAnn.get<{ state: GameState }>(`${camp()}/state`)).body.state.entities;

  const roach = {
    kind: 'creature',
    name: 'Dumpster Roach',
    aliases: ['rad roach'],
    summary: 'A dog-sized cockroach that nests in the alley bins.',
    status: 'hostile',
    sheet: [
      { label: 'Armor Class', value: '12', hidden: false },
      { label: 'Hit Points', value: '9 (2d8)', hidden: true },
    ],
    secret: 'The bins are a hive; the queen is under the dumpster.',
  };

  beforeAll(async () => {
    setConfigForTests(testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }));
    await migrate();
    const make = async (name: string) =>
      (await q1<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
        [`${name}-${tag}`, name],
      ))!.id;
    host = await make('Host');
    ann = await make('Ann');
    system = (await q1<{ id: string }>(
      `INSERT INTO game_systems (slug, name, created_by) VALUES ($1, 'Alley Rules', $2) RETURNING id`,
      [`alley-${tag}`, host],
    ))!.id;
    campaign = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, phase) VALUES ($1, $2, 'Back Alley', 'active') RETURNING id`,
      [system, host],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      campaign,
      host,
    ]);
    await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [campaign, ann]);
    app = await buildApp();
    asHost = await signedIn(app, host);
    asAnn = await signedIn(app, ann);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = $1', [campaign]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[host, ann]]);
    await closeDb();
  });

  it('lets an owner add a creature, and shows players only what is not a spoiler', async () => {
    expect((await asAnn.post(`${camp()}/entities`, roach)).status).toBe(403);
    const made = await asHost.post<{ entry: EntityFull }>(`${camp()}/entities`, roach);
    expect(made.status).toBe(200);
    expect(made.body.entry).toMatchObject({ kind: 'creature', hidden: false, sheet: roach.sheet });
    expect((await asHost.post(`${camp()}/entities`, roach)).status).toBe(409);

    const seen = (await playerView()).find((e) => e.name === 'Dumpster Roach')!;
    expect(seen.sheet).toEqual([{ label: 'Armor Class', value: '12' }]);
    expect(seen).not.toHaveProperty('secret');
    // Nothing about spoilers is in what the player is sent, anywhere.
    const raw = (await asAnn.get(`${camp()}/state`)).raw;
    expect(raw).not.toContain('9 (2d8)');
    expect(raw).not.toContain('queen');
  });

  it('keeps an entry the party has not met away from players entirely', async () => {
    const planned = await asHost.post<{ entry: EntityFull }>(`${camp()}/entities`, {
      kind: 'npc',
      name: 'The Landlord',
      summary: 'Owns the building. Wants the roaches gone.',
      hidden: true,
    });
    const id = planned.body.entry.id;
    expect((await playerView()).some((e) => e.name === 'The Landlord')).toBe(false);
    expect((await asAnn.get(`${camp()}/codex/${id}`)).status).toBe(404);
    expect((await asAnn.get(`${camp()}/entities/${id}`)).status).toBe(403);
    expect((await asHost.get<{ entry: EntityFull }>(`${camp()}/entities/${id}`)).body.entry.hidden).toBe(
      true,
    );
  });

  it('lets an owner change and reveal what was hidden, and delete an entry', async () => {
    const id = (await playerView()).find((e) => e.name === 'Dumpster Roach')!.id;
    const full = (await asHost.get<{ entry: EntityFull }>(`${camp()}/entities/${id}`)).body.entry;
    expect(full.secret).toBe(roach.secret);
    const changed = await asHost.put<{ entry: EntityFull }>(`${camp()}/entities/${id}`, {
      ...full,
      status: 'dead',
      sheet: full.sheet.map((l) => ({ ...l, hidden: false })),
      secretRevealed: true,
    });
    expect(changed.status).toBe(200);
    const seen = (await playerView()).find((e) => e.id === id) as Entity;
    expect(seen.status).toBe('dead');
    expect(seen.sheet).toContainEqual({ label: 'Hit Points', value: '9 (2d8)' });
    expect(seen.secret).toBe(roach.secret);

    expect((await asAnn.del(`${camp()}/entities/${id}`)).status).toBe(403);
    expect((await asHost.del(`${camp()}/entities/${id}`)).status).toBe(200);
    expect((await playerView()).some((e) => e.id === id)).toBe(false);
    expect((await asHost.get(`${camp()}/entities/${id}`)).status).toBe(404);
  });
});
