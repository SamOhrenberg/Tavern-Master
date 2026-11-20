import type { Entity, EntityEdit, EntityFull, StatLineFull } from '@tavern/protocol';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api';
import { useAction, useToast } from '../app';
import {
  IconBack,
  IconChevron,
  IconClose,
  IconKey,
  IconPlus,
  IconSearch,
  IconSparkle,
  IconSwords,
  IconUsers,
} from '../icons';
import { Avatar, ConfirmButton, Empty, Field, Segmented } from '../ui';
import { PortraitPick, usePortraitPick } from './portrait-pick';

/** People and creatures: the entries the NPCs tab holds. */
export const isNpc = (e: { kind: string }) => e.kind === 'npc' || e.kind === 'creature';

const SECTIONS = [
  { kind: 'npc', label: 'People', icon: <IconUsers /> },
  { kind: 'creature', label: 'Creatures', icon: <IconSwords /> },
] as const;

/**
 * One person or creature as this screen shows it. For players, only what the
 * party has learned (the server sends nothing else). For an owner looking
 * behind the curtain, everything, with the spoilers marked.
 */
interface Npc {
  id: string;
  kind: Entity['kind'];
  name: string;
  aliases: string[];
  summary: string;
  article: string;
  status: string;
  sheet: { label: string; value: string; hidden?: boolean }[];
  secret: string;
  /** False for a secret the party has not discovered (shown to owners only). */
  secretRevealed: boolean;
  articleSecret: string;
  /** The party has not met them yet (shown to owners only). */
  hidden: boolean;
  /** Where to load their picture from, if they have one. */
  portrait?: string;
}

const fromEntity = (e: Entity): Npc => ({
  ...e,
  secret: e.secret ?? '',
  articleSecret: e.articleSecret ?? '',
  secretRevealed: true,
  hidden: false,
});

const fromFull = (e: EntityFull): Npc => ({ ...e });

/** Name, other names, what the party knows and the stat block. */
function matches(e: Npc, query: string): boolean {
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

const BLANK: EntityEdit = {
  kind: 'npc',
  name: '',
  aliases: [],
  summary: '',
  article: '',
  status: '',
  sheet: [],
  secret: '',
  articleSecret: '',
  secretRevealed: false,
  hidden: false,
};

type View = { at: 'list' } | { at: 'entry'; id: string } | { at: 'edit'; entry: EntityFull | null };

/**
 * Everyone and everything the party has run into, with a search: the people
 * they have met and the creatures they have faced, each with the stat block
 * the DM keeps. Players see only what the party has learned. The campaign's
 * owners can add and change entries, and can choose to see the spoilers:
 * hidden lines, secrets, and people the party has not met yet.
 */
export function NpcTab({
  campaignId,
  entities,
  owner,
}: {
  campaignId: string;
  entities: Entity[];
  owner: boolean;
}) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>({ at: 'list' });
  const [spoilers, setSpoilers] = useState(false);
  const [full, setFull] = useState<EntityFull[] | null>(null);
  const [, run] = useAction();

  // The owner's view with spoilers comes from its own request, and again whenever the table changes.
  useEffect(() => {
    if (!owner || !spoilers) return setFull(null);
    let live = true;
    void run(async () => {
      const { entries } = await api<{ entries: EntityFull[] }>(
        `/campaigns/${campaignId}/entities?kinds=npc,creature`,
      );
      if (live) setFull(entries);
    });
    return () => {
      live = false;
    };
  }, [owner, spoilers, campaignId, entities, run]);

  const all = useMemo(
    () => (full ? full.map(fromFull) : entities.filter(isNpc).map(fromEntity)),
    [full, entities],
  );
  const found = useMemo(() => all.filter((e) => matches(e, query)), [all, query]);

  const edit = (id: string | null) =>
    run(async () => {
      const entry = id
        ? (await api<{ entry: EntityFull }>(`/campaigns/${campaignId}/entities/${id}`)).entry
        : null;
      setView({ at: 'edit', entry });
    });

  if (view.at === 'edit') {
    return (
      <NpcEditor
        campaignId={campaignId}
        entry={view.entry}
        onDone={(id) => setView(id ? { at: 'entry', id } : { at: 'list' })}
      />
    );
  }

  const open = view.at === 'entry' ? all.find((e) => e.id === view.id) : undefined;
  if (open) {
    return (
      <NpcDetail
        e={open}
        spoilers={!!full}
        onBack={() => setView({ at: 'list' })}
        onEdit={owner ? () => void edit(open.id) : undefined}
      />
    );
  }

  return (
    <div className="stack">
      {owner && (
        <div className="npc-owner">
          <label className="card row view-toggle">
            <div className="grow">
              <b>Show spoilers</b>
              <div className="small muted">
                Hidden lines, secrets and anyone the party has not met yet. Only owners can see them.
              </div>
            </div>
            <input type="checkbox" checked={spoilers} onChange={(e) => setSpoilers(e.target.checked)} />
          </label>
          <button type="button" className="btn block" onClick={() => void edit(null)}>
            <IconPlus /> Add a person or creature
          </button>
        </div>
      )}
      {all.length === 0 ? (
        <Empty icon={<IconUsers />} title="No one yet">
          The people you meet and the creatures you face are kept here, with what you have learned about them.
        </Empty>
      ) : (
        <>
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
                    <button
                      key={e.id}
                      type="button"
                      className="entity npc-row"
                      onClick={() => setView({ at: 'entry', id: e.id })}
                    >
                      <Avatar name={e.name} seed={e.id} src={e.portrait} />
                      <span className="grow npc-row-text">
                        <span className="row">
                          <b className="grow truncate">{e.name}</b>
                          {e.hidden && <span className="pill arcane">Not met</span>}
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
        </>
      )}
    </div>
  );
}

/** A spoiler, marked as such where an owner sees it. */
function Spoiler() {
  return (
    <span className="pill arcane spoiler-tag">
      <IconKey /> Hidden
    </span>
  );
}

/** One person or creature: what the party knows, and the stat block. */
function NpcDetail({
  e,
  spoilers,
  onBack,
  onEdit,
}: {
  e: Npc;
  /** An owner is looking with spoilers shown: mark them. */
  spoilers: boolean;
  onBack: () => void;
  onEdit?: () => void;
}) {
  const kindLine = `${e.kind === 'creature' ? 'Creature' : 'Person'}${e.status ? ` · ${e.status}` : ''}`;
  return (
    <div className="stack npc-detail">
      <div className="row">
        <button type="button" className="btn sm ghost npc-back" onClick={onBack}>
          <IconBack /> People and creatures
        </button>
        <span className="grow" />
        {onEdit && (
          <button type="button" className="btn sm" onClick={onEdit}>
            Edit
          </button>
        )}
      </div>
      {e.portrait ? (
        <div className="npc-hero">
          <NpcPortrait src={e.portrait} name={e.name} />
          <h3>{e.name}</h3>
          <p className="small muted">{kindLine}</p>
        </div>
      ) : (
        <div className="row npc-head">
          <Avatar name={e.name} seed={e.id} />
          <div className="grow">
            <h3>{e.name}</h3>
            <p className="small muted">{kindLine}</p>
          </div>
        </div>
      )}
      {spoilers && e.hidden && (
        <p className="small secret">
          <IconKey /> The party has not met them yet. Players do not see this entry.
        </p>
      )}
      {e.aliases.length > 0 && <p className="small muted aliases">Also known as {e.aliases.join(', ')}</p>}
      {e.summary && <p className="codex-summary">{e.summary}</p>}
      {e.sheet.length > 0 && (
        <dl className="kv card stat-block">
          {e.sheet.map((l, i) => (
            <div key={i} className={`kv-row${l.hidden ? ' spoiler' : ''}`}>
              <dt>
                {l.label}
                {l.hidden && <Spoiler />}
              </dt>
              <dd>{l.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {e.article && <p className="codex-article">{e.article}</p>}
      {e.articleSecret && (
        <p className="secret">
          <IconSparkle /> {e.articleSecret}
          {!e.secretRevealed && <Spoiler />}
        </p>
      )}
      {e.secret && (
        <p className="secret">
          <IconSparkle /> {e.secret}
          {!e.secretRevealed && <Spoiler />}
        </p>
      )}
      {!e.summary && !e.article && !e.sheet.length && (
        <p className="small muted">The story has not recorded more about them yet.</p>
      )}
    </div>
  );
}

/** A person's or creature's picture, large, opening full size when tapped. */
export function NpcPortrait({ src, name }: { src: string; name: string }) {
  const [viewing, setViewing] = useState(false);
  return (
    <>
      <button
        type="button"
        className="npc-hero-pic"
        onClick={() => setViewing(true)}
        aria-label={`See ${name}’s picture full size`}
      >
        <img src={src} alt="" decoding="async" />
      </button>
      {viewing && <PictureView src={src} name={name} onClose={() => setViewing(false)} />}
    </>
  );
}

/** A picture on its own, as large as the screen allows. A tap anywhere closes it. */
function PictureView({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const key = (ev: KeyboardEvent) => ev.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return createPortal(
    <div className="picture-view" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <button type="button" className="icon-btn picture-view-close" onClick={onClose} aria-label="Close">
        <IconClose />
      </button>
      <img src={src} alt={name} />
      <p className="picture-view-name">{name}</p>
    </div>,
    document.body,
  );
}

/** An owner adding someone, or changing everything about an entry, spoilers included. */
function NpcEditor({
  campaignId,
  entry,
  onDone,
}: {
  campaignId: string;
  /** Null to add a new one. */
  entry: EntityFull | null;
  /** Back to the entry (its id) or, after a delete or cancelling a new one, to the list. */
  onDone: (id: string | null) => void;
}) {
  const [busy, run] = useAction();
  const notify = useToast();
  // A picture chosen here goes up once the entry is saved; until then it is only previewed.
  const pick = usePortraitPick(entry?.portrait);
  const [draft, setDraft] = useState<EntityEdit>(() =>
    entry
      ? {
          kind: entry.kind,
          name: entry.name,
          aliases: entry.aliases,
          summary: entry.summary,
          article: entry.article,
          status: entry.status,
          sheet: entry.sheet,
          secret: entry.secret,
          articleSecret: entry.articleSecret,
          secretRevealed: entry.secretRevealed,
          hidden: entry.hidden,
        }
      : BLANK,
  );
  const [aliases, setAliases] = useState(draft.aliases.join(', '));
  const set = <K extends keyof EntityEdit>(key: K, value: EntityEdit[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setLine = (i: number, line: Partial<StatLineFull>) =>
    set(
      'sheet',
      draft.sheet.map((l, j) => (j === i ? { ...l, ...line } : l)),
    );

  const save = () =>
    run(async () => {
      const body: EntityEdit = {
        ...draft,
        aliases: aliases
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
        // A line with no label or no value is dropped rather than refused.
        sheet: draft.sheet
          .map((l) => ({ ...l, label: l.label.trim(), value: l.value.trim() }))
          .filter((l) => l.label && l.value),
      };
      const { entry: saved } = await api<{ entry: EntityFull }>(
        entry ? `/campaigns/${campaignId}/entities/${entry.id}` : `/campaigns/${campaignId}/entities`,
        { method: entry ? 'PUT' : 'POST', body },
      );
      // The entry is saved either way: a picture that fails to send must not lose the rest.
      await pick
        .save(`/campaigns/${campaignId}/entities/${saved.id}/portrait`)
        .catch((err) => notify(`Saved, but the picture was not: ${errorMessage(err)}`, 'error'));
      onDone(saved.id);
    }, 'Saved');

  const remove = () =>
    run(async () => {
      await api(`/campaigns/${campaignId}/entities/${entry!.id}`, { method: 'DELETE' });
      onDone(null);
    }, 'Removed');

  return (
    <form
      className="stack npc-editor"
      onSubmit={(ev) => {
        ev.preventDefault();
        void save();
      }}
    >
      <button type="button" className="btn sm ghost npc-back" onClick={() => onDone(entry?.id ?? null)}>
        <IconBack /> {entry ? 'Back without saving' : 'Cancel'}
      </button>
      <PortraitPick pick={pick} name={draft.name} seed={entry?.id ?? draft.name} />
      <Segmented
        value={draft.kind === 'creature' ? 'creature' : 'npc'}
        onChange={(kind) => set('kind', kind)}
        options={[
          { value: 'npc', label: 'Person' },
          { value: 'creature', label: 'Creature' },
        ]}
      />
      <Field label="Name">
        <input
          className="input"
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          maxLength={120}
          required
        />
      </Field>
      <Field label="Also known as" hint="Other names, separated by commas.">
        <input
          className="input"
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          maxLength={400}
        />
      </Field>
      <Field label="Status" hint="A word or two: ally, hostile, dead, missing…">
        <input
          className="input"
          value={draft.status}
          onChange={(e) => set('status', e.target.value)}
          maxLength={80}
        />
      </Field>
      <Field label="Summary" hint="What the party knows, in a line.">
        <textarea
          className="textarea"
          rows={2}
          value={draft.summary}
          onChange={(e) => set('summary', e.target.value)}
          maxLength={600}
        />
      </Field>
      <Field label="More about them" hint="What the party knows, at length.">
        <textarea
          className="textarea"
          rows={4}
          value={draft.article}
          onChange={(e) => set('article', e.target.value)}
          maxLength={4000}
        />
      </Field>

      <div className="section-title">
        <span>Stat block</span>
        <span>{draft.sheet.length}</span>
      </div>
      <p className="small muted">Mark a line hidden until the party learns it: players are not sent it.</p>
      {draft.sheet.map((l, i) => (
        <div key={i} className={`card stat-edit${l.hidden ? ' spoiler' : ''}`}>
          <div className="row">
            <input
              className="input grow"
              value={l.label}
              onChange={(e) => setLine(i, { label: e.target.value })}
              placeholder="Armor Class"
              maxLength={60}
              aria-label="Line name"
            />
            <button
              type="button"
              className="btn sm ghost"
              onClick={() =>
                set(
                  'sheet',
                  draft.sheet.filter((_, j) => j !== i),
                )
              }
              aria-label={`Remove ${l.label || 'this line'}`}
            >
              <IconClose />
            </button>
          </div>
          <textarea
            className="textarea"
            rows={1}
            value={l.value}
            onChange={(e) => setLine(i, { value: e.target.value })}
            placeholder="13"
            maxLength={400}
            aria-label={`${l.label || 'Line'} value`}
          />
          <label className="row stat-hide">
            <input
              type="checkbox"
              checked={l.hidden}
              onChange={(e) => setLine(i, { hidden: e.target.checked })}
            />
            <span>Hidden from players</span>
          </label>
        </div>
      ))}
      <button
        type="button"
        className="btn sm"
        disabled={draft.sheet.length >= 40}
        onClick={() => set('sheet', [...draft.sheet, { label: '', value: '', hidden: false }])}
      >
        <IconPlus /> Add a line
      </button>

      <div className="section-title">
        <span>Spoilers</span>
      </div>
      <Field label="Secret" hint="A hidden truth the DM reveals when the story gets there.">
        <textarea
          className="textarea"
          rows={2}
          value={draft.secret}
          onChange={(e) => set('secret', e.target.value)}
          maxLength={600}
        />
      </Field>
      <Field label="Hidden notes" hint="More the party does not know yet; revealed with the secret.">
        <textarea
          className="textarea"
          rows={3}
          value={draft.articleSecret}
          onChange={(e) => set('articleSecret', e.target.value)}
          maxLength={4000}
        />
      </Field>
      <label className="card row view-toggle">
        <div className="grow">
          <b>The party knows the secret</b>
          <div className="small muted">Players see the secret and hidden notes.</div>
        </div>
        <input
          type="checkbox"
          checked={draft.secretRevealed}
          disabled={!draft.secret.trim()}
          onChange={(e) => set('secretRevealed', e.target.checked)}
        />
      </label>
      <label className="card row view-toggle">
        <div className="grow">
          <b>Not met yet</b>
          <div className="small muted">
            Players do not see this entry at all until the DM names them in the story.
          </div>
        </div>
        <input type="checkbox" checked={draft.hidden} onChange={(e) => set('hidden', e.target.checked)} />
      </label>

      <button type="submit" className="btn primary block" disabled={busy || !draft.name.trim()}>
        {entry ? 'Save changes' : 'Add'}
      </button>
      {entry && (
        <ConfirmButton
          className="btn danger block"
          confirmLabel={`Remove ${entry.name} for good? Tap again`}
          disabled={busy}
          onConfirm={() => void remove()}
        >
          Remove
        </ConfirmButton>
      )}
    </form>
  );
}
