import pg from 'pg';
import { config } from '../config.js';
import { q, q1, type Queryable } from '../db/pool.js';
import { log } from '../log.js';

/**
 * Work waiting for a Dungeon Master outside the server: everything Claude is
 * asked to do in a Claude campaign except gathered turns, which stay on the
 * room's in-memory desk. One item is open per subject, and at most one item
 * per campaign is claimed at a time, so Claude does one thing at a time.
 */

export type WorkKind = 'guide' | 'sheet' | 'catalogue' | 'chronicle';
export const WORK_KINDS: WorkKind[] = ['guide', 'sheet', 'catalogue', 'chronicle'];
export type WorkStatus = 'waiting' | 'claimed' | 'done' | 'failed' | 'cancelled';

export interface WorkItem {
  id: string;
  campaignId: string;
  kind: WorkKind;
  subjectId: string;
  requestedBy: string | null;
  payload: Record<string, unknown>;
  status: WorkStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
}

interface Row {
  id: string;
  campaign_id: string;
  kind: WorkKind;
  subject_id: string;
  requested_by: string | null;
  payload: Record<string, unknown>;
  status: WorkStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: Date;
  claimed_at: Date | null;
  finished_at: Date | null;
}

const COLUMNS = `id, campaign_id, kind, subject_id, requested_by, payload, status, result, error,
                 created_at, claimed_at, finished_at`;

const toItem = (r: Row): WorkItem => ({
  id: r.id,
  campaignId: r.campaign_id,
  kind: r.kind,
  subjectId: r.subject_id,
  requestedBy: r.requested_by,
  payload: r.payload ?? {},
  status: r.status,
  result: r.result,
  error: r.error,
  createdAt: r.created_at,
  claimedAt: r.claimed_at,
  finishedAt: r.finished_at,
});

export const WORK_CHANNEL = 'dm_work';

/** Claim order: a waiting player first, then the bookkeeping. Turns and the opening outrank all of it. */
const PRIORITY = `CASE kind WHEN 'guide' THEN 0 WHEN 'sheet' THEN 1 WHEN 'chronicle' THEN 2 ELSE 3 END`;

let localHook: ((campaignId: string) => void) | null = null;
/** Called in this process whenever work for a campaign changes, beside the NOTIFY for other processes. */
export function onWorkChanged(fn: (campaignId: string) => void): void {
  localHook = fn;
}

async function changed(campaignId: string, client?: Queryable): Promise<void> {
  await q('SELECT pg_notify($1, $2)', [WORK_CHANNEL, campaignId], client);
  // Inside a transaction the NOTIFY waits for the commit; the local hook would run too early.
  if (!client) localHook?.(campaignId);
}

/**
 * Queue work unless an item is already open for the same subject. Returns the
 * new item's id, or null when one was already waiting. Safe from the worker.
 */
export async function queueWork(
  args: {
    campaignId: string;
    kind: WorkKind;
    subjectId: string;
    requestedBy?: string | null;
    payload?: Record<string, unknown>;
  },
  client?: Queryable,
): Promise<string | null> {
  const row = await q1<{ id: string }>(
    `INSERT INTO dm_work (campaign_id, kind, subject_id, requested_by, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (campaign_id, kind, subject_id) WHERE status IN ('waiting', 'claimed') DO NOTHING
     RETURNING id`,
    [
      args.campaignId,
      args.kind,
      args.subjectId,
      args.requestedBy ?? null,
      JSON.stringify(args.payload ?? {}),
    ],
    client,
  );
  if (row) await changed(args.campaignId, client);
  return row?.id ?? null;
}

/** The request Claude holds for this campaign, if any. */
export async function currentWork(campaignId: string): Promise<WorkItem | null> {
  const row = await q1<Row>(
    `SELECT ${COLUMNS} FROM dm_work WHERE campaign_id = $1 AND status = 'claimed'
      ORDER BY claimed_at LIMIT 1`,
    [campaignId],
  );
  return row ? toItem(row) : null;
}

export async function getWork(id: string): Promise<WorkItem | null> {
  const row = await q1<Row>(`SELECT ${COLUMNS} FROM dm_work WHERE id = $1`, [id]);
  return row ? toItem(row) : null;
}

/**
 * The request Claude holds, if any, else the next waiting one by priority,
 * now claimed. Claiming is a single statement, so two calls racing for the
 * same campaign cannot both claim.
 */
export async function claimNext(campaignId: string): Promise<{ item: WorkItem; fresh: boolean } | null> {
  const held = await currentWork(campaignId);
  if (held) return { item: held, fresh: false };
  const row = await q1<Row>(
    `UPDATE dm_work SET status = 'claimed', claimed_at = now()
      WHERE id = (SELECT id FROM dm_work
                   WHERE campaign_id = $1 AND status = 'waiting'
                     AND NOT EXISTS (SELECT 1 FROM dm_work c WHERE c.campaign_id = $1 AND c.status = 'claimed')
                   ORDER BY ${PRIORITY}, created_at LIMIT 1
                   FOR UPDATE SKIP LOCKED)
      RETURNING ${COLUMNS}`,
    [campaignId],
  ).catch((err: { code?: string }) => {
    // Lost a race to the unique index: someone else claimed meanwhile.
    if (err.code === '23505') return undefined;
    throw err;
  });
  if (!row) {
    const now = await currentWork(campaignId);
    return now ? { item: now, fresh: false } : null;
  }
  await changed(campaignId);
  return { item: toItem(row), fresh: true };
}

/** Record what a claimed request covers, decided at claim time. */
export async function setWorkPayload(id: string, payload: Record<string, unknown>): Promise<void> {
  await q('UPDATE dm_work SET payload = $2 WHERE id = $1', [id, JSON.stringify(payload)]);
}

async function settle(
  id: string,
  status: 'done' | 'failed',
  result: unknown,
  error: string | null,
): Promise<WorkItem | null> {
  const row = await q1<Row>(
    `UPDATE dm_work SET status = $2, result = $3, error = $4, finished_at = now()
      WHERE id = $1 AND status IN ('waiting', 'claimed') RETURNING ${COLUMNS}`,
    [id, status, result === undefined ? null : JSON.stringify(result), error],
  );
  if (row) await changed(row.campaign_id);
  return row ? toItem(row) : null;
}

/** Drop an item that turned out to have nothing left to do. */
export async function dropWork(id: string): Promise<void> {
  const row = await q1<{ campaign_id: string }>(
    `UPDATE dm_work SET status = 'cancelled', finished_at = now()
      WHERE id = $1 AND status IN ('waiting', 'claimed') RETURNING campaign_id`,
    [id],
  );
  if (row) await changed(row.campaign_id);
}

export const finishWork = (id: string, result: unknown = {}) => settle(id, 'done', result, null);
export const failWork = (id: string, error: string) => settle(id, 'failed', null, error.slice(0, 500));

/** Cancel open work of the given kinds (all by default). Returns what was cancelled. */
export async function cancelWork(campaignId: string, kinds: WorkKind[] = WORK_KINDS): Promise<WorkItem[]> {
  const rows = await q<Row>(
    `UPDATE dm_work SET status = 'cancelled', finished_at = now()
      WHERE campaign_id = $1 AND kind = ANY($2::text[]) AND status IN ('waiting', 'claimed')
      RETURNING ${COLUMNS}`,
    [campaignId, kinds],
  );
  if (rows.length) await changed(campaignId);
  return rows.map(toItem);
}

/** Open work for a campaign, oldest first. */
export async function openWork(campaignId: string): Promise<WorkItem[]> {
  const rows = await q<Row>(
    `SELECT ${COLUMNS} FROM dm_work WHERE campaign_id = $1 AND status IN ('waiting', 'claimed')
      ORDER BY ${PRIORITY}, created_at`,
    [campaignId],
  );
  return rows.map(toItem);
}

export async function openCount(campaignId: string): Promise<number> {
  const row = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM dm_work WHERE campaign_id = $1 AND status IN ('waiting', 'claimed')`,
    [campaignId],
  );
  return row?.n ?? 0;
}

/** Everything claimed for the campaign goes back to waiting. */
export async function releaseClaims(campaignId: string): Promise<number> {
  const rows = await q(
    `UPDATE dm_work SET status = 'waiting', claimed_at = NULL
      WHERE campaign_id = $1 AND status = 'claimed' RETURNING id`,
    [campaignId],
  );
  if (rows.length) await changed(campaignId);
  return rows.length;
}

/**
 * Claimed items untouched for CONNECTOR_CLAIM_TIMEOUT_MINUTES go back to
 * waiting. "Untouched" means the campaign has not seen its outside DM for
 * that long either, so a request Claude is still working through is kept.
 */
export async function releaseStale(campaignId: string): Promise<void> {
  const rows = await q(
    `UPDATE dm_work w SET status = 'waiting', claimed_at = NULL
       FROM campaigns c
      WHERE w.campaign_id = $1 AND c.id = w.campaign_id AND w.status = 'claimed'
        AND w.claimed_at < now() - make_interval(mins => $2)
        AND (c.dm_seen_at IS NULL OR c.dm_seen_at < now() - make_interval(mins => $2))
      RETURNING w.id`,
    [campaignId, config().CONNECTOR_CLAIM_TIMEOUT_MINUTES],
  );
  if (rows.length) await changed(campaignId);
}

/** When the last request for this campaign was finished, if ever. */
export async function lastFinishedAt(campaignId: string): Promise<Date | null> {
  const row = await q1<{ at: Date | null }>(
    `SELECT max(finished_at) AS at FROM dm_work WHERE campaign_id = $1 AND status = 'done'`,
    [campaignId],
  );
  return row?.at ?? null;
}

/**
 * LISTEN for work queued by any process (the worker catalogues documents and
 * queues the chronicle) and call back with the campaign id. Reconnects if the
 * connection drops.
 */
export async function listenForWork(onWork: (campaignId: string) => void): Promise<void> {
  let stopping = false;
  const connect = async () => {
    const client = new pg.Client({
      connectionString: config().DATABASE_URL,
      application_name: 'tavern-dm-work-listen',
    });
    client.on('notification', (n) => {
      if (n.channel === WORK_CHANNEL && n.payload) onWork(n.payload);
    });
    client.on('error', () => undefined);
    client.on('end', () => {
      if (!stopping) setTimeout(() => void connect().catch(() => undefined), 5000);
    });
    await client.connect();
    await client.query(`LISTEN ${WORK_CHANNEL}`);
  };
  process.once('beforeExit', () => {
    stopping = true;
  });
  await connect().catch((err) =>
    log().warn({ err }, 'LISTEN for DM work failed; rooms refresh on their own'),
  );
}
