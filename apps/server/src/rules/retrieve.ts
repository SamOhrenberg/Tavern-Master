import type { RuleHit } from '@tavern/protocol';
import { q } from '../db/pool.js';
import { log } from '../log.js';
import { embedder, toVector, type Embedder } from './embed.js';

const STOP = new Set(
  'the and for are but not you all any can had her was one our out has him his how its may new now see two who did get use that this with from they will have what when your which their there would about could should into than then them these those does'.split(
    ' ',
  ),
);

/** Turn free text into an OR query for to_tsquery. Only [a-z0-9] survives, so it is safe to pass on. */
export function keywordQuery(text: string): string {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 24).join(' | ');
}

/**
 * Reciprocal rank fusion: each list votes 1/(60 + rank) for its results.
 * Works without having to make keyword and cosine scores comparable.
 */
export function fuse(lists: number[][], k: number): { id: number; score: number }[] {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1)));
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, k);
}

interface ChunkRow {
  id: number;
  heading: string;
  page_start: number | null;
  content: string;
  title: string;
}

/**
 * Hybrid search over ONE game system. `systemId` always comes from the
 * server's own records (the campaign row), never from model or client input,
 * which is what keeps one system's rules out of another's campaign.
 */
export async function searchRules(
  systemId: string,
  query: string,
  k = 5,
  emb: Embedder | undefined = embedder('web'),
): Promise<RuleHit[]> {
  const lists: number[][] = [];

  const tsq = keywordQuery(query);
  if (tsq) {
    const rows = await q<{ id: number }>(
      `SELECT id FROM chunks, to_tsquery('english', $2) AS query
        WHERE system_id = $1 AND tsv @@ query
        ORDER BY ts_rank_cd(tsv, query) DESC, id LIMIT 20`,
      [systemId, tsq],
    );
    lists.push(rows.map((r) => r.id));
  }

  if (emb) {
    try {
      const [vec] = await emb.embed([query], 'query');
      if (vec) {
        const rows = await q<{ id: number }>(
          `SELECT id FROM chunks
            WHERE system_id = $1 AND embedding_model = $2 AND embedding IS NOT NULL
            ORDER BY embedding <=> $3::vector LIMIT 20`,
          [systemId, emb.model, toVector(vec)],
        );
        lists.push(rows.map((r) => r.id));
      }
    } catch (err) {
      // Worker down or model still downloading: keyword search still answers.
      log().warn({ err }, 'semantic search unavailable, using keyword search only');
    }
  }

  const ranked = fuse(lists, k);
  if (!ranked.length) return [];
  const rows = await q<ChunkRow>(
    `SELECT c.id, c.heading, c.page_start, c.content, d.title
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.system_id = $1 AND c.id = ANY($2::bigint[])`,
    [systemId, ranked.map((r) => r.id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ranked.flatMap(({ id, score }) => {
    const r = byId.get(id);
    return r
      ? [{ chunkId: r.id, document: r.title, heading: r.heading, page: r.page_start, text: r.content, score }]
      : [];
  });
}
