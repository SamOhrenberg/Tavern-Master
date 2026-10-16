import { migrate } from './migrate.js';
import { closeDb, waitForDb } from './pool.js';

await waitForDb();
const applied = await migrate();
console.warn(applied.length ? `applied: ${applied.join(', ')}` : 'schema is up to date');
await closeDb();
