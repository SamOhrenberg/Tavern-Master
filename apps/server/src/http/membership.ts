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
}

/** Every campaign route goes through this: no membership, no data (and no hint the campaign exists). */
export async function requireMember(
  req: FastifyRequest<{ Params: { id: string } }>,
  ownerOnly = false,
): Promise<Membership> {
  const auth = requireUser(req);
  const campaignId = parse(uuid, req.params.id);
  const row = await q1<{ role: 'owner' | 'player' }>(
    'SELECT role FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
    [campaignId, auth.user.id],
  );
  if (!row) throw notFound('Campaign not found');
  if (ownerOnly && row.role !== 'owner') throw forbidden('Only the campaign owner can do that.');
  return { auth, role: row.role, campaignId, viewer: { userId: auth.user.id, role: row.role } };
}
