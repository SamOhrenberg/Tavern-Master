import type { SheetDraftView, SheetSchema } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftSheet } from '../src/agent/sheet-drafter.js';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { signedIn, type SignedIn } from './http.js';

const current: SheetSchema = {
  version: 2,
  hp: { label: 'Hit points' },
  sections: [
    {
      id: 'core',
      label: 'Core',
      fields: [
        { key: 'class', label: 'Class', type: 'text' },
        { key: 'background', label: 'Background', type: 'text' },
      ],
    },
  ],
  createSteps: [],
};
const draft: SheetSchema = {
  version: 2,
  hp: { label: 'Harm' },
  sections: [
    {
      id: 'core',
      label: 'Core',
      fields: [
        { key: 'class', label: 'Playbook', type: 'select', options: ['Cutter', 'Hound'] },
        { key: 'stress', label: 'Stress', type: 'track' },
      ],
    },
  ],
  createSteps: ['Choose a playbook.'],
};

describe.skipIf(!process.env.TEST_DATABASE_URL)('drafting a sheet (database)', () => {
  const tag = `sd${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let admin = '';
  let user = '';
  let asAdmin: SignedIn;
  let asUser: SignedIn;
  const base = () => `/api/systems/${system}/sheet-draft`;
  const row = () =>
    q1<{ t: SheetSchema; d: unknown; s: string; e: string | null }>(
      `SELECT sheet_template AS t, sheet_draft AS d, sheet_draft_status AS s, sheet_draft_error AS e
         FROM game_systems WHERE id = $1`,
      [system],
    );

  beforeAll(async () => {
    setConfigForTests(
      testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, ADMIN_REQUIRE_TOTP: 'false' }),
    );
    await migrate();
    const make = async (name: string, role: string) =>
      (await q1<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
        [`${name}-${tag}`, name, role],
      ))!.id;
    admin = await make('Admin', 'admin');
    user = await make('Player', 'user');
    system = (await q1<{ id: string }>(
      `INSERT INTO game_systems (slug, name, sheet_template, created_by) VALUES ($1, 'Crow Court', $2, $3) RETURNING id`,
      [`sys-${tag}`, JSON.stringify(current), admin],
    ))!.id;
    app = await buildApp();
    asAdmin = await signedIn(app, admin);
    asUser = await signedIn(app, user);
  });

  afterAll(async () => {
    await app?.close();
    await q(`DELETE FROM jobs WHERE kind = 'draft_sheet' AND payload->>'systemId' = $1`, [system]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[admin, user]]);
    await closeDb();
  });

  it('needs a rulebook to read, and is the admins’ to ask for', async () => {
    expect((await asUser.post(base())).status).toBe(403);
    const none = await asAdmin.post(base());
    expect(none.status).toBe(400);
    expect(none.body.error?.message).toMatch(/Upload a rulebook/);
  });

  it('queues a draft once there are rules, and records why it failed when nothing was saved', async () => {
    const doc = await q1<{ id: string }>(
      `INSERT INTO documents (system_id, title, original_name, storage_name, mime, size_bytes, sha256, status)
       VALUES ($1, 'Crow Court Rules', 'r.md', $2, 'text/markdown', 1, 'x', 'ready') RETURNING id`,
      [system, `${tag}rules`],
    );
    await q(
      `INSERT INTO chunks (document_id, system_id, ordinal, heading, content) VALUES ($1, $2, 0, 'Scoundrels', $3)`,
      [doc!.id, system, 'Every scoundrel has Stress, from 0 to 9.'],
    );
    expect((await asAdmin.post(base())).status).toBe(200);
    expect((await row())!.s).toBe('queued');
    expect(
      await q1(`SELECT 1 FROM jobs WHERE kind = 'draft_sheet' AND payload->>'systemId' = $1`, [system]),
    ).toBeTruthy();
    // A draft that is under way cannot be thrown away.
    expect((await asAdmin.del(base())).status).toBe(409);

    // The mock model answers in prose and never saves a sheet.
    await draftSheet(system);
    const after = await row();
    expect(after!.s).toBe('failed');
    expect(after!.e).toMatch(/without saving a sheet/);
    expect(after!.t).toEqual(current);
  });

  it('shows a draft as changes and applies only those accepted', async () => {
    await q(
      `UPDATE game_systems SET sheet_draft = $2, sheet_draft_notes = $3, sheet_draft_status = 'ready',
              sheet_draft_at = now() WHERE id = $1`,
      [system, JSON.stringify(draft), JSON.stringify(['How many contacts to start with?'])],
    );
    expect((await asUser.get(base())).status).toBe(403);
    const view = await asAdmin.get<SheetDraftView>(base());
    expect(view.body.status).toBe('ready');
    expect(view.body.notes).toEqual(['How many contacts to start with?']);
    expect(view.body.proposals.map((p) => p.id).sort()).toEqual(
      ['add:stress', 'change:class', 'hp', 'remove:background', 'steps'].sort(),
    );

    const applied = await asAdmin.post<{ sheetSchema: SheetSchema }>(`${base()}/apply`, {
      accept: ['change:class', 'add:stress'],
    });
    expect(applied.status).toBe(200);
    const after = await row();
    expect(after!.t.sections[0]!.fields.map((f) => f.key)).toEqual(['class', 'stress', 'background']);
    expect(after!.t.hp.label).toBe('Hit points');
    expect(after).toMatchObject({ d: null, s: 'none' });
    expect((await asAdmin.post(`${base()}/apply`, { accept: [] })).status).toBe(409);
  });

  it('lets a draft go without changing the sheet', async () => {
    const before = (await row())!.t;
    await q(`UPDATE game_systems SET sheet_draft = $2, sheet_draft_status = 'ready' WHERE id = $1`, [
      system,
      JSON.stringify(draft),
    ]);
    expect((await asAdmin.del(base())).status).toBe(200);
    expect(await row()).toMatchObject({ t: before, d: null, s: 'none' });
  });
});
