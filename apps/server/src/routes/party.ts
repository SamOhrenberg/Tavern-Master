import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type {
  BuilderEvent,
  BuilderThread,
  CampaignDocKind,
  CampaignDocument,
  CharacterDraft,
  DocumentStatus,
} from '@tavern/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { builderTurn, controlOf, threadMessages } from '../agent/builder.js';
import { readSheet, validateSheet, type SheetSource } from '../agent/sheets.js';
import { config } from '../config.js';
import { dmMode } from '../connector/mode.js';
import { dropSheetFile, toPendingSheet, type SheetPayload } from '../connector/uploads.js';
import { getWork, queueWork, type WorkItem } from '../connector/work.js';
import { randomUUID } from 'node:crypto';
import { q, q1, tx } from '../db/pool.js';
import { badRequest, conflict, forbidden, HttpError, notFound, parse } from '../errors.js';
import { requireMember } from '../http/membership.js';
import { enforceLimit, rateLimiters } from '../http/security.js';
import { discard, receiveFile } from '../http/upload.js';
import { enqueue } from '../jobs/queue.js';
import { resolveLlm } from '../llm/index.js';
import { budgetBlock, recordUsage } from '../llm/usage.js';
import { log } from '../log.js';
import {
  ASSIGN_REFUSED,
  canEdit,
  characterSchema,
  controlSchema,
  createCharacter,
  deleteCharacter,
  loadAccess,
  mayAssign,
  portraitUrl,
  setControl,
  setPortrait,
  updateCharacter,
  type Control,
} from '../party.js';
import { getRoom } from '../realtime/room.js';
import { parseDocument, sniff, sniffImage } from '../rules/parse.js';
import { searchRules } from '../rules/retrieve.js';
import { CAMPAIGN_SHEET_SQL, toSchema } from '../sheet-schema.js';
import { uploadPath } from '../storage.js';

const uuid = z.string().uuid();
const SHEET_MAX_BYTES = 10 * 1024 * 1024;
/** The app shrinks a picture to a few hundred pixels before sending it, so this is generous. */
const PORTRAIT_MAX_BYTES = 2 * 1024 * 1024;
/** Images go to the model as they are, and model APIs cap a single image at about this size. */
const IMAGE_MAX_BYTES = 4.5 * 1024 * 1024;
/** Roughly ten dense pages. A longer upload is a rulebook, not a character sheet. */
const SHEET_MAX_CHARS = 40_000;

type Params = { id: string };
type CharParams = { id: string; characterId: string };
type DocParams = { id: string; documentId: string };
type ThreadParams = { id: string; threadId: string };

interface DocRow {
  id: string;
  title: string;
  size_bytes: number;
  status: DocumentStatus;
  error: string | null;
  kind: CampaignDocKind | null;
  audience: 'table' | 'gm';
  summary: string;
  uploaded_by: string | null;
  username: string | null;
  display_name: string | null;
  created_at: Date;
}
const DOC_SQL = `SELECT d.id, d.title, d.size_bytes, d.status, d.error, d.kind, d.audience, d.summary,
                        d.uploaded_by, u.username, u.display_name, d.created_at
                   FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by`;

const docKinds = z.enum(['rules', 'setting', 'adventure', 'character', 'handout', 'other']);

async function readHead(path: string): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function partyRoutes(app: FastifyInstance): Promise<void> {
  // ---- characters ----

  app.post<{ Params: Params }>('/api/campaigns/:id/characters', async (req) => {
    const { campaignId, viewer } = await requireMember(req);
    const body = parse(z.object({ character: characterSchema, control: controlSchema.optional() }), req.body);
    const id = await createCharacter(campaignId, viewer, body.character, body.control);
    getRoom(campaignId)?.partyChanged();
    return { id };
  });

  app.put<{ Params: CharParams }>('/api/campaigns/:id/characters/:characterId', async (req) => {
    const { campaignId, viewer } = await requireMember(req);
    const characterId = parse(uuid, req.params.characterId);
    await updateCharacter(campaignId, characterId, viewer, parse(characterSchema, req.body));
    getRoom(campaignId)?.partyChanged();
    return { ok: true };
  });

  /**
   * Who runs a party member: players, the DM, or an AI of its own. The owners
   * decide for anyone; a player for a companion they look after.
   */
  app.put<{ Params: CharParams }>('/api/campaigns/:id/characters/:characterId/control', async (req) => {
    const { campaignId, viewer } = await requireMember(req);
    const characterId = parse(uuid, req.params.characterId);
    await setControl(campaignId, characterId, parse(controlSchema, req.body), viewer);
    getRoom(campaignId)?.partyChanged();
    return { ok: true };
  });

  app.delete<{ Params: CharParams }>('/api/campaigns/:id/characters/:characterId', async (req) => {
    const { campaignId, viewer } = await requireMember(req);
    const characterId = parse(uuid, req.params.characterId);
    if (getRoom(campaignId)?.busy) throw conflict('Wait for the current turn to finish.');
    await deleteCharacter(campaignId, characterId, viewer);
    getRoom(campaignId)?.partyChanged();
    return { ok: true };
  });

  // ---- character pictures ----

  /** Set a character's picture: a PNG, JPEG or WebP image, replacing any it had. */
  app.put<{ Params: CharParams }>('/api/campaigns/:id/characters/:characterId/portrait', async (req) => {
    const { campaignId, viewer } = await requireMember(req);
    const characterId = parse(uuid, req.params.characterId);
    // Check before taking the file, so a stranger's upload is never written to disk.
    const access = await loadAccess(campaignId, characterId);
    if (!canEdit(viewer, access)) throw forbidden('That character belongs to another player.');
    const file = await receiveFile(req, PORTRAIT_MAX_BYTES);
    try {
      if (!sniffImage(await readHead(file.path))) throw badRequest('Choose a PNG, JPEG or WebP picture.');
      await setPortrait(campaignId, characterId, viewer, file.storageName);
    } catch (err) {
      await discard(file);
      throw err;
    }
    getRoom(campaignId)?.partyChanged();
    return { portrait: portraitUrl(campaignId, characterId, file.storageName) };
  });

  app.delete<{ Params: CharParams }>('/api/campaigns/:id/characters/:characterId/portrait', async (req) => {
    const { campaignId, viewer } = await requireMember(req);
    const characterId = parse(uuid, req.params.characterId);
    await setPortrait(campaignId, characterId, viewer, null);
    getRoom(campaignId)?.partyChanged();
    return { ok: true };
  });

  /** Anyone at the table may see the party's pictures. */
  app.get<{ Params: CharParams }>(
    '/api/campaigns/:id/characters/:characterId/portrait',
    async (req, reply) => {
      const { campaignId } = await requireMember(req);
      const characterId = parse(uuid, req.params.characterId);
      const row = await q1<{ portrait: string | null }>(
        'SELECT portrait FROM characters WHERE id = $1 AND campaign_id = $2',
        [characterId, campaignId],
      );
      if (!row?.portrait) throw notFound('No picture');
      const path = uploadPath(row.portrait);
      const type = sniffImage(await readHead(path).catch(() => Buffer.alloc(0)));
      if (!type) throw notFound('No picture');
      // The address changes with every new picture, so this one never goes stale.
      return reply
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .type(type)
        .send(createReadStream(path));
    },
  );

  /**
   * Read an uploaded character sheet (PDF, text, or a photo) into a draft.
   * Nothing is saved and the file is not kept: the player reviews the draft
   * in the sheet editor and saves it from there.
   */
  app.post<{ Params: Params }>('/api/campaigns/:id/characters/import', async (req) => {
    const { auth, campaignId, viewer } = await requireMember(req);
    // In a Claude campaign the upload is handed to Claude: no model runs here.
    const claude = (await dmMode(campaignId)) === 'claude';
    if (!claude) {
      enforceLimit(rateLimiters().llm, `user:${auth.user.id}`);
      const blocked = await budgetBlock(campaignId, [auth.user.id]);
      if (blocked) throw conflict(blocked, 'over_budget');
    }

    const file = await receiveFile(req, SHEET_MAX_BYTES);
    let keep = false;
    try {
      const head = await readHead(file.path);
      const source: SheetSource = {};
      const image = sniffImage(head);
      if (image && claude) {
        const max = config().CONNECTOR_IMAGE_MAX_BYTES;
        if (file.size > max) {
          throw badRequest(
            `That photo is too large for Claude to read here. Try one under ${Math.max(1, Math.floor(max / 1_000_000))} MB, or a PDF.`,
          );
        }
      } else if (image) {
        if (file.size > IMAGE_MAX_BYTES) throw badRequest('That photo is too large. Try one under 4 MB.');
        const fh = await open(file.path, 'r');
        try {
          source.image = { mediaType: image, data: (await fh.readFile()).toString('base64') };
        } finally {
          await fh.close();
        }
      } else {
        const kind = sniff(head, file.originalName);
        if (!kind)
          throw badRequest(
            'Upload a PDF, a text or Markdown file, or a photo of the sheet.',
            'bad_file_type',
          );
        const text = (await parseDocument(file.path, kind))
          .map((p) => p.text)
          .join('\n\n')
          .trim();
        if (text.length < 40) {
          throw badRequest(
            'No text could be read from that file. If it is a scan, upload a photo of the sheet instead.',
            'unreadable_sheet',
          );
        }
        if (text.length > SHEET_MAX_CHARS) {
          throw badRequest(
            'That file is too long to be a character sheet. Upload just the pages with the sheet on them.',
            'too_long',
          );
        }
        source.text = text;
      }

      if (claude) {
        let control: Control = { kind: 'pc', controller: 'player', playerIds: [auth.user.id] };
        if (file.fields.control) {
          let raw: unknown;
          try {
            raw = JSON.parse(file.fields.control);
          } catch {
            throw badRequest('The control field is not valid JSON.');
          }
          control = parse(controlSchema, raw);
        }
        if (!mayAssign(viewer, control)) throw forbidden(ASSIGN_REFUSED);
        const payload: SheetPayload = {
          fileName: file.originalName,
          control,
          ...(image ? { image: { storageName: file.storageName, mediaType: image } } : { text: source.text }),
        };
        const id = await queueWork({
          campaignId,
          kind: 'sheet',
          subjectId: randomUUID(),
          requestedBy: auth.user.id,
          payload: payload as unknown as Record<string, unknown>,
        });
        keep = !!image;
        const item = (await getWork(id!))!;
        return { pending: toPendingSheet(item) };
      }

      const campaign = await q1<{
        owner_id: string;
        system_id: string;
        system_name: string;
        sheet_template: unknown;
      }>(
        `SELECT c.owner_id, c.system_id, s.name AS system_name, ${CAMPAIGN_SHEET_SQL} AS sheet_template
           FROM campaigns c JOIN game_systems s ON s.id = c.system_id WHERE c.id = $1`,
        [campaignId],
      );
      if (!campaign) throw notFound();
      const llm = await resolveLlm('utility', campaign.owner_id);
      let draft: CharacterDraft;
      try {
        draft = await readSheet({
          llm,
          systemName: campaign.system_name,
          schema: toSchema(campaign.sheet_template),
          source,
          signal: AbortSignal.timeout(120_000),
          onUsage: (usage, model) =>
            recordUsage({
              task: 'sheet',
              provider: llm.provider.name,
              model,
              keySource: llm.keySource,
              campaignId,
              userIds: [auth.user.id],
              usage,
            }),
        });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        log().warn({ err, campaignId }, 'sheet could not be read');
        throw new HttpError(
          502,
          'model_failed',
          source.image
            ? 'The AI could not read that photo. The configured model may not accept images; try a PDF or text file.'
            : 'The AI could not read the sheet just now. Try again in a moment.',
        );
      }
      // Check the draft against the rules and suggest corrections (notably a max HP
      // the reader left at its placeholder). Best-effort: never block the upload.
      try {
        const klass = draft.sheet['Class'] ?? draft.sheet['class'] ?? '';
        const rules = await searchRules(
          campaign.system_id,
          `maximum hit points health calculation character creation starting ${klass} level`,
          6,
          undefined,
          campaignId,
        );
        const suggestions = await validateSheet({
          llm,
          systemName: campaign.system_name,
          draft,
          schema: toSchema(campaign.sheet_template),
          rules,
          signal: AbortSignal.timeout(60_000),
          onUsage: (usage, model) =>
            recordUsage({
              task: 'sheet-check',
              provider: llm.provider.name,
              model,
              keySource: llm.keySource,
              campaignId,
              userIds: [auth.user.id],
              usage,
            }),
        });
        if (suggestions.length) draft.suggestions = suggestions;
      } catch (err) {
        log().warn({ err, campaignId }, 'sheet rules check failed');
      }
      return { draft };
    } finally {
      if (!keep) await discard(file);
    }
  });

  /** Your uploaded sheets that Claude has, or has read, newest first. */
  app.get<{ Params: Params }>('/api/campaigns/:id/sheets', async (req) => {
    const { auth, campaignId } = await requireMember(req);
    const rows = await q<{
      id: string;
      status: WorkItem['status'];
      payload: Record<string, unknown>;
      result: Record<string, unknown> | null;
      error: string | null;
    }>(
      `SELECT id, status, payload, result, error FROM dm_work
        WHERE campaign_id = $1 AND requested_by = $2 AND kind = 'sheet'
        ORDER BY created_at DESC LIMIT 10`,
      [campaignId, auth.user.id],
    );
    return { sheets: rows.map(toPendingSheet) };
  });

  /** Forget an uploaded sheet once its draft is saved or dismissed. */
  app.delete<{ Params: { id: string; sheetId: string } }>(
    '/api/campaigns/:id/sheets/:sheetId',
    async (req) => {
      const { auth, role, campaignId } = await requireMember(req);
      const id = parse(uuid, req.params.sheetId);
      const item = await getWork(id);
      if (!item || item.campaignId !== campaignId || item.kind !== 'sheet') throw notFound();
      if (item.requestedBy !== auth.user.id && role !== 'owner')
        throw forbidden('That upload is someone else’s.');
      await q('DELETE FROM dm_work WHERE id = $1', [id]);
      await dropSheetFile(item.payload);
      getRoom(campaignId)?.workChanged();
      return { ok: true };
    },
  );

  // ---- the character-building guide ----

  /** Open (or return to) a chat with the guide, about an existing character or a new one. */
  app.post<{ Params: Params }>('/api/campaigns/:id/builder', async (req) => {
    const { auth, campaignId, viewer } = await requireMember(req);
    const body = parse(
      z.object({ characterId: uuid.optional(), control: controlSchema.optional() }),
      req.body,
    );
    let row: { id: string; character_id: string | null } | undefined;
    if (body.characterId) {
      if (!canEdit(viewer, await loadAccess(campaignId, body.characterId)))
        throw forbidden('That character belongs to another player.');
      row = await q1(
        `SELECT id, character_id FROM builder_threads
          WHERE campaign_id = $1 AND user_id = $2 AND character_id = $3 ORDER BY created_at DESC LIMIT 1`,
        [campaignId, auth.user.id, body.characterId],
      );
      row ??= await q1(
        `INSERT INTO builder_threads (campaign_id, user_id, character_id) VALUES ($1, $2, $3)
         RETURNING id, character_id`,
        [campaignId, auth.user.id, body.characterId],
      );
    } else {
      const control: Control = body.control ?? {
        kind: 'pc',
        controller: 'player',
        playerIds: [auth.user.id],
      };
      if (!mayAssign(viewer, control)) throw forbidden(ASSIGN_REFUSED);
      // An unfinished chat about the same kind of new character is picked up again.
      row = await q1(
        `SELECT id, character_id FROM builder_threads
          WHERE campaign_id = $1 AND user_id = $2 AND character_id IS NULL AND intent = $3::jsonb
            AND NOT EXISTS (SELECT 1 FROM builder_messages m WHERE m.thread_id = builder_threads.id
                             AND m.created_at < now() - interval '7 days')
          ORDER BY created_at DESC LIMIT 1`,
        [campaignId, auth.user.id, JSON.stringify(control)],
      );
      row ??= await q1(
        `INSERT INTO builder_threads (campaign_id, user_id, intent) VALUES ($1, $2, $3)
         RETURNING id, character_id`,
        [campaignId, auth.user.id, JSON.stringify(control)],
      );
    }
    const thread: BuilderThread = {
      id: row!.id,
      characterId: row!.character_id,
      messages: await threadMessages(row!.id),
    };
    return { thread };
  });

  /** A guide chat as it stands, for its owner: used to pick up Claude's replies. */
  app.get<{ Params: ThreadParams }>('/api/campaigns/:id/builder/:threadId', async (req) => {
    const { auth, campaignId } = await requireMember(req);
    const threadId = parse(uuid, req.params.threadId);
    const row = await q1<{ id: string; character_id: string | null }>(
      'SELECT id, character_id FROM builder_threads WHERE id = $1 AND campaign_id = $2 AND user_id = $3',
      [threadId, campaignId, auth.user.id],
    );
    if (!row) throw notFound();
    const thread: BuilderThread = {
      id: row.id,
      characterId: row.character_id,
      messages: await threadMessages(row.id),
    };
    return { thread };
  });

  /**
   * Say something to the guide. The reply is streamed as newline-delimited
   * JSON (`BuilderEvent`s): text as it is written, a line for each roll or
   * save, then the stored message. In a Claude campaign the message is stored
   * and handed to Claude instead, the stream says `queued`, and the reply
   * arrives later.
   */
  app.post<{ Params: ThreadParams }>('/api/campaigns/:id/builder/:threadId/messages', async (req, reply) => {
    const { auth, campaignId, viewer } = await requireMember(req);
    const threadId = parse(uuid, req.params.threadId);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(2000) }), req.body);
    const thread = await q1<{ character_id: string | null; intent: Partial<Control> }>(
      'SELECT character_id, intent FROM builder_threads WHERE id = $1 AND campaign_id = $2 AND user_id = $3',
      [threadId, campaignId, auth.user.id],
    );
    if (!thread) throw notFound();

    if ((await dmMode(campaignId)) === 'claude') {
      // No model runs here, so there is nothing to rate limit or charge: the host's Claude answers.
      await q(`INSERT INTO builder_messages (thread_id, role, content) VALUES ($1, 'user', $2)`, [
        threadId,
        text,
      ]);
      await q('UPDATE builder_threads SET updated_at = now() WHERE id = $1', [threadId]);
      await queueWork({ campaignId, kind: 'guide', subjectId: threadId, requestedBy: auth.user.id });
      reply.header('content-type', 'application/x-ndjson; charset=utf-8').header('cache-control', 'no-store');
      return `${JSON.stringify({ type: 'queued' } satisfies BuilderEvent)}\n`;
    }

    enforceLimit(rateLimiters().llm, `user:${auth.user.id}`);
    const control = controlOf(thread.intent, auth.user.id);

    // From here on the response is a stream we write ourselves.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    const send = (ev: BuilderEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
    };
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    try {
      const out = await builderTurn(
        {
          campaignId,
          threadId,
          viewer,
          displayName: auth.user.displayName,
          characterId: thread.character_id,
          control,
        },
        text,
        {
          signal: AbortSignal.any([gone.signal, AbortSignal.timeout(240_000)]),
          onText: (delta) => send({ type: 'delta', text: delta }),
          onTool: (tool, summary) => send({ type: 'tool', tool, summary }),
        },
      );
      if (out.stateChanged) getRoom(campaignId)?.partyChanged();
      send({ type: 'done', message: out.message, characterId: out.characterId });
    } catch (err) {
      if (!(err instanceof HttpError)) log().error({ err, campaignId }, 'builder turn failed');
      send({
        type: 'error',
        message: err instanceof HttpError ? err.message : 'The guide could not answer just now. Try again.',
      });
    } finally {
      res.end();
    }
  });

  // ---- campaign documents ----

  app.get<{ Params: Params }>('/api/campaigns/:id/documents', async (req) => {
    const { auth, role, campaignId } = await requireMember(req);
    const rows = await q<DocRow>(`${DOC_SQL} WHERE d.campaign_id = $1 ORDER BY d.created_at`, [campaignId]);
    const documents: CampaignDocument[] = rows.map((r) => {
      const mine = r.uploaded_by === auth.user.id;
      return {
        id: r.id,
        title: r.title,
        sizeBytes: r.size_bytes,
        status: r.status,
        error: r.error,
        kind: r.kind,
        audience: r.audience,
        // What a DM-only document holds is for the DM and whoever supplied it.
        summary: r.audience === 'table' || mine ? r.summary : '',
        uploadedBy: r.uploaded_by
          ? { id: r.uploaded_by, username: r.username ?? '', displayName: r.display_name ?? 'Unknown' }
          : null,
        canEdit: mine || role === 'owner',
        createdAt: r.created_at.toISOString(),
      };
    });
    return { documents };
  });

  /** Any player can add material for this campaign: setting notes, an adventure, a backstory. */
  app.post<{ Params: Params }>('/api/campaigns/:id/documents', async (req) => {
    const { auth, campaignId } = await requireMember(req);
    const limit = config().MAX_CAMPAIGN_DOCUMENTS;
    const campaign = await q1<{ system_id: string; n: number }>(
      `SELECT c.system_id, (SELECT count(*)::int FROM documents d WHERE d.campaign_id = c.id) AS n
         FROM campaigns c WHERE c.id = $1`,
      [campaignId],
    );
    if (!campaign) throw notFound();
    if (campaign.n >= limit) throw conflict(`A campaign holds at most ${limit} documents. Remove one first.`);

    const file = await receiveFile(req);
    try {
      const kind = sniff(await readHead(file.path), file.originalName);
      if (!kind)
        throw badRequest(
          'Only PDF, Markdown (.md) and plain-text (.txt) files are accepted.',
          'bad_file_type',
        );
      const mime =
        kind === 'pdf'
          ? 'application/pdf'
          : /\.txt$/i.test(file.originalName)
            ? 'text/plain'
            : 'text/markdown';
      const title =
        (file.fields.title ?? '').trim().slice(0, 120) || file.originalName.replace(/\.[^.]+$/, '');
      const audience = file.fields.audience === 'gm' ? 'gm' : 'table';
      const id = await tx(async (client) => {
        const row = await q1<{ id: string }>(
          `INSERT INTO documents (system_id, campaign_id, title, original_name, storage_name, mime, size_bytes,
                                  sha256, uploaded_by, audience)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            campaign.system_id,
            campaignId,
            title,
            file.originalName,
            file.storageName,
            mime,
            file.size,
            file.sha256,
            auth.user.id,
            audience,
          ],
          client,
        );
        await enqueue('ingest_document', { documentId: row!.id }, {}, client);
        return row!.id;
      });
      return { id };
    } catch (err) {
      await discard(file);
      throw err;
    }
  });

  /** The uploader or the owner may rename, reclassify, hide, retry or remove a document. */
  async function ownDocument(req: Parameters<typeof requireMember>[0], documentId: string) {
    const { auth, role, campaignId } = await requireMember(req);
    const id = parse(uuid, documentId);
    const doc = await q1<{ uploaded_by: string | null; storage_name: string; status: DocumentStatus }>(
      'SELECT uploaded_by, storage_name, status FROM documents WHERE id = $1 AND campaign_id = $2',
      [id, campaignId],
    );
    if (!doc) throw notFound();
    if (doc.uploaded_by !== auth.user.id && role !== 'owner')
      throw forbidden('Only whoever uploaded it, or the campaign owner, can change that document.');
    return { id, doc };
  }

  app.patch<{ Params: DocParams }>('/api/campaigns/:id/documents/:documentId', async (req) => {
    const { id } = await ownDocument(req, req.params.documentId);
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(120).optional(),
        audience: z.enum(['table', 'gm']).optional(),
        kind: docKinds.optional(),
      }),
      req.body,
    );
    await q(
      `UPDATE documents SET title = coalesce($2, title), audience = coalesce($3, audience),
                            kind = coalesce($4, kind) WHERE id = $1`,
      [id, body.title ?? null, body.audience ?? null, body.kind ?? null],
    );
    return { ok: true };
  });

  app.post<{ Params: DocParams }>('/api/campaigns/:id/documents/:documentId/retry', async (req) => {
    const { id, doc } = await ownDocument(req, req.params.documentId);
    if (doc.status !== 'failed') throw badRequest('That document is not waiting on a retry.');
    await q(`UPDATE documents SET status = 'queued', error = NULL WHERE id = $1`, [id]);
    await enqueue('ingest_document', { documentId: id });
    return { ok: true };
  });

  app.delete<{ Params: DocParams }>('/api/campaigns/:id/documents/:documentId', async (req) => {
    const { id, doc } = await ownDocument(req, req.params.documentId);
    await q('DELETE FROM documents WHERE id = $1', [id]);
    await rm(uploadPath(doc.storage_name), { force: true });
    return { ok: true };
  });
}
