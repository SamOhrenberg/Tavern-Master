import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { chunkPages } from '../src/rules/chunk.js';
import type { Embedder } from '../src/rules/embed.js';
import { sniff } from '../src/rules/parse.js';
import { fuse, keywordQuery, searchRules } from '../src/rules/retrieve.js';

describe('retrieval helpers', () => {
  it('builds a safe OR query from free text', () => {
    expect(keywordQuery('How does a Grapple work?')).toBe('grapple | work');
    expect(keywordQuery("x'); DROP TABLE chunks; -- & | ! :*")).toBe('drop | table | chunks');
    expect(keywordQuery('?? !!')).toBe('');
  });

  it('fuses rankings so agreement between lists wins', () => {
    const ranked = fuse(
      [
        [1, 2, 3],
        [3, 4, 1],
      ],
      3,
    );
    expect(ranked.map((r) => r.id)).toEqual([1, 3, 2]);
    expect(fuse([], 5)).toEqual([]);
  });

  it('chunks by heading and keeps the heading trail and pages', () => {
    const chunks = chunkPages([
      {
        page: 1,
        text: '# Combat\n\nIntro to combat goes here, long enough to keep.\n\n## Making an Attack\n\nRoll a d20 and add your modifiers to hit.',
      },
      { page: 2, text: 'GRAPPLING\n\nYou can use the Attack action to grapple a creature.' },
    ]);
    expect(chunks.map((c) => c.heading)).toEqual([
      'Combat',
      'Combat › Making an Attack',
      'Combat › Making an Attack › GRAPPLING',
    ]);
    expect(chunks[2]).toMatchObject({ pageStart: 2, pageEnd: 2, ordinal: 2 });
    const long = chunkPages([
      {
        page: null,
        text: Array.from({ length: 80 }, (_, i) => `Sentence number ${i} about the rules of the game.`).join(
          ' ',
        ),
      },
    ]);
    expect(long.length).toBeGreaterThan(1);
    expect(Math.max(...long.map((c) => c.content.length))).toBeLessThanOrEqual(2200);
  });

  it('identifies files by content, not by claimed type', () => {
    expect(sniff(Buffer.from('%PDF-1.7 rest'), 'rules.txt')).toBe('pdf');
    expect(sniff(Buffer.from('# Rules\nRoll dice.'), 'rules.md')).toBe('text');
    expect(sniff(Buffer.from('plain words — with unicode ✓'), 'notes.txt')).toBe('text');
    expect(sniff(Buffer.from('MZ\x90\x00\x03\x00'), 'rules.md')).toBeUndefined();
    expect(sniff(Buffer.from('<html><script>alert(1)</script>'), 'page.html')).toBeUndefined();
    expect(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]), 'rules.txt')).toBeUndefined();
  });
});

// Needs a real Postgres with pgvector (CI provides one; locally: docker compose -f docker-compose.dev.yml up -d).
describe.skipIf(!process.env.TEST_DATABASE_URL)('rules retrieval scoping (database)', () => {
  const tag = `t${Date.now().toString(36)}`;
  let fantasy = '';
  let scifi = '';

  // A toy embedder: axis 0 means "swords", axis 1 means "lasers".
  const emb: Embedder = {
    model: `toy-${tag}`,
    embed: async (texts) =>
      texts.map((t) => [
        /sword|blade|melee/i.test(t) ? 1 : 0.01,
        /laser|blaster|plasma/i.test(t) ? 1 : 0.01,
        0.01,
      ]),
  };

  async function addSystem(slug: string, chunks: { heading: string; content: string }[]): Promise<string> {
    const sys = await q1<{ id: string }>(
      `INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`,
      [slug, slug],
    );
    const doc = await q1<{ id: string }>(
      `INSERT INTO documents (system_id, title, original_name, storage_name, mime, size_bytes, sha256, status)
       VALUES ($1, $2, 'x.md', $3, 'text/markdown', 1, 'x', 'ready') RETURNING id`,
      [sys!.id, `${slug} rulebook`, `${slug}-file`],
    );
    const vectors = await emb.embed(
      chunks.map((c) => c.content),
      'passage',
    );
    for (const [i, c] of chunks.entries()) {
      await q(
        `INSERT INTO chunks (document_id, system_id, ordinal, heading, content, embedding, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7)`,
        [doc!.id, sys!.id, i, c.heading, c.content, `[${vectors[i]!.join(',')}]`, emb.model],
      );
    }
    return sys!.id;
  }

  beforeAll(async () => {
    setConfigForTests(testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }));
    await migrate();
    fantasy = await addSystem(`fantasy-${tag}`, [
      { heading: 'Melee', content: 'A sword attack uses a d20 plus your strength modifier.' },
      { heading: 'Resting', content: 'A long rest restores all hit points.' },
    ]);
    scifi = await addSystem(`scifi-${tag}`, [
      { heading: 'Ranged', content: 'A laser attack uses 2d6 under your blaster skill.' },
      { heading: 'Melee', content: 'A plasma sword attack ignores armour.' },
    ]);
  });

  afterAll(async () => {
    await q('DELETE FROM game_systems WHERE id = ANY($1::uuid[])', [[fantasy, scifi]]);
    await closeDb();
  });

  it('keyword search returns only the requested system', async () => {
    const hits = await searchRules(fantasy, 'sword attack', 5, undefined);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.document === `fantasy-${tag} rulebook`)).toBe(true);
    expect(hits[0]!.text).toContain('strength modifier');
  });

  it('vector search returns only the requested system', async () => {
    // "blade" matches no keyword in either system, so only the embedding can find it.
    const fantasyHits = await searchRules(fantasy, 'blade', 5, emb);
    expect(fantasyHits.map((h) => h.document)).toEqual(expect.arrayContaining([`fantasy-${tag} rulebook`]));
    expect(fantasyHits.every((h) => h.document === `fantasy-${tag} rulebook`)).toBe(true);
    expect(fantasyHits[0]!.heading).toBe('Melee');

    const scifiHits = await searchRules(scifi, 'laser sword attack', 5, emb);
    expect(scifiHits.length).toBe(2);
    expect(scifiHits.every((h) => h.document === `scifi-${tag} rulebook`)).toBe(true);
  });

  it('returns nothing for a system with no documents', async () => {
    expect(await searchRules('00000000-0000-4000-8000-000000000000', 'sword attack', 5, emb)).toEqual([]);
  });
});
