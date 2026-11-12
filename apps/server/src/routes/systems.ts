import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GameSystem, RuleDocument } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { q, q1, tx } from '../db/pool.js';
import { badRequest, conflict, HttpError, notFound, parse } from '../errors.js';
import { enforceLimit, rateLimiters, requireAdmin, requireUser } from '../http/security.js';
import { enqueue, hasPending } from '../jobs/queue.js';
import { editLoreSchema } from '../rules/lore.js';
import { sniffFile } from '../rules/parse.js';
import { searchRules } from '../rules/retrieve.js';
import { ensureDataDirs, newStorageName, uploadPath, uploadsDir } from '../storage.js';

const uuid = z.string().uuid();
const systemSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(600).default(''),
  abilities: z.array(z.string().trim().min(1).max(30)).max(12).default([]),
  fields: z
    .array(
      z.object({
        key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,30}$/),
        label: z.string().trim().min(1).max(40),
      }),
    )
    .max(24)
    .optional(),
});

const DEFAULT_FIELDS = [
  { key: 'role', label: 'Class / role' },
  { key: 'level', label: 'Level' },
  { key: 'background', label: 'Background' },
  { key: 'skills', label: 'Skills' },
  { key: 'features', label: 'Abilities & features' },
];

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'system';

interface DocRow {
  id: string;
  system_id: string;
  title: string;
  original_name: string;
  mime: string;
  size_bytes: number;
  status: RuleDocument['status'];
  error: string | null;
  page_count: number | null;
  chunk_count: number;
  created_at: Date;
  kind: string | null;
}
const toDoc = (r: DocRow): RuleDocument => ({
  id: r.id,
  systemId: r.system_id,
  title: r.title,
  originalName: r.original_name,
  mime: r.mime,
  sizeBytes: r.size_bytes,
  status: r.status,
  error: r.error,
  pageCount: r.page_count,
  chunkCount: r.chunk_count,
  createdAt: r.created_at.toISOString(),
  // Library documents are rules unless marked as setting/flavour.
  kind: r.kind === 'setting' ? 'setting' : 'rules',
});
const DOC_COLS =
  'id, system_id, title, original_name, mime, size_bytes, status, error, page_count, chunk_count, created_at, kind';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/systems', async (req) => {
    requireUser(req);
    const rows = await q(
      `SELECT s.id, s.slug, s.name, s.description, s.sheet_template, s.lore, s.lore_status,
              (SELECT count(*)::int FROM documents d WHERE d.system_id = s.id AND d.campaign_id IS NULL) AS docs,
              (SELECT count(*)::int FROM documents d
                 WHERE d.system_id = s.id AND d.campaign_id IS NULL AND d.kind = 'setting') AS setting_docs,
              (SELECT count(*)::int FROM chunks c WHERE c.system_id = s.id AND c.campaign_id IS NULL) AS chunks
         FROM game_systems s ORDER BY s.name`,
    );
    const systems: GameSystem[] = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      sheetTemplate: r.sheet_template,
      documentCount: r.docs,
      chunkCount: r.chunks,
      settingDocumentCount: r.setting_docs,
      loreStatus: r.lore_status,
      lore: r.lore ?? null,
    }));
    return { systems };
  });

  app.post('/api/systems', async (req) => {
    const auth = requireAdmin(req);
    const body = parse(systemSchema, req.body);
    const base = slugify(body.name);
    const template = { abilities: body.abilities, fields: body.fields ?? DEFAULT_FIELDS };
    for (let n = 0; n < 20; n++) {
      const row = await q1<{ id: string }>(
        `INSERT INTO game_systems (slug, name, description, sheet_template, created_by)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slug) DO NOTHING RETURNING id`,
        [n ? `${base}-${n + 1}` : base, body.name, body.description, JSON.stringify(template), auth.user.id],
      );
      if (row) {
        await audit('system.created', {
          actorId: auth.user.id,
          targetType: 'system',
          targetId: row.id,
          ip: req.ip,
        });
        return { id: row.id };
      }
    }
    throw conflict('A system with that name already exists.');
  });

  app.delete<{ Params: { id: string } }>('/api/systems/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = parse(uuid, req.params.id);
    if (await q1('SELECT 1 FROM campaigns WHERE system_id = $1 LIMIT 1', [id])) {
      throw conflict('Campaigns still use this system. Archive or delete them first.');
    }
    const files = await q<{ storage_name: string }>(
      'SELECT storage_name FROM documents WHERE system_id = $1',
      [id],
    );
    const rows = await q('DELETE FROM game_systems WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) throw notFound();
    for (const f of files) await rm(uploadPath(f.storage_name), { force: true });
    await audit('system.deleted', { actorId: auth.user.id, targetType: 'system', targetId: id, ip: req.ip });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/systems/:id/documents', async (req) => {
    requireUser(req);
    const id = parse(uuid, req.params.id);
    const rows = await q<DocRow>(
      // The library lists rulebooks only. A campaign's own documents stay with that campaign.
      `SELECT ${DOC_COLS} FROM documents WHERE system_id = $1 AND campaign_id IS NULL ORDER BY created_at`,
      [id],
    );
    return { documents: rows.map(toDoc) };
  });

  /** Try the retrieval the DM uses. Handy for checking an upload worked. */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/systems/:id/search', async (req) => {
    const auth = requireUser(req);
    enforceLimit(rateLimiters().llm, `search:${auth.user.id}`);
    const id = parse(uuid, req.params.id);
    const query = parse(z.string().trim().min(2).max(300), req.query.q);
    return { hits: await searchRules(id, query, 5) };
  });

  /**
   * Correct the distilled setting voice by hand. The DM reads this block as
   * flavour (never rules), so a human can fix what the reader misheard. The
   * edit is clamped like the reader's own output and marks the lore ready.
   * Note: re-uploading or re-tagging setting material re-runs distillation,
   * which overwrites manual edits.
   */
  app.put<{ Params: { id: string } }>('/api/systems/:id/lore', async (req) => {
    const auth = requireAdmin(req);
    const id = parse(uuid, req.params.id);
    const lore = parse(editLoreSchema, req.body);
    const row = await q1<{ id: string }>(
      `UPDATE game_systems
          SET lore = $2, lore_status = 'ready', lore_error = NULL, lore_at = now()
        WHERE id = $1 RETURNING id`,
      [id, JSON.stringify(lore)],
    );
    if (!row) throw notFound();
    await audit('system.lore_edited', {
      actorId: auth.user.id,
      targetType: 'system',
      targetId: id,
      ip: req.ip,
    });
    return { lore };
  });

  app.post<{ Params: { id: string } }>('/api/systems/:id/documents', async (req) => {
    const auth = requireAdmin(req);
    const systemId = parse(uuid, req.params.id);
    if (!(await q1('SELECT 1 FROM game_systems WHERE id = $1', [systemId]))) throw notFound();
    if (!req.isMultipart()) throw badRequest('Send the file as multipart/form-data.');

    const part = await req.file();
    if (!part) throw badRequest('No file was uploaded.');
    const originalName = part.filename.replace(/[^\w .()-]/g, '_').slice(-120) || 'document';
    const titleField = part.fields.title;
    const rawTitle = titleField && 'value' in titleField ? String(titleField.value) : '';
    const title = rawTitle.trim().slice(0, 120) || originalName.replace(/\.[^.]+$/, '');
    // A library document is rules by default; setting/flavour material is opt-in.
    const kindField = part.fields.kind;
    const docKind = (kindField && 'value' in kindField ? String(kindField.value) : '') === 'setting'
      ? 'setting'
      : null;

    // Stored outside the web root under a random name; the client's file name
    // is kept only as a label.
    const storageName = newStorageName();
    const path = uploadPath(storageName);
    await ensureDataDirs(uploadsDir());
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(part.file, meter, createWriteStream(path, { mode: 0o600 }));
      if (part.file.truncated) {
        throw new HttpError(413, 'too_large', `File is larger than the ${config().MAX_UPLOAD_MB} MB limit.`);
      }
      if (size === 0) throw badRequest('The file is empty.');
      const kind = await sniffFile(path, originalName);
      if (!kind)
        throw badRequest(
          'Only PDF, Markdown (.md) and plain-text (.txt) files are accepted.',
          'bad_file_type',
        );
      const mime =
        kind === 'pdf' ? 'application/pdf' : /\.txt$/i.test(originalName) ? 'text/plain' : 'text/markdown';

      const doc = await tx(async (client) => {
        const row = await q1<DocRow>(
          `INSERT INTO documents (system_id, title, original_name, storage_name, mime, size_bytes, sha256, uploaded_by, kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${DOC_COLS}`,
          [systemId, title, originalName, storageName, mime, size, hash.digest('hex'), auth.user.id, docKind],
          client,
        );
        await enqueue('ingest_document', { documentId: row!.id }, {}, client);
        return row!;
      });
      await audit('document.uploaded', {
        actorId: auth.user.id,
        targetType: 'document',
        targetId: doc.id,
        ip: req.ip,
        meta: { name: originalName, size },
      });
      return { document: toDoc(doc) };
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/documents/:id/retry', async (req) => {
    requireAdmin(req);
    const id = parse(uuid, req.params.id);
    const rows = await q(
      `UPDATE documents SET status = 'queued', error = NULL
        WHERE id = $1 AND status = 'failed' AND campaign_id IS NULL RETURNING id`,
      [id],
    );
    if (!rows.length) throw notFound();
    await enqueue('ingest_document', { documentId: id });
    return { ok: true };
  });

  /** Mark a library document as rules or setting/flavour, and refresh the system's lore. */
  app.patch<{ Params: { id: string } }>('/api/documents/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = parse(uuid, req.params.id);
    const kind = parse(z.enum(['rules', 'setting']), (req.body as { kind?: unknown })?.kind);
    const row = await q1<DocRow>(
      `UPDATE documents SET kind = $2 WHERE id = $1 AND campaign_id IS NULL RETURNING ${DOC_COLS}`,
      [id, kind === 'setting' ? 'setting' : null],
    );
    if (!row) throw notFound();
    // The system's setting corpus changed, so its distilled voice is now stale.
    if (!(await hasPending('distil_lore', 'systemId', row.system_id))) {
      await enqueue('distil_lore', { systemId: row.system_id });
      await q(`UPDATE game_systems SET lore_status = 'queued' WHERE id = $1 AND lore_status <> 'reading'`, [
        row.system_id,
      ]);
    }
    await audit('document.updated', {
      actorId: auth.user.id,
      targetType: 'document',
      targetId: id,
      ip: req.ip,
      meta: { kind },
    });
    return { document: toDoc(row) };
  });

  app.delete<{ Params: { id: string } }>('/api/documents/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = parse(uuid, req.params.id);
    const row = await q1<{ storage_name: string; kind: string | null; system_id: string }>(
      'DELETE FROM documents WHERE id = $1 AND campaign_id IS NULL RETURNING storage_name, kind, system_id',
      [id],
    );
    if (!row) throw notFound();
    await rm(uploadPath(row.storage_name), { force: true });
    // Removing setting material leaves the system's distilled voice stale.
    if (row.kind === 'setting' && !(await hasPending('distil_lore', 'systemId', row.system_id))) {
      await enqueue('distil_lore', { systemId: row.system_id });
      await q(`UPDATE game_systems SET lore_status = 'queued' WHERE id = $1 AND lore_status <> 'reading'`, [
        row.system_id,
      ]);
    }
    await audit('document.deleted', {
      actorId: auth.user.id,
      targetType: 'document',
      targetId: id,
      ip: req.ip,
    });
    return { ok: true };
  });
}
