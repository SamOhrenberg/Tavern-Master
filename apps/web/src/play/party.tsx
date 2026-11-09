import type {
  CampaignDetail,
  Character,
  Entity,
  EntityKind,
  GameState,
  SheetTemplate,
  UserRef,
} from '@tavern/protocol';
import { useState, type ReactNode } from 'react';
import { IconBackpack, IconMap, IconScroll, IconShield, IconSparkle, IconUsers } from '../icons';
import { Avatar, Empty, HpBar, Segmented, Sheet, timeAgo } from '../ui';

type Tab = 'party' | 'world' | 'journal';

const KINDS: { kind: EntityKind; label: string; icon: ReactNode }[] = [
  { kind: 'quest', label: 'Quests', icon: <IconScroll /> },
  { kind: 'npc', label: 'People', icon: <IconUsers /> },
  { kind: 'location', label: 'Places', icon: <IconMap /> },
  { kind: 'item', label: 'Items of note', icon: <IconBackpack /> },
  { kind: 'faction', label: 'Factions', icon: <IconShield /> },
];

const show = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

function CharacterCard({
  ch,
  player,
  template,
  mine,
  here,
  onEdit,
}: {
  ch: Character;
  player: string;
  template: SheetTemplate | undefined;
  mine: boolean;
  here: boolean;
  onEdit: () => void;
}) {
  const abilities = (template?.abilities ?? []).filter((a) => show(ch.sheet[a]) !== '');
  const fields = (template?.fields ?? []).filter((f) => show(ch.sheet[f.key]) !== '');
  const brief = fields.filter((f) => show(ch.sheet[f.key]).length <= 24).slice(0, 3);
  const long = fields.filter((f) => !brief.includes(f));

  return (
    <div className={`card char${mine ? ' mine' : ''}`}>
      <div className="row">
        <Avatar name={ch.name} seed={ch.userId} />
        <div className="grow">
          <h3 className="truncate">{ch.name}</h3>
          <p className="small muted truncate">
            {here && <i className="here" />}
            {mine ? 'You' : player}
            {brief.length > 0 && ` · ${brief.map((f) => show(ch.sheet[f.key])).join(' · ')}`}
          </p>
        </div>
        {mine && (
          <button type="button" className="btn sm" onClick={onEdit}>
            Edit
          </button>
        )}
      </div>

      <HpBar hp={ch.hp} max={ch.maxHp} temp={ch.tempHp} />

      {ch.conditions.length > 0 && (
        <div className="row wrap conditions">
          {ch.conditions.map((cond) => (
            <span key={cond} className="pill ember">
              {cond}
            </span>
          ))}
        </div>
      )}

      {abilities.length > 0 && (
        <div className="abilities">
          {abilities.map((a) => (
            <div key={a} className="ability">
              <span>{a.slice(0, 3)}</span>
              <b>{show(ch.sheet[a])}</b>
            </div>
          ))}
        </div>
      )}

      {(long.length > 0 || ch.inventory.length > 0 || (mine && ch.privateNotes)) && (
        <details className="more">
          <summary>Sheet and pack</summary>
          {long.map((f) => (
            <div key={f.key} className="sheet-field">
              <span className="label">{f.label}</span>
              <p>{show(ch.sheet[f.key])}</p>
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
      {e.summary && <p className="small muted">{e.summary}</p>}
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
  template,
  meId,
  present,
  onEdit,
  onClose,
}: {
  campaign: CampaignDetail;
  state: GameState;
  template: SheetTemplate | undefined;
  meId: string;
  present: UserRef[];
  onEdit: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('party');
  const ordered = [...state.characters].sort((a, b) => Number(b.userId === meId) - Number(a.userId === meId));
  const without = campaign.members.filter((m) => !state.characters.some((ch) => ch.userId === m.id));
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
              player={campaign.members.find((m) => m.id === ch.userId)?.displayName ?? 'A player'}
              template={template}
              mine={ch.userId === meId}
              here={present.some((u) => u.id === ch.userId)}
              onEdit={onEdit}
            />
          ))}
          {without.map((m) =>
            m.id === meId ? (
              <button key={m.id} type="button" className="btn primary block" onClick={onEdit}>
                Create your character
              </button>
            ) : (
              <div key={m.id} className="card char pending">
                <div className="row">
                  <Avatar name={m.displayName} seed={m.id} />
                  <div className="grow">
                    <h3 className="truncate">{m.displayName}</h3>
                    <p className="small muted">Has not made a character yet</p>
                  </div>
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {tab === 'world' && (
        <div className="stack">
          {state.scene && (
            <div className="card hero">
              <p className="small gold">The scene</p>
              <p className="scene">{state.scene}</p>
            </div>
          )}
          {KINDS.map(({ kind, label, icon }) => {
            const list = state.entities.filter((e) => e.kind === kind);
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
          {!state.scene && state.entities.length === 0 && (
            <Empty icon={<IconMap />} title="Uncharted">
              People, places and quests appear here as the Dungeon Master brings them into the story.
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
