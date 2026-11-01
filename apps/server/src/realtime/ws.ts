import type { ServerMessage } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveSession, SESSION_COOKIE } from '../auth/sessions.js';
import { q1 } from '../db/pool.js';
import { originAllowed, rateLimiters } from '../http/security.js';
import { log } from '../log.js';
import { closeRoomIfEmpty, openRoom } from './room.js';

const text = z.string().trim().min(1).max(2000);
const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('action'), text }),
  z.object({ type: z.literal('ooc'), text }),
  z.object({ type: z.literal('pass') }),
  z.object({ type: z.literal('force') }),
  z.object({ type: z.literal('ping') }),
]);

/**
 * Is this session still valid and its user still a member of the campaign?
 * Asked again for every message, so revoking a session or removing a member
 * takes effect on an already-open socket.
 */
async function membership(campaignId: string, sessionId: string): Promise<'owner' | 'player' | undefined> {
  const row = await q1<{ role: 'owner' | 'player' }>(
    `SELECT m.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN campaign_members m ON m.user_id = s.user_id AND m.campaign_id = $1
       JOIN campaigns c ON c.id = m.campaign_id AND c.status = 'active'
      WHERE s.id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [campaignId, sessionId],
  );
  return row?.role;
}

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/ws/campaigns/:id', { websocket: true }, async (socket, req) => {
    const send = (msg: ServerMessage) => socket.send(JSON.stringify(msg));
    try {
      // Browsers attach cookies to cross-site websocket handshakes, so the
      // origin is checked here just as it is for unsafe HTTP requests.
      if (!originAllowed(req.headers.origin, req.host)) return socket.close(4403, 'bad origin');
      const campaignId = z.string().uuid().safeParse(req.params.id);
      const auth = await resolveSession(req.cookies[SESSION_COOKIE]);
      if (!auth) return socket.close(4401, 'sign in required');
      if (!campaignId.success || !(await membership(campaignId.data, auth.sessionId))) {
        return socket.close(4403, 'not a member of this campaign');
      }

      const user = { id: auth.user.id, username: auth.user.username, displayName: auth.user.displayName };
      const room = await openRoom(campaignId.data);
      room.join(socket, user);

      socket.on('close', () => {
        room.leave(socket);
        closeRoomIfEmpty(room.campaignId);
      });

      socket.on('message', (raw) => {
        void (async () => {
          let parsed;
          try {
            parsed = clientMessage.safeParse(JSON.parse(String(raw)));
          } catch {
            return send({ type: 'error', code: 'bad_message', message: 'Message was not valid JSON.' });
          }
          if (!parsed.success)
            return send({ type: 'error', code: 'bad_message', message: 'Message was not understood.' });
          const msg = parsed.data;
          if (msg.type === 'ping') return send({ type: 'pong' });

          const role = await membership(room.campaignId, auth.sessionId);
          if (!role) return socket.close(4403, 'access removed');

          if (msg.type === 'action') {
            // Each action can cost a model call, so it has its own tighter limit.
            const limit = rateLimiters().llm.take(`user:${user.id}`);
            if (!limit.ok) {
              return send({
                type: 'error',
                code: 'rate_limited',
                message: `Slow down a little. Try again in ${limit.retryAfter}s.`,
              });
            }
            await room.action(user, msg.text);
          } else if (msg.type === 'ooc') {
            if (!rateLimiters().api.take(`chat:${user.id}`, 5).ok) {
              return send({
                type: 'error',
                code: 'rate_limited',
                message: 'You are sending messages too quickly.',
              });
            }
            await room.ooc(user, msg.text);
          } else if (msg.type === 'pass') {
            room.pass(user);
          } else if (msg.type === 'force') {
            if (role !== 'owner')
              return send({
                type: 'error',
                code: 'forbidden',
                message: 'Only the campaign owner can do that.',
              });
            room.force();
          }
        })().catch((err) => {
          log().error({ err }, 'websocket message failed');
          send({ type: 'error', code: 'internal', message: 'Something went wrong.' });
        });
      });
    } catch (err) {
      log().error({ err }, 'websocket setup failed');
      socket.close(1011, 'error');
    }
  });
}
