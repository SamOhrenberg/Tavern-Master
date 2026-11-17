import type { ChatMessage, PushPayload } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type WebPush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { revokeSession } from '../src/auth/sessions.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import {
  bodyOf,
  categoryOf,
  excerpt,
  notifyMessage,
  notifySession,
  notifyWaiting,
  prefsOf,
  releaseHeld,
  seenCampaign,
  resetCooldownsForTests,
  takeCooldown,
  waitingBody,
} from '../src/notify/notify.js';
import { inQuietHours, quietOf } from '../src/notify/quiet.js';
import { openRoom } from '../src/realtime/room.js';
import { isPushEndpoint } from '../src/routes/notifications.js';
import { signedIn, type SignedIn } from './http.js';

// Deliveries are recorded instead of sent. An endpoint containing "gone" answers 410, "busy" 503.
const push = vi.hoisted(() => ({ sent: [] as { endpoint: string; payload: PushPayload; topic?: string }[] }));
vi.mock('web-push', async (importOriginal) => {
  const real = (await importOriginal<{ default: typeof WebPush }>()).default;
  return {
    default: {
      ...real,
      sendNotification: async (
        sub: { endpoint: string },
        body: string,
        opts: { topic?: string },
      ): Promise<unknown> => {
        if (sub.endpoint.includes('gone')) throw new real.WebPushError('gone', 410, {}, '', sub.endpoint);
        if (sub.endpoint.includes('busy')) throw new real.WebPushError('busy', 503, {}, '', sub.endpoint);
        push.sent.push({
          endpoint: sub.endpoint,
          payload: JSON.parse(body) as PushPayload,
          topic: opts.topic,
        });
        return { statusCode: 201 };
      },
    },
  };
});

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 1,
  kind: 'action',
  turnId: null,
  user: null,
  characterName: null,
  content: '',
  createdAt: new Date().toISOString(),
  ...over,
});

describe('notification text and rules', () => {
  beforeAll(() => setConfigForTests(testConfig({ PUSH_COOLDOWN_SECONDS: '60' })));
  beforeEach(() => resetCooldownsForTests());

  it('turns a narration into one plain line, cut at a word', () => {
    expect(excerpt('The [[Gilded Eel]] creaks.\n\n**Rain** falls.')).toBe(
      'The Gilded Eel creaks. Rain falls.',
    );
    const long = excerpt('word '.repeat(80), 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('word…')).toBe(true);
  });

  it('names the speaker: the character for actions, the person for table talk', () => {
    const ann = { id: 'u1', username: 'ann', displayName: 'Ann' };
    expect(bodyOf(msg({ kind: 'action', user: ann, characterName: 'Thorn', content: 'I draw.' }))).toBe(
      'Thorn: I draw.',
    );
    expect(bodyOf(msg({ kind: 'ooc', user: ann, content: 'brb' }))).toBe('Ann: brb');
    expect(bodyOf(msg({ kind: 'dm', content: 'Night falls.' }))).toBe('Night falls.');
  });

  it('never notifies about system lines', () => {
    expect(categoryOf(msg({ kind: 'system' }))).toBeNull();
    expect(categoryOf(msg({ kind: 'dm' }))).toBe('narration');
    expect(categoryOf(msg({ kind: 'ooc' }))).toBe('chat');
  });

  it('treats a missing preference as on', () => {
    expect(prefsOf({ chat: false })).toMatchObject({ chat: false, narration: true, invites: true });
  });

  it('spaces out chatter per person and campaign, but never narration', () => {
    const t = 1_000_000;
    expect(takeCooldown('u', 'c', 'chat', t)).toBe(true);
    expect(takeCooldown('u', 'c', 'actions', t + 10_000)).toBe(false);
    expect(takeCooldown('u', 'other', 'actions', t + 10_000)).toBe(true);
    expect(takeCooldown('u', 'c', 'narration', t + 20_000)).toBe(true);
    expect(takeCooldown('u', 'c', 'chat', t + 81_000)).toBe(true);
  });

  it("knows quiet hours in the person's own time zone, across midnight", () => {
    const night = { start: '22:00', end: '08:00', timeZone: 'America/Chicago' };
    // 04:30 UTC is 22:30 the evening before in Chicago (CST, UTC-6).
    expect(inQuietHours(night, new Date('2026-01-15T04:30:00Z'))).toBe(true);
    expect(inQuietHours(night, new Date('2026-01-15T13:59:00Z'))).toBe(true); // 07:59
    expect(inQuietHours(night, new Date('2026-01-15T14:00:00Z'))).toBe(false); // 08:00
    expect(inQuietHours(night, new Date('2026-01-15T20:00:00Z'))).toBe(false); // 14:00
    const nap = { start: '13:00', end: '15:00', timeZone: 'UTC' };
    expect(inQuietHours(nap, new Date('2026-01-15T14:00:00Z'))).toBe(true);
    expect(inQuietHours(nap, new Date('2026-01-15T15:00:00Z'))).toBe(false);
    expect(inQuietHours({ ...nap, end: '13:00' }, new Date('2026-01-15T13:00:00Z'))).toBe(false);
    expect(inQuietHours(null)).toBe(false);
    expect(quietOf({ start: '25:00', end: '08:00', timeZone: 'UTC' })).toBeNull();
    expect(quietOf({ start: '22:00', end: '08:00', timeZone: 'Mars/Olympus' })).toBeNull();
  });

  it('says who the table is waiting on, and who already moved', () => {
    const h = (names: string[], othersActed: string[], acted = false) => ({
      userId: 'u',
      names,
      acted,
      othersActed,
    });
    expect(waitingBody(h(['Thorn'], ['Kestrel', 'Brin']))).toBe(
      'Kestrel and Brin have acted. The table is waiting on Thorn.',
    );
    expect(waitingBody(h(['Thorn'], ['A', 'B', 'C', 'D']))).toBe(
      'A, B and 2 more have acted. The table is waiting on Thorn.',
    );
    expect(waitingBody(h(['Thorn'], ['Kestrel'], true))).toBe(
      'You acted as Thorn. Tap Done so the DM can answer.',
    );
    expect(waitingBody(h(['Ann'], []))).toBe('The table is waiting on Ann.');
  });

  it('only sends to real push services', () => {
    expect(isPushEndpoint('https://web.push.apple.com/QGx1')).toBe(true);
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('https://db5p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isPushEndpoint('https://evil-push.apple.com.attacker.net/x')).toBe(false);
    expect(isPushEndpoint('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isPushEndpoint('not a url')).toBe(false);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('push notifications (database)', () => {
  const tag = `nt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let app: FastifyInstance;
  let camp = '';
  let turn = '';
  const ids: Record<string, string> = {};
  let asAnn: SignedIn;

  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;
  /** A device signed in as this user that allowed notifications; returns its session. */
  const subscribe = async (userId: string, endpoint: string) => {
    const session = (await q1<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, sha256(convert_to($2, 'UTF8')), now() + interval '1 day') RETURNING id`,
      [userId, endpoint],
    ))!.id;
    await q(
      `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        session,
        endpoint,
        // A valid P-256 public key and auth secret, as a browser would send.
        'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
        'tBHItJI5svbpez7KI4CCXg',
      ],
    );
    return session;
  };
  const endpoint = (who: string) => `https://fcm.googleapis.com/fcm/send/${tag}-${who}`;
  const sentTo = () => push.sent.map((s) => s.endpoint.split(`${tag}-`)[1]).sort();

  beforeAll(async () => {
    setConfigForTests(
      testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, BASE_URL: 'https://tavern.example' }),
    );
    await migrate();
    for (const name of ['ann', 'bob', 'cat', 'dee', 'eve', 'fay']) ids[name] = await user(name);
    const system = (await q1<{ id: string }>(
      `INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`,
      [`sys-${tag}`, 'Test System'],
    ))!.id;
    camp = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, phase, started_at) VALUES ($1, $2, $3, 'active', now()) RETURNING id`,
      [system, ids.ann, 'Low Tide'],
    ))!.id;
    for (const [name, id] of Object.entries(ids)) {
      await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3)`, [
        camp,
        id,
        name === 'ann' ? 'owner' : 'player',
      ]);
      // Fay never allowed notifications, so has no subscription.
      if (name !== 'fay') await subscribe(id, endpoint(name));
    }
    const session = (await q1<{ id: string }>(
      `INSERT INTO play_sessions (campaign_id, number) VALUES ($1, 1) RETURNING id`,
      [camp],
    ))!.id;
    turn = (await q1<{ id: string }>(
      `INSERT INTO turns (campaign_id, session_id, number) VALUES ($1, $2, 1) RETURNING id`,
      [camp, session],
    ))!.id;
    app = await buildApp();
    asAnn = await signedIn(app, ids.ann!);
  });

  beforeEach(async () => {
    push.sent = [];
    resetCooldownsForTests();
    await q(`UPDATE campaign_members SET notify_muted = false WHERE campaign_id = $1`, [camp]);
    await q(`UPDATE users SET notify_prefs = '{}' WHERE username LIKE $1`, [`%-${tag}`]);
  });

  afterAll(async () => {
    await app?.close();
    await q(`DELETE FROM campaigns WHERE id = $1`, [camp]);
    await q(`DELETE FROM game_systems WHERE slug = $1`, [`sys-${tag}`]);
    await q(`DELETE FROM users WHERE username LIKE $1`, [`%-${tag}`]);
    await closeDb();
  });

  it('tells everyone away except the author, whoever is watching, and those who opted out', async () => {
    await q(`UPDATE campaign_members SET notify_muted = true WHERE campaign_id = $1 AND user_id = $2`, [
      camp,
      ids.dee,
    ]);
    await q(`UPDATE users SET notify_prefs = '{"actions": false}' WHERE id = $1`, [ids.eve]);
    const ann = { id: ids.ann!, username: 'ann', displayName: 'Ann' };
    await notifyMessage(
      camp,
      msg({ kind: 'action', user: ann, characterName: 'Thorn', content: 'I open the door.' }),
      new Set([ids.bob!]),
    );
    expect(sentTo()).toEqual(['cat']);
    expect(push.sent[0]!.payload).toMatchObject({
      title: 'Low Tide',
      body: 'Thorn: I open the door.',
      url: `/c/${camp}`,
      tag: `campaign:${camp}`,
      category: 'actions',
    });
    expect(push.sent[0]!.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('holds back a second burst of chatter, but not the narration that follows', async () => {
    await notifyMessage(
      camp,
      msg({ kind: 'action', characterName: 'Kestrel', content: 'I wait.' }),
      new Set(),
    );
    await notifyMessage(camp, msg({ kind: 'ooc', content: 'back in 5' }), new Set());
    expect(push.sent).toHaveLength(5);
    push.sent = [];
    await notifyMessage(camp, msg({ kind: 'dm', content: 'The door groans open.' }), new Set());
    expect(sentTo()).toEqual(['ann', 'bob', 'cat', 'dee', 'eve']);
  });

  it('tells a player the DM wants their roll instead of sending the plain scene', async () => {
    const thorn = (await q1<{ id: string }>(
      `INSERT INTO characters (campaign_id, name, hp, max_hp) VALUES ($1, 'Thorn', 10, 10) RETURNING id`,
      [camp],
    ))!.id;
    await q('INSERT INTO character_players (character_id, campaign_id, user_id) VALUES ($1, $2, $3)', [
      thorn,
      camp,
      ids.cat,
    ]);
    await q(
      `INSERT INTO roll_requests (campaign_id, character_id, expression, reason, turn_id) VALUES ($1, $2, '1d20+3', 'Perception', $3)`,
      [camp, thorn, turn],
    );
    await notifyMessage(camp, msg({ kind: 'dm', turnId: turn, content: 'Something moves.' }), new Set());
    const toCat = push.sent.filter((s) => s.endpoint.endsWith('-cat'));
    expect(toCat).toHaveLength(1);
    expect(toCat[0]!.payload).toMatchObject({
      title: 'Low Tide: your roll',
      body: 'Thorn, roll 1d20+3 for Perception.',
      category: 'rolls',
    });
    expect(push.sent.filter((s) => s.payload.category === 'narration')).toHaveLength(4);
    await q(`UPDATE roll_requests SET status = 'rolled' WHERE campaign_id = $1`, [camp]);
  });

  it('announces a session to everyone away', async () => {
    await notifySession(camp, 'Session 2 is starting.', new Set([ids.ann!]));
    expect(sentTo()).toEqual(['bob', 'cat', 'dee', 'eve']);
    expect(push.sent[0]!.payload.category).toBe('sessions');
  });

  it('nudges whoever a turn is waiting on, unless they are looking or opted out', async () => {
    await q(`UPDATE users SET notify_prefs = '{"waiting": false}' WHERE id = $1`, [ids.eve]);
    await notifyWaiting(
      camp,
      [
        { userId: ids.cat!, names: ['Thorn'], acted: false, othersActed: ['Kestrel'] },
        { userId: ids.bob!, names: ['Brin'], acted: true, othersActed: ['Kestrel'] },
        { userId: ids.eve!, names: ['Ivy'], acted: false, othersActed: ['Kestrel'] },
      ],
      new Set([ids.bob!]),
    );
    expect(sentTo()).toEqual(['cat']);
    expect(push.sent[0]!.payload).toMatchObject({
      title: 'Low Tide: your move',
      body: 'Kestrel has acted. The table is waiting on Thorn.',
      category: 'waiting',
    });
  });

  it('a turn left waiting nudges the players it waits on, and not the one at the table', async () => {
    // Waits until everyone is ready, so Cat's character holds the turn although Cat is away.
    const table = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name, settings, phase, started_at, opened_at)
       SELECT system_id, owner_id, 'High Tide', '{"dm":"claude","gatherWindowSeconds":0}', 'active', now(), now()
         FROM campaigns WHERE id = $1 RETURNING id`,
      [camp],
    ))!.id;
    for (const who of ['cat', 'dee'])
      await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [table, ids[who]]);
    for (const [who, name] of [
      ['cat', 'Thorn'],
      ['dee', 'Kestrel'],
    ] as const) {
      const ch = (await q1<{ id: string }>(
        `INSERT INTO characters (campaign_id, name, hp, max_hp) VALUES ($1, $2, 10, 10) RETURNING id`,
        [table, name],
      ))!.id;
      await q('INSERT INTO character_players (character_id, campaign_id, user_id) VALUES ($1, $2, $3)', [
        ch,
        table,
        ids[who],
      ]);
    }
    const socket = { readyState: 1, OPEN: 1, send: () => undefined } as unknown as WebSocket;
    const dee = { id: ids.dee!, username: 'dee', displayName: 'Dee' };
    const room = await openRoom(table);
    try {
      await room.join(socket, dee);
      await room.action(dee, 'I keep watch.');
      await new Promise((r) => setTimeout(r, 200));
      push.sent = [];

      const inner = room as unknown as {
        turn: { id: string };
        waitingSince: Map<string, number>;
        nudgeHoldouts(turnId: string): void;
      };
      // Too soon: nobody has held the turn up for PUSH_WAITING_MINUTES yet.
      inner.nudgeHoldouts(inner.turn.id);
      await new Promise((r) => setTimeout(r, 100));
      expect(push.sent).toHaveLength(0);

      // What the timer does once PUSH_WAITING_MINUTES have passed.
      for (const seat of inner.waitingSince.keys()) inner.waitingSince.set(seat, 0);
      inner.nudgeHoldouts(inner.turn.id);
      await vi.waitFor(() => expect(push.sent.length).toBeGreaterThan(0));
      expect(sentTo()).toEqual(['cat']);
      expect(push.sent[0]!.payload).toMatchObject({
        title: 'High Tide: your move',
        body: 'Kestrel has acted. The table is waiting on Thorn.',
        url: `/c/${table}`,
      });

      // Each person hears about a turn once.
      push.sent = [];
      inner.nudgeHoldouts(inner.turn.id);
      await new Promise((r) => setTimeout(r, 100));
      expect(push.sent).toHaveLength(0);

      // A turn already over nudges nobody.
      push.sent = [];
      inner.nudgeHoldouts('00000000-0000-0000-0000-000000000000');
      await new Promise((r) => setTimeout(r, 100));
      expect(push.sent).toHaveLength(0);
    } finally {
      room.collector.reset();
      room.leave(socket);
      room.dispose();
      await q('DELETE FROM campaigns WHERE id = $1', [table]);
    }
  });

  it('holds notifications during quiet hours and sends one summary per campaign after', async () => {
    // Quiet all day except the minute this test pretends it is later.
    const now = new Date();
    const hhmm = (d: Date) => d.toISOString().slice(11, 16);
    const later = new Date(now.getTime() + 2 * 3600_000);
    await q(`UPDATE users SET notify_quiet = $2 WHERE id = $1`, [
      ids.cat,
      JSON.stringify({
        start: hhmm(new Date(now.getTime() - 3600_000)),
        end: hhmm(new Date(now.getTime() + 3600_000)),
        timeZone: 'UTC',
      }),
    ]);
    try {
      await notifyMessage(camp, msg({ kind: 'ooc', content: 'anyone up?' }), new Set());
      await notifyMessage(camp, msg({ kind: 'dm', content: 'Dawn breaks over the harbour.' }), new Set());
      await notifyMessage(camp, msg({ kind: 'ooc', content: 'night all' }), new Set());
      expect(sentTo().filter((w) => w === 'cat')).toEqual([]);

      // Still quiet: nothing goes out.
      push.sent = [];
      await releaseHeld(now);
      expect(push.sent).toHaveLength(0);

      // Over: one summary, leading with the narration rather than the chat that came after it.
      await releaseHeld(later);
      expect(sentTo()).toEqual(['cat']);
      expect(push.sent[0]!.payload).toMatchObject({
        title: 'Low Tide',
        body: '3 updates while you were away. Dawn breaks over the harbour.',
        tag: `campaign:${camp}`,
      });
      push.sent = [];
      await releaseHeld(later);
      expect(push.sent).toHaveLength(0);

      // Opening the campaign meanwhile throws away what was held for it.
      await notifyMessage(camp, msg({ kind: 'dm', content: 'Gulls.' }), new Set());
      await seenCampaign(ids.cat!, camp);
      await releaseHeld(later);
      expect(push.sent.filter((s) => s.endpoint.endsWith('-cat'))).toHaveLength(0);
    } finally {
      await q(`UPDATE users SET notify_quiet = NULL WHERE id = $1`, [ids.cat]);
    }
  });

  it('stores quiet hours, and refuses a made-up time zone', async () => {
    const bad = await asAnn.put('/api/notifications/quiet', {
      quiet: { start: '22:00', end: '07:00', timeZone: 'Mars/Olympus' },
    });
    expect(bad.status).toBe(400);
    const quiet = { start: '22:30', end: '07:00', timeZone: 'Europe/Berlin' };
    expect((await asAnn.put('/api/notifications/quiet', { quiet })).status).toBe(200);
    expect((await asAnn.get<{ quiet: unknown }>('/api/notifications')).body.quiet).toEqual(quiet);
    await asAnn.put('/api/notifications/quiet', { quiet: null });
    expect((await asAnn.get<{ quiet: unknown }>('/api/notifications')).body.quiet).toBeNull();
  });

  it('drops a subscription the push service says is gone', async () => {
    await subscribe(ids.bob!, `${endpoint('bob')}-gone`);
    await notifySession(camp, 'Session 3 is starting.');
    const left = await q(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [`${endpoint('bob')}-gone`]);
    expect(left).toHaveLength(0);
  });

  it('keeps a subscription through a push service outage', async () => {
    const busy = `${endpoint('bob')}-busy`;
    await subscribe(ids.bob!, busy);
    try {
      for (let i = 0; i < 8; i++) await notifySession(camp, `Session ${i} is starting.`);
      const left = await q(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [busy]);
      expect(left).toHaveLength(1);
    } finally {
      await q(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [busy]);
    }
  });

  it('sends nothing to a device whose sign-in was revoked', async () => {
    const phone = `${endpoint('dee')}-lost`;
    const session = await subscribe(ids.dee!, phone);
    await revokeSession(session, ids.dee!);
    expect(await q(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [phone])).toHaveLength(0);

    // Expired without anyone revoking it: kept, but sent nothing.
    const old = `${endpoint('dee')}-expired`;
    const expired = await subscribe(ids.dee!, old);
    try {
      await q(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired]);
      push.sent = [];
      await notifySession(camp, 'Session 9 is starting.');
      expect(push.sent.some((s) => s.endpoint === old)).toBe(false);
      expect(push.sent.some((s) => s.endpoint === endpoint('dee'))).toBe(true);
    } finally {
      await q(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [old]);
    }
  });

  it('stores subscriptions from push services only, and settings per person and campaign', async () => {
    const keys = {
      p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
      auth: 'tBHItJI5svbpez7KI4CCXg',
    };
    const bad = await asAnn.post('/api/notifications/subscriptions', {
      endpoint: 'https://169.254.169.254/latest',
      keys,
    });
    expect(bad.status).toBe(400);
    const ok = await asAnn.post('/api/notifications/subscriptions', {
      endpoint: `https://web.push.apple.com/${tag}`,
      keys,
    });
    expect(ok.status).toBe(200);
    expect((await asAnn.get<{ devices: number }>('/api/notifications')).body.devices).toBe(2);

    const prefs = await asAnn.put<{ prefs: Record<string, boolean> }>('/api/notifications/prefs', {
      prefs: { chat: false },
    });
    expect(prefs.body.prefs).toMatchObject({ chat: false, narration: true });

    await asAnn.put(`/api/campaigns/${camp}/notifications`, { muted: true });
    expect((await asAnn.get<{ muted: boolean }>(`/api/campaigns/${camp}/notifications`)).body.muted).toBe(
      true,
    );

    const key = await asAnn.get<{ publicKey: string }>('/api/notifications/key');
    expect(key.body.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    // Made once and kept.
    expect((await asAnn.get<{ publicKey: string }>('/api/notifications/key')).body.publicKey).toBe(
      key.body.publicKey,
    );

    await asAnn.send('DELETE', '/api/notifications/subscriptions', {
      endpoint: `https://web.push.apple.com/${tag}`,
    });
    expect((await asAnn.get<{ devices: number }>('/api/notifications')).body.devices).toBe(1);
  });
});
