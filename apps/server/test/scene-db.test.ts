import type { GameState } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgStore } from '../src/agent/store.js';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { rewindTo, snapshotState } from '../src/rewind.js';
import { signedIn, type SignedIn } from './http.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('who is in the scene (database)', () => {
  const tag = `sc${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let camp = '';
  let host = '';
  let ann = '';
  let mara = '';
  let roach = '';
  let masked = '';
  let place = '';
  let asHost: SignedIn;
  let asAnn: SignedIn;

  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;
  const entity = async (name: string, kind = 'npc', hidden = false) =>
    (await q1<{ id: string }>(
      `INSERT INTO entities (campaign_id, kind, name, hidden) VALUES ($1, $2, $3, $4) RETURNING id`,
      [camp, kind, name, hidden],
    ))!.id;
  const inScene = async () =>
    (
      await q<{ name: string }>(
        'SELECT name FROM entities WHERE campaign_id = $1 AND in_scene ORDER BY name',
        [camp],
      )
    ).map((r) => r.name);
  const toggle = (who: SignedIn, entityId: string, on: boolean) =>
    who.send('PUT', `/api/campaigns/${camp}/entities/${entityId}/scene`, { inScene: on });

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
      `INSERT INTO campaigns (system_id, owner_id, name) VALUES ($1, $2, 'Ashen Crown') RETURNING id`,
      [system, host],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      camp,
      host,
    ]);
    await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [camp, ann]);
    mara = await entity('Mara Voss');
    roach = await entity('Dumpster Roach', 'creature');
    masked = await entity('The Masked One', 'npc', true);
    place = await entity('The Gilded Rat', 'location');
    app = await buildApp();
    asHost = await signedIn(app, host);
    asAnn = await signedIn(app, ann);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = $1', [camp]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[host, ann]]);
    await closeDb();
  });

  it('puts exactly the people and creatures it is given in the scene', async () => {
    await pgStore.setPresent(camp, [mara, roach, masked, place]);
    // A place is never "in the scene": only people and creatures are.
    expect(await inScene()).toEqual(['Dumpster Roach', 'Mara Voss', 'The Masked One']);
    await pgStore.setPresent(camp, [mara, masked]);
    expect(await inScene()).toEqual(['Mara Voss', 'The Masked One']);
    expect((await pgStore.entities(camp)).find((e) => e.id === mara)?.inScene).toBe(true);
  });

  it('shows players who is there, but not someone they have not met', async () => {
    const { entities } = (await asAnn.get<{ state: GameState }>(`/api/campaigns/${camp}/state`)).body.state;
    expect(entities.filter((e) => e.inScene).map((e) => e.name)).toEqual(['Mara Voss']);
    expect(entities.find((e) => e.id === roach)?.inScene).toBe(false);
  });

  it('lets an owner, and only an owner, put someone in or take them out', async () => {
    expect((await toggle(asAnn, roach, true)).status).toBe(403);
    expect((await toggle(asHost, roach, true)).status).toBe(200);
    expect((await toggle(asHost, mara, false)).status).toBe(200);
    expect(await inScene()).toEqual(['Dumpster Roach', 'The Masked One']);
    expect((await toggle(asHost, place, true)).status).toBe(404);
  });

  it('goes back with the story when it is rewound', async () => {
    await pgStore.setPresent(camp, [mara]);
    const scene = (await q1<{ id: number }>(
      `INSERT INTO messages (campaign_id, kind, content) VALUES ($1, 'dm', 'Mara counts her coins.') RETURNING id`,
      [camp],
    ))!.id;
    await snapshotState(camp, null);
    await pgStore.setPresent(camp, [roach]);
    await rewindTo(camp, Number(scene));
    expect(await inScene()).toEqual(['Mara Voss']);
  });
});
