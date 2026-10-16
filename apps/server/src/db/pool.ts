import pg from 'pg';
import { config } from '../config.js';

// Return bigint columns (bigserial ids, token sums) as JS numbers. Values here
// stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'tavern',
    });
    // An idle client erroring (db restart) must not crash the process.
    pool.on('error', () => undefined);
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  const p = pool;
  pool = undefined;
  await p?.end();
}

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/** Run a query and return its rows. All SQL in the app is parameterised. */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  on: Queryable = db(),
): Promise<T[]> {
  const res = await on.query<T>(text, params);
  return res.rows;
}

export async function q1<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  on: Queryable = db(),
): Promise<T | undefined> {
  return (await q<T>(text, params, on))[0];
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function waitForDb(attempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await db().query('SELECT 1');
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
