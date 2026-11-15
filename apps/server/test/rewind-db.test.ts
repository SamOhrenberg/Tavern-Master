import type { CampaignDetail, ChatMessage, Recap } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { pgStore } from '../src/agent/store.js';
import { saveSession } from '../src/agent/summarize.js';
import { rewoundNotice } from '../src/connector/tools.js';
import { endIfStale, isResting, openRoom } from '../src/realtime/room.js';
import { snapshotState } from '../src/rewind.js';
import type { WebSocket } from 'ws';
import { signedIn, type SignedIn } from './http.js';

/** Stands in for Ann's open connection. */
const annSocket = { readyState: 1, OPEN: 1, send: () => undefined } as unknown as WebSocket;

// Rewinding play, editing what was said, and the pause between sessions.
describe.skipIf(!process.env.TEST_DATABASE_URL)('rewind, edits and sessions (database)', () => {
  const tag = `rw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let app: FastifyInstance;
  let system = '';
  let camp = '';
  let host = '';
  let ann = '';
  let thorn = '';
  let session = '';
  let asHost: SignedIn;
  let asAnn: SignedIn;
  const ids: Record<string, number> = {};

  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;
  const say = async (
    key: string,
    kind: string,
    content: string,
    userId: string | null = null,
    turn: string | null = null,
  ) => {
    const row = await q1<{ id: string }>(
      `INSERT INTO messages (campaign_id, session_id, turn_id, kind, user_id, character_name, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [camp, session, turn, kind, userId, kind === 'action' ? 'Thorn' : null, content],
    );
    ids[key] = Number(row!.id);
  };
  const turn = async (n: number) =>
    (await q1<{ id: string }>(
      `INSERT INTO turns (campaign_id, session_id, number, status) VALUES ($1, $2, $3, 'done') RETURNING id`,
      [camp, session, n],
    ))!.id;
  const hp = async () => (await q1<{ hp: number }>('SELECT hp FROM characters WHERE id = $1', [thorn]))!.hp;
  const entities = async () =>
    (await q<{ name: string }>('SELECT name FROM entities WHERE campaign_id = $1 ORDER BY name', [camp])).map(
      (e) => e.name,
    );
  const story = async () =>
    (await asAnn.get<{ messages: ChatMessage[] }>(`/api/campaigns/${camp}/messages`)).body.messages.map(
      (m) => m.content,
    );

  beforeAll(async () => {
    setConfigForTests(testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }));
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `sys-${tag}`,
    ]))!.id;
    host = await user('Host');
    ann = await user('Ann');
    // Run by Claude, so nothing here calls a model.
    camp = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, settings, phase, started_at, opened_at)
       VALUES ($1, $2, $3, '{"dm":"claude"}', 'active', now(), now()) RETURNING id`,
      [system, host, `Rewind ${tag}`],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      camp,
      host,
    ]);
    await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [camp, ann]);
    thorn = (await q1<{ id: string }>(
      `INSERT INTO characters (campaign_id, name, hp, max_hp) VALUES ($1, 'Thorn', 10, 10) RETURNING id`,
      [camp],
    ))!.id;
    await q('INSERT INTO character_players (character_id, campaign_id, user_id) VALUES ($1, $2, $3)', [
      thorn,
      camp,
      ann,
    ]);
    session = (await q1<{ id: string }>(
      `INSERT INTO play_sessions (campaign_id, number) VALUES ($1, 1) RETURNING id`,
      [camp],
    ))!.id;

    // Before the opening: the world is empty and Thorn is unhurt.
    await snapshotState(camp, null);
    await say('opening', 'dm', 'You stand at the gates of the drowned city.');
    await q(`INSERT INTO entities (campaign_id, kind, name) VALUES ($1, 'location', 'Drowned City')`, [camp]);

    // Turn 1: Thorn is hurt, meets Vane, a flag and a note are set.
    const t1 = await turn(1);
    await say('a1', 'action', 'I swim for the gate', ann, t1);
    await snapshotState(camp, t1);
    await q('UPDATE characters SET hp = 4 WHERE id = $1', [thorn]);
    await q(`INSERT INTO entities (campaign_id, kind, name) VALUES ($1, 'npc', 'Captain Vane')`, [camp]);
    await q(`INSERT INTO flags (campaign_id, key, value) VALUES ($1, 'gate_open', 'true')`, [camp]);
    await q(`INSERT INTO gm_notes (campaign_id, title, content) VALUES ($1, 'Plan', 'Vane betrays them')`, [
      camp,
    ]);
    await say(
      'n1',
      'dm',
      'The current slams Thorn against the gate. [[Captain Vane]] hauls him out.',
      null,
      t1,
    );

    // Turn 2: Thorn is nearly killed.
    const t2 = await turn(2);
    await say('a2', 'action', 'I punch Vane', ann, t2);
    await snapshotState(camp, t2);
    await q('UPDATE characters SET hp = 1 WHERE id = $1', [thorn]);
    await say('n2', 'dm', 'Vane hits back, hard.', null, t2);

    app = await buildApp();
    asHost = await signedIn(app, host);
    asAnn = await signedIn(app, ann);
  });

  afterAll(async () => {
    await app?.close();
    await q('DELETE FROM campaigns WHERE id = $1', [camp]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`%-${tag}`]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await closeDb();
  });

  it('lets a player edit their own action but not the narration, and the host edit anything', async () => {
    const own = await asAnn.patch<{ message: ChatMessage }>(`/api/campaigns/${camp}/messages/${ids.a2}`, {
      content: 'I punch Vane in the jaw',
    });
    expect(own.status).toBe(200);
    expect(own.body.message).toMatchObject({ content: 'I punch Vane in the jaw', edited: true });
    expect(
      (await asAnn.patch(`/api/campaigns/${camp}/messages/${ids.n2}`, { content: 'I win.' })).status,
    ).toBe(403);

    const fixed = await asHost.patch<{ message: ChatMessage }>(`/api/campaigns/${camp}/messages/${ids.n1}`, {
      content: 'The current slams Thorn against the gate. [[Captain Vane]] and [[Nobody]] haul him out.',
    });
    expect(fixed.status).toBe(200);
    // Codex links are worked out again: a known entry stays linked, an unknown name becomes plain text.
    expect(fixed.body.message.content).toContain('[[Captain Vane]] and Nobody');
    expect(fixed.body.message.refs?.map((r) => r.name)).toEqual(['Captain Vane']);
  });

  it('only lets the host rewind, and only to a narration', async () => {
    expect((await asAnn.post(`/api/campaigns/${camp}/rewind`, { messageId: ids.n1 })).status).toBe(403);
    expect((await asHost.post(`/api/campaigns/${camp}/rewind`, { messageId: ids.a2 })).status).toBe(400);
  });

  it('rewinds to a narration, and the world goes back with the story', async () => {
    const res = await asHost.post<{ removed: number; reopen: boolean }>(`/api/campaigns/${camp}/rewind`, {
      messageId: ids.n1,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 2, reopen: false });
    expect(await story()).toEqual([
      'You stand at the gates of the drowned city.',
      'I swim for the gate',
      expect.stringContaining('[[Captain Vane]] and Nobody'),
    ]);
    // As it stood after turn 1: hurt, but not nearly dead.
    expect(await hp()).toBe(4);
    expect(await entities()).toEqual(['Captain Vane', 'Drowned City']);
    expect((await q('SELECT number FROM turns WHERE campaign_id = $1', [camp])).map((t) => t.number)).toEqual(
      [1],
    );
  });

  it('tells Claude once that the story was rewound, and what it must forget', async () => {
    const note = await rewoundNotice(camp);
    expect(note).toContain('<rewound>');
    expect(note).toContain('The current slams Thorn');
    expect(note).toContain('forget it');
    expect(await rewoundNotice(camp)).toBe('');
  });

  it('rewinds to the opening, undoing the codex, flags and notebook too', async () => {
    expect((await asHost.post(`/api/campaigns/${camp}/rewind`, { messageId: ids.opening })).status).toBe(200);
    expect(await story()).toEqual(['You stand at the gates of the drowned city.']);
    expect(await hp()).toBe(10);
    // The snapshot before turn 1 was taken after the opening made the city.
    expect(await entities()).toEqual(['Drowned City']);
    expect(await q('SELECT 1 FROM flags WHERE campaign_id = $1', [camp])).toEqual([]);
    expect(await q('SELECT 1 FROM gm_notes WHERE campaign_id = $1', [camp])).toEqual([]);
  });

  it('starts the session over from before the opening, and the DM writes it again', async () => {
    const res = await asHost.post<{ reopen: boolean; number: number }>(
      `/api/campaigns/${camp}/restart-session`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reopen: true, number: 1 });
    expect(await story()).toEqual([]);
    expect(await entities()).toEqual([]);
    const c = await q1<{ opened_at: Date | null }>('SELECT opened_at FROM campaigns WHERE id = $1', [camp]);
    expect(c!.opened_at).toBeNull();
    // The session is kept, open, to play again.
    expect(
      await q('SELECT number FROM play_sessions WHERE campaign_id = $1 AND ended_at IS NULL', [camp]),
    ).toEqual([{ number: 1 }]);
  });

  it('will not rewind past what was saved', async () => {
    await q('DELETE FROM state_snapshots WHERE campaign_id = $1', [camp]);
    await say('old', 'dm', 'An opening from before rewinding existed.');
    await say('later', 'dm', 'And a later scene.');
    const res = await asHost.post<{ error: { code: string } }>(`/api/campaigns/${camp}/rewind`, {
      messageId: ids.old,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('too_old');
  });

  it('pauses at the end of a session until every player is ready, then starts the next', async () => {
    await q('UPDATE campaigns SET opened_at = now() WHERE id = $1', [camp]);
    expect((await asHost.post(`/api/campaigns/${camp}/end-session`)).status).toBe(200);
    const detail = await asAnn.get<{ campaign: CampaignDetail }>(`/api/campaigns/${camp}`);
    expect(detail.body.campaign.restingSince).not.toBeNull();

    const recap = await asAnn.get<Recap>(`/api/campaigns/${camp}/recap`);
    expect(recap.body.sessions).toEqual([expect.objectContaining({ number: 1, summary: null })]);

    const early = await asHost.post<{ error: { message: string } }>(`/api/campaigns/${camp}/resume`);
    expect(early.status).toBe(409);
    expect(early.body.error.message).toContain('Waiting for Ann');

    // Ready is not present: Ann tapped it and closed the app.
    expect((await asAnn.put(`/api/campaigns/${camp}/ready`, { ready: true })).status).toBe(200);
    const absent = await asHost.post<{ error: { message: string } }>(`/api/campaigns/${camp}/resume`);
    expect(absent.status).toBe(409);
    expect(absent.body.error.message).toContain('Waiting for Ann');

    await (await openRoom(camp)).join(annSocket, { id: ann, username: `Ann-${tag}`, displayName: 'Ann' });
    const resumed = await asHost.post<{ number: number }>(`/api/campaigns/${camp}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.number).toBe(2);
    expect((await story()).at(-1)).toBe('Session 2 begins.');
    const after = await asAnn.get<{ campaign: CampaignDetail }>(`/api/campaigns/${camp}`);
    expect(after.body.campaign.restingSince).toBeNull();
    // Readying up only means something between sessions.
    expect((await asAnn.put(`/api/campaigns/${camp}/ready`, { ready: false })).status).toBe(409);
  });

  it('will not end a session while a turn is being gathered', async () => {
    const room = await openRoom(camp);
    room.collector.submit({ seat: 'x', userId: ann, text: 'I knock on the door' });
    const res = await asHost.post<{ error: { code: string } }>(`/api/campaigns/${camp}/end-session`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('dm_busy');
    expect(await isResting(camp)).toBe(false);
    room.collector.reset();
  });

  it('sends a table that went quiet for hours to the recap, not into a silent new session', async () => {
    await q(`UPDATE messages SET created_at = now() - interval '7 hours' WHERE campaign_id = $1`, [camp]);
    await q(`UPDATE play_sessions SET started_at = now() - interval '8 hours' WHERE campaign_id = $1`, [
      camp,
    ]);
    expect(await endIfStale(camp)).toBe(true);
    expect(await isResting(camp)).toBe(true);
    // The session that stood open is closed, and nothing new was opened behind the table's back.
    expect(
      await q('SELECT 1 FROM play_sessions WHERE campaign_id = $1 AND ended_at IS NULL', [camp]),
    ).toEqual([]);
    expect(await endIfStale(camp)).toBe(false);
  });

  it('drops a summary written for play that was rewound away', async () => {
    const over = (await q1<{ id: string }>(
      `INSERT INTO play_sessions (campaign_id, number, ended_at) VALUES ($1, 90, now()) RETURNING id`,
      [camp],
    ))!.id;
    const last = (await q1<{ id: string }>(
      `INSERT INTO messages (campaign_id, session_id, kind, content) VALUES ($1, $2, 'dm', 'A scene.') RETURNING id`,
      [camp, over],
    ))!.id;
    const text = 'They crossed the drowned city and met the captain at the gate. '.repeat(3);
    // The scene the summary runs up to was deleted by a rewind meanwhile.
    expect(await saveSession(camp, over, Number(last) + 1_000_000, [], text, [])).toBe(false);
    expect(await q(`SELECT 1 FROM summaries WHERE session_id = $1`, [over])).toEqual([]);
    expect(await saveSession(camp, over, Number(last), [], text, [])).toBe(true);
    expect(await q(`SELECT 1 FROM summaries WHERE session_id = $1`, [over])).toHaveLength(1);
    // A session the rewind reopened is not over, so it gets no summary yet.
    await q('UPDATE play_sessions SET ended_at = NULL WHERE id = $1', [over]);
    expect(await saveSession(camp, over, Number(last), [], text, [])).toBe(false);
    await q('UPDATE play_sessions SET ended_at = now() WHERE id = $1', [over]);
  });

  it('blacks out an unrevealed secret in a corrected narration, as in any narration', async () => {
    await q(`INSERT INTO entities (campaign_id, kind, name, secret) VALUES ($1, 'npc', 'Duke Orrin', $2)`, [
      camp,
      'Duke Orrin is secretly the head of the drowned cult',
    ]);
    await q(`INSERT INTO messages (campaign_id, kind, content) VALUES ($1, 'dm', 'The duke bows.')`, [camp]);
    const done = await pgStore.amendLastNarration(
      camp,
      'The duke bows. Duke Orrin is secretly the head of the drowned cult, and he smiles.',
    );
    expect(done?.redacted).toBe(true);
    const row = await q1<{ content: string; meta: { redacted?: boolean } }>(
      'SELECT content, meta FROM messages WHERE id = $1',
      [done!.id],
    );
    expect(row!.content).not.toContain('head of the drowned cult');
    expect(row!.meta.redacted).toBe(true);
  });

  it('lets the host start without someone who is not ready', async () => {
    // Ann is connected but has not readied up (ending the session cleared it).
    const blocked = await asHost.post(`/api/campaigns/${camp}/resume`);
    expect(blocked.status).toBe(409);
    const out = await asHost.post<{ number: number }>(`/api/campaigns/${camp}/resume`, { anyway: true });
    expect(out.status).toBe(200);
    // After the session numbered 90 an earlier test made up.
    expect(out.body.number).toBe(91);
    expect(await isResting(camp)).toBe(false);
  });
});
