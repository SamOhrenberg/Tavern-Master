import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { createToken, revokeToken } from '../src/connector/tokens.js';
import { queueWork } from '../src/connector/work.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { createCharacter } from '../src/party.js';
import { openRoom } from '../src/realtime/room.js';
import { mcpClient } from './http.js';

/** A connected player's socket, as far as the room needs one. */
const fakeSocket = () =>
  ({ readyState: 1, OPEN: 1, send: () => undefined, close: () => undefined }) as unknown as WebSocket;

const settle = () => new Promise((r) => setTimeout(r, 150));

// Needs a real Postgres, like the other database tests.
describe.skipIf(!process.env.TEST_DATABASE_URL)('Claude as every AI at the table (database)', () => {
  const tag = `c${Date.now().toString(36)}`;
  let app: FastifyInstance;
  let system = '';
  let camp = '';
  let other = '';
  let stranger = '';
  let host = '';
  let ann = '';
  let token = '';
  let tokenId = '';
  let claude: ReturnType<typeof mcpClient>;
  const annSocket = fakeSocket();
  const annRef = () => ({ id: ann, username: `ann-${tag}`, displayName: 'Ann' });

  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;
  const campaign = async (owner: string, name: string) => {
    const id = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, premise, settings, phase, started_at)
       VALUES ($1, $2, $3, 'A drowned town rings at low tide.', '{"dm": "claude"}', 'active', now()) RETURNING id`,
      [system, owner, name],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      id,
      owner,
    ]);
    return id;
  };

  beforeAll(async () => {
    setConfigForTests(
      testConfig({
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        SUMMARY_KEEP_MESSAGES: '2',
        CONNECTOR_IDLE_MINUTES: '1',
      }),
    );
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `sys-${tag}`,
    ]))!.id;
    host = await user('Host');
    ann = await user('Ann');
    const eve = await user('Eve');
    camp = await campaign(host, `Sunken Bell ${tag}`);
    other = await campaign(host, `Second Table ${tag}`);
    stranger = await campaign(eve, `Not Yours ${tag}`);
    await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [camp, ann]);
    await createCharacter(camp, { userId: ann, role: 'player' }, { name: 'Wren', maxHp: 12, sheet: {} });
    const made = (await createToken(host, 'test'))!;
    token = made.token;
    tokenId = made.id;
    app = await buildApp();
    claude = mcpClient(app, token);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [[camp, other, stranger]]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`%-${tag}`]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await closeDb();
  });

  it('turns away requests without a valid token', async () => {
    expect((await claude.rpc('tools/list', {}, '')).status).toBe(401);
    expect((await claude.rpc('tools/list', {}, 'tmc_not-a-real-token')).status).toBe(401);
  });

  it('speaks MCP: initialises and lists its tools', async () => {
    const init = await claude.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ serverInfo: { name: 'tavern-master' } });
    const list = await claude.rpc('tools/list', {});
    const names = (list.body.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['open_campaign', 'wait_for_work', 'narrate', 'roll_dice']));
    expect(names).not.toContain('take_turn');
  });

  it('needs a campaign opened before anything else', async () => {
    expect((await claude.call('list_campaigns')).text).toContain('DM: you. waiting: 0');
    const early = await claude.call('wait_for_work', { wait_seconds: 0 });
    expect(early.isError).toBe(true);
    expect(early.text).toContain('open_campaign');
  });

  it('opens the campaign with the full guide, what is waiting, and the next step', async () => {
    const out = await claude.call('open_campaign', { campaign: 'sunken bell' });
    expect(out.isError).toBe(false);
    // Results on the account-wide address carry the campaign's name.
    expect(out.text.startsWith(`[Sunken Bell ${tag}]`)).toBe(true);
    expect(out.text).toContain('<dm_instructions>');
    expect(out.text).toContain('A drowned town rings at low tide.');
    expect(out.text).toContain('<waiting>\n- The opening scene.');
    expect(out.text).toContain('Wren');
    expect(out.text.trimEnd().endsWith('Call wait_for_work.')).toBe(true);
  });

  it('hands out the opening, which narrate posts', async () => {
    const opening = await claude.call('wait_for_work', { wait_seconds: 0 });
    expect(opening.text).toContain('The campaign begins now');
    expect(opening.text).toContain('Post it with narrate.');
    expect(
      (
        await claude.call('upsert_entity', {
          kind: 'npc',
          name: 'Mayor Ost',
          secret: 'The mayor drowned years ago',
        })
      ).isError,
    ).toBe(false);
    expect(
      (await claude.call('roll_dice', { expression: '1d20', reason: 'Tide height', kind: 'other' })).text,
    ).toContain('Rolled');
    const posted = await claude.call('narrate', {
      text: 'The bell rings beneath the water. [[Mayor Ost]] waits on the pier.',
    });
    expect(posted.text).toContain('Posted the opening scene');
    // Nothing more to narrate until the players act.
    expect((await claude.call('narrate', { text: 'More.' })).isError).toBe(true);
  });

  it('hands out a gathered turn; narrate posts it with secrets blacked out', async () => {
    const room = await openRoom(camp);
    await room.join(annSocket, annRef());
    await room.action(annRef(), 'I climb the bell tower');

    const turn = await claude.call('wait_for_work', { wait_seconds: 5 });
    expect(turn.text).toContain('Turn 1 is yours to resolve');
    expect(turn.text).toContain('I climb the bell tower');
    expect(turn.text).toContain('character="Wren"');

    expect((await claude.call('update_character', { character: 'Wren', hp_delta: -3 })).text).toContain(
      'HP 12→9',
    );
    const posted = await claude.call('narrate', {
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

  it('sends the host’s own action and closes the turn on request', async () => {
    const sent = await claude.call('host_action', { action: 'I ring the bell myself' });
    // Ann is connected and has not acted, so the table is still waiting on her.
    expect(sent.text).toContain('Waiting on: Wren');
    expect((await claude.call('close_turn')).text).toContain('closed');
    const turn = await claude.call('wait_for_work', { wait_seconds: 5 });
    expect(turn.text).toContain('Turn 2 is yours to resolve');
    expect(turn.text).toContain('I ring the bell myself');
    // Asking again before narrating hands back the same turn.
    const again = await claude.call('wait_for_work', { wait_seconds: 0 });
    expect(again.text).toContain('Turn 2 is yours');
    expect(again.text).toContain('You claimed this turn earlier');
    expect((await claude.call('narrate', { text: 'The bell answers from below.' })).text).toContain(
      'Posted turn 2',
    );
    await settle();
  });

  it('gives an abandoned turn out again with what was already applied', async () => {
    const room = await openRoom(camp);
    await room.action(annRef(), 'I dive for the bell');
    const turn = await claude.call('wait_for_work', { wait_seconds: 5 });
    expect(turn.text).toContain('Turn 3 is yours');
    await claude.call('update_character', { character: 'Wren', hp_delta: -2 });
    expect(room.dmStatus().state).toBe('working');

    // Claude goes quiet past the claim timeout; its next call finds the turn released and hands it out again.
    room.ageLastCallForTests(11 * 60_000);
    const back = await claude.call('wait_for_work', { wait_seconds: 0 });
    expect(back.text).toContain('Turn 3 is yours');
    expect(back.text).toContain('Already applied this turn (do not repeat):');
    expect(back.text).toContain('HP 9→7');
    expect((await claude.call('narrate', { text: 'The water closes over her.' })).text).toContain(
      'Posted turn 3',
    );
    await settle();
  });

  it('does one thing at a time: tools outside the request Claude holds are refused', async () => {
    const workId = await queueWork({ campaignId: camp, kind: 'guide', subjectId: `thread-${tag}` });
    expect(workId).toBeTruthy();
    // The same subject is never queued twice.
    expect(await queueWork({ campaignId: camp, kind: 'guide', subjectId: `thread-${tag}` })).toBeNull();
    const got = await claude.call('wait_for_work', { wait_seconds: 0 });
    expect(got.text).toContain(workId!);
    const refused = await claude.call('update_character', { character: 'Wren', hp_delta: -1 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`Finish the open request first (guide, id ${workId})`);
    expect(
      (await claude.call('roll_dice', { expression: '1d6', reason: 'test', kind: 'other' })).isError,
    ).toBe(false);
    expect((await claude.call('skip_work', { work_id: workId, reason: 'Testing the queue' })).text).toContain(
      'Dropped',
    );
    const row = await q1<{ status: string; error: string }>(
      'SELECT status, error FROM dm_work WHERE id = $1',
      [workId],
    );
    expect(row).toMatchObject({ status: 'failed', error: 'Testing the queue' });
    expect((await claude.call('update_character', { character: 'Wren', hp_delta: 0 })).isError).toBe(false);
  });

  it('says how the table stands when nothing is waiting, and when to stop', async () => {
    const busy = await claude.call('wait_for_work', { wait_seconds: 0 });
    expect(busy.text).toContain('Nothing for you yet.');
    expect(busy.text).toContain('Players connected: 1.');
    expect(busy.text).not.toContain('The table is empty');

    (await openRoom(camp)).leave(annSocket);
    await settle();
    await q(`UPDATE messages SET created_at = now() - interval '1 hour' WHERE campaign_id = $1`, [camp]);
    await q(`UPDATE dm_work SET finished_at = now() - interval '1 hour' WHERE campaign_id = $1`, [camp]);
    const empty = await claude.call('wait_for_work', { wait_seconds: 0 });
    expect(empty.text).toContain('Players connected: 0.');
    expect(empty.text).toContain('The table is empty. Stop calling wait_for_work');
  });

  it('serves one campaign on its own address, and only that one', async () => {
    // The account-wide connection last opened the first campaign.
    const before = await q1<{ campaign_id: string }>(
      'SELECT campaign_id FROM connector_tokens WHERE id = $1',
      [tokenId],
    );
    const pinned = mcpClient(app, token, `/mcp/c/${other}`);
    const opened = await pinned.call('open_campaign');
    expect(opened.isError).toBe(false);
    expect(opened.text.startsWith('# Second Table')).toBe(true);
    // Works without opening first, and never names the campaign in brackets.
    const status = await pinned.call('wait_for_work', { wait_seconds: 0 });
    expect(status.text).toContain('The campaign begins now');
    expect(status.text.startsWith('[')).toBe(false);
    const after = await q1<{ campaign_id: string }>(
      'SELECT campaign_id FROM connector_tokens WHERE id = $1',
      [tokenId],
    );
    expect(after?.campaign_id).toBe(before?.campaign_id);
    // Someone else's campaign, or no campaign at all, is not found.
    expect((await mcpClient(app, token, `/mcp/c/${stranger}`).rpc('tools/list', {})).status).toBe(404);
    expect((await mcpClient(app, token, '/mcp/c/not-a-uuid').rpc('tools/list', {})).status).toBe(404);
  });

  it('stops working once the campaign goes back to the built-in AI, or the token is revoked', async () => {
    await q(`UPDATE campaigns SET settings = settings || '{"dm": "server"}' WHERE id = $1`, [camp]);
    const refused = await claude.call('get_state');
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('built-in AI');
    await revokeToken(host, tokenId);
    expect((await claude.rpc('tools/list', {})).status).toBe(401);
  });
});
