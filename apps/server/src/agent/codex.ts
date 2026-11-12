import type { Entity, EntityRef } from '@tavern/protocol';
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
  };
}

/**
 * Resolve the `[[name]]` codex markers a narrator leaves in its prose. A marker
 * whose inner text matches a browsable entry's name or alias stays as `[[text]]`
 * in the content (the anchor the client turns into a chip) and yields a ref; a
 * marker that matches nothing is stripped back to plain text so no dangling
 * markup reaches the reader. Matching is case-insensitive. Only `in_codex`
 * entries resolve, so bookkeeping entities never link.
 */
export function resolveRefs(
  text: string,
  entities: EntityRow[],
): { content: string; refs: EntityRef[] } {
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
