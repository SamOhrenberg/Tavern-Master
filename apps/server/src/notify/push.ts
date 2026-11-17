import type { PushPayload } from '@tavern/protocol';
import webpush from 'web-push';
import { config } from '../config.js';
import { q, q1 } from '../db/pool.js';
import { log } from '../log.js';
import { decryptSecret, encryptSecret, sha256 } from '../security/crypto.js';

/** A subscription the push service rejected this many times in a row is dropped. */
const MAX_FAILURES = 5;
/** Push service answers that mean this subscription itself is bad (404 and 410 drop it at once). */
const SUBSCRIPTION_FAULTS = new Set([400]);

interface Keys {
  publicKey: string;
  privateKey: string;
}

let keys: Promise<Keys> | undefined;

/**
 * The server's VAPID key pair: from the environment when both halves are set,
 * otherwise made once and kept (encrypted) in the database. Every
 * subscription is tied to the public key, so it must not change.
 */
export function vapidKeys(): Promise<Keys> {
  keys ??= (async () => {
    const cfg = config();
    if (cfg.VAPID_PUBLIC_KEY && cfg.VAPID_PRIVATE_KEY)
      return { publicKey: cfg.VAPID_PUBLIC_KEY, privateKey: cfg.VAPID_PRIVATE_KEY };
    const made = webpush.generateVAPIDKeys();
    // Two processes starting at once both try; the first insert wins and both read it back.
    await q(
      `INSERT INTO push_keys (id, public_key, private_enc) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`,
      [made.publicKey, encryptSecret(made.privateKey)],
    );
    const row = await q1<{ public_key: string; private_enc: string }>(
      'SELECT public_key, private_enc FROM push_keys WHERE id = 1',
    );
    return { publicKey: row!.public_key, privateKey: decryptSecret(row!.private_enc) };
  })().catch((err) => {
    keys = undefined;
    throw err;
  });
  return keys;
}

/** Push services want an https: URL or a mailto: address to reach the operator. */
function subject(): string {
  const cfg = config();
  if (cfg.VAPID_SUBJECT) return cfg.VAPID_SUBJECT;
  if (cfg.baseUrl.protocol === 'https:') return cfg.baseUrl.origin;
  return 'mailto:admin@tavern-master.invalid';
}

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * SQL: subscription `alias` belongs to a sign-in that is still good, by the
 * same rules as resolveSession. A device that was signed out, revoked from
 * the Devices sheet or left to expire gets nothing more.
 */
export function signedIn(alias = 's'): string {
  const idle = Math.trunc(config().SESSION_IDLE_HOURS);
  return `EXISTS (SELECT 1 FROM sessions ss
                   WHERE ss.id = ${alias}.session_id AND ss.revoked_at IS NULL AND ss.expires_at > now()
                     AND ss.last_seen_at > now() - make_interval(hours => ${idle}))`;
}

/**
 * Store a browser's subscription for this sign-in. An endpoint moves to
 * whoever subscribed with it last.
 */
export async function saveSubscription(
  userId: string,
  sessionId: string,
  sub: Subscription,
  userAgent: string | null,
): Promise<void> {
  await q(
    `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = $1, session_id = $2, p256dh = $4, auth = $5, user_agent = $6,
           seen_at = now(), failures = 0`,
    [userId, sessionId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 300) ?? null],
  );
}

export async function deleteSubscription(userId: string, endpoint: string): Promise<void> {
  await q('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

export interface Delivery {
  payload: PushPayload;
  /** Seconds the push service holds it for a device that is off. Stale news is not worth delivering. */
  ttl: number;
  urgency: 'normal' | 'high';
}

/**
 * Send one notification to every device of these users. Never throws:
 * notifications are a nicety and must not break the thing that caused them.
 */
export async function pushTo(userIds: string[], d: Delivery): Promise<void> {
  if (!userIds.length) return;
  try {
    const subs = await q<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions s
        WHERE s.user_id = ANY($1::uuid[]) AND ${signedIn('s')}`,
      [userIds],
    );
    if (!subs.length) return;
    const { publicKey, privateKey } = await vapidKeys();
    const body = JSON.stringify(d.payload);
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            {
              vapidDetails: { subject: subject(), publicKey, privateKey },
              TTL: d.ttl,
              urgency: d.urgency,
              // A newer push with the same topic replaces one still waiting for an offline device.
              topic: topicOf(d.payload.tag),
              timeout: 10_000,
            },
          );
          await q('UPDATE push_subscriptions SET last_sent_at = now(), failures = 0 WHERE id = $1', [s.id]);
        } catch (err) {
          const status = err instanceof webpush.WebPushError ? err.statusCode : 0;
          // 404/410: the browser unsubscribed or the app was removed. It will not come back.
          if (status === 404 || status === 410) {
            await q('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
            return;
          }
          log().warn({ err, status }, 'push delivery failed');
          // Only an error about this subscription itself counts against it.
          // Rate limits, outages and timeouts pass; a 403 is usually the
          // server's own VAPID setup, which would otherwise wipe every device.
          if (!SUBSCRIPTION_FAULTS.has(status)) return;
          const kept = await q(
            'UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1 AND failures + 1 < $2 RETURNING id',
            [s.id, MAX_FAILURES],
          );
          if (!kept.length) await q('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
        }
      }),
    );
  } catch (err) {
    log().warn({ err }, 'could not send push notifications');
  }
}

/** Topics are at most 32 URL-safe characters; a hash of the tag fits any tag. */
function topicOf(tag: string): string {
  return sha256(tag).toString('base64url').slice(0, 32);
}
