import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, q } from './pool.js';
import { log } from '../log.js';

// migrations/ sits next to src/ in development and next to dist/ in the image.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const LOCK_ID = 7_316_001;

export async function listMigrations(dir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
}

/**
 * Apply pending SQL migrations in filename order. An advisory lock makes
 * concurrent starters (web + worker) safe: one applies, the other waits.
 */
export async function migrate(dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await db().connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set((await q<{ name: string }>('SELECT name FROM schema_migrations', [], client)).map((r) => r.name));
    for (const file of await listMigrations(dir)) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
      log().info({ migration: file }, 'applied migration');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}

/** Used by the worker: block until the web process has migrated the schema. */
export async function waitForSchema(attempts = 60, delayMs = 2000): Promise<void> {
  const wanted = await listMigrations();
  for (let i = 1; ; i++) {
    try {
      const rows = await q<{ name: string }>('SELECT name FROM schema_migrations');
      const have = new Set(rows.map((r) => r.name));
      if (wanted.every((m) => have.has(m))) return;
    } catch {
      // table not created yet
    }
    if (i >= attempts) throw new Error('timed out waiting for database migrations');
    await new Promise((r) => setTimeout(r, delayMs));
  }
}
