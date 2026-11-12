import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changesSince, compileBrief, refreshBrief } from '../src/agent/brief.js';
import { scopeEntity } from '../src/agent/codex.js';
import { briefAndChanges, recentHistory } from '../src/agent/context.js';
import { pgStore } from '../src/agent/store.js';
import { setConfigForTests, testConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb, q, q1 } from '../src/db/pool.js';
import { applyDraft, createCharacter, deleteCharacter, setControl, updateCharacter } from '../src/party.js';
import { distilLore } from '../src/rules/lore.js';
import { searchCampaignDocs, searchRules } from '../src/rules/retrieve.js';

// Needs a real Postgres with pgvector, like the retrieval tests.
describe.skipIf(!process.env.TEST_DATABASE_URL)('party, documents and records (database)', () => {
  const tag = `p${Date.now().toString(36)}`;
  let system = '';
  let camp = '';
  let other = '';
  let host = '';
  let ann = '';
  let bob = '';

  const user = async (name: string) =>
    (await q1<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}-${tag}`, name],
    ))!.id;
  const campaign = async (name: string, members: string[]) => {
    const id = (await q1<{ id: string }>(
      `INSERT INTO campaigns (system_id, owner_id, name) VALUES ($1, $2, $3) RETURNING id`,
      [system, host, name],
    ))!.id;
    await q(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, host]);
    for (const m of members)
      await q('INSERT INTO campaign_members (campaign_id, user_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const doc = async (
    campaignId: string | null,
    title: string,
    content: string,
    extra: { kind?: string; audience?: string } = {},
  ) => {
    const d = await q1<{ id: string }>(
      `INSERT INTO documents (system_id, campaign_id, title, original_name, storage_name, mime, size_bytes,
                              sha256, status, kind, audience, summary, processed_at)
       VALUES ($1, $2, $3, 'x.md', $4, 'text/markdown', 1, 'x', 'ready', $5, $6, 'About things.', now())
       RETURNING id`,
      [
        system,
        campaignId,
        title,
        `${tag}-${title}`.replace(/\W/g, ''),
        extra.kind ?? null,
        extra.audience ?? 'table',
      ],
    );
    await q(
      `INSERT INTO chunks (document_id, system_id, campaign_id, ordinal, heading, content) VALUES ($1, $2, $3, 0, '', $4)`,
      [d!.id, system, campaignId, content],
    );
  };
  const body = (name: string) => ({ name, maxHp: 10, sheet: {} });

  beforeAll(async () => {
    setConfigForTests(testConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }));
    await migrate();
    system = (await q1<{ id: string }>(`INSERT INTO game_systems (slug, name) VALUES ($1, $2) RETURNING id`, [
      `sys-${tag}`,
      `sys-${tag}`,
    ]))!.id;
    host = await user('Host');
    ann = await user('Ann');
    bob = await user('Bob');
    camp = await campaign('Ashen Crown', [ann, bob]);
    other = await campaign('Other Table', []);
  });

  afterAll(async () => {
    await q('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [[camp, other]]);
    await q('DELETE FROM game_systems WHERE id = $1', [system]);
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[host, ann, bob]]);
    await closeDb();
  });

  it('starts new campaigns in the prep phase', async () => {
    expect(await q1('SELECT phase, opened_at FROM campaigns WHERE id = $1', [camp])).toEqual({
      phase: 'prep',
      opened_at: null,
    });
  });

  it('lets a player make their own character and nothing else', async () => {
    const viewer = { userId: ann, role: 'player' as const };
    const id = await createCharacter(camp, viewer, body('Thorn'));
    const chars = await pgStore.characters(camp);
    expect(chars).toMatchObject([{ id, name: 'Thorn', kind: 'pc', controller: 'player', playerIds: [ann] }]);

    await expect(
      createCharacter(camp, viewer, body('Bram'), { kind: 'npc', controller: 'gm', playerIds: [] }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createCharacter(camp, viewer, body('Mira'), { kind: 'pc', controller: 'player', playerIds: [bob] }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(createCharacter(camp, viewer, body('thorn'))).rejects.toMatchObject({ status: 409 });
  });

  it('lets the owner add companions and hand characters to several players', async () => {
    const owner = { userId: host, role: 'owner' as const };
    const bram = await createCharacter(camp, owner, body('Bram'), {
      kind: 'npc',
      controller: 'agent',
      playerIds: [ann], // ignored: an AI-run character has no players
    });
    let chars = await pgStore.characters(camp);
    expect(chars.find((c) => c.id === bram)).toMatchObject({
      kind: 'npc',
      controller: 'agent',
      playerIds: [],
    });

    await setControl(camp, bram, { kind: 'npc', controller: 'player', playerIds: [ann, bob] });
    chars = await pgStore.characters(camp);
    expect(chars.find((c) => c.id === bram)!.playerIds.sort()).toEqual([ann, bob].sort());

    // Someone from outside the campaign cannot be given a character.
    const stranger = await user('Stranger');
    await expect(
      setControl(camp, bram, { kind: 'npc', controller: 'player', playerIds: [stranger] }),
    ).rejects.toMatchObject({ status: 400 });
    await q('DELETE FROM users WHERE id = $1', [stranger]);

    await setControl(camp, bram, { kind: 'npc', controller: 'gm', playerIds: [] });
    expect((await pgStore.characters(camp)).find((c) => c.id === bram)).toMatchObject({
      controller: 'gm',
      playerIds: [],
    });
  });

  it('keeps one player out of another player’s sheet, owner included', async () => {
    const thorn = (await pgStore.characters(camp)).find((c) => c.name === 'Thorn')!;
    const edit = { ...body('Thorn'), sheet: { Strength: 18 } };
    await expect(
      updateCharacter(camp, thorn.id, { userId: bob, role: 'player' }, edit),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      updateCharacter(camp, thorn.id, { userId: host, role: 'owner' }, edit),
    ).rejects.toMatchObject({
      status: 403,
    });
    await updateCharacter(camp, thorn.id, { userId: ann, role: 'player' }, { ...edit, privateNotes: 'shh' });
    expect((await pgStore.characters(camp)).find((c) => c.id === thorn.id)!.sheet).toEqual({ Strength: 18 });
    // A character from another campaign cannot be reached through this one.
    await expect(
      updateCharacter(other, thorn.id, { userId: host, role: 'owner' }, edit),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('merges what the guide saves into the sheet that is there', async () => {
    const viewer = { userId: bob, role: 'player' as const };
    await expect(applyDraft(camp, null, viewer, { max_hp: 12 })).rejects.toMatchObject({ status: 400 });
    const made = await applyDraft(camp, null, viewer, {
      name: 'Mira',
      max_hp: 12,
      fields: [{ field: 'Level', value: 1 }],
    });
    expect(made.created).toBe(true);
    await applyDraft(camp, made.id, viewer, {
      fields: [
        { field: 'level', value: 2 },
        { field: 'class', value: 'Wizard' },
      ],
      max_hp: 16,
      persona: 'Curious.',
    });
    const mira = (await pgStore.characters(camp)).find((c) => c.id === made.id)!;
    expect(mira).toMatchObject({
      name: 'Mira',
      sheet: { Level: 2, class: 'Wizard' },
      maxHp: 16,
      hp: 16, // was at full health, so stays at full health
      persona: 'Curious.',
      playerIds: [bob],
    });
    await expect(
      applyDraft(camp, made.id, { userId: ann, role: 'player' }, { persona: 'Mine now' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('unassigns a departing player’s character instead of deleting it', async () => {
    await q('DELETE FROM campaign_members WHERE campaign_id = $1 AND user_id = $2', [camp, bob]);
    const mira = (await pgStore.characters(camp)).find((c) => c.name === 'Mira')!;
    expect(mira).toMatchObject({ controller: 'player', playerIds: [] });
    // Now nobody's, so the owner may look after it and remove it.
    await deleteCharacter(camp, mira.id, { userId: host, role: 'owner' });
    expect((await pgStore.characters(camp)).some((c) => c.name === 'Mira')).toBe(false);
  });

  it('stores codex fields and withholds unrevealed secrets through scopeEntity', async () => {
    await pgStore.upsertEntity(camp, {
      kind: 'term',
      name: 'The Ashen Crown',
      aliases: ['The Grey Diadem'],
      summary: 'A lost relic of the old kings.',
      article: 'Said to crown whoever ends the long winter.',
      secret: 'It is a fake; the real crown sank with the fleet.',
      articleSecret: 'The forger left a maker’s mark inside the band.',
    });
    const row = (await pgStore.entities(camp)).find((e) => e.name === 'The Ashen Crown')!;
    expect(row).toMatchObject({
      kind: 'term',
      aliases: ['The Grey Diadem'],
      article: 'Said to crown whoever ends the long winter.',
      inCodex: true,
      secretRevealed: false,
    });

    // Scoped to a viewer: the player-visible article ships, the secret and its extension do not.
    const hidden = scopeEntity(row);
    expect(hidden.article).toContain('long winter');
    expect(hidden.secret).toBeUndefined();
    expect(hidden.articleSecret).toBeUndefined();

    // After the DM reveals it, both travel with the entry.
    await pgStore.revealSecret(camp, 'term', 'The Ashen Crown');
    const revealed = scopeEntity((await pgStore.entities(camp)).find((e) => e.name === 'The Ashen Crown')!);
    expect(revealed.secret).toContain('fake');
    expect(revealed.articleSecret).toContain('maker');
  });

  it('keeps campaign documents with their campaign', async () => {
    await doc(null, 'Core Rules', 'Grappling uses an athletics contest.');
    await doc(camp, 'House Rules', 'Grappling at this table always succeeds.', { kind: 'rules' });
    await doc(camp, 'World Guide', 'The Sunken Vault lies beneath the lake.', { kind: 'setting' });
    await doc(camp, 'The Module', 'The Sunken Vault holds the duke, who is a vampire.', {
      kind: 'adventure',
      audience: 'gm',
    });
    await doc(other, 'Other World', 'The Sunken Vault is a tavern in this other world.', { kind: 'setting' });

    // The library, and a campaign with no documents of its own, see only library rulebooks.
    const titles = async (p: ReturnType<typeof searchRules>) => (await p).map((h) => h.document).sort();
    expect(await titles(searchRules(system, 'grappling', 5, undefined))).toEqual(['Core Rules']);
    expect(await titles(searchRules(system, 'grappling vault', 5, undefined, camp))).toEqual([
      'Core Rules',
      'House Rules',
    ]);
    expect(await titles(searchRules(system, 'grappling vault', 5, undefined, other))).toEqual(['Core Rules']);

    expect(await titles(searchCampaignDocs(camp, 'sunken vault', 5, false, undefined))).toEqual([
      'The Module',
      'World Guide',
    ]);
    // The players' side of the table (the guide, companions) never sees DM-only material.
    expect(await titles(searchCampaignDocs(camp, 'sunken vault', 5, true, undefined))).toEqual([
      'World Guide',
    ]);
    expect(await titles(searchCampaignDocs(other, 'sunken vault', 5, false, undefined))).toEqual([
      'Other World',
    ]);
  });

  it('distils a system’s setting documents into its lore, and clears it when there are none', async () => {
    const lore = async () =>
      q1<{ lore: { voice: string } | null; lore_status: string }>(
        'SELECT lore, lore_status FROM game_systems WHERE id = $1',
        [system],
      );

    // No library setting documents yet: distilling leaves the system with none.
    await distilLore(system);
    expect(await lore()).toMatchObject({ lore: null, lore_status: 'none' });

    // A library (campaign-less) setting document gives the system a voice.
    await doc(null, 'Carl Chronicles', 'The System welcomes you to the Crawl. Loot awaits, meatbag.', {
      kind: 'setting',
    });
    await distilLore(system);
    const ready = await lore();
    expect(ready?.lore_status).toBe('ready');
    expect(ready?.lore?.voice).toMatch(/broadcast/i);
  });

  it('recalls what was said in this campaign only', async () => {
    const say = (id: string, kind: string, content: string, who: string | null = null) =>
      q(`INSERT INTO messages (campaign_id, kind, content, character_name) VALUES ($1, $2, $3, $4)`, [
        id,
        kind,
        content,
        who,
      ]);
    await say(camp, 'dm', 'The innkeeper introduces his daughter Wren, who keeps the ledger.');
    await say(camp, 'action', 'I ask Wren about the ledger.', 'Thorn');
    await say(camp, 'ooc', 'brb, the innkeeper of my house wants dinner');
    await say(other, 'dm', 'An innkeeper named Odo glares at you.');

    const hits = await pgStore.recall(camp, "innkeeper's daughter", 6);
    expect(hits.map((h) => h.where)).toEqual(['narration']);
    expect(hits[0]!.text).toContain('Wren');
    expect(JSON.stringify(await pgStore.recall(camp, 'ledger', 6))).toContain('Thorn');
    expect(await pgStore.recall(camp, 'Odo', 6)).toEqual([]);
    expect(await pgStore.recall(camp, '?? !!', 6)).toEqual([]);
  });

  it('labels a companion’s past actions when history is replayed', async () => {
    await q(
      `INSERT INTO messages (campaign_id, kind, content, character_name, meta) VALUES ($1, 'action', $2, 'Bram', '{"ai": true}')`,
      [camp, 'I hold the lantern high.'],
    );
    const text = JSON.stringify(await recentHistory(camp, null));
    expect(text).toContain('player=\\"AI companion\\" character=\\"Bram\\"');
  });

  it('compiles the brief once and sends later notes separately', async () => {
    await q(
      `UPDATE campaign_members SET wishes = 'More heists.\nNo spiders please.' WHERE campaign_id = $1 AND user_id = $2`,
      [camp, ann],
    );
    await pgStore.writeNote(camp, 'Story plan', 'The duke is a vampire.');
    await pgStore.remember(camp, { kind: 'promise', content: 'Thorn owes Wren a favour.', importance: 4 });

    const first = await briefAndChanges(camp);
    expect(first.changes).toBe('');
    expect(first.brief).toContain('- Ann: "More heists. No spiders please."');
    expect(first.brief).toContain('### Story plan\nThe duke is a vampire.');
    expect(first.brief).toContain('- (promise) Thorn owes Wren a favour.');
    expect(first.brief).toContain('- "The Module" (adventure, for your eyes only): About things.');
    expect(first.brief).not.toContain('Other World');

    // Written after the brief: the stored brief does not move, the note rides along beside it.
    await pgStore.writeNote(camp, 'Story plan', 'The duchess is the vampire.');
    await pgStore.remember(camp, { kind: 'fact', content: 'The lake froze overnight.', importance: 2 });
    const second = await briefAndChanges(camp);
    expect(second.brief).toBe(first.brief);
    expect(second.changes).toContain('Notebook page "Story plan" now reads:\nThe duchess is the vampire.');
    expect(second.changes).toContain('- (fact) The lake froze overnight.');
    expect(second.changes).not.toContain('Thorn owes Wren');

    const at = (await q1<{ brief_at: Date }>('SELECT brief_at FROM campaigns WHERE id = $1', [camp]))!
      .brief_at;
    expect(await refreshBrief(camp)).toContain('The duchess is the vampire.');
    expect(await changesSince(camp, new Date())).toBe('');
    expect(
      (await q1<{ brief_at: Date }>('SELECT brief_at FROM campaigns WHERE id = $1', [camp]))!.brief_at > at,
    ).toBe(true);
    expect(await compileBrief(other)).not.toContain('vampire');
  });
});
