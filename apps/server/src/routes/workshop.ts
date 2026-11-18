import type { GmGuide, GuideTopicId, Workshop, WorkshopEvent } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  postQuestion,
  unanswered,
  workshopAnswerer as answererOf,
  workshopBusy,
  workshopMessages,
  workshopTurn,
} from '../agent/workshop.js';
import { audit } from '../audit.js';
import { q, q1 } from '../db/pool.js';
import { badRequest, conflict, HttpError, notFound, parse } from '../errors.js';
import { GUIDE_LIMITS, loadGuide, saveGuide, TOPIC_IDS, withoutRuling, withTopic } from '../gm-guide.js';
import { enforceLimit, rateLimiters, requireAdmin } from '../http/security.js';
import { log } from '../log.js';

const uuid = z.string().uuid();
type Params = { id: string };

interface SystemRow {
  created_by: string | null;
  workshop_ai: 'server' | 'claude';
}

async function systemOrNotFound(id: string): Promise<SystemRow> {
  const row = await q1<SystemRow>('SELECT created_by, workshop_ai FROM game_systems WHERE id = $1', [id]);
  if (!row) throw notFound();
  return row;
}

/**
 * The workshop, for admins: talk a game system over with the AI, and keep
 * the GM guide it writes. Sheet changes it proposes go to the system's sheet
 * draft and are reviewed there (see systems.ts).
 */
export async function workshopRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: Params }>('/api/systems/:id/workshop', async (req): Promise<{ workshop: Workshop }> => {
    const auth = requireAdmin(req);
    const id = parse(uuid, req.params.id);
    const who = await answererOf(await systemOrNotFound(id), auth.user.id);
    return {
      workshop: {
        messages: await workshopMessages(id),
        guide: await loadGuide(id),
        answering: workshopBusy(id),
        ...who,
        waiting: who.answeredBy === 'claude' && (await unanswered(id)).length > 0,
      },
    };
  });

  /** Choose who answers the workshop in the app: the built-in AI, or Claude through the connector. */
  app.patch<{ Params: Params }>('/api/systems/:id/workshop', async (req) => {
    const auth = requireAdmin(req);
    const id = parse(uuid, req.params.id);
    const { answeredBy } = parse(z.object({ answeredBy: z.enum(['server', 'claude']) }), req.body);
    const sys = await systemOrNotFound(id);
    if (answeredBy === 'server' && !(await answererOf(sys, auth.user.id)).builtIn)
      throw badRequest('This server has no built-in AI, so Claude answers the workshop.', 'no_built_in');
    await q('UPDATE game_systems SET workshop_ai = $2 WHERE id = $1', [id, answeredBy]);
    return { ok: true };
  });

  /**
   * Say something in the workshop. The answer streams back as
   * newline-delimited JSON (`WorkshopEvent`s): text as it is written, a line
   * for each thing the AI does, then the stored message.
   */
  app.post<{ Params: Params }>('/api/systems/:id/workshop/messages', async (req, reply) => {
    const auth = requireAdmin(req);
    const id = parse(uuid, req.params.id);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(4000) }), req.body);
    const sys = await systemOrNotFound(id);
    if ((await answererOf(sys, auth.user.id)).answeredBy === 'claude') {
      // Claude answers through the connector: keep the message for it, and say so.
      await postQuestion(id, auth.user.id, text);
      reply.header('content-type', 'application/x-ndjson; charset=utf-8').header('cache-control', 'no-store');
      return `${JSON.stringify({ type: 'queued' } satisfies WorkshopEvent)}\n`;
    }
    if (workshopBusy(id)) throw conflict('The workshop is still answering the last message.');
    enforceLimit(rateLimiters().llm, `user:${auth.user.id}`);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    const send = (ev: WorkshopEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
    };
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    try {
      const out = await workshopTurn({ systemId: id, userId: auth.user.id }, text, {
        signal: AbortSignal.any([gone.signal, AbortSignal.timeout(300_000)]),
        onText: (delta) => send({ type: 'delta', text: delta }),
        onTool: (tool, summary) => send({ type: 'tool', tool, summary }),
      });
      send({ type: 'done', message: out.message });
    } catch (err) {
      if (!(err instanceof HttpError)) log().error({ err, systemId: id }, 'workshop turn failed');
      send({
        type: 'error',
        message:
          err instanceof HttpError ? err.message : 'The workshop could not answer just now. Try again.',
      });
    } finally {
      res.end();
    }
  });

  /** Start the conversation over. The sheet, its draft and the guide stay as they are. */
  app.delete<{ Params: Params }>('/api/systems/:id/workshop', async (req) => {
    requireAdmin(req);
    const id = parse(uuid, req.params.id);
    await systemOrNotFound(id);
    if (workshopBusy(id)) throw conflict('Wait for the answer first.');
    await q('DELETE FROM system_workshop_messages WHERE system_id = $1', [id]);
    return { ok: true };
  });

  /** Write a topic of the GM guide by hand. Empty text takes it out. */
  app.put<{ Params: Params & { topic: string } }>(
    '/api/systems/:id/guide/:topic',
    async (req): Promise<{ guide: GmGuide }> => {
      const auth = requireAdmin(req);
      const id = parse(uuid, req.params.id);
      const topic = parse(z.enum(TOPIC_IDS), req.params.topic) as GuideTopicId;
      const { text } = parse(z.object({ text: z.string().max(GUIDE_LIMITS.topic) }), req.body);
      await systemOrNotFound(id);
      const guide = withTopic(await loadGuide(id), topic, text);
      await saveGuide(id, guide);
      await audit('system.guide_edited', {
        actorId: auth.user.id,
        targetType: 'system',
        targetId: id,
        ip: req.ip,
        meta: { topic },
      });
      return { guide };
    },
  );

  /** Strike a ruling. Every table's GM stops following it from its next turn. */
  app.delete<{ Params: Params & { rulingId: string } }>(
    '/api/systems/:id/guide/rulings/:rulingId',
    async (req): Promise<{ guide: GmGuide }> => {
      const auth = requireAdmin(req);
      const id = parse(uuid, req.params.id);
      const rulingId = parse(z.string().min(1).max(20), req.params.rulingId);
      await systemOrNotFound(id);
      const guide = withoutRuling(await loadGuide(id), rulingId);
      if (!guide) throw notFound('There is no such ruling.');
      await saveGuide(id, guide);
      await audit('system.ruling_retired', {
        actorId: auth.user.id,
        targetType: 'system',
        targetId: id,
        ip: req.ip,
      });
      return { guide };
    },
  );
}
