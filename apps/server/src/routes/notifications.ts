import type { NotifyPrefs, NotifySettings, QuietHours } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, q1 } from '../db/pool.js';
import { badRequest, parse } from '../errors.js';
import { requireMember } from '../http/membership.js';
import { enforceLimit, rateLimiters, requireUser } from '../http/security.js';
import { NOTIFY_CATEGORIES, prefsOf } from '../notify/notify.js';
import { quietOf, validTimeZone } from '../notify/quiet.js';
import { deleteSubscription, pushTo, saveSubscription, signedIn, vapidKeys } from '../notify/push.js';

/**
 * Push services browsers use. The server sends to whatever endpoint a
 * subscription names, so it only accepts these: anything else would let a
 * client make the server call an address of its choosing.
 */
const PUSH_HOSTS = [
  'push.apple.com', // Safari, and every iPhone home-screen app
  'fcm.googleapis.com', // Chrome, Android, most Chromium browsers
  'push.services.mozilla.com', // Firefox
  'notify.windows.com', // Edge on Windows
];

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port) return false;
  return PUSH_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}

const b64url = z.string().regex(/^[A-Za-z0-9_-]+=*$/);
const subscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: b64url.min(40).max(200), auth: b64url.min(8).max(100) }),
});
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 22:00');
const quietSchema = z.object({
  quiet: z.object({ start: hhmm, end: hhmm, timeZone: z.string().min(1).max(64) }).nullable(),
});
const prefsSchema = z.object({
  prefs: z.partialRecord(z.enum(NOTIFY_CATEGORIES as [string, ...string[]]), z.boolean()),
});

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  /** Your notification settings, and how many devices will receive them. */
  app.get('/api/notifications', async (req): Promise<NotifySettings> => {
    const auth = requireUser(req);
    const row = await q1<{ notify_prefs: Record<string, unknown>; notify_quiet: unknown; devices: number }>(
      `SELECT notify_prefs, notify_quiet,
              (SELECT count(*)::int FROM push_subscriptions s WHERE s.user_id = $1 AND ${signedIn('s')}) AS devices
         FROM users WHERE id = $1`,
      [auth.user.id],
    );
    return {
      prefs: prefsOf(row?.notify_prefs),
      quiet: quietOf(row?.notify_quiet),
      devices: row?.devices ?? 0,
    };
  });

  /** Set quiet hours, or turn them off with null. */
  app.put('/api/notifications/quiet', async (req): Promise<{ quiet: QuietHours | null }> => {
    const auth = requireUser(req);
    const { quiet } = parse(quietSchema, req.body);
    if (quiet && !validTimeZone(quiet.timeZone)) throw badRequest('Unknown time zone.');
    await q('UPDATE users SET notify_quiet = $2 WHERE id = $1', [
      auth.user.id,
      quiet ? JSON.stringify(quiet) : null,
    ]);
    // Turning them off (or moving them) may end them now; the next sweep sends what was held.
    return { quiet };
  });

  app.put('/api/notifications/prefs', async (req): Promise<{ prefs: NotifyPrefs }> => {
    const auth = requireUser(req);
    const { prefs } = parse(prefsSchema, req.body);
    const row = await q1<{ notify_prefs: Record<string, unknown> }>(
      'UPDATE users SET notify_prefs = notify_prefs || $2::jsonb WHERE id = $1 RETURNING notify_prefs',
      [auth.user.id, JSON.stringify(prefs)],
    );
    return { prefs: prefsOf(row?.notify_prefs) };
  });

  /** This device allowed notifications (or the app is confirming it still has them). */
  app.post('/api/notifications/subscriptions', async (req) => {
    const auth = requireUser(req);
    const sub = parse(subscriptionSchema, req.body);
    if (!isPushEndpoint(sub.endpoint)) throw badRequest('That push service is not supported.');
    await saveSubscription(auth.user.id, auth.sessionId, sub, req.headers['user-agent'] ?? null);
    return { ok: true };
  });

  app.delete('/api/notifications/subscriptions', async (req) => {
    const auth = requireUser(req);
    const { endpoint } = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
    await deleteSubscription(auth.user.id, endpoint);
    return { ok: true };
  });

  /** Send yourself a notification, to see that it arrives. */
  app.post('/api/notifications/test', async (req) => {
    const auth = requireUser(req);
    enforceLimit(rateLimiters().auth, `push-test:${auth.user.id}`);
    const subs = await q(`SELECT 1 FROM push_subscriptions s WHERE s.user_id = $1 AND ${signedIn('s')}`, [
      auth.user.id,
    ]);
    if (!subs.length) throw badRequest('No device has notifications turned on yet.');
    // Sent whatever your categories say: you asked for it.
    await pushTo([auth.user.id], {
      payload: {
        title: 'Tavern Master',
        body: 'Notifications are working. See you at the table.',
        url: '/you',
        tag: 'test',
        category: 'invites',
      },
      ttl: 600,
      urgency: 'high',
    });
    return { ok: true };
  });

  app.get('/api/notifications/key', async () => ({ publicKey: (await vapidKeys()).publicKey }));

  /** Mute or unmute one campaign. */
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/notifications', async (req) => {
    const { auth, campaignId } = await requireMember(req);
    const row = await q1<{ notify_muted: boolean }>(
      'SELECT notify_muted FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
      [campaignId, auth.user.id],
    );
    return { muted: row?.notify_muted ?? false };
  });

  app.put<{ Params: { id: string } }>('/api/campaigns/:id/notifications', async (req) => {
    const { auth, campaignId } = await requireMember(req);
    const { muted } = parse(z.object({ muted: z.boolean() }), req.body);
    await q('UPDATE campaign_members SET notify_muted = $3 WHERE campaign_id = $1 AND user_id = $2', [
      campaignId,
      auth.user.id,
      muted,
    ]);
    return { muted };
  });
}
