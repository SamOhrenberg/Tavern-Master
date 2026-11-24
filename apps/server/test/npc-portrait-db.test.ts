import { existsSync } from 'node:fs';
import type { EntityFull, GameState } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { rewindTo, snapshotState } from '../src/rewind.js';
import { uploadPath } from '../src/storage.js';
import { signedIn, type SignedIn } from './http.js';

// The smallest valid PNG: one transparent pixel.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

/** A multipart body holding one file, as the browser's FormData sends it. */
function multipart(data: Buffer) {
  const boundary = '----tavern-test-boundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="portrait.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('pictures of people and creatures (database)', () => {
  const tag = `np${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let camp = '';
  let host = '';
  let ann = '';
  let stranger = '';
  let mara = '';
  let asHost: SignedIn;
  let asAnn: SignedIn;
  let asStranger: SignedIn;

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
  const url = (entityId = mara) => `/api/campaigns/${camp}/entities/${entityId}/portrait`;
  const upload = (who: SignedIn, data: Buffer, entityId = mara) => {
    const { body, headers } = multipart(data);
    return who.send<{ portrait?: string }>('PUT', url(entityId), undefined, headers, body);
  };
  const stored = async (entityId = mara) =>
    (await q1<{ portrait: string }>('SELECT portrait FROM npc_portraits WHERE entity_id = $1', [entityId]))
      ?.portrait ?? null;
  const playerState = async () =>
    (await asAnn.get<{ state: GameState }>(`/api/campaigns/${camp}/state`)).body.state;

  beforeAll(async () => {
    setConfigForTests(testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }));
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `sys-${tag}`,
    ]))!.id;
    host = await user('Host');
    ann = await user('Ann');
    stranger = await user('Stranger');
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
    app = await buildApp();
    asHost = await signedIn(app, host);
    asAnn = await signedIn(app, ann);
    asStranger = await signedIn(app, stranger);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = $1', [camp]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[host, ann, stranger]]);
    await closeDb();
  });

  it('lets an owner give someone a picture the whole table can see', async () => {
    const res = await upload(asHost, PNG);
    expect(res.status).toBe(200);
    const name = await stored();
    expect(name).toMatch(/^[a-f0-9]{32}$/);
    expect(res.body.portrait).toBe(`${url()}?v=${name!.slice(0, 12)}`);
    expect(existsSync(uploadPath(name!))).toBe(true);

    expect((await playerState()).entities.find((e) => e.id === mara)?.portrait).toBe(res.body.portrait);
    const full = await asHost.get<{ entry: EntityFull }>(`/api/campaigns/${camp}/entities/${mara}`);
    expect(full.body.entry.portrait).toBe(res.body.portrait);

    const pic = await asAnn.send('GET', res.body.portrait!);
    expect(pic.status).toBe(200);
    expect(pic.headers['content-type']).toBe('image/png');
    expect(pic.headers['cache-control']).toContain('immutable');
  });

  it('keeps choosing pictures to the owners, and the pictures to the table', async () => {
    const before = await stored();
    expect((await upload(asAnn, JPEG)).status).toBe(403);
    expect((await asAnn.del(url())).status).toBe(403);
    expect((await asStranger.get(url())).status).toBe(404);
    expect((await upload(asStranger, JPEG)).status).toBe(404);
    expect(await stored()).toBe(before);
  });

  it('refuses a file that is not a picture, and an entry that is not a person or creature', async () => {
    const before = await stored();
    expect((await upload(asHost, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status).toBe(400);
    expect(await stored()).toBe(before);
    const place = await entity('The Gilded Rat', 'location');
    expect((await upload(asHost, PNG, place)).status).toBe(400);
    expect(await stored(place)).toBeNull();
  });

  it('does not show players the picture of someone the party has not met', async () => {
    const villain = await entity('The Masked One', 'npc', true);
    expect((await upload(asHost, PNG, villain)).status).toBe(200);
    expect((await playerState()).entities.some((e) => e.id === villain)).toBe(false);
    expect((await asAnn.get(url(villain))).status).toBe(404);
    expect((await asHost.get(url(villain))).status).toBe(200);

    await q('UPDATE entities SET hidden = false WHERE id = $1', [villain]);
    expect((await asAnn.get(url(villain))).status).toBe(200);
  });

  it('removes the old file when a picture is replaced or taken away', async () => {
    const first = (await stored())!;
    expect((await upload(asHost, JPEG)).status).toBe(200);
    const second = (await stored())!;
    expect(second).not.toBe(first);
    expect(existsSync(uploadPath(first))).toBe(false);

    expect((await asHost.del(url())).status).toBe(200);
    expect(await stored()).toBeNull();
    expect(existsSync(uploadPath(second))).toBe(false);
    expect((await asAnn.get(url())).status).toBe(404);
    expect((await playerState()).entities.find((e) => e.id === mara)?.portrait).toBeUndefined();
  });

  it('removes the picture with the entry', async () => {
    const roach = await entity('Dumpster Roach', 'creature');
    await upload(asHost, PNG, roach);
    const name = (await stored(roach))!;
    expect((await asHost.del(`/api/campaigns/${camp}/entities/${roach}`)).status).toBe(200);
    expect(await stored(roach)).toBeNull();
    expect(existsSync(uploadPath(name))).toBe(false);
  });

  it('keeps pictures through a rewind, except of entries it takes away', async () => {
    await upload(asHost, PNG);
    const kept = (await stored())!;
    const scene = (await q1<{ id: number }>(
      `INSERT INTO messages (campaign_id, kind, content) VALUES ($1, 'dm', 'The rain falls.') RETURNING id`,
      [camp],
    ))!.id;
    await snapshotState(camp, null);
    const later = await entity('Pip the Fence');
    await upload(asHost, PNG, later);
    const gone = (await stored(later))!;

    await rewindTo(camp, Number(scene));
    expect(await stored()).toBe(kept);
    expect(existsSync(uploadPath(kept))).toBe(true);
    expect(await stored(later)).toBeNull();
    expect(existsSync(uploadPath(gone))).toBe(false);
  });
});
