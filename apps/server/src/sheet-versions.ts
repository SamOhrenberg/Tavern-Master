import type { SheetRename, SheetSchema, SheetUpdate, SheetValue } from '@tavern/protocol';
import { q, q1, tx, type Queryable } from './db/pool.js';
import { badRequest, conflict, notFound } from './errors.js';
import { proposalsFor } from './sheet-proposals.js';
import { blank, checkSheet, clip, coerce, fieldIndex, formatValue, toSchema } from './sheet-schema.js';

/**
 * Versions of a system's character sheet. Publishing a sheet makes a new
 * version and keeps the old ones, so a campaign in play is never changed
 * under its players: it stays on its version until the host updates it, and
 * the update carries every character's values across, field by field.
 */

const low = (s: string) => s.trim().toLowerCase();

/** Keys of a version's renames, matched whatever the capitalisation. */
function renameOf(renames: Record<string, string>, key: string): string | undefined {
  const hit = Object.entries(renames).find(([from]) => low(from) === low(key));
  return hit?.[1];
}

/**
 * Check a set of renames against the sheet before and after: each must move
 * a field the new sheet no longer has to one the old sheet did not have.
 * Throws a 400 naming the first that does not.
 */
export function checkRenames(
  before: SheetSchema,
  after: SheetSchema,
  renames: SheetRename[],
): Record<string, string> {
  const was = fieldIndex(before);
  const now = fieldIndex(after);
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const { from, to } of renames) {
    const old = was.get(low(from));
    const next = now.get(low(to));
    if (!old || now.has(low(from)))
      throw badRequest(
        `"${from}" is not a field this version takes away, so there is nothing to carry over.`,
      );
    if (!next || was.has(low(to))) throw badRequest(`"${to}" is not a field this version adds.`);
    if (taken.has(low(next.key)) || out[old.key])
      throw badRequest(`Each field can be carried over once: "${from}" → "${to}" repeats one.`);
    taken.add(low(next.key));
    out[old.key] = next.key;
  }
  return out;
}

/**
 * Publish a new version of a system's sheet: it becomes the sheet new
 * campaigns get. Campaigns with no characters yet have nothing to carry over
 * and move to it at once; the rest stay where they are until their host
 * updates. Publishing the sheet the system already has makes no new version.
 * Returns the version the system is now on.
 */
export async function publishSheet(
  systemId: string,
  schema: SheetSchema,
  opts: { renames?: Record<string, string>; by?: string | null } = {},
  on?: Queryable,
): Promise<number> {
  const run = async (c: Queryable) => {
    const sys = await q1<{ sheet_template: unknown; sheet_version: number }>(
      'SELECT sheet_template, sheet_version FROM game_systems WHERE id = $1 FOR UPDATE',
      [systemId],
      c,
    );
    if (!sys) throw notFound();
    const renames = opts.renames ?? {};
    if (
      JSON.stringify(toSchema(sys.sheet_template)) === JSON.stringify(schema) &&
      !Object.keys(renames).length
    )
      return sys.sheet_version;
    // A system made before versions, or never published since, gets its first version recorded now.
    await q(
      `INSERT INTO sheet_versions (system_id, version, schema) VALUES ($1, $2, $3)
       ON CONFLICT (system_id, version) DO NOTHING`,
      [systemId, sys.sheet_version, JSON.stringify(sys.sheet_template)],
      c,
    );
    const next = sys.sheet_version + 1;
    await q(
      'INSERT INTO sheet_versions (system_id, version, schema, renames, created_by) VALUES ($1, $2, $3, $4, $5)',
      [systemId, next, JSON.stringify(schema), JSON.stringify(renames), opts.by ?? null],
      c,
    );
    await q(
      'UPDATE game_systems SET sheet_template = $2, sheet_version = $3 WHERE id = $1',
      [systemId, JSON.stringify(schema), next],
      c,
    );
    await q(
      `UPDATE campaigns c SET sheet_version = $2
        WHERE c.system_id = $1 AND NOT EXISTS (SELECT 1 FROM characters ch WHERE ch.campaign_id = c.id)`,
      [systemId, next],
      c,
    );
    return next;
  };
  return on ? run(on) : tx(run);
}

// ---- carrying a sheet from one version to the next ----

export interface Carried {
  sheet: Record<string, SheetValue>;
  moved: SheetRename[];
  kept: { field: string; as: string }[];
}

/** A free name beside a field for a value that no longer fits it: "Previous Stress". */
function spareName(label: string, taken: (k: string) => boolean): string {
  const base = `Previous ${label}`
    .replace(/[^\w ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 36)
    .trim();
  let name = base;
  for (let n = 2; taken(name); n++) name = `${base} ${n}`;
  return name;
}

/**
 * A sheet written for one version as the next version holds it: values under
 * a renamed field move to its new name, and each value is put in its field's
 * new shape. A value that cannot take that shape (text where a number now
 * goes) is not lost: it stays on the sheet under a name of its own, beside
 * the field, for someone to sort out.
 */
export function carrySheet(
  sheet: Record<string, unknown>,
  schema: SheetSchema,
  renames: Record<string, string>,
): Carried {
  const index = fieldIndex(schema);
  const moved: SheetRename[] = [];
  const kept: Carried['kept'] = [];
  const out: Record<string, unknown> = {};
  const has = (k: string) => Object.keys(out).some((x) => low(x) === low(k));

  // Values under renamed fields go last, so they win over a stray entry of the same name.
  const entries = Object.entries(sheet).sort(
    ([a], [b]) => Number(!!renameOf(renames, a)) - Number(!!renameOf(renames, b)),
  );
  for (const [key, value] of entries) {
    if (blank(value)) continue;
    const to = renameOf(renames, key);
    if (to) moved.push({ from: key, to });
    const name = to ?? key;
    const field = index.get(low(name));
    if (!field) {
      out[name] = value;
      continue;
    }
    const fitted = coerce(field, value);
    if (fitted !== undefined) {
      for (const k of Object.keys(out)) if (low(k) === low(field.key)) delete out[k];
      out[field.key] = fitted;
      continue;
    }
    const as = spareName(field.label, (k) => has(k) || index.has(low(k)) || k in sheet);
    out[as] = typeof value === 'number' ? value : clip(formatValue(value), 1500);
    kept.push({ field: field.key, as });
  }
  let checked: Record<string, SheetValue>;
  try {
    checked = checkSheet(schema, out);
  } catch {
    // Over a limit the new version sets: keep the sheet as carried, to be trimmed on its next save.
    checked = out as Record<string, SheetValue>;
  }
  return { sheet: checked, moved, kept };
}

interface VersionRow {
  version: number;
  schema: unknown;
  renames: Record<string, string>;
}

/** The versions after `from`, up to and including `to`, oldest first. */
async function stepsBetween(
  systemId: string,
  from: number,
  to: number,
  on?: Queryable,
): Promise<VersionRow[]> {
  const rows = await q<VersionRow>(
    `SELECT version, schema, renames FROM sheet_versions
      WHERE system_id = $1 AND version > $2 AND version <= $3 ORDER BY version`,
    [systemId, from, to],
    on,
  );
  if (rows.length !== to - from)
    throw conflict('A version of this sheet is missing, so it cannot be updated.');
  return rows;
}

/** Carry a sheet across every version from `from` to the last of `steps`. */
function carryAcross(sheet: Record<string, unknown>, steps: VersionRow[]): Carried {
  let now: Carried = { sheet: sheet as Record<string, SheetValue>, moved: [], kept: [] };
  for (const step of steps) {
    const next = carrySheet(now.sheet, toSchema(step.schema), step.renames ?? {});
    // A value moved twice (a → b, then b → c) reads as one move, a → c.
    const moved = [...now.moved];
    for (const m of next.moved) {
      const earlier = moved.find((x) => low(x.to) === low(m.from));
      if (earlier) earlier.to = m.to;
      else moved.push(m);
    }
    now = { sheet: next.sheet, moved, kept: [...now.kept, ...next.kept] };
  }
  return now;
}

/**
 * Sheets saved at an earlier version (in a rewind snapshot) as the version a
 * campaign is on now. Unchanged when the versions are the same.
 */
export async function carrySheets<T extends { sheet: Record<string, unknown> }>(
  systemId: string,
  from: number,
  to: number,
  rows: T[],
  on?: Queryable,
): Promise<T[]> {
  if (from >= to || !rows.length) return rows;
  const steps = await stepsBetween(systemId, from, to, on);
  return rows.map((r) => ({ ...r, sheet: carryAcross(r.sheet ?? {}, steps).sheet }));
}

// ---- updating a campaign ----

interface CampaignVersion {
  system_id: string;
  sheet_version: number;
  latest: number;
}

async function campaignVersion(campaignId: string, on?: Queryable, lock = false): Promise<CampaignVersion> {
  const row = await q1<CampaignVersion>(
    `SELECT c.system_id, c.sheet_version, s.sheet_version AS latest
       FROM campaigns c JOIN game_systems s ON s.id = c.system_id WHERE c.id = $1${lock ? ' FOR UPDATE OF c' : ''}`,
    [campaignId],
    on,
  );
  if (!row) throw notFound();
  return row;
}

async function schemaAt(systemId: string, version: number, on?: Queryable): Promise<SheetSchema> {
  const row = await q1<{ schema: unknown }>(
    `SELECT coalesce(
       (SELECT schema FROM sheet_versions WHERE system_id = $1 AND version = $2),
       (SELECT sheet_template FROM game_systems WHERE id = $1)) AS schema`,
    [systemId, version],
    on,
  );
  return toSchema(row?.schema);
}

/** What updating the campaign to its system's latest sheet would do, or null when it is on it. */
async function planUpdate(campaignId: string, on?: Queryable, lock = false) {
  const v = await campaignVersion(campaignId, on, lock);
  if (v.sheet_version >= v.latest) return null;
  const steps = await stepsBetween(v.system_id, v.sheet_version, v.latest, on);
  const chars = await q<{ id: string; name: string; sheet: Record<string, unknown> }>(
    `SELECT id, name, sheet FROM characters WHERE campaign_id = $1 ORDER BY created_at${lock ? ' FOR UPDATE' : ''}`,
    [campaignId],
    on,
  );
  const carried = chars.map((c) => ({ ...c, carried: carryAcross(c.sheet ?? {}, steps) }));
  const update: SheetUpdate = {
    from: v.sheet_version,
    to: v.latest,
    changes: proposalsFor(await schemaAt(v.system_id, v.sheet_version, on), toSchema(steps.at(-1)!.schema)),
    characters: carried.map((c) => ({ name: c.name, moved: c.carried.moved, kept: c.carried.kept })),
  };
  return { update, carried };
}

/** For the host: what updating to the latest sheet would change. Null when the campaign is on it. */
export async function previewUpdate(campaignId: string): Promise<SheetUpdate | null> {
  return (await planUpdate(campaignId))?.update ?? null;
}

/**
 * Move the campaign to its system's latest sheet and carry every character's
 * sheet across. `to` is the version the host was shown: if a newer one was
 * published since, nothing changes and they are asked to look again.
 */
export async function applyUpdate(campaignId: string, to: number): Promise<SheetUpdate> {
  return tx(async (c) => {
    const plan = await planUpdate(campaignId, c, true);
    if (!plan) throw conflict('This campaign is already on the latest version of its sheet.');
    if (plan.update.to !== to)
      throw conflict(
        'A newer version of the sheet was published meanwhile. Look over the changes again.',
        'stale',
      );
    for (const ch of plan.carried)
      await q(
        'UPDATE characters SET sheet = $2, updated_at = now() WHERE id = $1',
        [ch.id, JSON.stringify(ch.carried.sheet)],
        c,
      );
    await q('UPDATE campaigns SET sheet_version = $2 WHERE id = $1', [campaignId, to], c);
    return plan.update;
  });
}
