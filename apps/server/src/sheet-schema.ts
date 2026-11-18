import type { SheetField, SheetFieldType, SheetSchema, SheetSection } from '@tavern/protocol';
import { z } from 'zod';
import { q1 } from './db/pool.js';
import { badRequest } from './errors.js';

/**
 * Sheet schemas: what a character sheet holds in one game system. A sheet is
 * still a flat map of field name to value; the schema says which names a
 * system uses and what kind of value each one takes. Every way a sheet is
 * written (the form, the guide, the sheet reader, the GM) goes through
 * {@link checkSheet}, so a value of the wrong shape never reaches the table.
 */

export const LIMITS = {
  /** Fields a schema may define, counting every section. */
  fields: 80,
  sections: 12,
  options: 30,
  itemFields: 8,
  steps: 20,
  /** Names on one sheet: the schema's fields plus anything else written there. */
  sheetKeys: 100,
  /** Rows in one list. */
  rows: 50,
  /** Characters in a text value, and in one cell of a list. */
  text: 1500,
  cell: 300,
  /** The whole sheet as JSON. */
  sheetBytes: 64_000,
} as const;

const KEY = /^[\w ]{1,40}$/;
export const fieldKey = z
  .string()
  .trim()
  .regex(KEY, 'letters, digits, underscores and spaces only, at most 40');

const SCALAR_TYPES = ['number', 'text', 'longtext', 'select', 'checkbox', 'derived'] as const;
const ALL_TYPES = [...SCALAR_TYPES, 'track', 'list'] as const satisfies readonly SheetFieldType[];

const fieldBase = {
  key: fieldKey,
  label: z.string().trim().min(1).max(60),
  help: z.string().trim().max(300).optional(),
  options: z.array(z.string().trim().min(1).max(60)).max(LIMITS.options).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  derivedFrom: z.string().trim().max(300).optional(),
  setAt: z.enum(['creation', 'play']).optional(),
  editableBy: z.enum(['player', 'gm', 'both']).optional(),
  showOnCard: z.boolean().optional(),
  gmNote: z.string().trim().max(400).optional(),
};

const needsOptions = (f: { type: string; options?: string[] }) => f.type !== 'select' || !!f.options?.length;

const itemFieldSchema = z
  .object({ ...fieldBase, type: z.enum(SCALAR_TYPES) })
  .refine(needsOptions, { message: 'A select needs its options.' });

export const fieldSchema = z
  .object({
    ...fieldBase,
    type: z.enum(ALL_TYPES),
    itemFields: z.array(itemFieldSchema).max(LIMITS.itemFields).optional(),
  })
  .refine(needsOptions, { message: 'A select needs its options.' })
  .refine((f) => f.type !== 'list' || !!f.itemFields?.length, {
    message: 'A list needs the fields of its rows.',
  })
  .refine(
    (f) => new Set((f.itemFields ?? []).map((i) => i.key.toLowerCase())).size === (f.itemFields ?? []).length,
    { message: 'The fields of a list row need different names.' },
  );

export const sectionSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,40}$/, 'lower-case letters, digits and hyphens'),
  label: z.string().trim().min(1).max(60),
  fields: z.array(fieldSchema).max(LIMITS.fields),
});

/** A schema as an admin or an AI writes it. Field names must be unique across the whole sheet. */
export const schemaSchema = z
  .object({
    version: z.literal(2),
    hp: z.object({ label: z.string().trim().min(1).max(40) }),
    sections: z.array(sectionSchema).max(LIMITS.sections),
    createSteps: z.array(z.string().trim().min(1).max(300)).max(LIMITS.steps).default([]),
  })
  .superRefine((s, ctx) => {
    const fields = s.sections.flatMap((sec) => sec.fields);
    if (fields.length > LIMITS.fields)
      ctx.addIssue({ code: 'custom', message: `A sheet holds at most ${LIMITS.fields} fields.` });
    const seen = new Set<string>();
    for (const f of fields) {
      const k = f.key.toLowerCase();
      if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `Two fields are called "${f.key}".` });
      seen.add(k);
    }
    const ids = new Set<string>();
    for (const sec of s.sections) {
      if (ids.has(sec.id)) ctx.addIssue({ code: 'custom', message: `Two sections have the id "${sec.id}".` });
      ids.add(sec.id);
    }
  });

// ---- the original template, and reading whatever is stored ----

const LONG = /feature|spell|proficien|skill|trait|background|equipment|note|talent|power/i;

/** How the old template named an ability score's field: its label, cleaned. */
const abilityKey = (label: string) =>
  label
    .replace(/[^\w ]+/g, ' ')
    .trim()
    .slice(0, 40);

/**
 * The original template as a schema, under the same field names, so sheets
 * written against it read exactly as before.
 */
export function fromTemplate(t: { abilities?: unknown; fields?: unknown }): SheetSchema {
  const abilities = (Array.isArray(t.abilities) ? t.abilities : [])
    .filter((a): a is string => typeof a === 'string' && !!abilityKey(a))
    .slice(0, 12);
  const fields = (Array.isArray(t.fields) ? t.fields : []).filter(
    (f): f is { key: string; label: string } =>
      !!f && typeof f.key === 'string' && KEY.test(f.key) && typeof f.label === 'string',
  );
  let card = 0;
  const sections: SheetSection[] = [];
  if (abilities.length)
    sections.push({
      id: 'abilities',
      label: 'Abilities',
      fields: abilities.map((a) => ({ key: abilityKey(a), label: a, type: 'number', showOnCard: true })),
    });
  if (fields.length)
    sections.push({
      id: 'details',
      label: 'Details',
      fields: fields.map((f) => {
        const long = LONG.test(f.key) || LONG.test(f.label);
        // The first few short fields (class, level, ...) were what the party card showed.
        const showOnCard = !long && card++ < 3;
        return { key: f.key, label: f.label.slice(0, 60), type: long ? 'longtext' : 'text', showOnCard };
      }),
    });
  return { version: 2, hp: { label: 'Hit points' }, sections, createSteps: [] };
}

/** A schema with nothing in it: every value on the sheet is free-form. */
export const EMPTY_SCHEMA: SheetSchema = {
  version: 2,
  hp: { label: 'Hit points' },
  sections: [],
  createSteps: [],
};

/** Whatever a system has stored (a schema, or the original template) as a schema. */
export function toSchema(raw: unknown): SheetSchema {
  if (raw && typeof raw === 'object' && (raw as { version?: unknown }).version === 2) {
    const parsed = schemaSchema.safeParse(raw);
    return parsed.success ? (parsed.data as SheetSchema) : EMPTY_SCHEMA;
  }
  return raw && typeof raw === 'object' ? fromTemplate(raw) : EMPTY_SCHEMA;
}

/** A schema to store, checked. Throws a 400 naming what is wrong. */
export function parseSchema(raw: unknown): SheetSchema {
  const parsed = schemaSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (at ${issue.path.join('.')})` : '';
    throw badRequest(`That sheet schema is not valid: ${issue?.message ?? 'unknown problem'}${where}`);
  }
  return parsed.data as SheetSchema;
}

export async function systemSchema(systemId: string): Promise<SheetSchema> {
  const row = await q1<{ sheet_template: unknown }>('SELECT sheet_template FROM game_systems WHERE id = $1', [
    systemId,
  ]);
  return toSchema(row?.sheet_template);
}

export async function campaignSchema(campaignId: string): Promise<SheetSchema> {
  const row = await q1<{ sheet_template: unknown }>(
    `SELECT s.sheet_template FROM campaigns c JOIN game_systems s ON s.id = c.system_id WHERE c.id = $1`,
    [campaignId],
  );
  return toSchema(row?.sheet_template);
}

export const schemaFields = (schema: SheetSchema): SheetField[] => schema.sections.flatMap((s) => s.fields);

/** The schema's fields by lower-case name, so "strength" finds "Strength". */
export function fieldIndex(schema: SheetSchema): Map<string, SheetField> {
  return new Map(schemaFields(schema).map((f) => [f.key.toLowerCase(), f]));
}
