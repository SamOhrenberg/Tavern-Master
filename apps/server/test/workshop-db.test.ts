import type { GmGuide, SheetSchema, Workshop, WorkshopEvent } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { setProviderForTests } from '../src/llm/index.js';
import type { Block, ChatProvider, ChatRequest, StreamEvent } from '../src/llm/types.js';
import { infoOf, loadCampaign } from '../src/realtime/room.js';
import { signedIn, type SignedIn } from './http.js';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A model that plays one scripted reply per call, and keeps what it was sent. */
function scripted(rounds: Block[][]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return {
    name: 'scripted',
    requests,
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      // A copy: the agent loop keeps adding to the same conversation after the call.
      requests.push(structuredClone(req));
      const content = rounds[Math.min(i++, rounds.length - 1)] ?? [];
      for (const b of content) if (b.type === 'text') yield { type: 'text', text: b.text };
      const isTool = content.some((b) => b.type === 'tool_use');
      yield { type: 'done', stop: isTool ? 'tool_use' : 'end', content, usage, model: req.model };
    },
  };
}
const call = (name: string, input: unknown, id = name): Block => ({ type: 'tool_use', id, name, input });

const sheet: SheetSchema = {
  version: 2,
  hp: { label: 'Hit points' },
  sections: [{ id: 'core', label: 'Core', fields: [{ key: 'class', label: 'Class', type: 'text' }] }],
  createSteps: [],
};

describe.skipIf(!process.env.TEST_DATABASE_URL)('the workshop (database)', () => {
  const tag = `ws${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let campaign = '';
  let admin = '';
  let player = '';
  let asAdmin: SignedIn;
  let asPlayer: SignedIn;
  const base = () => `/api/systems/${system}`;

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
    player = await make('Player', 'user');
    system = (await q1<{ id: string }>(
      `INSERT INTO game_systems (slug, name, sheet_template, created_by) VALUES ($1, 'Crow Rules', $2, $3) RETURNING id`,
      [`sys-${tag}`, JSON.stringify(sheet), admin],
    ))!.id;
    campaign = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name) VALUES ($1, $2, 'Crow Court') RETURNING id`,
      [system, admin],
    ))!.id;
    app = await buildApp();
    asAdmin = await signedIn(app, admin);
    asPlayer = await signedIn(app, player);
  });

  afterEach(() => setProviderForTests());

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = $1', [campaign]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[admin, player]]);
    await closeDb();
  });

  const say = async (text: string) => {
    const res = await asAdmin.send('POST', `${base()}/workshop/messages`, { text });
    return {
      status: res.status,
      events: res.raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as WorkshopEvent),
    };
  };

  it('is for admins only', async () => {
    expect((await asPlayer.get(`${base()}/workshop`)).status).toBe(403);
    expect((await asPlayer.post(`${base()}/workshop/messages`, { text: 'Hi' })).status).toBe(403);
  });

  it('turns a conversation into a sheet draft, a guide topic and a ruling', async () => {
    const model = scripted([
      [
        call('change_sheet', {
          changes: [
            {
              op: 'add_field',
              section: 'core',
              field: { key: 'stress', label: 'Stress', type: 'track', setAt: 'play' },
            },
            { op: 'update_field', key: 'class', changes: { label: 'Playbook' } },
          ],
        }),
        call('write_guide', { topic: 'resolution', text: 'Roll a pool of d6s; the highest die decides.' }),
        call('add_ruling', { text: 'Stress clears fully at the end of each session.' }),
      ],
      [{ type: 'text', text: 'Done: I proposed **Stress** and renamed Class to Playbook.' }],
    ]);
    setProviderForTests(model);

    const out = await say('Add stress, call class Playbook, and write down how rolls work.');
    expect(out.status).toBe(200);
    expect(out.events.filter((e) => e.type === 'tool').map((e) => e.type === 'tool' && e.tool)).toEqual([
      'change_sheet',
      'write_guide',
      'add_ruling',
    ]);
    const done = out.events.at(-1);
    expect(done).toMatchObject({ type: 'done', message: { role: 'assistant', author: null } });

    // What the model was told: the state of the system, and who said what.
    const first = JSON.stringify(model.requests[0]!.messages.at(-1));
    expect(first).toContain('workshop_state');
    expect(first).toContain('admin name=\\"Admin\\"');

    const row = await q1<{ t: SheetSchema; d: SheetSchema; s: string; g: GmGuide }>(
      `SELECT sheet_template AS t, sheet_draft AS d, sheet_draft_status AS s, gm_guide AS g
         FROM game_systems WHERE id = $1`,
      [system],
    );
    // The sheet in use is untouched: the change waits in the draft for review.
    expect(row!.t).toEqual(sheet);
    expect(row!.s).toBe('ready');
    expect(row!.d.sections[0]!.fields.map((f) => [f.key, f.label])).toEqual([
      ['class', 'Playbook'],
      ['stress', 'Stress'],
    ]);
    expect(row!.g.topics).toEqual([
      { id: 'resolution', text: 'Roll a pool of d6s; the highest die decides.' },
    ]);
    expect(row!.g.rulings.map((r) => r.text)).toEqual(['Stress clears fully at the end of each session.']);

    const view = await asAdmin.get<{ workshop: Workshop }>(`${base()}/workshop`);
    expect(view.body.workshop.messages.map((m) => [m.role, m.author?.displayName ?? null])).toEqual([
      ['user', 'Admin'],
      ['assistant', null],
    ]);

    // Every table on the system now reads the guide.
    const info = infoOf(campaign, await loadCampaign(campaign));
    expect(info.gmGuide).toContain('Roll a pool of d6s');
    expect(info.gmGuide).toContain('Stress clears fully');
  });

  it('tells the model when a sheet change cannot be made', async () => {
    const model = scripted([
      [call('change_sheet', { changes: [{ op: 'remove_field', key: 'ghost' }] })],
      [{ type: 'text', text: 'There is no such field.' }],
    ]);
    setProviderForTests(model);
    await say('Remove the ghost field.');
    const result = JSON.stringify(model.requests[1]!.messages.at(-1));
    expect(result).toContain('There is no field \\"ghost\\"');
  });

  it('lets an admin edit the guide by hand and strike rulings', async () => {
    const edited = await asAdmin.put<{ guide: GmGuide }>(`${base()}/guide/scenes`, {
      text: 'Open on the job.',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.guide.topics.map((t) => t.id)).toEqual(['resolution', 'scenes']);
    expect((await asAdmin.put(`${base()}/guide/astrology`, { text: 'x' })).status).toBe(400);

    const id = edited.body.guide.rulings[0]!.id;
    const struck = await asAdmin.del<{ guide: GmGuide }>(`${base()}/guide/rulings/${id}`);
    expect(struck.body.guide.rulings).toEqual([]);
    expect((await asAdmin.del(`${base()}/guide/rulings/${id}`)).status).toBe(404);

    expect((await asAdmin.del(`${base()}/workshop`)).status).toBe(200);
    const after = await asAdmin.get<{ workshop: Workshop }>(`${base()}/workshop`);
    expect(after.body.workshop.messages).toEqual([]);
    // Starting the conversation over keeps the guide.
    expect(after.body.workshop.guide.topics).toHaveLength(2);
  });
});
