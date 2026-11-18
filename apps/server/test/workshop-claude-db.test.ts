import type { GmGuide, SheetSchema, Workshop, WorkshopEvent } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { createToken } from '../src/connector/tokens.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { mcpClient, signedIn, type SignedIn } from './http.js';

const sheet: SheetSchema = {
  version: 2,
  hp: { label: 'Hit points' },
  sections: [{ id: 'core', label: 'Core', fields: [{ key: 'class', label: 'Class', type: 'text' }] }],
  createSteps: [],
};

// The workshop answered by an admin's Claude: through the connector, and in the app's chat.
describe.skipIf(!process.env.TEST_DATABASE_URL)('the workshop from Claude (database)', () => {
  const tag = `wc${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let admin = '';
  let player = '';
  let asAdmin: SignedIn;
  let claude: ReturnType<typeof mcpClient>;
  let playerClaude: ReturnType<typeof mcpClient>;
  let adminToken = '';
  let playerToken = '';
  const name = () => `Crow Rules ${tag}`;

  beforeAll(async () => {
    setConfigForTests(
      testConfig({
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        ADMIN_REQUIRE_TOTP: 'false',
        CONNECTOR_MAX_WAIT_SECONDS: '10',
      }),
    );
    await migrate();
    const make = async (who: string, role: string) =>
      (await q1<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
        [`${who}-${tag}`, who, role],
      ))!.id;
    admin = await make('Admin', 'admin');
    player = await make('Player', 'user');
    system = (await q1<{ id: string }>(
      `INSERT INTO game_systems (slug, name, sheet_template, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [`sys-${tag}`, name(), JSON.stringify(sheet), admin],
    ))!.id;
    app = await buildApp();
    asAdmin = await signedIn(app, admin);
    adminToken = (await createToken(admin, 'workshop'))!.token;
    playerToken = (await createToken(player, 'workshop'))!.token;
    claude = mcpClient(app, adminToken);
    playerClaude = mcpClient(app, playerToken);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[admin, player]]);
    await closeDb();
  });

  it('is offered to Claude, and only an admin’s Claude may use it', async () => {
    const { body } = await claude.rpc('tools/list', {});
    const names = ((body.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
    for (const tool of [
      'open_workshop',
      'workshop_wait',
      'workshop_reply',
      'workshop_change_sheet',
      'workshop_write_guide',
    ])
      expect(names).toContain(tool);
    const refused = await playerClaude.call('open_workshop', { system: name() });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toMatch(/Only the server’s admins/);
    expect((await claude.call('open_workshop', { system: 'No Such Game' })).text).toMatch(/no system called/);
    // An admin's list of systems says where each stands in the workshop; a player's does not.
    const mine = (await claude.call('list_systems', {})).text;
    expect(mine).toContain(`- ${name()}: no description\n  Workshop: the sheet has 1 field`);
    expect((await playerClaude.call('list_systems', {})).text).not.toContain('Workshop:');
  });

  it('opens with its instructions and the system as it stands, and changes it like the built-in workshop', async () => {
    const opened = await claude.call('open_workshop', { system: name().toLowerCase() });
    expect(opened.isError).toBe(false);
    expect(opened.text).toContain('You are the workshop for');
    expect(opened.text).toContain('## Working from Claude');
    expect(opened.text).toContain('<workshop_state>');

    const changed = await claude.call('workshop_change_sheet', {
      system: name(),
      changes: [
        { op: 'add_field', section: 'core', field: { key: 'stress', label: 'Stress', type: 'track' } },
      ],
    });
    expect(changed.text).toMatch(/It now holds 1 change/);
    expect(
      (
        await claude.call('workshop_write_guide', {
          system: name(),
          topic: 'harm',
          text: 'Harm heals slowly.',
        })
      ).isError,
    ).toBe(false);
    const bad = await claude.call('workshop_change_sheet', {
      system: name(),
      changes: [{ op: 'remove_field', key: 'ghost' }],
    });
    expect(bad).toMatchObject({ isError: true });

    const row = await q1<{ d: SheetSchema; t: SheetSchema; g: GmGuide }>(
      'SELECT sheet_draft AS d, sheet_template AS t, gm_guide AS g FROM game_systems WHERE id = $1',
      [system],
    );
    expect(row!.t).toEqual(sheet);
    expect(row!.d.sections[0]!.fields.map((f) => f.key)).toEqual(['class', 'stress']);
    expect(row!.g.topics).toEqual([{ id: 'harm', text: 'Harm heals slowly.' }]);
  });

  it('answers the app’s workshop chat when the admins hand it to Claude', async () => {
    // While the built-in AI answers, Claude is told so rather than left waiting.
    expect((await claude.call('workshop_wait', { system: name(), wait_seconds: 0 })).text).toMatch(
      /built-in AI answers/,
    );

    expect((await asAdmin.patch(`/api/systems/${system}/workshop`, { answeredBy: 'claude' })).status).toBe(
      200,
    );
    const sent = await asAdmin.send('POST', `/api/systems/${system}/workshop/messages`, {
      text: 'Does stress ever clear?',
    });
    expect(JSON.parse(sent.raw.trim()) as WorkshopEvent).toEqual({ type: 'queued' });
    let view = (await asAdmin.get<{ workshop: Workshop }>(`/api/systems/${system}/workshop`)).body.workshop;
    expect(view).toMatchObject({ answeredBy: 'claude', waiting: true });

    const waiting = await claude.call('workshop_wait', { system: name(), wait_seconds: 0 });
    expect(waiting.text).toContain('Admin: Does stress ever clear?');
    expect(
      (await claude.call('workshop_reply', { system: name(), text: 'Yes: all of it, at downtime.' })).isError,
    ).toBe(false);

    view = (await asAdmin.get<{ workshop: Workshop }>(`/api/systems/${system}/workshop`)).body.workshop;
    expect(view.waiting).toBe(false);
    expect(view.messages.map((m) => m.content)).toEqual([
      'Does stress ever clear?',
      'Yes: all of it, at downtime.',
    ]);
    expect((await claude.call('workshop_wait', { system: name(), wait_seconds: 0 })).text).toBe(
      'Nothing is waiting in the workshop.',
    );
  });

  it('keeps a message written while Claude works waiting for its own answer', async () => {
    const ask = (text: string) => asAdmin.send('POST', `/api/systems/${system}/workshop/messages`, { text });
    await ask('Can armor break?');
    expect((await claude.call('workshop_wait', { system: name(), wait_seconds: 0 })).text).toContain(
      'Can armor break?',
    );
    // Written after Claude read the first, before it answered.
    await ask('And shields?');
    const reply = await claude.call('workshop_reply', { system: name(), text: 'Armor breaks on a 1.' });
    expect(reply.text).toMatch(/1 newer message is waiting/);
    const view = (await asAdmin.get<{ workshop: Workshop }>(`/api/systems/${system}/workshop`)).body.workshop;
    expect(view.waiting).toBe(true);
    const next = (await claude.call('workshop_wait', { system: name(), wait_seconds: 0 })).text;
    expect(next).toContain('And shields?');
    expect(next).not.toContain('Can armor break?');
    await claude.call('workshop_reply', { system: name(), text: 'Shields too.' });
  });

  it('wakes a waiting Claude as soon as an admin writes', async () => {
    const started = Date.now();
    const waiting = claude.call('workshop_wait', { system: name(), wait_seconds: 20 });
    await new Promise((r) => setTimeout(r, 200));
    await asAdmin.send('POST', `/api/systems/${system}/workshop/messages`, { text: 'What about helmets?' });
    expect((await waiting).text).toContain('What about helmets?');
    expect(Date.now() - started).toBeLessThan(5_000);
    await claude.call('workshop_reply', { system: name(), text: 'Helmets count as armor.' });
  });

  it('tells an admin’s DM launcher when the workshop waits for Claude', async () => {
    type Listed = { id: string; name: string; folder: string; waiting: number };
    const summon = async (token: string) =>
      (
        await app.inject({ method: 'GET', url: '/api/summon', headers: { authorization: `Bearer ${token}` } })
      ).json<{ workshops: Listed[] }>().workshops;
    const view = async () =>
      (await asAdmin.get<{ workshop: Workshop }>(`/api/systems/${system}/workshop`)).body.workshop;

    // No launcher has asked yet: the app says how to bring Claude by hand.
    expect((await view()).launcher).toBe(false);
    // A player's launcher is never handed the workshop: its tools would refuse it.
    expect(await summon(playerToken)).toEqual([]);

    expect((await summon(adminToken)).find((w) => w.id === system)).toEqual({
      id: system,
      name: name(),
      folder: `workshop-sys-${tag}`,
      waiting: 0,
    });
    expect((await view()).launcher).toBe(true);

    await asAdmin.send('POST', `/api/systems/${system}/workshop/messages`, { text: 'And gauntlets?' });
    expect((await summon(adminToken)).find((w) => w.id === system)?.waiting).toBe(1);
    await claude.call('workshop_reply', { system: name(), text: 'Gauntlets too.' });

    // Handed back to the built-in AI: the launcher has nothing to answer there.
    await asAdmin.patch(`/api/systems/${system}/workshop`, { answeredBy: 'server' });
    expect((await summon(adminToken)).some((w) => w.id === system)).toBe(false);
    expect((await view()).launcher).toBe(false);
  });
});
