import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { createToken, revokeToken } from '../src/connector/tokens.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { createCharacter } from '../src/party.js';
import { openRoom } from '../src/realtime/room.js';

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** A connected player's socket, as far as the room needs one. */
const fakeSocket = () =>
  ({ readyState: 1, OPEN: 1, send: () => undefined, close: () => undefined }) as unknown as WebSocket;

const settle = () => new Promise((r) => setTimeout(r, 150));

// Needs a real Postgres, like the other database tests.
describe.skipIf(!process.env.TEST_DATABASE_URL)('the Claude app as Dungeon Master (database)', () => {
  const tag = `c${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let camp = '';
  let host = '';
  let ann = '';
  let token = '';
  let tokenId = '';

  const rpc = async (method: string, params: unknown, bearer = token) => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method, params },
    });
    return { status: res.statusCode, body: res.json() as { result?: unknown; error?: { message: string } } };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { body } = await rpc('tools/call', { name, arguments: args });
    const result = body.result as ToolResult;
    return { text: result.content.map((c) => c.text).join('\n'), isError: !!result.isError };
  };
  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;

  beforeAll(async () => {
    setConfigForTests(
      testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, SUMMARY_KEEP_MESSAGES: '2' }),
    );
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `sys-${tag}`,
    ]))!.id;
    host = await user('Host');
    ann = await user('Ann');
    camp = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, premise, settings, phase, started_at)
       VALUES ($1, $2, $3, 'A drowned town rings at low tide.', '{"dm": "claude"}', 'active', now()) RETURNING id`,
      [system, host, `Sunken Bell ${tag}`],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      camp,
      host,
    ]);
    await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [camp, ann]);
    await createCharacter(camp, { userId: ann, role: 'player' }, { name: 'Wren', maxHp: 12, sheet: {} });
    const made = (await createToken(host, 'test'))!;
    token = made.token;
    tokenId = made.id;
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = $1', [camp]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[host, ann]]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await closeDb();
  });

  it('turns away requests without a valid token', async () => {
    expect((await rpc('tools/list', {}, '')).status).toBe(401);
    expect((await rpc('tools/list', {}, 'tmc_not-a-real-token')).status).toBe(401);
  });

  it('speaks MCP: initialises and lists its tools', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ serverInfo: { name: 'tavern-master' } });
    const list = await rpc('tools/list', {});
    const names = (list.body.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['open_campaign', 'take_turn', 'narrate', 'roll_dice']));
  });

  it('needs a campaign opened before anything else', async () => {
    expect((await call('list_campaigns')).text).toContain('DM: this chat');
    const early = await call('take_turn', { wait_seconds: 0 });
    expect(early.isError).toBe(true);
    expect(early.text).toContain('open_campaign');
  });

  it('opens the campaign with the full guide and asks for an opening scene', async () => {
    const out = await call('open_campaign', { campaign: 'sunken bell' });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('<dm_instructions>');
    expect(out.text).toContain('A drowned town rings at low tide.');
    expect(out.text).toContain('The campaign begins now');
    expect(out.text).toContain('Wren');
  });

  it('posts the opening scene, with tools used along the way', async () => {
    expect(
      (await call('upsert_entity', { kind: 'npc', name: 'Mayor Ost', secret: 'The mayor drowned years ago' }))
        .isError,
    ).toBe(false);
    expect(
      (await call('roll_dice', { expression: '1d20', reason: 'Tide height', kind: 'other' })).text,
    ).toContain('Rolled');
    const posted = await call('narrate', {
      text: 'The bell rings beneath the water. [[Mayor Ost]] waits on the pier.',
    });
    expect(posted.text).toContain('Posted the opening scene');
    const opened = await q1<{ opened: boolean }>(
      'SELECT opened_at IS NOT NULL AS opened FROM campaigns WHERE id = $1',
      [camp],
    );
    expect(opened?.opened).toBe(true);
    // Nothing more to narrate until the players act.
    expect((await call('narrate', { text: 'More.' })).isError).toBe(true);
  });

  it('collects a player’s turn, resolves it with tools and posts the narration', async () => {
    const room = await openRoom(camp);
    await room.join(fakeSocket(), { id: ann, username: `ann-${tag}`, displayName: 'Ann' });
    await room.action({ id: ann, username: `ann-${tag}`, displayName: 'Ann' }, 'I climb the bell tower');

    const turn = await call('take_turn', { wait_seconds: 5 });
    expect(turn.text).toContain('Turn 1 is yours to resolve');
    expect(turn.text).toContain('I climb the bell tower');
    expect(turn.text).toContain('character="Wren"');

    // Wren's player acted this turn, so Wren can be hurt.
    expect((await call('update_character', { character: 'Wren', hp_delta: -3 })).text).toContain('HP 12→9');
    const posted = await call('narrate', {
      text: 'Wren slips on the wet stones; the mayor drowned years ago, the bell tells her.',
    });
    expect(posted.text).toContain('Posted turn 1');
    expect(posted.text).toContain('blacked out');
    await settle();
    const done = await q1<{ status: string }>(
      `SELECT status FROM turns WHERE campaign_id = $1 AND number = 1`,
      [camp],
    );
    expect(done?.status).toBe('done');
    const last = await q1<{ content: string; meta: { redacted?: boolean } }>(
      `SELECT content, meta FROM messages WHERE campaign_id = $1 AND kind = 'dm' ORDER BY id DESC LIMIT 1`,
      [camp],
    );
    expect(last?.content).not.toContain('drowned years ago');
    expect(last?.meta.redacted).toBe(true);
  });

  it('takes the host’s own action and can stop waiting for the rest of the table', async () => {
    const waiting = await call('take_turn', { action: 'I ring the bell myself', wait_seconds: 0 });
    // Ann is connected and has not acted, so the table is still waiting on her.
    expect(waiting.text).toContain('Waiting on: Wren');
    const turn = await call('take_turn', { close_now: true, wait_seconds: 5 });
    expect(turn.text).toContain('Turn 2 is yours to resolve');
    expect(turn.text).toContain('I ring the bell myself');
    // Asking again before narrating hands back the same turn.
    expect((await call('take_turn', { wait_seconds: 0 })).text).toContain('Turn 2 is yours');
    expect((await call('narrate', { text: 'The bell answers from below.' })).text).toContain('Posted turn 2');
    await settle();
  });

  it('lets the DM write the chronicle itself', async () => {
    const review = await call('review_chronicle');
    const through = /through_message = (\d+)/.exec(review.text)?.[1];
    expect(through).toBeTruthy();
    const saved = await call('save_chronicle', {
      through_message: Number(through),
      summary:
        'The party arrived at the drowned town as the bell rang beneath the water. Wren climbed the bell tower and slipped on the wet stones.',
      memories: [{ kind: 'thread', content: 'The bell rings from below the water', importance: 4 }],
    });
    expect(saved.text).toContain('Stored.');
    const brief = await q1<{ brief: string }>('SELECT brief FROM campaigns WHERE id = $1', [camp]);
    expect(brief?.brief).toContain('Wren climbed the bell tower');
  });

  it('stops working once the campaign goes back to the built-in DM, or the token is revoked', async () => {
    await q(`UPDATE campaigns SET settings = settings || '{"dm": "server"}' WHERE id = $1`, [camp]);
    const refused = await call('get_state');
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('built-in DM');
    await revokeToken(host, tokenId);
    expect((await rpc('tools/list', {})).status).toBe(401);
  });
});
