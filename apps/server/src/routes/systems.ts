import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GameSystem, RuleDocument, SheetDraftView, SystemOwner } from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { q, q1, tx } from '../db/pool.js';
import { badRequest, conflict, HttpError, notFound, parse } from '../errors.js';
import { enforceLimit, rateLimiters, requireAdmin, requireUser } from '../http/security.js';
import { ownedSystems, requireDocumentEditor, requireSystemEditor } from '../http/system-access.js';
import { enqueue, hasPending } from '../jobs/queue.js';
import { rulesCorpus } from '../agent/sheet-drafter.js';
import { builtInAiFor, instanceAiConfigured } from '../llm/index.js';
import { applyProposals, proposalsFor, suggestRenames } from '../sheet-proposals.js';
import { editLoreSchema } from '../rules/lore.js';
import { sniffFile } from '../rules/parse.js';
import { searchRules } from '../rules/retrieve.js';
import { fromTemplate, parseSchema, toSchema } from '../sheet-schema.js';
import { checkRenames, publishSheet } from '../sheet-versions.js';
import { ensureDataDirs, newStorageName, uploadPath, uploadsDir } from '../storage.js';

const uuid = z.string().uuid();
const renamesInput = z
  .array(z.object({ from: z.string().trim().min(1).max(60), to: z.string().trim().min(1).max(60) }))
  .max(80)
  .default([]);
const systemSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(600).default(''),
  homebrew: z.boolean().default(false),
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

interface DraftRow {
  sheet_template: unknown;
  sheet_draft: unknown;
  sheet_draft_notes: string[];
  sheet_draft_status: SheetDraftView['status'];
  sheet_draft_error: string | null;
  sheet_draft_at: Date | null;
}
const DRAFT_SQL = `SELECT sheet_template, sheet_draft, sheet_draft_notes, sheet_draft_status, sheet_draft_error,
                          sheet_draft_at
                     FROM game_systems WHERE id = $1`;

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
    const auth = requireUser(req);
    const admin = auth.user.role === 'admin';
    const owned = admin ? new Set<string>() : await ownedSystems(auth.user.id);
    const rows = await q(
      `SELECT s.id, s.slug, s.name, s.description, s.sheet_template, s.sheet_version, s.lore, s.lore_status, s.homebrew,
              s.gm_instructions, s.sheet_draft_status,
              (SELECT count(*)::int FROM documents d WHERE d.system_id = s.id AND d.campaign_id IS NULL) AS docs,
              (SELECT count(*)::int FROM documents d
                 WHERE d.system_id = s.id AND d.campaign_id IS NULL AND d.kind = 'setting') AS setting_docs,
              (SELECT count(*)::int FROM chunks c WHERE c.system_id = s.id AND c.campaign_id IS NULL) AS chunks
         FROM game_systems s ORDER BY s.name`,
    );
    const systems: GameSystem[] = rows.map((r) => {
      const canEdit = admin || owned.has(r.id);
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        sheetSchema: toSchema(r.sheet_template),
        sheetVersion: r.sheet_version,
        documentCount: r.docs,
        chunkCount: r.chunks,
        settingDocumentCount: r.setting_docs,
        loreStatus: r.lore_status,
        lore: r.lore ?? null,
        homebrew: r.homebrew,
        canEdit,
        // Written for the GM, so only the people who write them see them.
        ...(canEdit ? { gmInstructions: r.gm_instructions, sheetDraftStatus: r.sheet_draft_status } : {}),
      };
    });
    return { systems };
  });

  app.post('/api/systems', async (req) => {
    const auth = requireAdmin(req);
    const body = parse(systemSchema, req.body);
    const base = slugify(body.name);
    const template = fromTemplate({ abilities: body.abilities, fields: body.fields ?? DEFAULT_FIELDS });
    for (let n = 0; n < 20; n++) {
      const row = await q1<{ id: string }>(
        `INSERT INTO game_systems (slug, name, description, sheet_template, created_by, homebrew)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (slug) DO NOTHING RETURNING id`,
        [
          n ? `${base}-${n + 1}` : base,
          body.name,
          body.description,
          JSON.stringify(template),
          auth.user.id,
          body.homebrew,
        ],
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

  /**
   * Change a system's settings.
   * - homebrew: tables on a homebrew system get the rules desk, and their GMs
   *   follow the rulings made there. Every campaign on the system has its
   *   brief compiled again on its next turn, so the rulings come in or go out
   *   with the switch.
   * - gmInstructions: standing instructions for the GM of every table on the
   *   system, e.g. which other AI to ask for what. They are part of the GM's
   *   instructions from the next turn on.
   */
  app.patch<{ Params: { id: string } }>('/api/systems/:id', async (req) => {
    const id = parse(uuid, req.params.id);
    const auth = await requireSystemEditor(req, id);
    const { homebrew, gmInstructions } = parse(
      z
        .object({
          homebrew: z.boolean().optional(),
          gmInstructions: z.string().trim().max(4000).optional(),
        })
        .refine((b) => b.homebrew !== undefined || b.gmInstructions !== undefined, 'Nothing to change.'),
      req.body,
    );
    const row = await q1<{ id: string }>(
      `UPDATE game_systems SET homebrew = coalesce($2, homebrew), gm_instructions = coalesce($3, gm_instructions)
        WHERE id = $1 RETURNING id`,
      [id, homebrew ?? null, gmInstructions ?? null],
    );
    if (!row) throw notFound();
    if (homebrew !== undefined) await q('UPDATE campaigns SET brief_at = NULL WHERE system_id = $1', [id]);
    await audit('system.updated', {
      actorId: auth.user.id,
      targetType: 'system',
      targetId: id,
      ip: req.ip,
      meta: {
        ...(homebrew !== undefined ? { homebrew } : {}),
        ...(gmInstructions !== undefined ? { gmInstructions: true } : {}),
      },
    });
    return { ok: true };
  });

  /**
   * Publish a new version of what a system's character sheets hold. New
   * campaigns get it; campaigns already playing stay on their version until
   * their host updates, which carries each sheet's values across (`renames`
   * moves a replaced field's values to its new name).
   */
  app.put<{ Params: { id: string } }>('/api/systems/:id/sheet-schema', async (req) => {
    const id = parse(uuid, req.params.id);
    const auth = await requireSystemEditor(req, id);
    const body = (req.body ?? {}) as { schema?: unknown; renames?: unknown };
    const schema = parseSchema(body.schema);
    const row = await q1<{ sheet_template: unknown }>(
      'SELECT sheet_template FROM game_systems WHERE id = $1',
      [id],
    );
    if (!row) throw notFound();
    const renames = checkRenames(toSchema(row.sheet_template), schema, parse(renamesInput, body.renames));
    const version = await publishSheet(id, schema, { renames, by: auth.user.id });
    await audit('system.updated', {
      actorId: auth.user.id,
      targetType: 'system',
      targetId: id,
      ip: req.ip,
      meta: { sheetSchema: true, sheetVersion: version },
    });
    return { sheetSchema: schema, sheetVersion: version };
  });

  // ---- the AI's draft of a system's sheet ----

  /**
   * Have the AI draft the system's sheet from its rulebooks. It runs in the
   * background; the draft waits for review and changes nothing on its own.
   */
  app.post<{ Params: { id: string } }>('/api/systems/:id/sheet-draft', async (req) => {
    const id = parse(uuid, req.params.id);
    const auth = await requireSystemEditor(req, id);
    const sys = await q1<{ created_by: string | null; sheet_draft_status: string }>(
      'SELECT created_by, sheet_draft_status FROM game_systems WHERE id = $1',
      [id],
    );
    if (!sys) throw notFound();
    if (!(await rulesCorpus(id)).length)
      throw badRequest('Upload a rulebook and let it finish indexing first: the draft is read from it.');
    // The job runs on the system creator's key if the server has none of its own.
    const owner = sys.created_by ?? auth.user.id;
    if (!(instanceAiConfigured() || (await builtInAiFor(owner))))
      throw badRequest(
        'Drafting a sheet needs the built-in AI, and this server has none set up.',
        'no_built_in',
      );
    if (!(await hasPending('draft_sheet', 'systemId', id))) {
      await enqueue('draft_sheet', { systemId: id });
      await q(
        `UPDATE game_systems SET sheet_draft_status = 'queued', sheet_draft_error = NULL WHERE id = $1`,
        [id],
      );
    }
    await audit('system.sheet_draft_requested', {
      actorId: auth.user.id,
      targetType: 'system',
      targetId: id,
      ip: req.ip,
    });
    return { ok: true };
  });

  /** The draft, as the changes it would make to the sheet the system has now. */
  app.get<{ Params: { id: string } }>(
    '/api/systems/:id/sheet-draft',
    async (req): Promise<SheetDraftView> => {
      const id = parse(uuid, req.params.id);
      await requireSystemEditor(req, id);
      const row = await q1<DraftRow>(DRAFT_SQL, [id]);
      if (!row) throw notFound();
      const draft = row.sheet_draft ? toSchema(row.sheet_draft) : null;
      const proposals = draft ? proposalsFor(toSchema(row.sheet_template), draft) : [];
      return {
        status: row.sheet_draft_status,
        error: row.sheet_draft_error,
        notes: row.sheet_draft_notes,
        proposals,
        renames: suggestRenames(proposals),
        draftedAt: row.sheet_draft_at?.toISOString() ?? null,
      };
    },
  );

  /**
   * Make the changes the admin chose, and only those, as a new version of the
   * sheet, then let the draft go. Ids are the proposals' own; one the draft no
   * longer proposes is ignored. `renames` pairs a removed field with an added
   * one whose values it carries over; both changes must be among those chosen.
   */
  app.post<{ Params: { id: string } }>('/api/systems/:id/sheet-draft/apply', async (req) => {
    const id = parse(uuid, req.params.id);
    const auth = await requireSystemEditor(req, id);
    const { accept, renames: pairs } = parse(
      z.object({ accept: z.array(z.string().max(80)).max(200), renames: renamesInput }),
      req.body,
    );
    const row = await q1<DraftRow>(DRAFT_SQL, [id]);
    if (!row) throw notFound();
    if (!row.sheet_draft) throw conflict('There is no draft to apply.');
    const current = toSchema(row.sheet_template);
    const schema = applyProposals(current, toSchema(row.sheet_draft), accept);
    const renames = checkRenames(current, schema, pairs);
    const version = await tx(async (c) => {
      const v = await publishSheet(id, schema, { renames, by: auth.user.id }, c);
      await q(
        `UPDATE game_systems SET sheet_draft = NULL, sheet_draft_notes = '[]',
                sheet_draft_status = 'none', sheet_draft_error = NULL WHERE id = $1`,
        [id],
        c,
      );
      return v;
    });
    await audit('system.updated', {
      actorId: auth.user.id,
      targetType: 'system',
      targetId: id,
      ip: req.ip,
      meta: { sheetSchema: true, fromDraft: accept.length, sheetVersion: version },
    });
    return { sheetSchema: schema, sheetVersion: version };
  });

  /** Let a draft (or a failed attempt) go without changing the sheet. */
  app.delete<{ Params: { id: string } }>('/api/systems/:id/sheet-draft', async (req) => {
    const id = parse(uuid, req.params.id);
    await requireSystemEditor(req, id);
    const row = await q1<{ sheet_draft_status: string }>(
      `UPDATE game_systems SET sheet_draft = NULL, sheet_draft_notes = '[]', sheet_draft_status = 'none',
              sheet_draft_error = NULL
        WHERE id = $1 AND sheet_draft_status NOT IN ('queued', 'drafting') RETURNING sheet_draft_status`,
      [id],
    );
    if (!row) {
      if (await q1('SELECT 1 FROM game_systems WHERE id = $1', [id]))
        throw conflict('Wait for the draft to finish.');
      throw notFound();
    }
    return { ok: true };
  });

  // ---- owners: players an admin trusts with one system ----

  /** Who owns a system besides the admins. Anyone who can edit it may see the list. */
  app.get<{ Params: { id: string } }>(
    '/api/systems/:id/owners',
    async (req): Promise<{ owners: SystemOwner[] }> => {
      const id = parse(uuid, req.params.id);
      await requireSystemEditor(req, id);
      const rows = await q<{ id: string; username: string; display_name: string; added_at: Date }>(
        `SELECT u.id, u.username, u.display_name, o.added_at
           FROM game_system_owners o JOIN users u ON u.id = o.user_id
          WHERE o.system_id = $1 ORDER BY o.added_at`,
        [id],
      );
      return {
        owners: rows.map((r) => ({
          id: r.id,
          username: r.username,
          displayName: r.display_name,
          addedAt: r.added_at.toISOString(),
        })),
      };
    },
  );

  /** An admin makes a player an owner of one system. */
  app.put<{ Params: { id: string; userId: string } }>('/api/systems/:id/owners/:userId', async (req) => {
    const auth = requireAdmin(req);
    const id = parse(uuid, req.params.id);
    const userId = parse(uuid, req.params.userId);
    if (!(await q1('SELECT 1 FROM game_systems WHERE id = $1', [id]))) throw notFound();
    const user = await q1<{ role: string }>(`SELECT role FROM users WHERE id = $1 AND status = 'active'`, [
      userId,
    ]);
    if (!user) throw notFound('No such player.');
    if (user.role === 'admin') throw badRequest('Admins can already change every system.');
    await q(
      `INSERT INTO game_system_owners (system_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [id, userId, auth.user.id],
    );
    await audit('system.owner_added', {
      actorId: auth.user.id,
      targetType: 'system',
      targetId: id,
      ip: req.ip,
      meta: { userId },
    });
    return { ok: true };
  });

  /** An admin takes a system back from one of its owners. */
  app.delete<{ Params: { id: string; userId: string } }>('/api/systems/:id/owners/:userId', async (req) => {
    const auth = requireAdmin(req);
    const id = parse(uuid, req.params.id);
    const userId = parse(uuid, req.params.userId);
    const rows = await q('DELETE FROM game_system_owners WHERE system_id = $1 AND user_id = $2 RETURNING 1', [
      id,
      userId,
    ]);
    if (!rows.length) throw notFound();
    await audit('system.owner_removed', {
      actorId: auth.user.id,
      targetType: 'system',
      targetId: id,
      ip: req.ip,
      meta: { userId },
    });
    return { ok: true };
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
    const id = parse(uuid, req.params.id);
    const auth = await requireSystemEditor(req, id);
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
    const systemId = parse(uuid, req.params.id);
    const auth = await requireSystemEditor(req, systemId);
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
    const docKind =
      (kindField && 'value' in kindField ? String(kindField.value) : '') === 'setting' ? 'setting' : null;

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
    const id = parse(uuid, req.params.id);
    await requireDocumentEditor(req, id);
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
    const id = parse(uuid, req.params.id);
    const auth = await requireDocumentEditor(req, id);
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
    const id = parse(uuid, req.params.id);
    const auth = await requireDocumentEditor(req, id);
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
