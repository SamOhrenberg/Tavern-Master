import type {
  SheetField,
  SheetFieldType,
  SheetScalar,
  SheetSchema,
  SheetSection,
  SheetValue,
  TrackValue,
} from '@tavern/protocol';
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

// ---- values ----

/** What a tool or a request may send as one value. The schema decides what it becomes. */
export const valueInput = z.union([
  z.string().max(LIMITS.text),
  z.number().finite(),
  z.boolean(),
  z.object({ current: z.number().finite(), max: z.number().finite() }),
  z
    .array(z.record(z.string(), z.union([z.string().max(LIMITS.cell), z.number().finite(), z.boolean()])))
    .max(LIMITS.rows),
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shorten text to fit, at a sentence or a word where one is near. */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Any value as one line of text: how a list or a track reads to a model or in a text field. */
export function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) {
    return v
      .map((row) => {
        if (!isObject(row)) return formatValue(row);
        // "Longsword (bonus: +5, damage: 1d8+3)": the first cell names the row.
        const cells = Object.entries(row)
          .map(([k, x]) => [k, formatValue(x)] as const)
          .filter(([, x]) => x);
        if (!cells.length) return '';
        const [[, first], ...more] = cells;
        return more.length ? `${first} (${more.map(([k, x]) => `${k}: ${x}`).join(', ')})` : first;
      })
      .filter(Boolean)
      .join('; ');
  }
  if (isObject(v)) {
    if (typeof v.current === 'number' && typeof v.max === 'number') return `${v.current}/${v.max}`;
    return Object.entries(v)
      .map(([k, x]) => [k, formatValue(x)] as const)
      .filter(([, x]) => x)
      .map(([k, x]) => `${k}: ${x}`)
      .join('; ');
  }
  return '';
}

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /^\s*([+-]?\d+(?:\.\d+)?)/.exec(v.replace(/[−–]/g, '-'));
  return m ? Number(m[1]) : undefined;
};

function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase();
  if (/^(yes|y|true|x|✓|on|1|proficient)$/.test(t)) return true;
  if (/^(no|n|false|off|0|-|)$/.test(t)) return false;
  return undefined;
}

function toTrack(v: unknown): TrackValue | undefined {
  let current: number | undefined;
  let max: number | undefined;
  if (typeof v === 'number') current = max = v;
  else if (typeof v === 'string') {
    // "12/15", "12 of 15", "12 / 15 max", or a bare "15".
    const m = /^\s*([+-]?\d+)\s*(?:\/|of|out of)\s*(\d+)/i.exec(v);
    if (m) [current, max] = [Number(m[1]), Number(m[2])];
    else current = max = num(v);
  } else if (isObject(v)) {
    current = num(v.current ?? v.value ?? v.cur ?? v.now);
    max = num(v.max ?? v.maximum ?? v.total ?? v.of);
    if (max === undefined) max = current;
    if (current === undefined) current = max;
  }
  if (current === undefined || max === undefined) return undefined;
  const top = Math.max(0, Math.min(Math.round(max), 99999));
  return { current: Math.max(0, Math.min(Math.round(current), 99999)), max: top };
}

/** One value of a single-valued field, or undefined when it holds nothing. */
function scalarFor(field: SheetField, raw: unknown, limit: number): SheetScalar | undefined {
  switch (field.type) {
    case 'number': {
      const n = num(raw);
      return n;
    }
    case 'checkbox':
      return toBool(raw);
    case 'derived': {
      // A derived value is usually a number, but "+5" or "15 (chain mail)" are fine too.
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
      const text = clip(formatValue(raw), limit);
      if (!text) return undefined;
      return /^[+-]?\d+(\.\d+)?$/.test(text) && !text.startsWith('+') ? Number(text) : text;
    }
    case 'select': {
      const text = clip(formatValue(raw), 200);
      if (!text) return undefined;
      // Settle on the option's own spelling; anything else is kept as written (options change).
      return field.options?.find((o) => o.toLowerCase() === text.toLowerCase()) ?? text;
    }
    default: {
      // A text field may hold a plain number ("Level: 3" on the original templates).
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
      const text = clip(formatValue(raw), limit);
      return text || undefined;
    }
  }
}

function rowsFor(field: SheetField, raw: unknown): Record<string, SheetScalar>[] | undefined {
  const items = field.itemFields ?? [];
  if (!items.length) return undefined;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/\n|;\s*/).filter((s) => s.trim())
      : isObject(raw)
        ? [raw]
        : [];
  const rows: Record<string, SheetScalar>[] = [];
  for (const entry of list) {
    const row: Record<string, SheetScalar> = {};
    if (isObject(entry)) {
      const byLower = new Map(Object.entries(entry).map(([k, v]) => [k.toLowerCase(), v]));
      for (const item of items) {
        const v = byLower.get(item.key.toLowerCase()) ?? byLower.get(item.label.toLowerCase());
        const value = v === undefined ? undefined : scalarFor(item, v, LIMITS.cell);
        if (value !== undefined && value !== '') row[item.key] = value;
      }
    } else {
      // A bare string or number fills the row's first field: "Longsword" becomes { name: "Longsword" }.
      const value = scalarFor(items[0]!, entry, LIMITS.cell);
      if (value !== undefined && value !== '') row[items[0]!.key] = value;
    }
    if (Object.keys(row).length) rows.push(row);
    if (rows.length >= LIMITS.rows) break;
  }
  return rows;
}

/**
 * One value as this field holds it, forgivingly: "14" for a number, "12/15"
 * for a track, a list of names for a list. Undefined when nothing usable is
 * there.
 */
export function coerce(field: SheetField, raw: unknown): SheetValue | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (field.type === 'track') return toTrack(raw);
  if (field.type === 'list') {
    const rows = rowsFor(field, raw);
    return rows?.length ? rows : undefined;
  }
  return scalarFor(field, raw, LIMITS.text);
}

const KIND_OF: Record<SheetFieldType, string> = {
  number: 'a number',
  text: 'text',
  longtext: 'text',
  select: 'one of its options',
  checkbox: 'yes or no',
  derived: 'a number or short text',
  track: 'a current and a maximum value, like 12/15',
  list: 'a list of rows',
};

/** Nothing was written: an empty string, an empty list. Such values are left off the sheet. */
const blank = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);

/**
 * Check a whole sheet against its schema and return it as it should be
 * stored: each value in its field's shape, under the field's own spelling,
 * with empty values left out. Names the schema does not know are kept as
 * text, numbers or yes/no. Throws a 400 naming the first value that cannot be
 * read as its field's kind.
 */
export function checkSheet(schema: SheetSchema, sheet: Record<string, unknown>): Record<string, SheetValue> {
  const index = fieldIndex(schema);
  const out: Record<string, SheetValue> = {};
  for (const [rawKey, raw] of Object.entries(sheet)) {
    if (blank(raw)) continue;
    const field = index.get(rawKey.trim().toLowerCase());
    if (field) {
      const value = coerce(field, raw);
      if (value === undefined) throw badRequest(`${field.label} should be ${KIND_OF[field.type]}.`);
      out[field.key] = value;
      continue;
    }
    const key = rawKey.trim();
    if (!KEY.test(key))
      throw badRequest(`"${key.slice(0, 40)}" cannot be a field name: use letters, digits and spaces.`);
    if (typeof raw === 'number' || typeof raw === 'boolean') out[key] = raw;
    else if (typeof raw === 'string') {
      if (raw.length > LIMITS.text) throw badRequest(`${key} is longer than ${LIMITS.text} characters.`);
      out[key] = raw.trim();
    } else {
      // Something structured under a name the schema does not know: keep it readable as text.
      const text = clip(formatValue(raw), LIMITS.text);
      if (text) out[key] = text;
    }
  }
  if (Object.keys(out).length > LIMITS.sheetKeys)
    throw badRequest(`A sheet holds at most ${LIMITS.sheetKeys} fields.`);
  if (JSON.stringify(out).length > LIMITS.sheetBytes) throw badRequest('That sheet is too long to save.');
  return out;
}

/**
 * Fields the GM keeps: once one holds a value, a player's save (or the
 * guide's, made for a player) leaves it as it was. An empty one may be filled
 * in, so a new character can start with a value.
 */
export function keepGmFields(
  schema: SheetSchema,
  before: Record<string, unknown>,
  after: Record<string, SheetValue>,
): Record<string, SheetValue> {
  const out = { ...after };
  for (const f of schemaFields(schema)) {
    if (f.editableBy !== 'gm') continue;
    const was = Object.entries(before).find(([k]) => k.toLowerCase() === f.key.toLowerCase());
    if (!was || blank(was[1])) continue;
    for (const k of Object.keys(out)) if (k.toLowerCase() === f.key.toLowerCase()) delete out[k];
    out[f.key] = was[1] as SheetValue;
  }
  return out;
}

// ---- describing a schema to a model ----

function describeField(f: SheetField, forGm: boolean): string {
  const bits: string[] = [];
  if (f.type === 'select') bits.push(`one of: ${(f.options ?? []).join(', ')}`);
  else if (f.type === 'list')
    bits.push(
      `list of rows, each with ${(f.itemFields ?? [])
        .map((i) => `"${i.key}"${i.type === 'number' ? ' (number)' : ''}`)
        .join(', ')}`,
    );
  else if (f.type === 'track') bits.push('track: {"current": n, "max": n}');
  else if (f.type === 'derived')
    bits.push(`worked out by the rules${f.derivedFrom ? `: ${f.derivedFrom}` : ''}`);
  else if (f.type === 'checkbox') bits.push('true or false');
  else if (f.type === 'number') bits.push('number');
  if (f.min !== undefined || f.max !== undefined) bits.push(`range ${f.min ?? '…'} to ${f.max ?? '…'}`);
  if (f.setAt === 'play') bits.push('changes during play');
  if (f.editableBy === 'gm') bits.push('the GM keeps this');
  const name = f.key === f.label ? `"${f.key}"` : `"${f.key}" (${f.label})`;
  const help = f.help ? ` — ${f.help}` : '';
  const note = forGm && f.gmNote ? ` GM: ${f.gmNote}` : '';
  return `- ${name}${bits.length ? ` [${bits.join('; ')}]` : ''}${help}${note}`;
}

/**
 * Tell a model what this system's sheets hold: every field by section, the
 * shape of its value, and what is free-form. `forGm` adds the notes written
 * for the GM; `steps` adds the order characters are built in.
 */
export function schemaGuide(schema: SheetSchema, opts: { forGm?: boolean; steps?: boolean } = {}): string {
  const lines: string[] = [];
  if (schema.sections.length) {
    lines.push(
      'Sheet fields, by section. Store each value under exactly the quoted field name, in the shape given in brackets (text where none is given).',
    );
    for (const sec of schema.sections) {
      if (!sec.fields.length) continue;
      lines.push(`${sec.label}:`);
      for (const f of sec.fields) lines.push(describeField(f, !!opts.forGm));
    }
  }
  lines.push(
    `${schema.hp.label} are this system's hit points: their maximum is max_hp, not a sheet field.`,
    'Anything else the rules need can go under a short field name of your own, using letters, digits and spaces, as text or a number.',
  );
  if (opts.steps && schema.createSteps.length) {
    lines.push('', 'Building a character in this system, step by step:');
    schema.createSteps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  return lines.join('\n');
}

/**
 * The sheet as the GM reads it in its instructions: every field with its GM
 * note. Empty for a system whose sheets are free-form, so its prompt is unchanged.
 */
export function gmSheetGuide(raw: unknown): string {
  const schema = toSchema(raw);
  return schemaFields(schema).length ? schemaGuide(schema, { forGm: true }) : '';
}
