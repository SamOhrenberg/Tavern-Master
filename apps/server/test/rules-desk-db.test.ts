import type { RulesDesk, RulesEvent } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileBrief } from '../src/agent/brief.js';
import { briefAndChanges } from '../src/agent/context.js';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { createToken } from '../src/connector/tokens.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { setProviderForTests } from '../src/llm/index.js';
import { mcpClient, signedIn, type SignedIn } from './http.js';

const events = (raw: string) =>
  raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RulesEvent);

// The rules desk on a homebrew system: with the built-in GM, and with Claude as the GM.
describe.skipIf(!process.env.TEST_DATABASE_URL)('the rules desk (database)', () => {
  const tag = `r${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let builtIn = '';
  let withClaude = '';
  let admin = '';
  let host = '';
  let ann = '';
  let asAdmin: SignedIn;
  let asHost: SignedIn;
  let asAnn: SignedIn;
  let claude: ReturnType<typeof mcpClient>;

  const user = async (name: string, role = 'user') =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
      [`${name}-${tag}`, name, role],
    ))!.id;
  const campaign = async (name: string, settings: object) => {
    const id = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, settings) VALUES ($1, $2, $3, $4) RETURNING id`,
      [system, host, `${name} ${tag}`, JSON.stringify(settings)],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, host]);
    await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [id, ann]);
    return id;
  };

  beforeAll(async () => {
    setConfigForTests(
      testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, ADMIN_REQUIRE_TOTP: 'false' }),
    );
    await migrate();
    setProviderForTests();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `Brew ${tag}`,
    ]))!.id;
    admin = await user('Admin', 'admin');
    host = await user('Host');
    ann = await user('Ann');
    builtIn = await campaign('Kettle', {});
    withClaude = await campaign('Lantern', { dm: 'claude' });
    app = await buildApp();
    asAdmin = await signedIn(app, admin);
    asHost = await signedIn(app, host);
    asAnn = await signedIn(app, ann);
    const { token } = (await createToken(host, 'rules'))!;
    claude = mcpClient(app, token, `/mcp/c/${withClaude}`);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [[builtIn, withClaude]]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`%-${tag}`]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await closeDb();
  });

  it('keeps the desk shut until an admin marks the system homebrew', async () => {
    expect((await asAnn.get(`/api/campaigns/${builtIn}/rules`)).status).toBe(409);
    expect((await asHost.patch(`/api/systems/${system}`, { homebrew: true })).status).toBe(403);
    expect((await asAdmin.patch(`/api/systems/${system}`, { homebrew: true })).status).toBe(200);
    const detail = await asAnn.get<{ campaign: { homebrew: boolean } }>(`/api/campaigns/${builtIn}`);
    expect(detail.body.campaign.homebrew).toBe(true);
    const desk = await asAnn.get<{ desk: RulesDesk }>(`/api/campaigns/${builtIn}/rules`);
    expect(desk.body.desk).toEqual({ messages: [], rulings: [], waiting: false });
  });

  it('lets the built-in GM answer and record what the table settles', async () => {
    const res = await asAnn.post(`/api/campaigns/${builtIn}/rules/messages`, {
      text: 'House rule: critical hits deal maximum damage on the first die.',
    });
    expect(res.status).toBe(200);
    const evs = events(res.raw);
    expect(evs.some((e) => e.type === 'tool' && e.tool === 'record_ruling')).toBe(true);
    expect(evs.at(-1)).toMatchObject({ type: 'done', message: { role: 'assistant' } });

    const desk = (await asHost.get<{ desk: RulesDesk }>(`/api/campaigns/${builtIn}/rules`)).body.desk;
    expect(desk.waiting).toBe(false);
    expect(desk.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(desk.messages[0]!.author?.displayName).toBe('Ann');
    expect(desk.rulings).toMatchObject([
      {
        kind: 'rule',
        content: 'critical hits deal maximum damage on the first die.',
        requestedBy: { displayName: 'Ann' },
      },
    ]);
  });

  it('puts rulings in front of the GM, ahead of everything else in the brief', async () => {
    const brief = await compileBrief(builtIn);
    expect(brief).toContain('## House rulings');
    expect(brief).toContain('House rule: critical hits deal maximum damage');
    // Straight after the brief's own preamble, before the notebook, facts and story.
    expect(brief.split('\n\n')[2]).toMatch(/^## House rulings/);

    // A ruling made after the brief was compiled arrives with the notes since.
    await q('UPDATE campaigns SET brief = $2, brief_at = now() WHERE id = $1', [builtIn, 'old brief']);
    await asAnn.post(`/api/campaigns/${builtIn}/rules/messages`, {
      text: 'House rule: resting in the wilds restores only half your hit points.',
    });
    const { changes } = await briefAndChanges(builtIn);
    expect(changes).toContain('New house rulings');
    expect(changes).toContain('restores only half');
    expect(changes).not.toContain('critical hits');
  });

  it('lets only the owner strike a ruling, and the brief drops it', async () => {
    const desk = (await asHost.get<{ desk: RulesDesk }>(`/api/campaigns/${builtIn}/rules`)).body.desk;
    const crits = desk.rulings.find((r) => r.content.includes('critical'))!;
    expect((await asAnn.del(`/api/campaigns/${builtIn}/rulings/${crits.id}`)).status).toBe(403);
    expect((await asHost.del(`/api/campaigns/${builtIn}/rulings/${crits.id}`)).status).toBe(200);
    expect((await asHost.del(`/api/campaigns/${builtIn}/rulings/${crits.id}`)).status).toBe(404);
    const { brief } = await briefAndChanges(builtIn);
    expect(brief).not.toContain('critical hits');
    expect(brief).toContain('restores only half');
  });

  it('hands the desk to Claude in a Claude campaign, with the desk’s tools only', async () => {
    setProviderForTests({
      name: 'forbidden',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('the server called a model in a Claude campaign');
      },
    });
    try {
      const sent = await asAnn.post(`/api/campaigns/${withClaude}/rules/messages`, {
        text: 'Can we say flanking gives advantage? Everyone wants it.',
      });
      expect(events(sent.raw)).toEqual([{ type: 'queued' }]);

      const work = await claude.call('wait_for_work', { wait_seconds: 0 });
      expect(work.text).toContain('Rules desk request');
      expect(work.text).toContain('flanking gives advantage');
      expect(work.text).toContain('<rulings>');
      const workId = /Rules desk request ([0-9a-f-]{36})/.exec(work.text)![1]!;

      // Nothing that speaks to the table or touches the story's secrets.
      expect((await claude.call('narrate', { text: 'Meanwhile…' })).isError).toBe(true);
      expect((await claude.call('write_note', { title: 'x', content: 'y' })).isError).toBe(true);
      expect((await claude.call('lookup_rules', { query: 'flanking' })).isError).toBe(false);

      const recorded = await claude.call('record_ruling', {
        work_id: workId,
        kind: 'rule',
        content: 'Flanking an enemy with an ally gives advantage on melee attacks.',
      });
      expect(recorded.isError).toBe(false);
      const replied = await claude.call('reply_rules', {
        work_id: workId,
        text: 'Done: flanking gives advantage from now on.',
      });
      expect(replied.isError).toBe(false);

      const desk = (await asAnn.get<{ desk: RulesDesk }>(`/api/campaigns/${withClaude}/rules`)).body.desk;
      expect(desk.messages.at(-1)).toMatchObject({ role: 'assistant', author: null });
      expect(desk.rulings).toMatchObject([{ kind: 'rule', requestedBy: { displayName: 'Ann' } }]);

      // The host can settle one with Claude directly, and open_campaign hands them all back with ids.
      const direct = await claude.call('record_ruling', {
        kind: 'direction',
        content: 'Lean into city intrigue over dungeon crawling.',
      });
      expect(direct.isError).toBe(false);
      const opened = await claude.call('open_campaign');
      expect(opened.text).toContain('<house_rulings>');
      expect(opened.text).toContain('Flanking an enemy');
      expect(opened.text).toContain('Lean into city intrigue');
      expect(opened.text).toMatch(/Direction \[[0-9a-f-]{36}\]/);
    } finally {
      setProviderForTests();
    }
  });

  it('turns rulings off with the switch, without losing them', async () => {
    expect((await asAdmin.patch(`/api/systems/${system}`, { homebrew: false })).status).toBe(200);
    expect((await asAnn.get(`/api/campaigns/${builtIn}/rules`)).status).toBe(409);
    const { brief, changes } = await briefAndChanges(builtIn);
    expect(`${brief}${changes}`).not.toContain('House rul');
    expect(
      (await claude.call('record_ruling', { kind: 'rule', content: 'Anything at all goes.' })).isError,
    ).toBe(true);
    expect(await q1('SELECT count(*)::int AS n FROM rulings WHERE campaign_id = $1', [builtIn])).toEqual({
      n: 2,
    });
  });
});
