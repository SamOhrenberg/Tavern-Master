import type { CampaignDetail, SheetDraftView, SheetSchema, SheetUpdate } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { insertCampaign } from '../src/campaign.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { applyDraft, createCharacter } from '../src/party.js';
import { snapshotState } from '../src/rewind.js';
import { campaignSchema } from '../src/sheet-schema.js';
import { carrySheets } from '../src/sheet-versions.js';
import { signedIn, type SignedIn } from './http.js';

const field = (key: string, label: string, type: 'number' | 'text' | 'track' = 'number') => ({
  key,
  label,
  type,
});
const sheet = (...fields: ReturnType<typeof field>[]): SheetSchema => ({
  version: 2,
  hp: { label: 'Health' },
  sections: [{ id: 'core', label: 'Core', fields }],
  createSteps: [],
});

const v1 = sheet(field('str', 'Strength'), field('luck', 'Luck', 'text'));
const v2 = sheet(field('Strength', 'Strength'), field('luck', 'Luck'), field('stress', 'Stress', 'track'));
const v3 = sheet(field('Strength', 'Strength'), field('luck', 'Luck'), field('Grit', 'Grit'));

describe.skipIf(!process.env.TEST_DATABASE_URL)('versions of a sheet (database)', () => {
  const tag = `sv${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let playing = '';
  let empty = '';
  let admin = '';
  let ann = '';
  let thorn = '';
  let asAdmin: SignedIn;
  let asAnn: SignedIn;
  const annViewer = () => ({ userId: ann, role: 'player' as const });
  const detail = async (who: SignedIn, id: string) =>
    (await who.get<{ campaign: CampaignDetail }>(`/api/campaigns/${id}`)).body.campaign;
  const sheetOf = async (id: string) =>
    (await q1<{ sheet: Record<string, unknown> }>('SELECT sheet FROM characters WHERE id = $1', [id]))!.sheet;

  beforeAll(async () => {
    setConfigForTests(
      testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, ADMIN_REQUIRE_TOTP: 'false' }),
    );
    await migrate();
    const user = async (name: string, role = 'user') =>
      (await q1<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
        [`${name}-${tag}`, name, role],
      ))!.id;
    admin = await user('Admin', 'admin');
    ann = await user('Ann');
    system = (await q1<{ id: string }>(
      `INSERT INTO game_systems (slug, name, sheet_template) VALUES ($1, $2, $3) RETURNING id`,
      [`sys-${tag}`, `sys-${tag}`, JSON.stringify(v1)],
    ))!.id;
    const make = async (name: string) => {
      const id = await insertCampaign({
        ownerId: admin,
        systemId: system,
        name,
        premise: '',
        tone: '',
        sheets: 'players',
        dm: 'server',
      });
      await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [id, ann]);
      return id;
    };
    playing = await make('Crow Court');
    empty = await make('Empty Halls');
    thorn = await createCharacter(playing, annViewer(), {
      name: 'Thorn',
      maxHp: 8,
      sheet: { str: 14, luck: 'plenty' },
    });
    app = await buildApp();
    asAdmin = await signedIn(app, admin);
    asAnn = await signedIn(app, ann);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE system_id = $1', [system]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[admin, ann]]);
    await closeDb();
  });

  it('publishes a new version and leaves a campaign in play on its own', async () => {
    // A snapshot from before the change, for the rewind below.
    await snapshotState(playing, null);
    const bad = await asAdmin.put(`/api/systems/${system}/sheet-schema`, {
      schema: v2,
      renames: [{ from: 'luck', to: 'Strength' }],
    });
    expect(bad.status).toBe(400);
    const put = await asAdmin.put<{ sheetVersion: number }>(`/api/systems/${system}/sheet-schema`, {
      schema: v2,
      renames: [{ from: 'str', to: 'Strength' }],
    });
    expect(put.body.sheetVersion).toBe(2);
    expect(
      (await q1<{ renames: unknown }>(
        'SELECT renames FROM sheet_versions WHERE system_id = $1 AND version = 2',
        [system],
      ))!.renames,
    ).toEqual({ str: 'Strength' });

    // The campaign with a party stays on version 1, and only its host is offered the update.
    const host = await detail(asAdmin, playing);
    expect(host).toMatchObject({ sheetVersion: 1, sheetUpdate: { version: 2 } });
    expect(host.sheetSchema.sections[0]!.fields.map((f) => f.key)).toEqual(['str', 'luck']);
    expect(await detail(asAnn, playing)).toMatchObject({ sheetVersion: 1, sheetUpdate: null });
    expect((await campaignSchema(playing)).sections[0]!.fields[0]!.key).toBe('str');
    // Saving still follows the version the campaign is on.
    await applyDraft(playing, thorn, annViewer(), { fields: [{ field: 'Strength', value: 15 }] });
    expect(await sheetOf(thorn)).toEqual({ str: 15, luck: 'plenty' });

    // One with no characters has nothing to carry, so it moves at once; a new one starts on the latest.
    expect(await detail(asAdmin, empty)).toMatchObject({ sheetVersion: 2, sheetUpdate: null });
    // Publishing the same sheet again makes no new version.
    expect(
      (await asAdmin.put<{ sheetVersion: number }>(`/api/systems/${system}/sheet-schema`, { schema: v2 }))
        .body.sheetVersion,
    ).toBe(2);
  });

  it('shows the host what an update would do, then carries every sheet across', async () => {
    const preview = await asAdmin.get<{ update: SheetUpdate }>(`/api/campaigns/${playing}/sheet-update`);
    expect(preview.body.update).toMatchObject({
      from: 1,
      to: 2,
      characters: [
        {
          name: 'Thorn',
          moved: [{ from: 'str', to: 'Strength' }],
          kept: [{ field: 'luck', as: 'Previous Luck' }],
        },
      ],
    });
    expect(preview.body.update.changes.map((p) => p.id)).toEqual(
      expect.arrayContaining(['add:strength', 'add:stress', 'change:luck', 'remove:str']),
    );
    expect((await asAnn.get(`/api/campaigns/${playing}/sheet-update`)).status).toBe(403);

    // Shown version 2, but 3 is out by the time they confirm: they are asked to look again.
    await asAdmin.put(`/api/systems/${system}/sheet-schema`, { schema: v3 });
    const stale = await asAdmin.post(`/api/campaigns/${playing}/sheet-update`, { version: 2 });
    expect(stale.status).toBe(409);
    expect(await sheetOf(thorn)).toEqual({ str: 15, luck: 'plenty' });

    const done = await asAdmin.post<{ update: SheetUpdate }>(`/api/campaigns/${playing}/sheet-update`, {
      version: 3,
    });
    expect(done.status).toBe(200);
    expect(await sheetOf(thorn)).toEqual({ Strength: 15, 'Previous Luck': 'plenty' });
    expect(await detail(asAdmin, playing)).toMatchObject({ sheetVersion: 3, sheetUpdate: null });
    expect((await asAdmin.post(`/api/campaigns/${playing}/sheet-update`, { version: 3 })).status).toBe(409);
  });

  it('carries a sheet saved before the update to the version the campaign is on now', async () => {
    const snap = await q1<{
      state: { sheetVersion?: number; characters: { sheet: Record<string, unknown> }[] };
    }>('SELECT state FROM state_snapshots WHERE campaign_id = $1 ORDER BY id LIMIT 1', [playing]);
    expect(snap!.state.sheetVersion).toBe(1);
    const [carried] = await carrySheets(system, 1, 3, snap!.state.characters);
    expect(carried!.sheet).toEqual({ Strength: 14, 'Previous Luck': 'plenty' });
  });

  it('pairs a field the draft replaces, and publishes the pair as a rename', async () => {
    const v4 = sheet(field('STR score', 'Strength'), field('luck', 'Luck'), field('Grit', 'Grit'));
    await q(`UPDATE game_systems SET sheet_draft = $2, sheet_draft_status = 'ready' WHERE id = $1`, [
      system,
      JSON.stringify(v4),
    ]);
    const view = (await asAdmin.get<SheetDraftView>(`/api/systems/${system}/sheet-draft`)).body;
    expect(view.renames).toEqual([{ from: 'Strength', to: 'STR score' }]);
    // Carrying a value needs the new field added: a rename to a field left out is refused.
    const refused = await asAdmin.post(`/api/systems/${system}/sheet-draft/apply`, {
      accept: ['remove:strength'],
      renames: view.renames,
    });
    expect(refused.status).toBe(400);
    const applied = await asAdmin.post<{ sheetVersion: number }>(`/api/systems/${system}/sheet-draft/apply`, {
      accept: ['remove:strength', 'add:str score'],
      renames: view.renames,
    });
    expect(applied.body.sheetVersion).toBe(4);
    await asAdmin.post(`/api/campaigns/${playing}/sheet-update`, { version: 4 });
    expect(await sheetOf(thorn)).toEqual({ 'STR score': 15, 'Previous Luck': 'plenty' });
  });
});
