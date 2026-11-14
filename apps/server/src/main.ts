import { buildApp } from './app.js';
import { ensureAdmin } from './auth/bootstrap.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { closeDb, waitForDb } from './db/pool.js';
import { log } from './log.js';
import { failStaleTurns, sweepRooms } from './realtime/room.js';
import { seedIfEmpty } from './seed.js';

async function main(): Promise<void> {
  const cfg = config();
  await waitForDb();
  await migrate();
  await ensureAdmin();
  await seedIfEmpty();
  await failStaleTurns();

  const app = await buildApp();
  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  // Rooms opened only by the connector have no socket to close them.
  setInterval(sweepRooms, 10 * 60_000).unref();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log().info({ signal }, 'shutting down');
    // Give in-flight requests a moment, then exit regardless.
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await app.close().catch(() => undefined);
    await closeDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  log().fatal({ err }, 'failed to start');
  process.exit(1);
});
