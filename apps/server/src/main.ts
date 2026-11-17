import { buildApp } from './app.js';
import { ensureAdmin } from './auth/bootstrap.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { closeDb, waitForDb } from './db/pool.js';
import { log } from './log.js';
import { listenForWork } from './connector/work.js';
import { releaseHeld } from './notify/notify.js';
import { sweepOAuth } from './oauth/clients.js';
import { failStaleTurns, getRoom, sweepRooms } from './realtime/room.js';
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
  // The worker queues work for Claude too (documents, the chronicle); wake the room when it does.
  await listenForWork((campaignId) => void getRoom(campaignId)?.workChanged());
  // Rooms opened only by the connector have no socket to close them.
  // Quiet hours that have ended let out what they held.
  setInterval(() => void releaseHeld(), 60_000).unref();
  setInterval(() => {
    sweepRooms();
    // Sign-ins nobody finished.
    void sweepOAuth().catch((err) => log().warn({ err }, 'could not sweep sign-in requests'));
  }, 10 * 60_000).unref();

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
