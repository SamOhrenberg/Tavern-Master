import type { SheetField, SheetSchema, TrackValue } from '@tavern/protocol';

/**
 * Sheet values as the app reads and edits them. The system's sheet schema
 * says what each field holds: a single value, a track (current and maximum),
 * or a list of rows. The server checks every value against the same schema.
 */

export const fieldsOf = (schema: SheetSchema | undefined): SheetField[] =>
  schema?.sections.flatMap((s) => s.fields) ?? [];

export const isTrack = (v: unknown): v is TrackValue =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as TrackValue).current === 'number' &&
  typeof (v as TrackValue).max === 'number';

/** A value on a sheet whatever the spelling of its name ("strength" for "Strength"). */
export function lookup(sheet: Record<string, unknown>, key: string): unknown {
  const hit = Object.keys(sheet).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit === undefined ? undefined : sheet[hit];
}

/** Any value as one line: a track as 3/9, a list as its rows' names. */
export function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (isTrack(v)) return `${v.current}/${v.max}`;
  if (Array.isArray(v)) {
    return v
      .map((row) => {
        if (typeof row !== 'object' || row === null) return formatValue(row);
        const cells = Object.values(row as Record<string, unknown>)
          .map(formatValue)
          .filter(Boolean);
        return cells.length > 1 ? `${cells[0]} (${cells.slice(1).join(', ')})` : (cells[0] ?? '');
      })
      .filter(Boolean)
      .join('; ');
  }
  return '';
}

// ---- the form ----

export interface ListRow {
  id: number;
  cells: Record<string, string | boolean>;
}
export type FieldInput = string | boolean | { current: string; max: string } | ListRow[];
export type FormValues = Record<string, FieldInput>;

function trackInput(raw: unknown): { current: string; max: string } {
  if (isTrack(raw)) return { current: String(raw.current), max: String(raw.max) };
  if (typeof raw === 'number') return { current: String(raw), max: String(raw) };
  const m = typeof raw === 'string' ? /^\s*(\d+)\s*(?:\/|of)\s*(\d+)/.exec(raw) : null;
  if (m) return { current: m[1]!, max: m[2]! };
  const one = typeof raw === 'string' ? raw.trim() : '';
  return { current: one, max: one };
}

function rowsInput(field: SheetField, raw: unknown): ListRow[] {
  const items = field.itemFields ?? [];
  const first = items[0]?.key;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' && raw.trim()
      ? raw.split(/\n|;\s*/).filter((s) => s.trim())
      : [];
  return list.map((entry, id) => {
    const cells: Record<string, string | boolean> = {};
    if (typeof entry === 'object' && entry !== null) {
      for (const item of items) {
        const v = lookup(entry as Record<string, unknown>, item.key);
        cells[item.key] = item.type === 'checkbox' ? v === true : formatValue(v);
      }
    } else if (first) cells[first] = formatValue(entry);
    return { id, cells };
  });
}

/** What the form starts with: each field's value from the sheet, in its input's shape. */
export function initialValues(schema: SheetSchema | undefined, sheet: Record<string, unknown>): FormValues {
  const out: FormValues = {};
  for (const f of fieldsOf(schema)) {
    const raw = lookup(sheet, f.key);
    if (f.type === 'checkbox') out[f.key] = raw === true || /^(yes|true|x)$/i.test(formatValue(raw));
    else if (f.type === 'track') out[f.key] = trackInput(raw);
    else if (f.type === 'list') out[f.key] = rowsInput(f, raw);
    else out[f.key] = formatValue(raw);
  }
  return out;
}

/**
 * The form's values as a sheet to send. Empty fields are left out; numbers
 * the player typed are sent as text and read by the server, which says which
 * field is wrong if one cannot be read.
 */
export function sheetFromValues(
  schema: SheetSchema | undefined,
  values: FormValues,
  before: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fieldsOf(schema)) {
    const v = values[f.key];
    if (typeof v === 'boolean') {
      // An unticked box is only worth keeping if the sheet had it ticked before.
      if (v || lookup(before, f.key) !== undefined) out[f.key] = v;
    } else if (typeof v === 'string') {
      if (v.trim()) out[f.key] = v.trim();
    } else if (Array.isArray(v)) {
      const rows = v
        .map((r) =>
          Object.fromEntries(
            Object.entries(r.cells)
              .map(([k, x]) => [k, typeof x === 'string' ? x.trim() : x] as const)
              .filter(([, x]) => x !== '' && x !== false),
          ),
        )
        .filter((r) => Object.keys(r).length);
      if (rows.length) out[f.key] = rows;
    } else if (v) {
      const current = v.current.trim();
      const max = v.max.trim();
      if (!current && !max) continue;
      const c = Number(current || max);
      const m = Number(max || current);
      out[f.key] = Number.isFinite(c) && Number.isFinite(m) ? { current: c, max: m } : `${current}/${max}`;
    }
  }
  return out;
}
