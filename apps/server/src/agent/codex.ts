import type { Entity, EntityFull, EntityRef, StatLineFull } from '@tavern/protocol';
import type { EntityRow } from './store.js';

/**
 * Strip an entity down to what may leave the server. Unrevealed secrets
 * (`secret` and `article_secret`) never ship, for anyone — not even the owner,
 * who is usually a player too. Once revealed they travel with the entry.
 */
export function scopeEntity(e: EntityRow): Entity {
  const revealed = Boolean(e.secret) && e.secretRevealed;
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    aliases: e.aliases,
    summary: e.summary,
    article: e.article,
    status: e.status,
    secretRevealed: e.secretRevealed,
    firstSeenAt: e.firstSeenAt,
    ...(revealed ? { secret: e.secret! } : {}),
    ...(revealed && e.articleSecret ? { articleSecret: e.articleSecret } : {}),
    // Hidden lines are spoilers: they stay on the server until the DM reveals them.
    sheet: e.sheet.filter((l) => !l.hidden).map(({ label, value }) => ({ label, value })),
    inScene: e.inScene,
    ...(e.portrait ? { portrait: e.portrait } : {}),
  };
}

/** Everything about an entry, spoilers included: for the campaign's owners only. */
export function fullEntity(e: EntityRow): EntityFull {
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    aliases: e.aliases,
    summary: e.summary,
    article: e.article,
    status: e.status,
    secret: e.secret ?? '',
    articleSecret: e.articleSecret ?? '',
    secretRevealed: e.secretRevealed,
    firstSeenAt: e.firstSeenAt,
    sheet: e.sheet,
    hidden: e.hidden,
    inScene: e.inScene,
    ...(e.portrait ? { portrait: e.portrait } : {}),
  };
}

/** Entries players are sent: browsable, and met (not still planned). */
export const playerVisible = (e: Pick<EntityRow, 'inCodex' | 'hidden'>) => e.inCodex && !e.hidden;

const MAX_LINES = 40;

/**
 * Update a stat block line by line, as the DM writes it: a line whose label
 * is already there (matched without regard to case) takes the new value, a
 * new label is added at the end, and an empty value removes the line. A line
 * keeps whether it is hidden unless the update says otherwise; a new one is
 * shown unless marked hidden.
 */
export function mergeStatLines(
  current: StatLineFull[],
  changes: { label: string; value: string; hidden?: boolean }[],
): StatLineFull[] {
  const out = current.map((l) => ({ ...l }));
  for (const c of changes) {
    const label = c.label.trim();
    if (!label) continue;
    const at = out.findIndex((l) => l.label.toLowerCase() === label.toLowerCase());
    const value = c.value.trim();
    if (!value) {
      if (at >= 0) out.splice(at, 1);
      continue;
    }
    if (at >= 0) out[at] = { label, value, hidden: c.hidden ?? out[at]!.hidden };
    else out.push({ label, value, hidden: c.hidden ?? false });
  }
  return out.slice(0, MAX_LINES);
}

/** Read a stat block from the database, dropping anything malformed. */
export function readStatLines(raw: unknown): StatLineFull[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) =>
    l && typeof l === 'object' && typeof l.label === 'string' && typeof l.value === 'string'
      ? [{ label: l.label, value: l.value, hidden: l.hidden === true }]
      : [],
  );
}

/**
 * Resolve the `[[name]]` codex markers a narrator leaves in its prose. A marker
 * whose inner text matches a browsable entry's name or alias stays as `[[text]]`
 * in the content (the anchor the client turns into a chip) and yields a ref; a
 * marker that matches nothing is stripped back to plain text so no dangling
 * markup reaches the reader. Matching is case-insensitive. Only `in_codex`
 * entries resolve, so bookkeeping entities never link.
 */
export function resolveRefs(text: string, entities: EntityRow[]): { content: string; refs: EntityRef[] } {
  const lookup = new Map<string, EntityRow>();
  for (const e of entities) {
    if (!e.inCodex) continue;
    for (const key of [e.name, ...e.aliases]) {
      const k = key.trim().toLowerCase();
      if (k && !lookup.has(k)) lookup.set(k, e);
    }
  }
  const seen = new Set<string>();
  const refs: EntityRef[] = [];
  const content = text.replace(/\[\[([^\]\n]+)\]\]/g, (_m, inner: string) => {
    const e = lookup.get(inner.trim().toLowerCase());
    if (!e) return inner;
    const dedupe = `${inner}\u0000${e.id}`;
    if (!seen.has(dedupe)) {
      seen.add(dedupe);
      refs.push({ text: inner, entityId: e.id, name: e.name, kind: e.kind });
    }
    return `[[${inner}]]`;
  });
  return { content, refs };
}

/** Does an entity match a free-text codex query? Name, aliases, summary and article. */
export function entityMatches(e: EntityRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [e.name, e.summary, e.article, ...e.aliases].join('\n').toLowerCase();
  return hay.includes(q);
}
