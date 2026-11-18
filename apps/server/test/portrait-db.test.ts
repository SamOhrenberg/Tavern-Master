import { existsSync } from 'node:fs';
import type { GameState } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { createCharacter } from '../src/party.js';
import { uploadPath } from '../src/storage.js';
import { signedIn, type SignedIn } from './http.js';

// The smallest valid PNG: one transparent pixel.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

/** A multipart body holding one file, as the browser's FormData sends it. */
function multipart(data: Buffer, name = 'portrait.jpg', type = 'image/jpeg') {
  const boundary = '----tavern-test-boundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('character pictures (database)', () => {
  const tag = `pp${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let camp = '';
  let host = '';
  let ann = '';
  let bob = '';
  let stranger = '';
  let thorn = '';
  let asAnn: SignedIn;
  let asBob: SignedIn;
  let asStranger: SignedIn;

  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;
  const url = (characterId = thorn) => `/api/campaigns/${camp}/characters/${characterId}/portrait`;
  const upload = (who: SignedIn, data: Buffer, characterId = thorn) => {
    const { body, headers } = multipart(data);
    return who.send<{ portrait?: string; error?: { code: string } }>(
      'PUT',
      url(characterId),
      undefined,
      headers,
      body,
    );
  };
  const stored = async (characterId = thorn) =>
    (await q1<{ portrait: string | null }>('SELECT portrait FROM characters WHERE id = $1', [characterId]))!
      .portrait;

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
    stranger = await user('Stranger');
    camp = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name) VALUES ($1, $2, 'Ashen Crown') RETURNING id`,
      [system, host],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      camp,
      host,
    ]);
    for (const m of [ann, bob])
      await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [camp, m]);
    thorn = await createCharacter(
      camp,
      { userId: ann, role: 'player' },
      { name: 'Thorn', maxHp: 10, sheet: {} },
    );
    app = await buildApp();
    asAnn = await signedIn(app, ann);
    asBob = await signedIn(app, bob);
    asStranger = await signedIn(app, stranger);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = $1', [camp]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[host, ann, bob, stranger]]);
    await closeDb();
  });

  it('lets a player give their own character a picture the whole table can see', async () => {
    const res = await upload(asAnn, PNG);
    expect(res.status).toBe(200);
    const name = await stored();
    expect(name).toMatch(/^[a-f0-9]{32}$/);
    expect(res.body.portrait).toBe(`${url()}?v=${name!.slice(0, 12)}`);
    expect(existsSync(uploadPath(name!))).toBe(true);

    const state = await asBob.get<{ state: GameState }>(`/api/campaigns/${camp}/state`);
    expect(state.body.state.characters.find((c) => c.id === thorn)?.portrait).toBe(res.body.portrait);

    const pic = await asBob.send('GET', res.body.portrait!);
    expect(pic.status).toBe(200);
    expect(pic.headers['content-type']).toBe('image/png');
    expect(pic.headers['cache-control']).toContain('immutable');
    expect(Buffer.from(pic.raw, 'binary').length).toBeGreaterThan(0);
  });

  it('keeps pictures to the table and sheets to the players who run them', async () => {
    expect((await asStranger.get(url())).status).toBe(404);
    expect((await upload(asStranger, JPEG)).status).toBe(404);
    const before = await stored();
    expect((await upload(asBob, JPEG)).status).toBe(403);
    expect((await asBob.del(url())).status).toBe(403);
    expect(await stored()).toBe(before);
  });

  it('refuses a file that is not a picture and keeps nothing of it', async () => {
    const before = await stored();
    const res = await upload(asAnn, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(res.status).toBe(400);
    expect(await stored()).toBe(before);
  });

  it('removes the old file when a picture is replaced or taken away', async () => {
    const first = (await stored())!;
    expect((await upload(asAnn, JPEG)).status).toBe(200);
    const second = (await stored())!;
    expect(second).not.toBe(first);
    expect(existsSync(uploadPath(first))).toBe(false);
    expect((await asAnn.get(url())).headers['content-type']).toBe('image/jpeg');

    expect((await asAnn.del(url())).status).toBe(200);
    expect(await stored()).toBeNull();
    expect(existsSync(uploadPath(second))).toBe(false);
    expect((await asAnn.get(url())).status).toBe(404);
  });

  it('removes the picture with the character', async () => {
    await upload(asAnn, PNG);
    const name = (await stored())!;
    expect((await asAnn.del(`/api/campaigns/${camp}/characters/${thorn}`)).status).toBe(200);
    expect(existsSync(uploadPath(name))).toBe(false);
  });
});
