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
 * Which chunks a search may see, as a WHERE clause over `c` (chunks) and `d`
 * (documents). Built only from the server's own records, so a scope is the
 * one place that decides what a search can reach.
 */
interface Scope {
  where: string;
  params: unknown[];
}

/**
 * A library system's rulebooks, plus one campaign's own house-rule documents
 * when given. Setting/flavour documents are excluded here: their voice is read
 * separately and must never be retrieved as if it were a rule.
 */
export function rulesScope(systemId: string, campaignId?: string): Scope {
  return campaignId
    ? {
        where: `c.system_id = $1 AND ((c.campaign_id IS NULL AND d.kind IS DISTINCT FROM 'setting')
                 OR (c.campaign_id = $2 AND d.kind = 'rules'))`,
        params: [systemId, campaignId],
      }
    : {
        where: `c.system_id = $1 AND c.campaign_id IS NULL AND d.kind IS DISTINCT FROM 'setting'`,
        params: [systemId],
      };
}

/** A library system's setting/flavour documents only, kept apart from its rules. */
export function settingScope(systemId: string): Scope {
  return {
    where: `c.system_id = $1 AND c.campaign_id IS NULL AND d.kind = 'setting'`,
    params: [systemId],
  };
}

/** One campaign's uploaded documents. `tableOnly` hides what was marked for the GM alone. */
export function campaignScope(campaignId: string, tableOnly: boolean): Scope {
  return {
    where: `c.campaign_id = $1${tableOnly ? ` AND d.audience = 'table'` : ''}`,
    params: [campaignId],
  };
}

const FROM = 'FROM chunks c JOIN documents d ON d.id = c.document_id';

async function hybrid(scope: Scope, query: string, k: number, emb: Embedder | undefined): Promise<RuleHit[]> {
  const lists: number[][] = [];
  const n = scope.params.length;

  const tsq = keywordQuery(query);
  if (tsq) {
    const rows = await q<{ id: number }>(
      `SELECT c.id ${FROM}, to_tsquery('english', $${n + 1}) AS query
        WHERE ${scope.where} AND c.tsv @@ query
        ORDER BY ts_rank_cd(c.tsv, query) DESC, c.id LIMIT 20`,
      [...scope.params, tsq],
    );
    lists.push(rows.map((r) => r.id));
  }

  if (emb) {
    try {
      const [vec] = await emb.embed([query], 'query');
      if (vec) {
        const rows = await q<{ id: number }>(
          `SELECT c.id ${FROM}
            WHERE ${scope.where} AND c.embedding_model = $${n + 1} AND c.embedding IS NOT NULL
            ORDER BY c.embedding <=> $${n + 2}::vector LIMIT 20`,
          [...scope.params, emb.model, toVector(vec)],
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
  // The scope is applied again here, so an id can never widen what comes back.
  const rows = await q<ChunkRow>(
    `SELECT c.id, c.heading, c.page_start, c.content, d.title ${FROM}
      WHERE ${scope.where} AND c.id = ANY($${n + 1}::bigint[])`,
    [...scope.params, ranked.map((r) => r.id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ranked.flatMap(({ id, score }) => {
    const r = byId.get(id);
    return r
      ? [{ chunkId: r.id, document: r.title, heading: r.heading, page: r.page_start, text: r.content, score }]
      : [];
  });
}

/**
 * Hybrid search over ONE game system. `systemId` and `campaignId` always come
 * from the server's own records (the campaign row), never from model or
 * client input, which is what keeps one table's material out of another's.
 */
export async function searchRules(
  systemId: string,
  query: string,
  k = 5,
  emb: Embedder | undefined = embedder('web'),
  campaignId?: string,
): Promise<RuleHit[]> {
  return hybrid(rulesScope(systemId, campaignId), query, k, emb);
}

/** Hybrid search over a system's setting/flavour documents (voice and colour, not rules). */
export async function searchSetting(
  systemId: string,
  query: string,
  k = 4,
  emb: Embedder | undefined = embedder('web'),
): Promise<RuleHit[]> {
  return hybrid(settingScope(systemId), query, k, emb);
}

/** Hybrid search over the documents uploaded to one campaign. */
export async function searchCampaignDocs(
  campaignId: string,
  query: string,
  k = 4,
  tableOnly = false,
  emb: Embedder | undefined = embedder('web'),
): Promise<RuleHit[]> {
  return hybrid(campaignScope(campaignId, tableOnly), query, k, emb);
}
