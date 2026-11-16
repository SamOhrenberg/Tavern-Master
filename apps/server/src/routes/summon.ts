import type { DmStatus } from '@tavern/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { kitFiles, slugOf } from '../connector/kit.js';
import { resolveToken, type ConnectorUser } from '../connector/tokens.js';
import { q, q1 } from '../db/pool.js';
import { notFound, parse, unauthorized } from '../errors.js';
import { dmStatusOf, getRoom } from '../realtime/room.js';

/**
 * For the DM launcher on the host's own computer (scripts/dm-launcher.mjs):
 * which of their campaigns run by Claude have someone at the table right now,
 * and each one's folder. The launcher starts Claude Code when a table fills
 * and stops it when the table empties, so the host never has to.
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
  dm: DmStatus;
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
        const players = getRoom(c.id)?.present().length ?? 0;
        return {
          id: c.id,
          name: c.name,
          folder: slugOf(c.name),
          wanted: players > 0,
          players,
          dm: await dmStatusOf(c.id, 'claude'),
        };
      }),
    );
    return { campaigns };
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
