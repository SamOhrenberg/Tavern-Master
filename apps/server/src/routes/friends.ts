import type { Friend } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, q1 } from '../db/pool.js';
import { badRequest, conflict, notFound, parse } from '../errors.js';
import { enforceLimit, rateLimiters, requireUser } from '../http/security.js';
import { notifyUser } from '../notify/notify.js';

const requestSchema = z.object({ username: z.string().trim().min(1).max(64) });

const PAIR = `least(requester_id, addressee_id) = least($1::uuid, $2::uuid)
          AND greatest(requester_id, addressee_id) = greatest($1::uuid, $2::uuid)`;

/** Are these two users accepted friends? */
export async function areFriends(a: string, b: string): Promise<boolean> {
  return !!(await q1(`SELECT 1 FROM friendships WHERE status = 'accepted' AND ${PAIR}`, [a, b]));
}

export async function friendRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/friends', async (req) => {
    const auth = requireUser(req);
    const rows = await q<{
      id: string;
      status: 'pending' | 'accepted';
      requester_id: string;
      uid: string;
      username: string;
      display_name: string;
    }>(
      `SELECT f.id, f.status, f.requester_id, u.id AS uid, u.username, u.display_name
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
        WHERE f.requester_id = $1 OR f.addressee_id = $1
        ORDER BY f.status DESC, u.display_name`,
      [auth.user.id],
    );
    const friends: Friend[] = rows.map((r) => ({
      friendshipId: r.id,
      status: r.status,
      direction: r.requester_id === auth.user.id ? 'outgoing' : 'incoming',
      user: { id: r.uid, username: r.username, displayName: r.display_name },
    }));
    return { friends };
  });

  app.post('/api/friends', async (req) => {
    const auth = requireUser(req);
    // Requests are addressed by exact username, so cap them to stop enumeration.
    enforceLimit(rateLimiters().auth, `friend:${auth.user.id}`);
    const { username } = parse(requestSchema, req.body);
    const target = await q1<{ id: string }>(
      `SELECT id FROM users WHERE username = $1 AND status = 'active'`,
      [username.toLowerCase()],
    );
    if (!target) throw notFound('No player with that username.');
    if (target.id === auth.user.id) throw badRequest('That is you.');
    const existing = await q1<{ id: string; status: string; requester_id: string }>(
      `SELECT id, status, requester_id FROM friendships WHERE ${PAIR}`,
      [auth.user.id, target.id],
    );
    if (existing) {
      if (existing.status === 'accepted') throw conflict('You are already friends.');
      if (existing.requester_id === auth.user.id) throw conflict('Request already sent.');
      // They asked first: sending a request back accepts theirs.
      await q(`UPDATE friendships SET status = 'accepted', responded_at = now() WHERE id = $1`, [
        existing.id,
      ]);
      return { ok: true, accepted: true };
    }
    await q('INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2)', [
      auth.user.id,
      target.id,
    ]);
    void notifyUser(target.id, {
      title: 'Friend request',
      body: `${auth.user.displayName} wants to be friends.`,
      url: '/friends',
      tag: `friend:${auth.user.id}`,
    });
    return { ok: true, accepted: false };
  });

  app.post<{ Params: { id: string } }>('/api/friends/:id/accept', async (req) => {
    const auth = requireUser(req);
    const id = parse(z.string().uuid(), req.params.id);
    const rows = await q(
      `UPDATE friendships SET status = 'accepted', responded_at = now()
        WHERE id = $1 AND addressee_id = $2 AND status = 'pending' RETURNING id`,
      [id, auth.user.id],
    );
    if (!rows.length) throw notFound();
    return { ok: true };
  });

  // Decline, cancel or unfriend: either side may delete the row.
  app.delete<{ Params: { id: string } }>('/api/friends/:id', async (req) => {
    const auth = requireUser(req);
    const id = parse(z.string().uuid(), req.params.id);
    const rows = await q(
      'DELETE FROM friendships WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2) RETURNING id',
      [id, auth.user.id],
    );
    if (!rows.length) throw notFound();
    return { ok: true };
  });
}
