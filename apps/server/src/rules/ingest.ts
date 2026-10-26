import { q, q1, tx } from '../db/pool.js';
import { log } from '../log.js';
import { uploadPath } from '../storage.js';
import { chunkPages } from './chunk.js';
import { toVector, type Embedder } from './embed.js';
import { parseDocument, sniffFile } from './parse.js';

interface DocRow {
  id: string;
  system_id: string;
  original_name: string;
  storage_name: string;
}

const setStatus = (id: string, status: string, error: string | null = null) =>
  q('UPDATE documents SET status = $2, error = $3 WHERE id = $1', [id, status, error]);

/**
 * Parse → chunk → embed → store one uploaded document. Progress is written to
 * documents.status so the admin UI can show it. Throws on failure after
 * recording the error; the job queue decides whether to retry.
 */
export async function ingestDocument(documentId: string, emb: Embedder | undefined): Promise<void> {
  const doc = await q1<DocRow>(
    'SELECT id, system_id, original_name, storage_name FROM documents WHERE id = $1',
    [documentId],
  );
  if (!doc) return; // deleted while queued

  try {
    await setStatus(doc.id, 'parsing');
    const path = uploadPath(doc.storage_name);
    const kind = await sniffFile(path, doc.original_name);
    if (!kind) throw new Error('Unsupported file: expected a PDF, Markdown or plain-text document');
    const pages = await parseDocument(path, kind);
    const chunks = chunkPages(pages);
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
          `INSERT INTO chunks (document_id, system_id, ordinal, heading, page_start, page_end, content,
                               token_count, embedding, embedding_model)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10)`,
          [
            doc.id,
            doc.system_id,
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
}
