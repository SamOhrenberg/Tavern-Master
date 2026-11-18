import type { GameSystem, SheetSchema } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { applyDraft, createCharacter, updateCharacter } from '../src/party.js';
import { SRD_SLUG, upgradeSrdSheet } from '../src/seed.js';
import { SRD_SHEET, SRD_TEMPLATE_V1 } from '../src/srd-sheet.js';
import { signedIn, type SignedIn } from './http.js';

const schema: SheetSchema = {
  version: 2,
  hp: { label: 'Health' },
  sections: [
    {
      id: 'core',
      label: 'Core',
      fields: [
        { key: 'Grit', label: 'Grit', type: 'number' },
        { key: 'stress', label: 'Stress', type: 'track' },
        { key: 'heat', label: 'Heat', type: 'number', editableBy: 'gm' },
        { key: 'ac', label: 'Armor Class', type: 'number' },
        {
          key: 'gear',
          label: 'Gear',
          type: 'list',
          itemFields: [
            { key: 'name', label: 'Item', type: 'text' },
            { key: 'load', label: 'Load', type: 'number' },
          ],
        },
      ],
    },
  ],
  createSteps: [],
};

describe.skipIf(!process.env.TEST_DATABASE_URL)('sheet schemas (database)', () => {
  const tag = `ss${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let camp = '';
  let admin = '';
  let ann = '';
  let asAdmin: SignedIn;
  let asAnn: SignedIn;
  const annViewer = () => ({ userId: ann, role: 'player' as const });

  const user = async (name: string, role = 'user') =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
      [`${name}-${tag}`, name, role],
    ))!.id;
  const sheetOf = async (id: string) =>
    (await q1<{ sheet: Record<string, unknown> }>('SELECT sheet FROM characters WHERE id = $1', [id]))!.sheet;

  beforeAll(async () => {
    // Admin routes ask for two-factor sign-in; these tests are about the sheet, not about that.
    setConfigForTests(
      testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, ADMIN_REQUIRE_TOTP: 'false' }),
    );
    await migrate();
    system = (await q1<{ id: string }>(
      `INSERT INTO game_systems (slug, name, sheet_template) VALUES ($1, $2, $3) RETURNING id`,
      [`sys-${tag}`, `sys-${tag}`, JSON.stringify(schema)],
    ))!.id;
    admin = await user('Admin', 'admin');
    ann = await user('Ann');
    camp = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name) VALUES ($1, $2, 'Crow Court') RETURNING id`,
      [system, admin],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      camp,
      admin,
    ]);
    await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [camp, ann]);
    app = await buildApp();
    asAdmin = await signedIn(app, admin);
    asAnn = await signedIn(app, ann);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = $1', [camp]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[admin, ann]]);
    await closeDb();
  });

  it('stores each value in its field’s shape and refuses one that cannot be read', async () => {
    const id = await createCharacter(camp, annViewer(), {
      name: 'Vesper',
      maxHp: 8,
      sheet: {
        grit: '3',
        Stress: '2/9',
        gear: [{ name: 'Lantern', load: '1' }],
        Contacts: 'The Dimmer Sisters',
      },
    });
    expect(await sheetOf(id)).toEqual({
      Grit: 3,
      stress: { current: 2, max: 9 },
      gear: [{ name: 'Lantern', load: 1 }],
      Contacts: 'The Dimmer Sisters',
    });
    await expect(
      createCharacter(camp, annViewer(), { name: 'Rook', maxHp: 8, sheet: { Grit: 'plenty' } }),
    ).rejects.toMatchObject({ status: 400, message: 'Grit should be a number.' });
  });

  it('keeps a GM-kept field once it holds a value, whoever saves for the player', async () => {
    const id = await createCharacter(camp, annViewer(), { name: 'Marlo', maxHp: 8, sheet: { heat: 1 } });
    expect((await sheetOf(id)).heat).toBe(1);
    await updateCharacter(camp, id, annViewer(), { name: 'Marlo', maxHp: 8, sheet: { heat: 0, Grit: 2 } });
    expect(await sheetOf(id)).toEqual({ heat: 1, Grit: 2 });
    // The character guide saves as the player, so it is held to the same rule.
    const saved = await applyDraft(camp, id, annViewer(), { fields: [{ field: 'heat', value: 5 }] });
    expect((await sheetOf(id)).heat).toBe(1);
    // ...and is told so, rather than left to think it saved.
    expect(saved.notes).toEqual(['"heat" is kept by the GM, so it was left as it was.']);
    // The GM itself may change it.
    const asGm = await applyDraft(
      camp,
      id,
      annViewer(),
      { fields: [{ field: 'Heat', value: 4 }] },
      undefined,
      {
        asGm: true,
      },
    );
    expect((await sheetOf(id)).heat).toBe(4);
    expect(asGm.notes).toEqual([]);
  });

  it('writes under the system’s own field names, and says which names it does not define', async () => {
    const id = await createCharacter(camp, annViewer(), { name: 'Oriel', maxHp: 8, sheet: {} });
    const out = await applyDraft(camp, id, annViewer(), {
      fields: [
        { field: 'Gritt', value: 2 },
        { field: 'STRESS', value: '1/9' },
        { field: 'Gear', value: 'Rope' },
      ],
    });
    expect(out.changed).toEqual(['Gritt', 'stress', 'gear']);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toContain('"Gritt" (did you mean "Grit"?)');
    expect(out.notes[0]).toContain('remove_fields');
    expect(await sheetOf(id)).toEqual({ Gritt: 2, stress: { current: 1, max: 9 }, gear: [{ name: 'Rope' }] });
  });

  it('removes the entry by the name given, and has no note about names it removed', async () => {
    // Extra entries from before names were matched by label: "Armor Class" beside the real "ac".
    const gm = { userId: admin, role: 'owner' as const };
    const id = await createCharacter(camp, gm, {
      name: 'Tamsin',
      maxHp: 8,
      sheet: { ac: 12, 'Armor Class': 14, Gritt: 1 },
    });
    const out = await applyDraft(camp, id, gm, { remove_fields: ['Armor Class', 'gritt'] });
    expect(await sheetOf(id)).toEqual({ ac: 12 });
    expect(out.changed).toEqual(['-Armor Class', '-Gritt']);
    expect(out.notes).toEqual([]);
    // With no entry of its own, a label still reaches its field.
    await applyDraft(camp, id, gm, { remove_fields: ['armor class'] });
    expect(await sheetOf(id)).toEqual({});
  });

  it('sends the schema with the system and lets only an admin replace it', async () => {
    const list = await asAnn.get<{ systems: GameSystem[] }>('/api/systems');
    expect(list.body.systems.find((s) => s.id === system)?.sheetSchema.hp.label).toBe('Health');

    const next = { ...schema, hp: { label: 'Wounds' } };
    expect((await asAnn.put(`/api/systems/${system}/sheet-schema`, { schema: next })).status).toBe(403);
    const bad = await asAdmin.put(`/api/systems/${system}/sheet-schema`, {
      schema: {
        ...schema,
        sections: [{ id: 'x', label: 'X', fields: [{ key: 'a', label: 'A', type: 'list' }] }],
      },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.message).toMatch(/rows/);
    expect((await asAdmin.put(`/api/systems/${system}/sheet-schema`, { schema: next })).status).toBe(200);
    expect(
      (await q1<{ t: { hp: { label: string } } }>(
        'SELECT sheet_template AS t FROM game_systems WHERE id = $1',
        [system],
      ))!.t.hp.label,
    ).toBe('Wounds');
  });

  it('gives an untouched starter system the full sheet, and leaves an edited one alone', async () => {
    const had = await q1<{ id: string; t: unknown }>(
      'SELECT id, sheet_template AS t FROM game_systems WHERE slug = $1',
      [SRD_SLUG],
    );
    const starter =
      had?.id ??
      (await q1<{ id: string }>(
        `INSERT INTO game_systems (slug, name, sheet_template) VALUES ($1, 'SRD', $2) RETURNING id`,
        [SRD_SLUG, JSON.stringify(SRD_TEMPLATE_V1)],
      ))!.id;
    try {
      await q('UPDATE game_systems SET sheet_template = $2 WHERE id = $1', [
        starter,
        JSON.stringify(SRD_TEMPLATE_V1),
      ]);
      expect(await upgradeSrdSheet()).toBe(true);
      const row = await q1<{ t: SheetSchema }>('SELECT sheet_template AS t FROM game_systems WHERE id = $1', [
        starter,
      ]);
      expect(row!.t).toEqual(SRD_SHEET);
      expect(await upgradeSrdSheet()).toBe(false);
      const edited = { ...SRD_TEMPLATE_V1, abilities: ['Might'] };
      await q('UPDATE game_systems SET sheet_template = $2 WHERE id = $1', [starter, JSON.stringify(edited)]);
      expect(await upgradeSrdSheet()).toBe(false);
    } finally {
      if (had)
        await q('UPDATE game_systems SET sheet_template = $2 WHERE id = $1', [
          starter,
          JSON.stringify(had.t),
        ]);
      else await q('DELETE FROM game_systems WHERE id = $1', [starter]);
    }
  });
});
