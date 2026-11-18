import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext } from '../auth/sessions.js';
import { q1 } from '../db/pool.js';
import { forbidden, notFound, parse } from '../errors.js';
import type { Viewer } from '../party.js';
import { requireUser } from './security.js';

const uuid = z.string().uuid();

export interface Membership {
  auth: AuthContext;
  role: 'owner' | 'player';
  campaignId: string;
  /** The same person, in the shape the party rules take. */
  viewer: Viewer;
  /**
   * Whoever made the campaign: the host. A campaign can have several owners,
   * but the host's AI and Claude run the table, so a few things stay theirs.
   */
  hostId: string;
  /** The person asking is the host. */
  host: boolean;
}

/**
 * Every campaign route goes through this: no membership, no data (and no hint
 * the campaign exists). `need` narrows it to the campaign's owners (the host
 * and anyone the host made an owner), or to the host alone.
 */
export async function requireMember(
  req: FastifyRequest<{ Params: { id: string } }>,
  need: boolean | 'owner' | 'host' = false,
): Promise<Membership> {
  const auth = requireUser(req);
  const campaignId = parse(uuid, req.params.id);
  const row = await q1<{ role: 'owner' | 'player'; owner_id: string }>(
    `SELECT m.role, c.owner_id FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id
      WHERE m.campaign_id = $1 AND m.user_id = $2`,
    [campaignId, auth.user.id],
  );
  if (!row) throw notFound('Campaign not found');
  const host = row.owner_id === auth.user.id;
  if ((need === true || need === 'owner') && row.role !== 'owner')
    throw forbidden('Only the campaign’s owners can do that.');
  if (need === 'host' && !host) throw forbidden('Only the host, who made this campaign, can do that.');
  return {
    auth,
    role: row.role,
    campaignId,
    viewer: { userId: auth.user.id, role: row.role },
    hostId: row.owner_id,
    host,
  };
}
