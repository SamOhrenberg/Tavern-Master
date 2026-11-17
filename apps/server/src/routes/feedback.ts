import type { FeedbackList } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { q, q1, tx } from '../db/pool.js';
import { badRequest, notFound, parse } from '../errors.js';
import { feedbackTarget } from '../feedback/github.js';
import { isPublicRepo, listFeedback, scrubPath, sendFeedback } from '../feedback/feedback.js';
import { enforceLimit, requireUser } from '../http/security.js';
import { sniffImage } from '../rules/parse.js';
import { RateLimiter } from '../security/ratelimit.js';
import { ensureDataDirs, newStorageName, uploadPath, uploadsDir } from '../storage.js';

/** Largest image accepted, after the app has shrunk it. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 2;

const submitSchema = z.object({
  kind: z.enum(['bug', 'idea', 'feedback']),
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().max(5000).default(''),
  context: z
    .object({
      path: z.string().max(500).optional(),
      viewport: z
        .string()
        .regex(/^\d{2,5}×\d{2,5}( @[\d.]{1,4}x)?$/)
        .optional(),
      standalone: z.boolean().optional(),
      version: z.string().max(40).optional(),
    })
    .default({}),
  images: z
    .array(
      z.object({
        source: z.enum(['screenshot', 'photo']),
        // base64, without a data: prefix
        data: z.string().max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8),
      }),
    )
    .max(MAX_IMAGES)
    .default([]),
});

let submitLimiter: RateLimiter | undefined;
/** A handful an hour is plenty for a person, and stops a script filling the tracker. */
const limiter = () => (submitLimiter ??= new RateLimiter(10, 60 * 60_000));
export function resetFeedbackLimiterForTests(): void {
  submitLimiter = undefined;
}

function target() {
  const t = feedbackTarget();
  if (!t) throw notFound('Feedback is not set up on this server.');
  return t;
}

export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/feedback', { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const auth = requireUser(req);
    const t = target();
    const body = parse(submitSchema, req.body);
    enforceLimit(limiter(), `feedback:${auth.user.id}`);

    // Decode and check every image before anything is stored.
    const images = body.images.map((img, i) => {
      const buf = Buffer.from(img.data, 'base64');
      const mime = sniffImage(buf.subarray(0, 16));
      if (!mime) throw badRequest(`Attachment ${i + 1} is not a PNG, JPEG or WebP image.`);
      if (buf.length > MAX_IMAGE_BYTES) throw badRequest(`Attachment ${i + 1} is too large.`);
      return { source: img.source, buf, mime, name: newStorageName() };
    });
    await ensureDataDirs(uploadsDir());
    for (const img of images) await writeFile(uploadPath(img.name), img.buf);

    const context = {
      ...(body.context.path ? { path: scrubPath(body.context.path) } : {}),
      ...(body.context.viewport ? { viewport: body.context.viewport } : {}),
      ...(body.context.standalone !== undefined ? { standalone: body.context.standalone } : {}),
      ...(body.context.version ? { version: body.context.version } : {}),
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
    };
    let id: string;
    try {
      id = await tx(async (c) => {
        const row = await q1<{ id: string }>(
          `INSERT INTO feedback (user_id, kind, title, body, context) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [auth.user.id, body.kind, body.title, body.body, JSON.stringify(context)],
          c,
        );
        for (const [i, img] of images.entries()) {
          await q(
            `INSERT INTO feedback_images (feedback_id, n, source, storage_name, mime, bytes) VALUES ($1, $2, $3, $4, $5, $6)`,
            [row!.id, i + 1, img.source, img.name, img.mime, img.buf.length],
            c,
          );
        }
        return row!.id;
      });
    } catch (err) {
      for (const img of images) await rm(uploadPath(img.name), { force: true });
      throw err;
    }
    // Saved either way; if GitHub is not answering it is tried again when the list is next opened.
    const issue = await sendFeedback(t, id);
    return { id, issueNumber: issue?.number ?? null, issueUrl: issue?.url ?? null };
  });

  app.get('/api/feedback', async (req): Promise<FeedbackList> => {
    const auth = requireUser(req);
    const t = target();
    const [items, publicRepo] = await Promise.all([listFeedback(t, auth.user.id), isPublicRepo(t)]);
    return { items, repo: t.repo, publicRepo };
  });

  // An attachment: for whoever sent it, and for admins, who reach it from the issue's link.
  app.get<{ Params: { id: string; n: string } }>('/api/feedback/:id/images/:n', async (req, reply) => {
    const auth = requireUser(req);
    const id = parse(z.string().uuid(), req.params.id);
    const n = parse(z.coerce.number().int().min(1).max(MAX_IMAGES), req.params.n);
    const img = await q1<{ storage_name: string; mime: string; user_id: string }>(
      `SELECT i.storage_name, i.mime, f.user_id FROM feedback_images i JOIN feedback f ON f.id = i.feedback_id
        WHERE i.feedback_id = $1 AND i.n = $2`,
      [id, n],
    );
    if (!img || (img.user_id !== auth.user.id && auth.user.role !== 'admin')) throw notFound();
    const data = await readFile(uploadPath(img.storage_name)).catch(() => null);
    if (!data) throw notFound();
    return reply
      .header('content-type', img.mime)
      .header('cache-control', 'private, max-age=3600')
      .header('content-disposition', 'inline')
      .send(data);
  });
}
