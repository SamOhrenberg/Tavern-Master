import { rm } from 'node:fs/promises';
import type { CharacterController, CharacterKind, InventoryItem } from '@tavern/protocol';
import { z } from 'zod';
import { q, q1, tx } from './db/pool.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import {
  campaignSchema,
  checkSheet,
  fieldName,
  gmKeptNames,
  keepGmFields,
  LIMITS,
  putInventory,
  removeEntry,
  settleMaxHp,
  unknownNamesNote,
  valueInput,
  writesInventory,
  writesMaxHp,
} from './sheet-schema.js';
import { uploadPath } from './storage.js';

/**
 * The party: who is in it and who speaks for each member. Used by the REST
 * routes and by the character-building guide, so both obey the same rules.
 */

export const MAX_PARTY = 12;
/** How many characters a player may make for themselves. The owner is not limited. */
const MAX_OWN = 3;

const uuid = z.string().uuid();
export const sheetKey = z
  .string()
  .trim()
  .regex(/^[\w ]{1,40}$/, 'letters, digits and spaces only');
export const inventorySchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(80),
      qty: z.number().int().min(1).max(9999),
      notes: z.string().max(200).optional(),
    }),
  )
  .max(100);

export const characterSchema = z.object({
  name: z.string().trim().min(1).max(60),
  // Left out when the system's sheet has its own Max HP field: that field sets it.
  maxHp: z.number().int().min(1).max(9999).optional(),
  hp: z.number().int().min(0).max(9999).optional(),
  // The shape of each value is checked against the system's sheet schema when it is saved.
  sheet: z
    .record(sheetKey, valueInput)
    .refine((s) => Object.keys(s).length <= LIMITS.sheetKeys, 'Too many fields'),
  inventory: inventorySchema.optional(),
  persona: z.string().max(2000).optional(),
  privateNotes: z.string().max(4000).optional(),
});
export type CharacterBody = z.infer<typeof characterSchema>;

export const controlSchema = z.object({
  kind: z.enum(['pc', 'npc']),
  controller: z.enum(['player', 'gm', 'agent']),
  playerIds: z.array(uuid).max(8).default([]),
});

export interface Control {
  kind: CharacterKind;
  controller: CharacterController;
  playerIds: string[];
}

/** The person making a request, as the campaign sees them. */
export interface Viewer {
  userId: string;
  role: 'owner' | 'player';
}

export interface CharacterAccess {
  id: string;
  name: string;
  controller: CharacterController;
  playerIds: string[];
  /** Who added them to the party. */
  createdBy?: string | null;
}

/** A change to part of a sheet, as the guide and the sheet reader produce it. */
export interface DraftPatch {
  name?: string;
  max_hp?: number;
  /** Values in whatever shape the model wrote; the sheet schema settles each one. */
  fields?: { field: string; value: unknown }[];
  remove_fields?: string[];
  inventory?: InventoryItem[];
  persona?: string;
}

/**
 * Who may write a sheet: the players who run the character. The owners look
 * after party members that no player runs (AI companions, and characters left
 * behind by someone who is gone), as does the player who added a companion,
 * but nobody rewrites another player's own.
 */
export function canEdit(
  viewer: Viewer,
  c: Pick<CharacterAccess, 'controller' | 'playerIds'> & { createdBy?: string | null },
): boolean {
  if (c.controller === 'player' && c.playerIds.includes(viewer.userId)) return true;
  const unrun = c.controller !== 'player' || c.playerIds.length === 0;
  return unrun && (viewer.role === 'owner' || (!!c.createdBy && c.createdBy === viewer.userId));
}

/**
 * Who may give a character this control. The owners may give any; a player
 * may make their own character, or a companion that they, the DM or an AI of
 * its own plays. Handing a character to other players stays with the owners.
 */
export function mayAssign(viewer: Viewer, control: Control): boolean {
  if (viewer.role === 'owner') return true;
  const self = control.playerIds.length === 1 && control.playerIds[0] === viewer.userId;
  if (control.controller === 'player') return self;
  return control.kind === 'npc';
}

/** What a player is told when they ask for a control only the owners may give. */
export const ASSIGN_REFUSED = 'Only the campaign’s owners can hand a character to another player.';

export async function loadAccess(campaignId: string, characterId: string): Promise<CharacterAccess> {
  const row = await q1<{
    id: string;
    name: string;
    controller: CharacterController;
    player_ids: string[];
    created_by: string | null;
  }>(
    `SELECT c.id, c.name, c.controller, c.created_by::text AS created_by,
            coalesce((SELECT array_agg(p.user_id::text) FROM character_players p WHERE p.character_id = c.id), '{}')
              AS player_ids
       FROM characters c WHERE c.id = $1 AND c.campaign_id = $2`,
    [characterId, campaignId],
  );
  if (!row) throw notFound('Character not found');
  return {
    id: row.id,
    name: row.name,
    controller: row.controller,
    playerIds: row.controller === 'player' ? row.player_ids : [],
    createdBy: row.created_by,
  };
}

async function assertNameFree(campaignId: string, name: string, exceptId: string | null): Promise<void> {
  const clash = await q1(
    `SELECT 1 FROM characters WHERE campaign_id = $1 AND lower(name) = lower($2)
        AND ($3::uuid IS NULL OR id <> $3)`,
    [campaignId, name, exceptId],
  );
  if (clash) throw conflict(`There is already a ${name} in this party. Pick another name.`);
}

/** Players listed on a character must be at this table, and only player-run characters have any. */
async function normalise(campaignId: string, control: Control): Promise<Control> {
  if (control.controller !== 'player') return { ...control, playerIds: [] };
  const ids = [...new Set(control.playerIds)];
  if (ids.length) {
    const rows = await q<{ user_id: string }>(
      'SELECT user_id::text FROM campaign_members WHERE campaign_id = $1 AND user_id = ANY($2::uuid[])',
      [campaignId, ids],
    );
    if (rows.length !== ids.length)
      throw badRequest('Everyone who runs a character must be in the campaign.');
  }
  return { ...control, playerIds: ids };
}

/**
 * Add a party member. A player makes characters for themselves, and
 * companions; only the owners can hand a character to someone else.
 */
export async function createCharacter(
  campaignId: string,
  viewer: Viewer,
  body: CharacterBody,
  wanted?: Control,
): Promise<string> {
  const mine: Control = { kind: 'pc', controller: 'player', playerIds: [viewer.userId] };
  let control = wanted ?? mine;
  if (!mayAssign(viewer, control)) throw forbidden(ASSIGN_REFUSED);
  control = await normalise(campaignId, control);

  // A player's limit counts the characters they run and the companions they added.
  const counts = await q1<{ party: number; own: number }>(
    `SELECT count(*)::int AS party,
            count(*) FILTER (WHERE c.created_by = $2 OR EXISTS (SELECT 1 FROM character_players p
                                            WHERE p.character_id = c.id AND p.user_id = $2))::int AS own
       FROM characters c WHERE c.campaign_id = $1`,
    [campaignId, viewer.userId],
  );
  if ((counts?.party ?? 0) >= MAX_PARTY) throw conflict(`A party holds at most ${MAX_PARTY} characters.`);
  if (viewer.role !== 'owner' && (counts?.own ?? 0) >= MAX_OWN)
    throw conflict(`You already run ${MAX_OWN} characters in this campaign.`);
  await assertNameFree(campaignId, body.name, null);
  const schema = await campaignSchema(campaignId);
  const written = { ...body.sheet };
  const maxHp =
    settleMaxHp(schema, written, body.maxHp, writesMaxHp(schema, Object.keys(body.sheet))) ??
    body.maxHp ??
    10;
  // A sheet with its own inventory list takes the items given, unless its list was written too.
  if (body.inventory && !writesInventory(schema, Object.keys(body.sheet)))
    putInventory(schema, written, body.inventory);
  const sheet = checkSheet(schema, written);

  return tx(async (client) => {
    const row = await q1<{ id: string }>(
      `INSERT INTO characters (campaign_id, name, kind, controller, sheet, hp, max_hp, inventory, persona,
                               private_notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        campaignId,
        body.name,
        control.kind,
        control.controller,
        JSON.stringify(sheet),
        Math.min(body.hp ?? maxHp, maxHp),
        maxHp,
        JSON.stringify(body.inventory ?? []),
        body.persona ?? '',
        body.privateNotes ?? '',
        viewer.userId,
      ],
      client,
    );
    for (const userId of control.playerIds) {
      await client.query(
        'INSERT INTO character_players (character_id, campaign_id, user_id) VALUES ($1, $2, $3)',
        [row!.id, campaignId, userId],
      );
    }
    return row!.id;
  });
}

/** Replace a sheet with what the editor sent. */
export async function updateCharacter(
  campaignId: string,
  characterId: string,
  viewer: Viewer,
  body: CharacterBody,
): Promise<void> {
  const access = await loadAccess(campaignId, characterId);
  if (!canEdit(viewer, access)) throw forbidden('That character belongs to another player.');
  await assertNameFree(campaignId, body.name, characterId);
  const schema = await campaignSchema(campaignId);
  const before = await q1<{ sheet: Record<string, unknown>; max_hp: number }>(
    'SELECT sheet, max_hp FROM characters WHERE id = $1',
    [characterId],
  );
  const written = { ...body.sheet };
  if (body.inventory && !writesInventory(schema, Object.keys(body.sheet)))
    putInventory(schema, written, body.inventory);
  const sheet = keepGmFields(schema, before?.sheet ?? {}, checkSheet(schema, written));
  // Settled after the GM's fields are kept, so a Max HP the GM holds still decides.
  const maxHp =
    settleMaxHp(schema, sheet, body.maxHp, writesMaxHp(schema, Object.keys(body.sheet))) ??
    body.maxHp ??
    before?.max_hp ??
    10;
  // Private notes belong to the players who run the character, so only they can change them.
  const notes = access.playerIds.includes(viewer.userId) ? (body.privateNotes ?? null) : null;
  await q(
    `UPDATE characters
        SET name = $3, sheet = $4, max_hp = $5,
            hp = least(CASE WHEN $6 THEN $7 ELSE hp END, $5),
            inventory = coalesce($8::jsonb, inventory),
            persona = coalesce($9, persona),
            private_notes = coalesce($10, private_notes), updated_at = now()
      WHERE id = $1 AND campaign_id = $2`,
    [
      characterId,
      campaignId,
      body.name,
      JSON.stringify(sheet),
      maxHp,
      body.hp !== undefined,
      body.hp ?? 0,
      body.inventory ? JSON.stringify(body.inventory) : null,
      body.persona ?? null,
      notes,
    ],
  );
}

/**
 * Change who runs a party member. The owners change any; a player changes a
 * companion they look after (one they run, or one they added that no player
 * runs) among themselves, the DM and an AI of its own.
 */
export async function setControl(
  campaignId: string,
  characterId: string,
  wanted: Control,
  viewer?: Viewer,
): Promise<void> {
  const access = await loadAccess(campaignId, characterId);
  if (viewer && viewer.role !== 'owner') {
    // A character more than one player runs is the owners' to hand on.
    if (!canEdit(viewer, access) || !mayAssign(viewer, wanted) || access.playerIds.length > 1)
      throw forbidden('Only the campaign’s owners can change who plays that character.');
  }
  const control = await normalise(campaignId, wanted);
  await tx(async (client) => {
    await client.query(
      'UPDATE characters SET kind = $3, controller = $4, updated_at = now() WHERE id = $1 AND campaign_id = $2',
      [characterId, campaignId, control.kind, control.controller],
    );
    await client.query('DELETE FROM character_players WHERE character_id = $1', [characterId]);
    for (const userId of control.playerIds) {
      await client.query(
        'INSERT INTO character_players (character_id, campaign_id, user_id) VALUES ($1, $2, $3)',
        [characterId, campaignId, userId],
      );
    }
  });
}

/**
 * Where the app loads a character's picture from. The storage name is random
 * and changes with every upload, so part of it doubles as a cache-buster and
 * the picture can be cached for good.
 */
export function portraitUrl(campaignId: string, characterId: string, portrait: string | null | undefined) {
  return portrait
    ? `/api/campaigns/${campaignId}/characters/${characterId}/portrait?v=${portrait.slice(0, 12)}`
    : undefined;
}

/** Remove a picture file that nothing refers to any more. */
export async function dropPortrait(portrait: string | null | undefined): Promise<void> {
  if (portrait) await rm(uploadPath(portrait), { force: true });
}

/**
 * Give a character a new picture, or none, by the same rule as editing its
 * sheet. The file it had before is removed.
 */
export async function setPortrait(
  campaignId: string,
  characterId: string,
  viewer: Viewer,
  portrait: string | null,
): Promise<void> {
  const access = await loadAccess(campaignId, characterId);
  if (!canEdit(viewer, access)) throw forbidden('That character belongs to another player.');
  const row = await q1<{ old: string | null }>(
    `WITH old AS (SELECT portrait FROM characters WHERE id = $1 AND campaign_id = $2 FOR UPDATE)
     UPDATE characters c SET portrait = $3, updated_at = now() FROM old
      WHERE c.id = $1 RETURNING old.portrait AS old`,
    [characterId, campaignId, portrait],
  );
  if (!row) throw notFound('Character not found');
  if (row.old !== portrait) await dropPortrait(row.old);
}

export async function deleteCharacter(
  campaignId: string,
  characterId: string,
  viewer: Viewer,
): Promise<void> {
  const access = await loadAccess(campaignId, characterId);
  const sole = access.playerIds.length === 1 && access.playerIds[0] === viewer.userId;
  // The player who added a companion no one else runs may take it out again.
  const made = canEdit(viewer, access) && access.playerIds.every((id) => id === viewer.userId);
  if (viewer.role !== 'owner' && !sole && !made)
    throw forbidden('Only the campaign’s owners can remove that character.');
  const gone = await q1<{ portrait: string | null }>(
    'DELETE FROM characters WHERE id = $1 AND campaign_id = $2 RETURNING portrait',
    [characterId, campaignId],
  );
  await dropPortrait(gone?.portrait);
}

export interface DraftResult {
  id: string;
  created: boolean;
  /** The names of what changed. */
  changed: string[];
  /** What the writer should know about the save: names the system does not define, fields left as they were. */
  notes: string[];
}

/**
 * Apply a partial change from the guide: create the character if there is
 * none yet, otherwise merge into the sheet that is there. Field names are
 * matched to the system's own, by name or label. `asGm` is the GM writing
 * (Claude building with the host), who may change the fields the GM keeps.
 */
export async function applyDraft(
  campaignId: string,
  characterId: string | null,
  viewer: Viewer,
  patch: DraftPatch,
  control?: Control,
  opts: { asGm?: boolean } = {},
): Promise<DraftResult> {
  const schema = await campaignSchema(campaignId);
  const named = (field: string) => fieldName(schema, field);
  const notes: string[] = [];
  // Only what was written stays on the sheet: a removed name needs no note.
  const unknown = unknownNamesNote(
    schema,
    (patch.fields ?? []).map((f) => f.field),
    'remove_fields',
  );
  if (unknown) notes.push(unknown);
  // Removals are named by the key that went, once the sheet is known.
  const changedWith = (removed: string[]) => [
    ...(patch.name ? ['name'] : []),
    ...(patch.max_hp ? ['hit points'] : []),
    ...(patch.fields ?? []).map((f) => named(f.field)),
    ...removed.map((f) => `-${f}`),
    ...(patch.inventory ? ['inventory'] : []),
    ...(patch.persona !== undefined ? ['persona'] : []),
  ];
  const changed = changedWith((patch.remove_fields ?? []).map(named));
  if (!changed.length) throw badRequest('Nothing to save.');

  if (!characterId) {
    if (!patch.name) throw badRequest('A new character needs a name before it can be saved.');
    // createCharacter checks the values against the system's schema.
    const sheet: Record<string, unknown> = {};
    for (const { field, value } of patch.fields ?? []) sheet[named(field)] = value;
    const id = await createCharacter(
      campaignId,
      viewer,
      {
        name: patch.name,
        maxHp: patch.max_hp,
        sheet: sheet as CharacterBody['sheet'],
        inventory: patch.inventory,
        persona: patch.persona,
      },
      control,
    );
    return { id, created: true, changed, notes };
  }

  const access = await loadAccess(campaignId, characterId);
  if (!canEdit(viewer, access)) throw forbidden('That character belongs to another player.');
  if (patch.name) await assertNameFree(campaignId, patch.name, characterId);
  const row = await q1<{ sheet: Record<string, unknown>; hp: number; max_hp: number }>(
    'SELECT sheet, hp, max_hp FROM characters WHERE id = $1',
    [characterId],
  );
  const sheet = { ...(row?.sheet ?? {}) };
  // Match an existing field whatever its capitalisation, so "level" updates "Level".
  const keyFor = (field: string) =>
    Object.keys(sheet).find((k) => k.toLowerCase() === field.toLowerCase()) ?? field;
  const removed = (patch.remove_fields ?? []).map(
    (field) => removeEntry(schema, sheet, field) ?? named(field),
  );
  for (const { field, value } of patch.fields ?? []) sheet[keyFor(named(field))] = value;
  // A sheet with its own inventory list takes the items given, unless its list was written too.
  if (
    patch.inventory &&
    !writesInventory(
      schema,
      (patch.fields ?? []).map((f) => f.field),
    )
  )
    putInventory(schema, sheet, patch.inventory);
  let checked = checkSheet(schema, sheet);
  if (!opts.asGm) {
    const before = row?.sheet ?? {};
    checked = keepGmFields(schema, before, checked);
    const kept = gmKeptNames(schema, before, [
      ...(patch.fields ?? []).map((f) => f.field),
      ...(patch.remove_fields ?? []),
    ]);
    if (kept.length)
      notes.push(
        `${kept.map((k) => `"${k}"`).join(', ')} ${kept.length === 1 ? 'is' : 'are'} kept by the GM, so ${kept.length === 1 ? 'it was' : 'they were'} left as ${kept.length === 1 ? 'it was' : 'they were'}.`,
      );
  }
  // A sheet with its own Max HP field keeps it and the maximum in step.
  const fieldMax = settleMaxHp(
    schema,
    checked,
    patch.max_hp,
    writesMaxHp(
      schema,
      (patch.fields ?? []).map((f) => f.field),
    ),
  );
  const maxHp = fieldMax ?? patch.max_hp ?? row?.max_hp ?? 10;
  // Someone at full health stays at full health when their maximum changes.
  const hp = row && row.hp >= row.max_hp ? maxHp : Math.min(row?.hp ?? maxHp, maxHp);
  await q(
    `UPDATE characters
        SET name = coalesce($2, name), sheet = $3, max_hp = $4, hp = $5,
            inventory = coalesce($6::jsonb, inventory), persona = coalesce($7, persona), updated_at = now()
      WHERE id = $1`,
    [
      characterId,
      patch.name ?? null,
      JSON.stringify(checked),
      maxHp,
      hp,
      patch.inventory ? JSON.stringify(patch.inventory) : null,
      patch.persona ?? null,
    ],
  );
  return { id: characterId, created: false, changed: changedWith(removed), notes };
}
