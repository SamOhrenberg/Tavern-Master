import type { ChatMessage, NotifyCategory, NotifyPrefs, PushPayload } from '@tavern/protocol';
import { config } from '../config.js';
import { q, q1 } from '../db/pool.js';
import { log } from '../log.js';
import { pushTo, signedIn, type Delivery } from './push.js';
import { dropHeld, hold, quietNow, takeReleased } from './quiet.js';

/**
 * Who hears about what, and when. The rules, in order:
 *
 * - Never about your own message, and never about a campaign you are looking
 *   at right now (the table already shows it; see Room.watching).
 * - Only for campaigns you have not muted, and kinds you have not switched off.
 * - Table talk and party actions come in bursts, so they are held to one
 *   notification per person per campaign every PUSH_COOLDOWN_SECONDS. The
 *   DM's narration, a roll you are asked for and a session starting always
 *   go out: they happen at most once a turn and they are why you come back.
 * - One campaign's notifications share a tag, so they replace each other on
 *   the lock screen instead of piling up.
 * - During your quiet hours nothing is sent: it is held, one per campaign,
 *   and sent as a summary when they end (see quiet.ts).
 */

export const NOTIFY_CATEGORIES: NotifyCategory[] = [
  'narration',
  'rolls',
  'waiting',
  'actions',
  'chat',
  'sessions',
  'invites',
];

export function prefsOf(stored: Partial<Record<string, unknown>> | null | undefined): NotifyPrefs {
  const out = {} as NotifyPrefs;
  for (const c of NOTIFY_CATEGORIES) out[c] = stored?.[c] !== false;
  return out;
}

/** Categories that come in bursts and are rate limited per person and campaign. */
const CHATTY = new Set<NotifyCategory>(['actions', 'chat']);

const lastSent = new Map<string, number>();

/** Whether a chatty notification may go to this person now; records it if so. */
export function takeCooldown(userId: string, campaignId: string, category: NotifyCategory, now = Date.now()) {
  const key = `${userId}:${campaignId}`;
  const windowMs = config().PUSH_COOLDOWN_SECONDS * 1000;
  if (CHATTY.has(category) && now - (lastSent.get(key) ?? 0) < windowMs) return false;
  lastSent.set(key, now);
  if (lastSent.size > 5000) {
    for (const [k, at] of lastSent) if (now - at > windowMs) lastSent.delete(k);
  }
  return true;
}

export function resetCooldownsForTests(): void {
  lastSent.clear();
}

/** Plain text for a lock screen: codex markers and markdown dropped, one line, cut at a word. */
export function excerpt(text: string, max = 160): string {
  const plain = text
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[*_`#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

const campaignTag = (campaignId: string) => `campaign:${campaignId}`;

/**
 * Members of a campaign who want this kind of notification and have a device
 * to send it to, minus whoever is in `skip`.
 */
async function audience(campaignId: string, category: NotifyCategory, skip: ReadonlySet<string>) {
  const rows = await q<{ user_id: string; notify_prefs: Record<string, unknown> }>(
    `SELECT m.user_id, u.notify_prefs
       FROM campaign_members m
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
      WHERE m.campaign_id = $1 AND NOT m.notify_muted
        AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = m.user_id AND ${signedIn('s')})`,
    [campaignId],
  );
  return rows.filter((r) => !skip.has(r.user_id) && prefsOf(r.notify_prefs)[category]).map((r) => r.user_id);
}

async function campaignName(campaignId: string): Promise<string> {
  const row = await q1<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [campaignId]);
  return row?.name ?? 'Tavern Master';
}

/** What a message is, for notifications. System lines are the table's own bookkeeping and never notify. */
export function categoryOf(m: ChatMessage): NotifyCategory | null {
  if (m.kind === 'dm') return 'narration';
  if (m.kind === 'action') return 'actions';
  if (m.kind === 'ooc') return 'chat';
  return null;
}

/** The body line for a message: who said it, then what. */
export function bodyOf(m: ChatMessage): string {
  if (m.kind === 'dm') return excerpt(m.content);
  const who = m.characterName ?? m.user?.displayName ?? 'Someone';
  return excerpt(`${who}: ${m.content}`);
}

const DELIVERY: Record<NotifyCategory, Omit<Delivery, 'payload'>> = {
  narration: { ttl: 12 * 3600, urgency: 'normal' },
  rolls: { ttl: 24 * 3600, urgency: 'high' },
  waiting: { ttl: 6 * 3600, urgency: 'high' },
  actions: { ttl: 3600, urgency: 'normal' },
  chat: { ttl: 3600, urgency: 'normal' },
  sessions: { ttl: 3 * 3600, urgency: 'high' },
  invites: { ttl: 7 * 24 * 3600, urgency: 'normal' },
};

/**
 * Send now, or hold for whoever is in their quiet hours. About a campaign,
 * what is sent now goes through the per-campaign cooldown; what is held does
 * not, since holding buzzes nobody and the summary should count everything.
 */
async function send(userIds: string[], payload: PushPayload, campaignId?: string): Promise<void> {
  if (!userIds.length) return;
  const quiet = await quietNow(userIds);
  const now = userIds.filter(
    (id) => !quiet.has(id) && (!campaignId || takeCooldown(id, campaignId, payload.category)),
  );
  await Promise.all([hold([...quiet], payload), pushTo(now, { payload, ...DELIVERY[payload.category] })]);
}

/**
 * Quiet hours that have ended let out what they held: one notification per
 * campaign, leading with the most important thing that happened. Run every
 * minute or so. Never throws.
 */
export async function releaseHeld(now = new Date()): Promise<void> {
  try {
    const released = await takeReleased(now);
    await Promise.all(
      released.map(({ userId, payload, count }) =>
        pushTo([userId], {
          payload: {
            ...payload,
            body: count > 1 ? excerpt(`${count} updates while you were away. ${payload.body}`) : payload.body,
          },
          ttl: 12 * 3600,
          urgency: 'normal',
        }),
      ),
    );
  } catch (err) {
    log().warn({ err }, 'could not release held notifications');
  }
}

/** You have the campaign open: nothing held about it needs sending any more. */
export async function seenCampaign(userId: string, campaignId: string): Promise<void> {
  await dropHeld(userId, campaignTag(campaignId)).catch((err) =>
    log().warn({ err }, 'could not drop held notifications'),
  );
}

/**
 * Rolls the DM asked for in the turn this narration answers, by the person
 * who plays each character. A narration with no turn (the opening scene)
 * picks up requests made in the last few minutes.
 */
async function rollsFor(campaignId: string, turnId: string | null) {
  return q<{ user_id: string; character: string; reason: string; expression: string }>(
    `SELECT p.user_id, c.name AS character, r.reason, r.expression
       FROM roll_requests r
       JOIN characters c ON c.id = r.character_id
       JOIN character_players p ON p.character_id = r.character_id
      WHERE r.campaign_id = $1 AND r.status = 'pending'
        AND (r.turn_id = $2 OR ($2::uuid IS NULL AND r.created_at > now() - interval '15 minutes'))`,
    [campaignId, turnId],
  );
}

/**
 * A message was posted at the table: tell the members who are not looking.
 * `watching` is who has the campaign open on screen. Never throws.
 */
export async function notifyMessage(
  campaignId: string,
  message: ChatMessage,
  watching: ReadonlySet<string>,
): Promise<void> {
  try {
    const category = categoryOf(message);
    if (!category) return;
    const skip = new Set(watching);
    if (message.user) skip.add(message.user.id);
    const url = `/c/${campaignId}`;
    const tag = campaignTag(campaignId);
    // Who could hear about it comes first: most tables have nobody away with a device.
    const listeners = await audience(campaignId, category, skip);
    const rollers =
      category === 'narration' ? new Set(await audience(campaignId, 'rolls', skip)) : new Set<string>();
    if (!listeners.length && !rollers.size) return;
    const name = await campaignName(campaignId);

    // Narration that asks you for a roll says so, instead of being one more scene.
    if (rollers.size) {
      const asked = await rollsFor(campaignId, message.turnId);
      const byUser = new Map<string, typeof asked>();
      for (const r of asked) {
        if (!rollers.has(r.user_id)) continue;
        byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
      }
      await Promise.all(
        [...byUser].map(([userId, rolls]) => {
          skip.add(userId);
          const first = rolls[0]!;
          return send(
            [userId],
            {
              title: `${name}: your roll`,
              body: excerpt(
                rolls.length === 1
                  ? `${first.character}, roll ${first.expression}${first.reason ? ` for ${first.reason}` : ''}.`
                  : `The DM wants ${rolls.length} rolls: ${rolls.map((r) => `${r.character} (${r.reason || r.expression})`).join(', ')}.`,
              ),
              url,
              tag,
              category: 'rolls',
            },
            campaignId,
          );
        }),
      );
    }

    await send(
      listeners.filter((id) => !skip.has(id)),
      { title: name, body: bodyOf(message), url, tag, category },
      campaignId,
    );
  } catch (err) {
    log().warn({ err, campaignId }, 'could not notify about a message');
  }
}

/** The campaign began, or the host started the next session. */
export async function notifySession(
  campaignId: string,
  text: string,
  watching: ReadonlySet<string> = new Set(),
): Promise<void> {
  try {
    const users = await audience(campaignId, 'sessions', watching);
    if (!users.length) return;
    await send(
      users,
      {
        title: await campaignName(campaignId),
        body: text,
        url: `/c/${campaignId}`,
        tag: campaignTag(campaignId),
        category: 'sessions',
      },
      campaignId,
    );
  } catch (err) {
    log().warn({ err, campaignId }, 'could not notify about a session');
  }
}

/** Notifications about you rather than a table: invitations and friend requests. */
export async function notifyUser(
  userId: string,
  payload: Omit<PushPayload, 'category'>,
  category: NotifyCategory = 'invites',
): Promise<void> {
  try {
    const row = await q1<{ notify_prefs: Record<string, unknown> }>(
      `SELECT notify_prefs FROM users WHERE id = $1 AND status = 'active'`,
      [userId],
    );
    if (!row || !prefsOf(row.notify_prefs)[category]) return;
    await send([userId], { ...payload, category });
  } catch (err) {
    log().warn({ err }, 'could not notify a user');
  }
}

/** Someone a turn is waiting on: the seats (characters) of theirs that have not finished. */
export interface Holdout {
  userId: string;
  /** Character names, or the player's own name for a seat with no character. */
  names: string[];
  /** Whether they acted already and only have to say they are done. */
  acted: boolean;
  /** Everyone else's seats that have acted this turn, by name. */
  othersActed: string[];
}

const listed = (names: string[]) =>
  names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;

/** How a turn that has waited a while on someone asks them to come back. */
export function waitingBody(h: Holdout): string {
  const who = listed(h.names);
  const acted = h.othersActed;
  if (h.acted) return `You acted as ${who}. Tap Done so the DM can answer.`;
  if (!acted.length) return `The table is waiting on ${who}.`;
  return `${listed(acted)} ${acted.length === 1 ? 'has' : 'have'} acted. The table is waiting on ${who}.`;
}

/**
 * A turn has waited PUSH_WAITING_MINUTES on these people. Each hears about
 * it once per turn (the room makes sure of that), unless they are looking.
 * Never throws.
 */
export async function notifyWaiting(
  campaignId: string,
  holdouts: Holdout[],
  watching: ReadonlySet<string>,
): Promise<void> {
  try {
    if (!holdouts.length) return;
    const wanted = new Set(await audience(campaignId, 'waiting', watching));
    if (!holdouts.some((h) => wanted.has(h.userId))) return;
    const name = await campaignName(campaignId);
    await Promise.all(
      holdouts
        .filter((h) => wanted.has(h.userId))
        .map((h) =>
          send(
            [h.userId],
            {
              title: `${name}: your move`,
              body: waitingBody(h),
              url: `/c/${campaignId}`,
              tag: campaignTag(campaignId),
              category: 'waiting',
            },
            campaignId,
          ),
        ),
    );
  } catch (err) {
    log().warn({ err, campaignId }, 'could not nudge players a turn is waiting on');
  }
}
