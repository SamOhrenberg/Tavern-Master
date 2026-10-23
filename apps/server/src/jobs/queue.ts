import { q, q1, type Queryable } from '../db/pool.js';

export type JobKind = 'ingest_document' | 'summarize_campaign';

export interface Job<P = Record<string, unknown>> {
  id: number;
  kind: JobKind;
  payload: P;
  attempts: number;
  max_attempts: number;
}

export const JOBS_CHANNEL = 'tavern_jobs';

/** Add a job. Pass a transaction client to enqueue atomically with other writes. */
export async function enqueue(
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { delaySeconds?: number; maxAttempts?: number } = {},
  on?: Queryable,
): Promise<number> {
  const row = await q1<{ id: number }>(
    `INSERT INTO jobs (kind, payload, run_at, max_attempts)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4) RETURNING id`,
    [kind, JSON.stringify(payload), opts.delaySeconds ?? 0, opts.maxAttempts ?? 3],
    on,
  );
  // Wake the worker now instead of waiting for its next poll.
  await q(`SELECT pg_notify($1, '')`, [JOBS_CHANNEL], on);
  return row!.id;
}

/** Atomically claim the next due job. SKIP LOCKED lets several workers coexist. */
export async function claim(workerId: string): Promise<Job | undefined> {
  return q1<Job>(
    `UPDATE jobs
        SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'queued' AND run_at <= now()
         ORDER BY run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING id, kind, payload, attempts, max_attempts`,
    [workerId],
  );
}

export async function complete(id: number): Promise<void> {
  await q(`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1`, [id]);
}

/** Record a failure. Retries with exponential backoff until max_attempts. Returns true if it will retry. */
export async function fail(job: Job, error: string, retryable = true): Promise<boolean> {
  const willRetry = retryable && job.attempts < job.max_attempts;
  const backoff = Math.min(600, 15 * 2 ** (job.attempts - 1));
  await q(
    `UPDATE jobs
        SET status = $2, last_error = $3, locked_at = NULL, locked_by = NULL,
            run_at = now() + make_interval(secs => $4),
            finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
      WHERE id = $1`,
    [job.id, willRetry ? 'queued' : 'failed', error.slice(0, 2000), willRetry ? backoff : 0],
  );
  return willRetry;
}

/** Jobs whose worker died mid-run go back to the queue. */
export async function requeueStale(olderThanMinutes = 15): Promise<number> {
  const rows = await q(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL
      WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1) RETURNING id`,
    [olderThanMinutes],
  );
  return rows.length;
}

/** Is there already a pending job of this kind for this payload key? */
export async function hasPending(kind: JobKind, key: string, value: string): Promise<boolean> {
  const row = await q1(
    `SELECT 1 FROM jobs WHERE kind = $1 AND status IN ('queued', 'running') AND payload->>$2 = $3 LIMIT 1`,
    [kind, key, value],
  );
  return !!row;
}
