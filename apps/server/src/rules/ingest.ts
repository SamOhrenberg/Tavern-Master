import { q, q1, tx } from '../db/pool.js';
import { enqueue, hasPending } from '../jobs/queue.js';
import { log } from '../log.js';
import { uploadPath } from '../storage.js';
import { catalogue } from './catalogue.js';
import { chunkPages, type Chunk } from './chunk.js';
import { toVector, type Embedder } from './embed.js';
import { parseDocument, sniffFile } from './parse.js';

interface DocRow {
  id: string;
  system_id: string;
  campaign_id: string | null;
  title: string;
  kind: string | null;
  uploaded_by: string | null;
  original_name: string;
  storage_name: string;
}

const setStatus = (id: string, status: string, error: string | null = null) =>
  q('UPDATE documents SET status = $2, error = $3 WHERE id = $1', [id, status, error]);

/**
 * A campaign document gets a catalogue entry (what it holds, what kind of
 * thing it is) once it is searchable. This is a convenience on top of a
 * finished ingestion, so a failure here is logged and nothing more.
 */
async function describe(doc: DocRow, chunks: Chunk[]): Promise<void> {
  if (!doc.campaign_id) return;
  try {
    const owner = await q1<{ owner_id: string }>('SELECT owner_id FROM campaigns WHERE id = $1', [
      doc.campaign_id,
    ]);
    const entry = await catalogue({
      campaignId: doc.campaign_id,
      ownerId: owner?.owner_id ?? null,
      uploaderId: doc.uploaded_by,
      title: doc.title,
      chunks,
    });
    if (!entry) return;
    // A kind the uploader picked by hand is kept.
    await q('UPDATE documents SET summary = $2, kind = coalesce(kind, $3) WHERE id = $1', [
      doc.id,
      entry.summary,
      entry.kind,
    ]);
  } catch (err) {
    log().warn({ err, documentId: doc.id }, 'could not catalogue document');
  } finally {
    await q(`UPDATE documents SET kind = coalesce(kind, 'other') WHERE id = $1`, [doc.id]);
  }
}

/**
 * Parse → chunk → embed → store one uploaded document. Progress is written to
 * documents.status so the UI can show it. Throws on failure after recording
 * the error; the job queue decides whether to retry.
 */
export async function ingestDocument(documentId: string, emb: Embedder | undefined): Promise<void> {
  const doc = await q1<DocRow>(
    `SELECT id, system_id, campaign_id, title, kind, uploaded_by, original_name, storage_name
       FROM documents WHERE id = $1`,
    [documentId],
  );
  if (!doc) return; // deleted while queued

  let chunks: Chunk[];
  try {
    await setStatus(doc.id, 'parsing');
    const path = uploadPath(doc.storage_name);
    const kind = await sniffFile(path, doc.original_name);
    if (!kind) throw new Error('Unsupported file: expected a PDF, Markdown or plain-text document');
    const pages = await parseDocument(path, kind);
    chunks = chunkPages(pages);
    if (!chunks.length) throw new Error('No text could be extracted (scanned PDFs need OCR first)');

    await setStatus(doc.id, 'embedding');
    let vectors: number[][] | undefined;
    if (emb)
      vectors = await emb.embed(
        chunks.map((c) => (c.heading ? `${c.heading}\n${c.content}` : c.content)),
        'passage',
      );

    await tx(async (client) => {
      await client.query('DELETE FROM chunks WHERE document_id = $1', [doc.id]);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const vec = vectors?.[i];
        await client.query(
          `INSERT INTO chunks (document_id, system_id, campaign_id, ordinal, heading, page_start, page_end,
                               content, token_count, embedding, embedding_model)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, $11)`,
          [
            doc.id,
            doc.system_id,
            doc.campaign_id,
            c.ordinal,
            c.heading,
            c.pageStart,
            c.pageEnd,
            c.content,
            c.tokenCount,
            vec ? toVector(vec) : null,
            vec ? emb!.model : null,
          ],
        );
      }
      await client.query(
        `UPDATE documents SET status = 'ready', error = NULL, chunk_count = $2, page_count = $3,
                              embedding_model = $4, processed_at = now() WHERE id = $1`,
        [doc.id, chunks.length, kind === 'pdf' ? pages.length : null, vectors ? emb!.model : null],
      );
    });
    log().info({ documentId: doc.id, chunks: chunks.length, embedded: !!vectors }, 'document ingested');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ingestion failed';
    await setStatus(doc.id, 'failed', message.slice(0, 500));
    throw err;
  }
  await describe(doc, chunks);
  await maybeDistilLore(doc);
}

/**
 * A library setting/flavour document just became searchable, so the system's
 * distilled voice is now stale. Queue one read per system (deduped), and mark
 * the lore as queued so the library can show it is being refreshed.
 */
async function maybeDistilLore(doc: DocRow): Promise<void> {
  if (doc.campaign_id || doc.kind !== 'setting') return;
  try {
    if (await hasPending('distil_lore', 'systemId', doc.system_id)) return;
    await enqueue('distil_lore', { systemId: doc.system_id });
    await q(`UPDATE game_systems SET lore_status = 'queued' WHERE id = $1 AND lore_status <> 'reading'`, [
      doc.system_id,
    ]);
  } catch (err) {
    log().warn({ err, systemId: doc.system_id }, 'could not queue lore distillation');
  }
}
