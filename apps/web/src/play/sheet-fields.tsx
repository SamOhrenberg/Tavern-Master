import type { SheetField, SheetSchema, TrackValue } from '@tavern/protocol';
import { IconPlus, IconTrash } from '../icons';

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

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const HP_NAMES = ['hp', 'hitpoints', 'hitpoint', 'health'];

/**
 * The field a system's sheet keeps maximum hit points in, if it has one
 * ("Max HP", worked out by the rules). The HP box steps aside for it, and the
 * server sets the character's maximum from it. Matches the server's rule.
 */
export function maxHpField(schema: SheetSchema | undefined): SheetField | undefined {
  if (!schema) return undefined;
  const hp = [...new Set([...HP_NAMES, squash(schema.hp.label)])].filter(Boolean);
  const max = hp.flatMap((h) => [`max${h}`, `maximum${h}`, `${h}max`, `${h}maximum`]);
  return fieldsOf(schema).find((f) => {
    if (f.type !== 'number' && f.type !== 'derived' && f.type !== 'text') return false;
    const names = [squash(f.key), squash(f.label)];
    return names.some((n) => max.includes(n)) || (f.type === 'derived' && names.some((n) => hp.includes(n)));
  });
}

const INVENTORY_NAMES = [
  'inventory',
  'invlist',
  'inventorylist',
  'items',
  'itemlist',
  'backpack',
  'pack',
  'belongings',
];

/**
 * The list a system's sheet keeps belongings in, if it has one. The built-in
 * inventory steps aside for it, and the GM's inventory changes land on its
 * rows. Matches the server's rule.
 */
export function inventoryListField(schema: SheetSchema | undefined): SheetField | undefined {
  return fieldsOf(schema).find(
    (f) =>
      f.type === 'list' &&
      !!f.itemFields?.length &&
      (INVENTORY_NAMES.includes(squash(f.key)) || INVENTORY_NAMES.includes(squash(f.label))),
  );
}

/** The whole number a max-HP value reads as ("27.5" and "27 (10 + ...)" are 27), if it is one. */
export function readMaxHp(v: unknown): number | undefined {
  const m = /^\s*([+-]?\d+(?:\.\d+)?)/.exec(String(v ?? '').replace(/[−–]/g, '-'));
  const whole = m ? Math.floor(Number(m[1])) : NaN;
  return whole >= 1 && whole <= 9999 ? whole : undefined;
}

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

// ---- inputs ----

function Hint({ field, locked }: { field: SheetField; locked: boolean }) {
  const parts = [
    locked ? 'The GM keeps this.' : '',
    field.type === 'derived' && field.derivedFrom
      ? `Worked out: ${field.derivedFrom.trim().replace(/\.*$/, '')}.`
      : '',
    field.help ?? '',
  ].filter(Boolean);
  return parts.length ? <span className="hint">{parts.join(' ')}</span> : null;
}

function SelectInput({
  field,
  value,
  locked,
  onChange,
}: {
  field: SheetField;
  value: string;
  locked: boolean;
  onChange: (v: string) => void;
}) {
  const options = field.options ?? [];
  // A value from before the options changed stays choosable rather than vanishing.
  const all = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select className="input" value={value} disabled={locked} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {all.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function ListInput({
  field,
  rows,
  locked,
  onChange,
}: {
  field: SheetField;
  rows: ListRow[];
  locked: boolean;
  onChange: (rows: ListRow[]) => void;
}) {
  const items = field.itemFields ?? [];
  const setCell = (id: number, key: string, v: string | boolean) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, cells: { ...r.cells, [key]: v } } : r)));
  return (
    <div className="sheet-list">
      <span className="label">{field.label}</span>
      {rows.map((r) => (
        <div key={r.id} className="sheet-list-row">
          <div className="sheet-list-cells">
            {items.map((item) =>
              item.type === 'checkbox' ? (
                <label key={item.key} className="sheet-check-cell">
                  <input
                    type="checkbox"
                    checked={r.cells[item.key] === true}
                    disabled={locked}
                    onChange={(e) => setCell(r.id, item.key, e.target.checked)}
                  />
                  <span>{item.label}</span>
                </label>
              ) : (
                // A caption over each cell: once a row is filled in, "1 4 1" means nothing without one.
                <label
                  key={item.key}
                  className={`sheet-cell${item.type === 'number' ? ' num' : ''}`}
                  title={item.help}
                >
                  <span>{item.label}</span>
                  <input
                    className="input"
                    inputMode={item.type === 'number' ? 'numeric' : undefined}
                    value={typeof r.cells[item.key] === 'string' ? (r.cells[item.key] as string) : ''}
                    readOnly={locked}
                    maxLength={300}
                    onChange={(e) => setCell(r.id, item.key, e.target.value)}
                  />
                </label>
              ),
            )}
          </div>
          {!locked && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
              aria-label={`Remove from ${field.label}`}
            >
              <IconTrash />
            </button>
          )}
        </div>
      ))}
      {!locked && rows.length < 50 && (
        <button
          type="button"
          className="btn sm ghost add-item"
          onClick={() => onChange([...rows, { id: Math.max(-1, ...rows.map((r) => r.id)) + 1, cells: {} }])}
        >
          <IconPlus /> Add to {field.label.toLowerCase()}
        </button>
      )}
      <Hint field={field} locked={locked} />
    </div>
  );
}

function FieldInputView({
  field,
  value,
  locked,
  onChange,
}: {
  field: SheetField;
  value: FieldInput | undefined;
  locked: boolean;
  onChange: (v: FieldInput) => void;
}) {
  if (field.type === 'list')
    return (
      <ListInput field={field} rows={Array.isArray(value) ? value : []} locked={locked} onChange={onChange} />
    );
  if (field.type === 'checkbox')
    return (
      <label className="sheet-toggle">
        <span className="grow">
          {field.label}
          <Hint field={field} locked={locked} />
        </span>
        <input
          type="checkbox"
          checked={value === true}
          disabled={locked}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    );
  if (field.type === 'track') {
    const t = value && typeof value === 'object' && !Array.isArray(value) ? value : { current: '', max: '' };
    return (
      <div className="field">
        <span>{field.label}</span>
        <div className="row sheet-track">
          <input
            className="input"
            inputMode="numeric"
            value={t.current}
            readOnly={locked}
            aria-label={`${field.label} now`}
            onChange={(e) => onChange({ ...t, current: e.target.value })}
          />
          <span className="muted">of</span>
          <input
            className="input"
            inputMode="numeric"
            value={t.max}
            readOnly={locked}
            aria-label={`${field.label} maximum`}
            onChange={(e) => onChange({ ...t, max: e.target.value })}
          />
        </div>
        <Hint field={field} locked={locked} />
      </div>
    );
  }
  const text = typeof value === 'string' ? value : '';
  return (
    <div className="field">
      <span>{field.label}</span>
      {field.type === 'select' ? (
        <SelectInput field={field} value={text} locked={locked} onChange={onChange} />
      ) : field.type === 'longtext' ? (
        <textarea
          className="textarea"
          rows={3}
          value={text}
          readOnly={locked}
          maxLength={1500}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="input"
          inputMode={field.type === 'number' ? 'numeric' : undefined}
          value={text}
          readOnly={locked}
          maxLength={field.type === 'text' ? 1500 : 60}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <Hint field={field} locked={locked} />
    </div>
  );
}

const blankInput = (v: FieldInput | undefined) =>
  v === undefined ||
  v === false ||
  (typeof v === 'string' && !v.trim()) ||
  (Array.isArray(v) && !v.length) ||
  (typeof v === 'object' && !Array.isArray(v) && !v.current.trim() && !v.max.trim());

/**
 * The schema's sections as a form. Numbers sit in a compact grid at the top of
 * their section; everything else follows in order. A field the GM keeps is
 * read-only once it holds a value, unless `newSheet` (a player may set its
 * starting value).
 */
export function SheetSections({
  schema,
  values,
  onChange,
  newSheet,
}: {
  schema: SheetSchema | undefined;
  values: FormValues;
  onChange: (key: string, v: FieldInput) => void;
  newSheet: boolean;
}) {
  const locked = (f: SheetField) => f.editableBy === 'gm' && !newSheet && !blankInput(values[f.key]);
  return (
    <>
      {(schema?.sections ?? []).map((sec) => {
        const nums = sec.fields.filter((f) => f.type === 'number');
        const rest = sec.fields.filter((f) => f.type !== 'number');
        // A lone number reads better as a full-width field than as a grid of one.
        const grid = nums.length >= 2 ? nums : [];
        return (
          <section key={sec.id} className="sheet-section stack">
            <h3 className="sheet-section-title">{sec.label}</h3>
            {grid.length > 0 && (
              <div className="ability-inputs">
                {grid.map((f) => (
                  <label key={f.key} className="ability-input" title={f.help}>
                    <span>{f.label}</span>
                    <input
                      className="input"
                      inputMode="numeric"
                      value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''}
                      readOnly={locked(f)}
                      onChange={(e) => onChange(f.key, e.target.value)}
                      maxLength={8}
                    />
                  </label>
                ))}
              </div>
            )}
            {grid.some(locked) && (
              <span className="small faint">
                The GM keeps{' '}
                {grid
                  .filter(locked)
                  .map((f) => f.label.toLowerCase())
                  .join(' and ')}
                .
              </span>
            )}
            {(grid.length ? rest : sec.fields).map((f) => (
              <FieldInputView
                key={f.key}
                field={f}
                value={values[f.key]}
                locked={locked(f)}
                onChange={(v) => onChange(f.key, v)}
              />
            ))}
          </section>
        );
      })}
    </>
  );
}
