import type { DmStatus } from '@tavern/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { kitFiles, slugOf } from '../connector/kit.js';
import { quietMinutes } from '../connector/tools.js';
import { resolveToken, type ConnectorUser } from '../connector/tokens.js';
import { q, q1 } from '../db/pool.js';
import { notFound, parse, unauthorized } from '../errors.js';
import { dmStatusOf, getRoom } from '../realtime/room.js';
import { unansweredCounts, workshopAnswerer } from '../agent/workshop.js';

/**
 * For the DM launcher on the host's own computer (scripts/dm-launcher.mjs):
 * which of their campaigns run by Claude have someone at the table right now,
 * and each one's folder. The launcher starts Claude Code when a table fills
 * and stops it when the table empties, so the host never has to.
 *
 * It also answers the workshop: for an admin's launcher, it lists the game
 * systems whose workshop Claude answers, and whether a message waits there.
 *
 * It runs outside the browser, so it signs in with a hand-made connector
 * token rather than a session. Tokens a Claude client got by signing in are
 * bound to the connector's address and are refused here.
 */

export const SUMMON_PATH = '/api/summon';

export interface SummonCampaign {
  id: string;
  name: string;
  /** The folder the kit unpacks into, under the launcher's own directory. */
  folder: string;
  /** Someone is at the table: Claude should be there. */
  wanted: boolean;
  /** Players connected right now. */
  players: number;
  /**
   * Minutes since anything happened at the table: someone acted or chatted,
   * Claude finished a request, or a player opened the table. Null when nothing
   * has. The launcher lets a run go when this grows long and nothing waits.
   */
  quietMinutes: number | null;
  dm: DmStatus;
}

export interface SummonWorkshop {
  /** The game system. */
  id: string;
  name: string;
  /** Where the launcher runs Claude for it, and what its log is called. */
  folder: string;
  /** Admins' messages waiting for an answer: Claude should be there. */
  waiting: number;
}

/** When each admin's launcher last asked for work, so the app can say Claude is on its way. */
const launcherSeen = new Map<string, number>();
/** A launcher polls every 15 s or so; one heard from in this long is running. */
const LAUNCHER_FRESH_MS = 60_000;

/** An admin's DM launcher is running and will answer the workshop. */
export function workshopLauncherLive(now = Date.now()): boolean {
  for (const at of launcherSeen.values()) if (now - at < LAUNCHER_FRESH_MS) return true;
  return false;
}

/** The workshops an admin's launcher should answer: those Claude answers in the app. */
async function workshopsFor(userId: string): Promise<SummonWorkshop[]> {
  const user = await q1<{ role: string; totp: boolean }>(
    'SELECT role, totp_enabled_at IS NOT NULL AS totp FROM users WHERE id = $1',
    [userId],
  );
  // The workshop tools refuse anyone else, so a run for them would only fail.
  if (user?.role !== 'admin' || (config().ADMIN_REQUIRE_TOTP && !user.totp)) return [];
  launcherSeen.set(userId, Date.now());
  const systems = await q<{
    id: string;
    name: string;
    slug: string;
    created_by: string | null;
    workshop_ai: 'server' | 'claude';
  }>('SELECT id, name, slug, created_by, workshop_ai FROM game_systems ORDER BY name');
  const byClaude = (
    await Promise.all(
      systems.map(async (s) => ((await workshopAnswerer(s, userId)).answeredBy === 'claude' ? s : null)),
    )
  ).filter((s) => s !== null);
  const counts = await unansweredCounts(byClaude.map((s) => s.id));
  return byClaude.map((s) => ({
    id: s.id,
    name: s.name,
    folder: `workshop-${slugOf(s.slug || s.name)}`,
    waiting: counts.get(s.id) ?? 0,
  }));
}

async function tokenUser(req: FastifyRequest): Promise<ConnectorUser> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  const user = await resolveToken(m?.[1], new URL(SUMMON_PATH, config().baseUrl).toString());
  if (!user) throw unauthorized('A connector token is required (You → Claude → Use a token instead).');
  return user;
}

const params = z.object({ id: z.string().uuid() });

export async function summonRoutes(app: FastifyInstance): Promise<void> {
  app.get(SUMMON_PATH, async (req) => {
    const user = await tokenUser(req);
    const rows = await q<{ id: string; name: string }>(
      `SELECT id, name FROM campaigns
        WHERE owner_id = $1 AND status = 'active' AND settings->>'dm' = 'claude'
        ORDER BY created_at`,
      [user.userId],
    );
    const campaigns: SummonCampaign[] = await Promise.all(
      rows.map(async (c) => {
        const room = getRoom(c.id);
        const players = room?.present().length ?? 0;
        const arrived = room?.lastArrivalAt
          ? Math.floor((Date.now() - room.lastArrivalAt) / 60_000)
          : Infinity;
        const quiet = Math.min(await quietMinutes(c.id), arrived);
        return {
          id: c.id,
          name: c.name,
          folder: slugOf(c.name),
          wanted: players > 0,
          players,
          quietMinutes: Number.isFinite(quiet) ? quiet : null,
          dm: await dmStatusOf(c.id, 'claude'),
        };
      }),
    );
    return { campaigns, workshops: await workshopsFor(user.userId) };
  });

  /** The campaign folder as plain files: the same kit the app offers as a zip. */
  app.get<{ Params: { id: string } }>(`${SUMMON_PATH}/:id/kit`, async (req) => {
    const user = await tokenUser(req);
    const { id } = parse(params, req.params);
    const row = await q1<{ name: string }>(
      `SELECT name FROM campaigns WHERE id = $1 AND owner_id = $2 AND settings->>'dm' = 'claude'`,
      [id, user.userId],
    );
    if (!row) throw notFound('Campaign not found');
    const folder = slugOf(row.name);
    return {
      folder,
      files: kitFiles({ id, name: row.name }, config().baseUrl.origin).map((f) => ({
        path: f.path.slice(folder.length + 1),
        text: f.data.toString('utf8'),
      })),
    };
  });
}
