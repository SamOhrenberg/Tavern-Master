import type { RulesEvent } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { answerDesk, deskBusy, loadDesk, sayAtDesk } from '../agent/rules-desk.js';
import { isHomebrew, retireRuling } from '../agent/rulings.js';
import { dmMode } from '../connector/mode.js';
import { queueWork } from '../connector/work.js';
import { conflict, HttpError, notFound, parse } from '../errors.js';
import { requireMember } from '../http/membership.js';
import { enforceLimit, rateLimiters } from '../http/security.js';
import { log } from '../log.js';
import { getRoom } from '../realtime/room.js';

type Params = { id: string };
const uuid = z.string().uuid();

async function requireHomebrew(campaignId: string): Promise<void> {
  if (!(await isHomebrew(campaignId)))
    throw conflict('This campaign’s system is not homebrew, so it has no rules desk.', 'not_homebrew');
}

/** Tell everyone at the table the desk changed, so open desks fetch it again. */
const deskChanged = (campaignId: string) => getRoom(campaignId)?.broadcast({ type: 'rules' });

/**
 * The rules desk, for campaigns on a homebrew system: a chat shared by the
 * whole table where players talk rules over with the GM, and the rulings
 * they settle on.
 */
export async function rulesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: Params }>('/api/campaigns/:id/rules', async (req) => {
    const { campaignId } = await requireMember(req);
    await requireHomebrew(campaignId);
    return { desk: await loadDesk(campaignId) };
  });

  /**
   * Say something at the desk. With the built-in GM the answer is worked out
   * here and the response streams `RulesEvent`s: a line for each tool, then
   * the stored answer. In a Claude campaign, or while the GM is still
   * answering someone else, the message is stored, the stream says `queued`,
   * and the answer reaches everyone through the table's connection.
   */
  app.post<{ Params: Params }>('/api/campaigns/:id/rules/messages', async (req, reply) => {
    const { auth, campaignId } = await requireMember(req);
    await requireHomebrew(campaignId);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(2000) }), req.body);
    const claude = (await dmMode(campaignId)) === 'claude';
    // Checked before storing, so a refused message is not left unanswered at the desk.
    if (!claude) enforceLimit(rateLimiters().llm, `user:${auth.user.id}`);

    await sayAtDesk(campaignId, auth.user.id, text);
    deskChanged(campaignId);

    const queued = () => {
      reply.header('content-type', 'application/x-ndjson; charset=utf-8').header('cache-control', 'no-store');
      return `${JSON.stringify({ type: 'queued' } satisfies RulesEvent)}\n`;
    };
    if (claude) {
      await queueWork({ campaignId, kind: 'rules', subjectId: campaignId, requestedBy: auth.user.id });
      return queued();
    }
    // The answer already being written picks this message up when it is done.
    if (deskBusy(campaignId)) return queued();

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    const send = (ev: RulesEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
    };
    try {
      // Not tied to this request: the rest of the table is waiting on the answer too.
      await answerDesk(campaignId, {
        signal: AbortSignal.timeout(240_000),
        onTool: (tool, summary) => send({ type: 'tool', tool, summary }),
        onAnswer: (message, out) => {
          send({ type: 'done', message });
          deskChanged(campaignId);
          if (out.stateChanged) getRoom(campaignId)?.broadcast({ type: 'state_changed' });
        },
      });
    } catch (err) {
      if (!(err instanceof HttpError)) log().error({ err, campaignId }, 'rules desk answer failed');
      send({
        type: 'error',
        message: err instanceof HttpError ? err.message : 'The GM could not answer just now. Try again.',
      });
    } finally {
      res.end();
    }
  });

  /** The owner takes a ruling out of force by hand. */
  app.delete<{ Params: Params & { rulingId: string } }>(
    '/api/campaigns/:id/rulings/:rulingId',
    async (req) => {
      const { auth, campaignId } = await requireMember(req, true);
      const rulingId = parse(uuid, req.params.rulingId);
      const done = await retireRuling(campaignId, rulingId, auth.user.id);
      if (!done) throw notFound('That ruling is not in force.');
      await audit('ruling.retired', {
        actorId: auth.user.id,
        targetType: 'campaign',
        targetId: campaignId,
        ip: req.ip,
        meta: { rulingId },
      });
      deskChanged(campaignId);
      return { ok: true };
    },
  );
}
