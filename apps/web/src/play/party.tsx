import type {
  CampaignDetail,
  Character,
  Entity,
  EntityKind,
  GameState,
  SheetSchema,
  UserRef,
} from '@tavern/protocol';
import { api } from '../api';
import { useMemo, useState, type ReactNode } from 'react';
import {
  IconBackpack,
  IconBook,
  IconClock,
  IconMap,
  IconPlus,
  IconScroll,
  IconSearch,
  IconShield,
  IconSparkle,
} from '../icons';
import { Avatar, Empty, HpBar, Presence, Segmented, Sheet, timeAgo } from '../ui';
import { CastActions, playedBy, runsIt, type CastPanel } from './cast';
import { isNpc, NpcTab } from './npcs';
import { fieldsOf, formatValue, isTrack, lookup } from './sheet-fields';

type Tab = 'party' | 'npcs' | 'world' | 'journal';

const KINDS: { kind: EntityKind; label: string; icon: ReactNode }[] = [
  { kind: 'quest', label: 'Quests', icon: <IconScroll /> },
  { kind: 'location', label: 'Places', icon: <IconMap /> },
  { kind: 'item', label: 'Items of note', icon: <IconBackpack /> },
  { kind: 'faction', label: 'Factions', icon: <IconShield /> },
  { kind: 'event', label: 'Events', icon: <IconClock /> },
  { kind: 'term', label: 'Lore', icon: <IconBook /> },
];

/** True if an entry matches a free-text codex query (name, aliases, summary, article). */
function entityMatches(e: Entity, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [e.name, e.summary, e.article, ...e.aliases].join('\n').toLowerCase().includes(needle);
}

/** A party member: who plays them, how they are doing, and their sheet. */
export function CharacterCard({
  ch,
  campaign,
  schema,
  meId,
  present,
  onOpen,
}: {
  ch: Character;
  campaign: CampaignDetail;
  schema: SheetSchema | undefined;
  meId: string;
  present: UserRef[];
  onOpen: (panel: CastPanel) => void;
}) {
  const mine = runsIt(ch, meId);
  // A character a person plays: whether any of its players is in the app right now.
  const played = ch.controller === 'player' && ch.playerIds.length > 0;
  const here = ch.playerIds.some((id) => present.some((u) => u.id === id));
  const all = fieldsOf(schema);
  const value = (key: string) => lookup(ch.sheet, key);
  const filled = all.filter((f) => formatValue(value(f.key)) !== '');
  // A section with a few card numbers (the ability scores) makes a grid; a lone one (Level) joins the line.
  const grid = (schema?.sections ?? []).flatMap((sec) => {
    const nums = sec.fields.filter((f) => f.showOnCard && f.type === 'number' && filled.includes(f));
    return nums.length >= 3 ? nums : [];
  });
  const tracks = filled.filter((f) => f.showOnCard && f.type === 'track' && isTrack(value(f.key)));
  const brief = filled
    .filter(
      (f) =>
        f.showOnCard &&
        !grid.includes(f) &&
        f.type !== 'track' &&
        f.type !== 'list' &&
        formatValue(value(f.key)).length <= 24,
    )
    .slice(0, 3);
  const long = filled.filter((f) => !grid.includes(f) && !brief.includes(f) && !tracks.includes(f));
  // Whatever else is on the sheet: fields the DM, the guide or an upload added.
  const known = new Set(all.map((f) => f.key.toLowerCase()));
  const extra = Object.keys(ch.sheet).filter(
    (k) => !known.has(k.toLowerCase()) && formatValue(ch.sheet[k]) !== '',
  );

  return (
    <div className={`card char${mine ? ' mine' : ''}`}>
      <div className="row">
        <Avatar name={ch.name} seed={ch.id} src={ch.portrait} online={played ? here : undefined} />
        <div className="grow">
          <h3 className="truncate">{ch.name}</h3>
          <p className="small muted truncate">
            {played && (
              <>
                <Presence online={here} /> ·{' '}
              </>
            )}
            {playedBy(ch, campaign, meId)}
            {brief.length > 0 &&
              ` · ${brief
                // A bare number means nothing without its label ("Level 3", not "3").
                .map((f) => {
                  const v = formatValue(value(f.key));
                  return (/^[+-]?\d+$/.test(v) ? `${f.label} ` : '') + v;
                })
                .join(' · ')}`}
          </p>
        </div>
        {ch.kind === 'npc' && <span className="pill arcane">Companion</span>}
      </div>

      {ch.whereabouts && (
        <div className="row">
          <p className="small muted grow">Away from the group: {ch.whereabouts}</p>
          {campaign.role === 'owner' && (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() =>
                void api(`/campaigns/${campaign.id}/characters/${ch.id}/whereabouts`, { method: 'DELETE' })
              }
            >
              Back with the party
            </button>
          )}
        </div>
      )}

      <HpBar hp={ch.hp} max={ch.maxHp} temp={ch.tempHp} label={schema?.hp.label} />
      {tracks.map((f) => {
        const t = value(f.key) as { current: number; max: number };
        return (
          <div key={f.key} className="card-track">
            <span className="small muted">{f.label}</span>
            <HpBar hp={t.current} max={t.max} label={f.label} />
          </div>
        );
      })}

      {ch.conditions.length > 0 && (
        <div className="row wrap conditions">
          {ch.conditions.map((cond) => (
            <span key={cond} className="pill ember">
              {cond}
            </span>
          ))}
        </div>
      )}

      {grid.length > 0 && (
        <div className="abilities">
          {grid.map((f) => (
            <div key={f.key} className="ability" title={f.label}>
              <span>{f.label.slice(0, 3)}</span>
              <b>{formatValue(value(f.key))}</b>
            </div>
          ))}
        </div>
      )}

      {(long.length > 0 ||
        extra.length > 0 ||
        ch.inventory.length > 0 ||
        ch.persona ||
        (mine && ch.privateNotes)) && (
        <details className="more">
          <summary>Sheet and pack</summary>
          {ch.persona && (
            <div className="sheet-field">
              <span className="label">Who they are</span>
              <p>{ch.persona}</p>
            </div>
          )}
          {long.map((f) => {
            const v = value(f.key);
            return (
              <div key={f.key} className="sheet-field">
                <span className="label">{f.label}</span>
                {Array.isArray(v) ? (
                  <ul className="sheet-rows">
                    {v.map((row, i) => (
                      <li key={i}>{formatValue([row])}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{formatValue(v)}</p>
                )}
              </div>
            );
          })}
          {extra.map((k) => (
            <div key={k} className="sheet-field">
              <span className="label">{k}</span>
              <p>{formatValue(ch.sheet[k])}</p>
            </div>
          ))}
          {ch.inventory.length > 0 && (
            <div className="sheet-field">
              <span className="label">Inventory</span>
              <ul className="inventory">
                {ch.inventory.map((item) => (
                  <li key={item.name}>
                    <span className="grow">
                      {item.name}
                      {item.notes && <small>{item.notes}</small>}
                    </span>
                    {item.qty > 1 && <span className="qty">×{item.qty}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {mine && ch.privateNotes && (
            <div className="sheet-field">
              <span className="label">Private notes (only you see these)</span>
              <p>{ch.privateNotes}</p>
            </div>
          )}
        </details>
      )}
      <CastActions character={ch} campaign={campaign} onOpen={onOpen} />
    </div>
  );
}

function EntityRow({ e }: { e: Entity }) {
  return (
    <div className="entity">
      <div className="row">
        <b className="grow">{e.name}</b>
        {e.status && <span className="pill">{e.status}</span>}
      </div>
      {e.aliases.length > 0 && <p className="small muted aliases">Also known as {e.aliases.join(', ')}</p>}
      {e.summary && <p className="small muted">{e.summary}</p>}
      {e.article && (
        <details className="article">
          <summary>Read more</summary>
          <p>{e.article}</p>
          {e.articleSecret && (
            <p className="secret">
              <IconSparkle /> {e.articleSecret}
            </p>
          )}
        </details>
      )}
      {e.secret && (
        <p className="small secret">
          <IconSparkle /> {e.secret}
        </p>
      )}
    </div>
  );
}

/** Everything the table knows: the party's sheets, the world so far, and a log of what changed. */
export function PartySheet({
  campaign,
  state,
  schema,
  meId,
  present,
  onOpen,
  onClose,
}: {
  campaign: CampaignDetail;
  state: GameState;
  schema: SheetSchema | undefined;
  meId: string;
  present: UserRef[];
  /** Open one of the party sheets (add, edit, guide, who plays). */
  onOpen: (panel: CastPanel) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('party');
  const [codexQuery, setCodexQuery] = useState('');
  // People and creatures have their own tab.
  const world = useMemo(() => state.entities.filter((e) => !isNpc(e)), [state.entities]);
  const matches = useMemo(() => world.filter((e) => entityMatches(e, codexQuery)), [world, codexQuery]);
  const ordered = [...state.characters].sort((a, b) => Number(runsIt(b, meId)) - Number(runsIt(a, meId)));
  const without = campaign.members.filter(
    (m) => m.id !== meId && !state.characters.some((ch) => runsIt(ch, m.id)),
  );
  const flags = Object.entries(state.flags);

  return (
    <Sheet
      title="The table"
      onClose={onClose}
      tall
      header={
        <div className="sheet-tabs">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'party', label: 'Party' },
              { value: 'npcs', label: 'NPCs' },
              { value: 'world', label: 'World' },
              { value: 'journal', label: 'Journal' },
            ]}
          />
        </div>
      }
    >
      {tab === 'party' && (
        <div className="stack">
          {ordered.map((ch) => (
            <CharacterCard
              key={ch.id}
              ch={ch}
              campaign={campaign}
              schema={schema}
              meId={meId}
              present={present}
              onOpen={onOpen}
            />
          ))}
          {without.map((m) => (
            <div key={m.id} className="card char pending">
              <div className="row">
                <Avatar name={m.displayName} seed={m.id} />
                <div className="grow">
                  <h3 className="truncate">{m.displayName}</h3>
                  <p className="small muted">Has not made a character yet</p>
                </div>
              </div>
            </div>
          ))}
          {campaign.status === 'active' && (
            <button type="button" className="btn block" onClick={() => onOpen({ kind: 'add' })}>
              <IconPlus /> Add to the party
            </button>
          )}
        </div>
      )}

      {tab === 'npcs' && (
        <NpcTab campaignId={campaign.id} entities={state.entities} owner={campaign.role === 'owner'} />
      )}

      {tab === 'world' && (
        <div className="stack">
          {state.scene && (
            <div className="card hero">
              <p className="small gold">The scene</p>
              <p className="scene">{state.scene}</p>
            </div>
          )}
          {world.length > 0 && (
            <div className="codex-search">
              <IconSearch />
              <input
                className="input"
                value={codexQuery}
                onChange={(ev) => setCodexQuery(ev.target.value)}
                placeholder="Search the codex"
                maxLength={120}
                enterKeyHint="search"
                aria-label="Search the codex"
              />
            </div>
          )}
          {KINDS.map(({ kind, label, icon }) => {
            const list = matches.filter((e) => e.kind === kind);
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
                    <EntityRow key={e.id} e={e} />
                  ))}
                </div>
              </section>
            );
          })}
          {world.length > 0 && matches.length === 0 && (
            <p className="small muted empty-hint">Nothing in the codex matches “{codexQuery}”.</p>
          )}
          {!state.scene && world.length === 0 && (
            <Empty icon={<IconMap />} title="Uncharted">
              Places, quests, events and lore appear here as the Dungeon Master brings them into the story.
            </Empty>
          )}
        </div>
      )}

      {tab === 'journal' && (
        <div className="stack">
          {flags.length > 0 && (
            <dl className="kv card">
              {flags.map(([k, v]) => (
                <div key={k} className="kv-row">
                  <dt>{k.replace(/_/g, ' ')}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {state.events.length === 0 ? (
            <Empty icon={<IconScroll />} title="Nothing recorded yet">
              Every change the Dungeon Master makes to hit points, packs and the world is logged here.
            </Empty>
          ) : (
            <ul className="timeline">
              {state.events.map((ev) => (
                <li key={ev.id}>
                  <span>{ev.summary}</span>
                  <time>{timeAgo(ev.createdAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Sheet>
  );
}
