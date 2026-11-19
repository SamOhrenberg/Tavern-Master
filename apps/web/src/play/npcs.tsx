import type { Entity } from '@tavern/protocol';
import { useMemo, useState } from 'react';
import { IconBack, IconChevron, IconSearch, IconSparkle, IconSwords, IconUsers } from '../icons';
import { Avatar, Empty } from '../ui';

/** People and creatures: the entries the NPCs tab holds. */
export const isNpc = (e: Entity) => e.kind === 'npc' || e.kind === 'creature';

const SECTIONS = [
  { kind: 'npc', label: 'People', icon: <IconUsers /> },
  { kind: 'creature', label: 'Creatures', icon: <IconSwords /> },
] as const;

/** Name, other names, what the party knows and the stat block they have seen. */
function matches(e: Entity, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    e.name,
    e.summary,
    e.article,
    e.status,
    ...e.aliases,
    ...e.sheet.map((l) => `${l.label} ${l.value}`),
  ]
    .join('\n')
    .toLowerCase()
    .includes(needle);
}

/**
 * Everyone and everything the party has run into, with a search: the people
 * they have met and the creatures they have faced, each with the stat block
 * the DM keeps. Only what the party has learned is here; spoilers never
 * reach this screen.
 */
export function NpcTab({ entities }: { entities: Entity[] }) {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const all = useMemo(() => entities.filter(isNpc), [entities]);
  const found = useMemo(() => all.filter((e) => matches(e, query)), [all, query]);
  const open = openId ? all.find((e) => e.id === openId) : undefined;

  if (open) return <NpcDetail e={open} onBack={() => setOpenId(null)} />;

  if (!all.length) {
    return (
      <Empty icon={<IconUsers />} title="No one yet">
        The people you meet and the creatures you face are kept here, with what you have learned about them.
      </Empty>
    );
  }

  return (
    <div className="stack">
      <div className="codex-search">
        <IconSearch />
        <input
          className="input"
          type="search"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          placeholder="Search people and creatures"
          maxLength={120}
          enterKeyHint="search"
          aria-label="Search people and creatures"
        />
      </div>
      {SECTIONS.map(({ kind, label, icon }) => {
        const list = found.filter((e) => e.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind}>
            <div className="section-title with-icon">
              <span>
                {icon}
                {label}
              </span>
              <span>{list.length}</span>
            </div>
            <div className="entities">
              {list.map((e) => (
                <button key={e.id} type="button" className="entity npc-row" onClick={() => setOpenId(e.id)}>
                  <Avatar name={e.name} seed={e.id} small />
                  <span className="grow npc-row-text">
                    <span className="row">
                      <b className="grow truncate">{e.name}</b>
                      {e.status && <span className="pill">{e.status}</span>}
                    </span>
                    {e.summary && <span className="small muted npc-row-summary">{e.summary}</span>}
                  </span>
                  <IconChevron className="chev" />
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {found.length === 0 && <p className="small muted empty-hint">No one matches “{query}”.</p>}
    </div>
  );
}

/** One person or creature: what the party knows, and the stat block lines they have learned. */
function NpcDetail({ e, onBack }: { e: Entity; onBack: () => void }) {
  return (
    <div className="stack npc-detail">
      <button type="button" className="btn sm ghost npc-back" onClick={onBack}>
        <IconBack /> People and creatures
      </button>
      <div className="row npc-head">
        <Avatar name={e.name} seed={e.id} />
        <div className="grow">
          <h3>{e.name}</h3>
          <p className="small muted">
            {e.kind === 'creature' ? 'Creature' : 'Person'}
            {e.status ? ` · ${e.status}` : ''}
          </p>
        </div>
      </div>
      {e.aliases.length > 0 && <p className="small muted aliases">Also known as {e.aliases.join(', ')}</p>}
      {e.summary && <p className="codex-summary">{e.summary}</p>}
      {e.sheet.length > 0 && (
        <dl className="kv card stat-block">
          {e.sheet.map((l) => (
            <div key={l.label} className="kv-row">
              <dt>{l.label}</dt>
              <dd>{l.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {e.article && <p className="codex-article">{e.article}</p>}
      {e.articleSecret && (
        <p className="secret">
          <IconSparkle /> {e.articleSecret}
        </p>
      )}
      {e.secret && (
        <p className="secret">
          <IconSparkle /> {e.secret}
        </p>
      )}
      {!e.summary && !e.article && !e.sheet.length && (
        <p className="small muted">The story has not recorded more about them yet.</p>
      )}
    </div>
  );
}
