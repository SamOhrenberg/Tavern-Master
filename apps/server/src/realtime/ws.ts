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
  z.object({ type: z.literal('action'), text, characterId: z.string().uuid().optional() }),
  z.object({ type: z.literal('ooc'), text }),
  // Players roll only what the DM asked for; the server knows the dice.
  z.object({ type: z.literal('roll'), requestId: z.string().uuid() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('pass') }),
  z.object({ type: z.literal('force') }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('visible'), visible: z.boolean() }),
]);

/**
 * Is this session still valid and its user still a member of the campaign?
 * Asked again for every message, so revoking a session or removing a member
 * takes effect on an already-open socket.
 */
async function membership(
  campaignId: string,
  sessionId: string,
): Promise<{ role: 'owner' | 'player'; phase: 'prep' | 'active' } | undefined> {
  return q1<{ role: 'owner' | 'player'; phase: 'prep' | 'active' }>(
    `SELECT m.role, c.phase
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN campaign_members m ON m.user_id = s.user_id AND m.campaign_id = $1
       JOIN campaigns c ON c.id = m.campaign_id AND c.status = 'active'
      WHERE s.id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [campaignId, sessionId],
  );
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
      // The app says in the URL whether it opened this socket on screen, so a
      // background reconnect never counts as someone looking at the table.
      const { visible } = (req.query ?? {}) as { visible?: string };
      void room.join(socket, user, visible !== '0');
      // A campaign that has just begun gets its opening scene as soon as someone is there to read it.
      void room.maybeOpen();

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
          // Anything from the app means it is still alive; push notifications skip whoever is watching.
          room.heard(socket, msg.type === 'visible' ? msg.visible : undefined);
          if (msg.type === 'visible') return;
          if (msg.type === 'ping') return send({ type: 'pong' });

          const member = await membership(room.campaignId, auth.sessionId);
          if (!member) return socket.close(4403, 'access removed');
          const { role } = member;
          // The lobby has table talk, but the story has not begun.
          if (member.phase === 'prep' && msg.type !== 'ooc') {
            return send({
              type: 'error',
              code: 'not_started',
              message: 'The campaign has not started yet.',
            });
          }

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
            await room.action(user, msg.text, msg.characterId);
          } else if (msg.type === 'ooc') {
            if (!rateLimiters().api.take(`chat:${user.id}`, 5).ok) {
              return send({
                type: 'error',
                code: 'rate_limited',
                message: 'You are sending messages too quickly.',
              });
            }
            await room.ooc(user, msg.text);
          } else if (msg.type === 'roll') {
            // A cheap action, but still rate-limited so the button cannot be spammed.
            if (!rateLimiters().api.take(`roll:${user.id}`, 3).ok) {
              return send({
                type: 'error',
                code: 'rate_limited',
                message: 'You are rolling too quickly.',
              });
            }
            await room.roll(user, msg.requestId);
          } else if (msg.type === 'done') {
            room.done(user);
          } else if (msg.type === 'pass') {
            // Passing writes a line into the turn and can open one, so it counts as an action.
            const limit = rateLimiters().llm.take(`user:${user.id}`);
            if (!limit.ok) {
              return send({
                type: 'error',
                code: 'rate_limited',
                message: `Slow down a little. Try again in ${limit.retryAfter}s.`,
              });
            }
            await room.pass(user);
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
