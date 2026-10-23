import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { q1, tx, closeDb, waitForDb } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { enqueue } from './jobs/queue.js';
import { log } from './log.js';
import { ensureDataDirs, newStorageName, uploadPath, uploadsDir } from './storage.js';

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');

export const SRD_SLUG = 'dnd5e-srd';

const SRD_SHEET_TEMPLATE = {
  abilities: ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'],
  fields: [
    { key: 'class', label: 'Class' },
    { key: 'level', label: 'Level' },
    { key: 'species', label: 'Species' },
    { key: 'background', label: 'Background' },
    { key: 'armorClass', label: 'Armor Class' },
    { key: 'speed', label: 'Speed' },
    { key: 'proficiencies', label: 'Proficiencies' },
    { key: 'features', label: 'Features & spells' },
  ],
};

/**
 * Create the starter game system with a short SRD rules excerpt and queue it
 * for ingestion. Idempotent: does nothing if the system already exists.
 */
export async function seedSrdSystem(): Promise<boolean> {
  if (await q1('SELECT 1 FROM game_systems WHERE slug = $1', [SRD_SLUG])) return false;

  const fileName = 'srd-5.1-core-rules.md';
  const content = await readFile(join(SEED_DIR, fileName));
  const storageName = newStorageName();
  await ensureDataDirs(uploadsDir());
  await writeFile(uploadPath(storageName), content, { mode: 0o600 });

  await tx(async (client) => {
    const system = await q1<{ id: string }>(
      `INSERT INTO game_systems (slug, name, description, sheet_template)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        SRD_SLUG,
        'D&D 5e (SRD 5.1)',
        'Fifth edition core rules from the System Reference Document 5.1 (CC-BY-4.0). ' +
          'Seeded with a short excerpt; upload the full SRD for complete coverage.',
        JSON.stringify(SRD_SHEET_TEMPLATE),
      ],
      client,
    );
    const doc = await q1<{ id: string }>(
      `INSERT INTO documents (system_id, title, original_name, storage_name, mime, size_bytes, sha256)
       VALUES ($1, $2, $3, $4, 'text/markdown', $5, $6) RETURNING id`,
      [
        system!.id,
        'SRD 5.1 Core Rules Excerpt',
        fileName,
        storageName,
        content.length,
        createHash('sha256').update(content).digest('hex'),
      ],
      client,
    );
    await enqueue('ingest_document', { documentId: doc!.id }, {}, client);
  });
  log().info('seeded starter system "D&D 5e (SRD 5.1)"');
  return true;
}

/** First boot only: seed when the library is completely empty. */
export async function seedIfEmpty(): Promise<void> {
  if (await q1('SELECT 1 FROM game_systems LIMIT 1')) return;
  await seedSrdSystem().catch((err) => log().error({ err }, 'seeding failed'));
}

// `npm run seed`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await waitForDb();
  await migrate();
  const created = await seedSrdSystem();
  console.warn(created ? 'seeded D&D 5e (SRD 5.1)' : 'starter system already present');
  await closeDb();
}
