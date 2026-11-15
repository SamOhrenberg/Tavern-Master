import type { GameSystem, LoreStatus, RuleDocument, RuleHit, SettingLore } from '@tavern/protocol';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useAction, useMe, useQuery, useToast } from '../app';
import {
  IconAlert,
  IconBook,
  IconChevron,
  IconChevronDown,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
} from '../icons';
import { ConfirmButton, Empty, Field, PageHead, Segmented, Sheet, Skeletons, ruleSource } from '../ui';

const DEFAULT_ABILITIES = 'Strength, Dexterity, Constitution, Intelligence, Wisdom, Charisma';

const HOMEBREW_OPTIONS: { value: 'published' | 'homebrew'; label: string }[] = [
  { value: 'published', label: 'Published' },
  { value: 'homebrew', label: 'Homebrew' },
];
const HOMEBREW_HINT =
  'Homebrew gives each table a rules desk: players talk rules over with the GM, and what they settle is kept and followed.';

function useCanManage(): { admin: boolean; locked: boolean } {
  const me = useMe();
  return { admin: me.role === 'admin', locked: me.totpRequired };
}

function TwoFactorNotice() {
  return (
    <Link to="/you" className="banner">
      <IconAlert />
      <span className="grow">Turn on two-factor sign-in to add systems and upload rulebooks.</span>
      <IconChevron className="chev" />
    </Link>
  );
}

function NewSystem({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [abilities, setAbilities] = useState(DEFAULT_ABILITIES);
  const [homebrew, setHomebrew] = useState<'published' | 'homebrew'>('published');
  const [busy, run] = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<{ id: string }>('/systems', {
        body: {
          name,
          description,
          homebrew: homebrew === 'homebrew',
          abilities: abilities
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
        },
      });
      navigate(`/library/${res.id}`);
    }, 'System created');
  };

  return (
    <Sheet title="New game system" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Blades in the Dark"
            minLength={2}
            maxLength={80}
            required
          />
        </Field>
        <Field label="Description">
          <textarea
            className="textarea"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={600}
          />
        </Field>
        <Field
          label="Ability scores"
          hint="Comma separated. These become the boxes on every character sheet."
        >
          <input className="input" value={abilities} onChange={(e) => setAbilities(e.target.value)} />
        </Field>
        <Field label="Whose rules" hint={HOMEBREW_HINT}>
          <Segmented value={homebrew} onChange={setHomebrew} options={HOMEBREW_OPTIONS} />
        </Field>
        <button type="submit" className="btn primary block" disabled={busy}>
          Create system
        </button>
      </form>
    </Sheet>
  );
}

export function LibraryScreen() {
  const { admin, locked } = useCanManage();
  const systems = useQuery(() => api<{ systems: GameSystem[] }>('/systems'), []);
  const [creating, setCreating] = useState(false);
  const list = systems.data?.systems ?? [];

  return (
    <main className="page">
      <PageHead
        eyebrow="Rules library"
        title="Game systems"
        action={
          admin &&
          !locked && (
            <button
              type="button"
              className="icon-btn tinted"
              onClick={() => setCreating(true)}
              aria-label="New system"
            >
              <IconPlus />
            </button>
          )
        }
      />
      {admin && locked && <TwoFactorNotice />}

      {systems.loading ? (
        <Skeletons />
      ) : systems.error ? (
        <div className="form-error">{systems.error}</div>
      ) : list.length === 0 ? (
        <Empty icon={<IconBook />} title="The shelves are bare">
          {admin
            ? 'Create a game system, then upload its rulebooks.'
            : 'Whoever runs this server has not added any rules yet.'}
        </Empty>
      ) : (
        <div className="stack">
          {list.map((s) => (
            <Link key={s.id} to={`/library/${s.id}`} className="card tap">
              <div className="row">
                <span className="tome">
                  <IconBook />
                </span>
                <div className="grow">
                  <h2 className="truncate">
                    {s.name}
                    {s.homebrew && <span className="pill gold system-tag">Homebrew</span>}
                  </h2>
                  <p className="small muted">
                    {s.documentCount} {s.documentCount === 1 ? 'book' : 'books'} ·{' '}
                    {s.chunkCount.toLocaleString()} passages
                  </p>
                </div>
                <IconChevron className="chev" />
              </div>
              {s.description && <p className="small muted system-desc">{s.description}</p>}
            </Link>
          ))}
        </div>
      )}
      <p className="small faint library-note">
        The Dungeon Master searches a campaign&rsquo;s own system for rulings, and cites the passage it used.
      </p>
      {creating && <NewSystem onClose={() => setCreating(false)} />}
    </main>
  );
}

const STATUS: Record<RuleDocument['status'], { label: string; tone: string; live: boolean }> = {
  queued: { label: 'Queued', tone: '', live: true },
  parsing: { label: 'Reading', tone: 'gold', live: true },
  embedding: { label: 'Indexing', tone: 'arcane', live: true },
  ready: { label: 'Ready', tone: 'jade', live: false },
  failed: { label: 'Failed', tone: 'ember', live: false },
};

const LORE: Record<LoreStatus, { label: string; tone: string; live: boolean }> = {
  none: { label: 'No setting yet', tone: '', live: false },
  queued: { label: 'Queued', tone: '', live: true },
  reading: { label: 'Reading', tone: 'gold', live: true },
  ready: { label: 'Ready', tone: 'jade', live: false },
  failed: { label: 'Could not read', tone: 'ember', live: false },
};

const size = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** What the app heard in the setting material, once distilled. Spoilers are never shown. */
function LorePreview({ lore }: { lore: NonNullable<GameSystem['lore']> }) {
  return (
    <div className="stack lore-preview">
      {lore.voice && <p className="small">{lore.voice}</p>}
      {lore.glossary.length > 0 && (
        <dl className="lore-glossary">
          {lore.glossary.slice(0, 5).map((g) => (
            <div key={g.term} className="row">
              <dt>{g.term}</dt>
              <dd className="small muted truncate">{g.meaning}</dd>
            </div>
          ))}
        </dl>
      )}
      {lore.presentation.length > 0 && (
        <p className="small muted">{lore.presentation.slice(0, 4).join(' · ')}</p>
      )}
      {lore.cautions.length > 0 && (
        <p className="small faint">
          {lore.cautions.length} {lore.cautions.length === 1 ? 'spoiler' : 'spoilers'} kept back from the
          DM&rsquo;s working notes.
        </p>
      )}
    </div>
  );
}

/** One line per entry; blank lines dropped. The DM reads these as a flat list. */
const splitLines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const joinLines = (xs: string[]) => xs.join('\n');

/**
 * Hand-correct the distilled voice the DM reads as flavour. Seeded from what
 * the reader produced; saving replaces it. Lists are one entry per line.
 */
/**
 * A section that folds away. Which groups are open is remembered per system
 * in this browser only; without storage every group simply starts open.
 */
function Group({
  systemId,
  name,
  title,
  count,
  children,
}: {
  systemId: string;
  name: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  const key = `tm.system-group.${systemId}.${name}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== 'closed';
    } catch {
      return true;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(key, next ? 'open' : 'closed');
    } catch {
      // No storage: the choice lasts until the page is left.
    }
  };
  const bodyId = `group-${name}`;
  return (
    <section className={`group${open ? ' open' : ''}`}>
      <button
        type="button"
        className="section-title group-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <span className="group-label">
          <IconChevronDown className="group-chev" />
          {title}
        </span>
        {count > 0 && <span>{count}</span>}
      </button>
      {open && (
        <div id={bodyId} className="group-body">
          {children}
        </div>
      )}
    </section>
  );
}

/** One library document, with its status and, for admins, what can be done with it. */
function DocCard({
  doc: d,
  manage,
  busy,
  act,
}: {
  doc: RuleDocument;
  manage: boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>, done: string) => unknown;
}) {
  const st = STATUS[d.status];
  return (
    <div className="card doc">
      <div className="row">
        <div className="grow">
          <h3 className="truncate">{d.title}</h3>
          <p className="small muted truncate">
            {size(d.sizeBytes)}
            {d.pageCount ? ` · ${d.pageCount} pages` : ''}
            {d.status === 'ready' ? ` · ${d.chunkCount} passages` : ''}
          </p>
        </div>
        <span className={`pill ${st.tone}`}>
          {st.live && <i className="live" />}
          {st.label}
        </span>
      </div>
      {d.status === 'failed' && <p className="small danger doc-error">{d.error ?? 'Could not be read.'}</p>}
      {manage && (
        <div className="row doc-actions">
          {d.status === 'failed' && (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() =>
                void act(() => api(`/documents/${d.id}/retry`, { method: 'POST' }), 'Trying again')
              }
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            onClick={() =>
              void act(
                () =>
                  api(`/documents/${d.id}`, {
                    method: 'PATCH',
                    body: { kind: d.kind === 'setting' ? 'rules' : 'setting' },
                  }),
                d.kind === 'setting' ? 'Moved to rulebooks' : 'Moved to setting',
              )
            }
          >
            {d.kind === 'setting' ? 'Use as rules' : 'Use as setting'}
          </button>
          <ConfirmButton
            className="btn sm ghost"
            confirmLabel="Delete?"
            disabled={busy}
            onConfirm={() =>
              void act(() => api(`/documents/${d.id}`, { method: 'DELETE' }), 'Document removed')
            }
          >
            <IconTrash /> Remove
          </ConfirmButton>
        </div>
      )}
    </div>
  );
}

/**
 * Standing instructions for the GM of every table on this system, e.g. which
 * other AI to ask for what. Admins only; players never see them.
 */
function GmInstructions({
  systemId,
  value,
  onSaved,
}: {
  systemId: string;
  value: string;
  onSaved: () => Promise<unknown>;
}) {
  const [text, setText] = useState(value);
  const [busy, run] = useAction();
  useEffect(() => setText(value), [value]);
  const dirty = text.trim() !== value.trim();
  return (
    <div className="card stack">
      <textarea
        className="textarea"
        rows={5}
        value={text}
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Whenever a character earns an achievement, ask Gemini to write the announcement in the system AI's voice, then use it in your narration."
        aria-label="GM instructions"
      />
      <p className="small muted">
        The GM of every table on this system follows these, from the next turn on. Players never see them. Set
        up other AIs it can ask in Admin → AIs.
      </p>
      <button
        type="button"
        className="btn block"
        disabled={busy || !dirty}
        onClick={() =>
          void run(async () => {
            await api(`/systems/${systemId}`, { method: 'PATCH', body: { gmInstructions: text } });
            await onSaved();
          }, 'Instructions saved')
        }
      >
        Save instructions
      </button>
    </div>
  );
}

function EditLore({
  systemId,
  lore,
  onClose,
  onSaved,
}: {
  systemId: string;
  lore: SettingLore | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [voice, setVoice] = useState(lore?.voice ?? '');
  const [pacing, setPacing] = useState(lore?.pacing ?? '');
  const [presentation, setPresentation] = useState(joinLines(lore?.presentation ?? []));
  const [touchstones, setTouchstones] = useState(joinLines(lore?.touchstones ?? []));
  const [cautions, setCautions] = useState(joinLines(lore?.cautions ?? []));
  const [glossary, setGlossary] = useState<{ term: string; meaning: string; soundsLike: string }[]>(
    (lore?.glossary ?? []).map((g) => ({ term: g.term, meaning: g.meaning, soundsLike: g.soundsLike ?? '' })),
  );
  const [busy, run] = useAction();

  const setRow = (i: number, patch: Partial<(typeof glossary)[number]>) =>
    setGlossary((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setGlossary((rows) => [...rows, { term: '', meaning: '', soundsLike: '' }]);
  const removeRow = (i: number) => setGlossary((rows) => rows.filter((_, j) => j !== i));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(`/systems/${systemId}/lore`, {
        method: 'PUT',
        body: {
          voice,
          pacing,
          presentation: splitLines(presentation),
          touchstones: splitLines(touchstones),
          cautions: splitLines(cautions),
          glossary: glossary
            .map((g) => ({
              term: g.term.trim(),
              meaning: g.meaning.trim(),
              ...(g.soundsLike.trim() ? { soundsLike: g.soundsLike.trim() } : {}),
            }))
            .filter((g) => g.term && g.meaning),
        },
      });
      onSaved();
      onClose();
    }, 'Voice updated');
  };

  return (
    <Sheet title="Edit the voice" onClose={onClose} tall>
      <form className="stack" onSubmit={submit}>
        <p className="small muted">
          The DM borrows this for colour — tone, vocabulary and pacing. It is never quoted as a rule. Correct
          anything the reader misheard. One entry per line in the lists.
        </p>
        <Field label="How it sounds" hint="A few sentences on the world's voice.">
          <textarea
            className="textarea"
            rows={4}
            value={voice}
            maxLength={600}
            onChange={(e) => setVoice(e.target.value)}
          />
        </Field>
        <Field label="How it moves" hint="How scenes move; what a beat feels like.">
          <textarea
            className="textarea"
            rows={3}
            value={pacing}
            maxLength={400}
            onChange={(e) => setPacing(e.target.value)}
          />
        </Field>

        <div className="section-title">
          <span>In-world vocabulary</span>
        </div>
        <div className="stack">
          {glossary.map((g, i) => (
            <div key={i} className="card stack glossary-row">
              <div className="row">
                <input
                  className="input grow"
                  value={g.term}
                  placeholder="Term"
                  maxLength={60}
                  onChange={(e) => setRow(i, { term: e.target.value })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Remove term"
                  onClick={() => removeRow(i)}
                >
                  <IconTrash />
                </button>
              </div>
              <input
                className="input"
                value={g.meaning}
                placeholder="What it means"
                maxLength={300}
                onChange={(e) => setRow(i, { meaning: e.target.value })}
              />
              <input
                className="input"
                value={g.soundsLike}
                placeholder="Say it like… (optional)"
                maxLength={120}
                onChange={(e) => setRow(i, { soundsLike: e.target.value })}
              />
            </div>
          ))}
          <button type="button" className="btn sm ghost" onClick={addRow}>
            <IconPlus /> Add a term
          </button>
        </div>

        <Field label="Recurring devices" hint='One per line, e.g. "System messages in boxes".'>
          <textarea
            className="textarea"
            rows={3}
            value={presentation}
            onChange={(e) => setPresentation(e.target.value)}
          />
        </Field>
        <Field
          label="Touchstones"
          hint="Names, places and motifs the DM may reference as known. One per line."
        >
          <textarea
            className="textarea"
            rows={3}
            value={touchstones}
            onChange={(e) => setTouchstones(e.target.value)}
          />
        </Field>
        <Field
          label="Do not pre-empt"
          hint="Spoilers the DM must let players reach on their own. One per line."
        >
          <textarea
            className="textarea"
            rows={3}
            value={cautions}
            onChange={(e) => setCautions(e.target.value)}
          />
        </Field>

        <button type="submit" className="btn primary block" disabled={busy}>
          Save the voice
        </button>
      </form>
    </Sheet>
  );
}

export function SystemScreen() {
  const { id = '' } = useParams();
  const { admin, locked } = useCanManage();
  const navigate = useNavigate();
  const notify = useToast();
  const systems = useQuery(() => api<{ systems: GameSystem[] }>('/systems'), []);
  const docs = useQuery(() => api<{ documents: RuleDocument[] }>(`/systems/${id}/documents`), [id]);
  const [busy, run] = useAction();
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<RuleHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const settingPicker = useRef<HTMLInputElement>(null);

  const [uploadKind, setUploadKind] = useState<'rules' | 'setting'>('rules');
  const [editingLore, setEditingLore] = useState(false);
  const system = systems.data?.systems.find((s) => s.id === id);
  const list = docs.data?.documents ?? [];
  const loreBusy = LORE[system?.loreStatus ?? 'none'].live;
  const working = list.some((d) => STATUS[d.status].live) || loreBusy;
  const reloadDocs = docs.reload;
  const reloadSystems = systems.reload;

  // Ingestion and lore distillation happen in the background: poll while in flight.
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => {
      void reloadDocs();
      void reloadSystems();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [working, reloadDocs, reloadSystems]);

  /** Upload the picked files one at a time, so one bad file does not stop the rest. */
  const upload = async (files: FileList | null, kind: 'rules' | 'setting' = 'rules') => {
    const picked = files ? [...files] : [];
    if (picked.length === 0) return;
    setUploadKind(kind);
    const failed: string[] = [];
    try {
      for (const [i, file] of picked.entries()) {
        setUploading({ done: i, total: picked.length });
        try {
          const form = new FormData();
          form.append('title', file.name.replace(/\.[^.]+$/, ''));
          form.append('file', file);
          if (kind === 'setting') form.append('kind', 'setting');
          await api(`/systems/${id}/documents`, { form });
          void reloadDocs();
        } catch (err) {
          failed.push(`${file.name}: ${errorMessage(err)}`);
        }
      }
      await Promise.all([reloadDocs(), reloadSystems()]);
    } finally {
      setUploading(null);
      if (picker.current) picker.current.value = '';
      if (settingPicker.current) settingPicker.current.value = '';
    }
    const ok = picked.length - failed.length;
    if (failed.length) {
      notify(
        ok === 0 && failed.length === 1
          ? failed[0]!
          : `${ok} uploaded, ${failed.length} failed. ${failed.join(' · ')}`,
        'error',
      );
    } else if (kind === 'setting') {
      notify(
        ok === 1 ? 'Uploaded. Reading it for the voice.' : `${ok} uploaded. Reading them for the voice.`,
      );
    } else {
      notify(ok === 1 ? 'Uploaded. Indexing has started.' : `${ok} uploaded. Indexing has started.`);
    }
  };
  const uploadLabel = (kind: 'rules' | 'setting', idle: string) =>
    uploading && uploadKind === kind
      ? uploading.total > 1
        ? `Uploading ${uploading.done + 1} of ${uploading.total}…`
        : 'Uploading…'
      : idle;
  const rulebooks = list.filter((d) => d.kind !== 'setting');
  const settingDocs = list.filter((d) => d.kind === 'setting');

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      const res = await api<{ hits: RuleHit[] }>(
        `/systems/${id}/search?q=${encodeURIComponent(query.trim())}`,
      );
      setHits(res.hits);
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setSearching(false);
    }
  };

  const act = (fn: () => Promise<unknown>, done: string) =>
    run(async () => {
      await fn();
      await reloadDocs();
    }, done);

  return (
    <main className="page">
      <PageHead eyebrow="Game system" title={system?.name ?? 'Rules'} back="/library" />
      {system?.description && <p className="muted system-lede">{system.description}</p>}
      {admin && locked && <TwoFactorNotice />}

      <Group systemId={id} name="rules" title="Rulebooks" count={rulebooks.length}>
        {docs.loading ? (
          <Skeletons count={2} />
        ) : rulebooks.length === 0 ? (
          <Empty icon={<IconBook />} title="No rulebooks yet">
            Upload PDF, Markdown or text files. The DM can cite them within a minute or two.
          </Empty>
        ) : (
          <div className="stack">
            {rulebooks.map((d) => (
              <DocCard key={d.id} doc={d} manage={admin && !locked} busy={busy} act={act} />
            ))}
          </div>
        )}
        {admin && !locked && (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              className="sr-only"
              accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain"
              onChange={(e) => void upload(e.target.files)}
              tabIndex={-1}
              aria-hidden="true"
            />
            <button
              type="button"
              className="btn primary block upload"
              disabled={!!uploading}
              onClick={() => picker.current?.click()}
            >
              <IconUpload /> {uploadLabel('rules', 'Upload rulebooks')}
            </button>
          </>
        )}
      </Group>

      {system && (
        <Group systemId={id} name="setting" title="Setting & flavour" count={settingDocs.length}>
          <div className="card lore-card">
            <div className="row">
              <div className="grow">
                <p className="small muted">
                  Setting material shapes how the DM <em>sounds</em> — its voice, pacing and vocabulary. It is
                  never quoted as a rule.
                </p>
              </div>
              <span className={`pill ${LORE[system.loreStatus].tone}`}>
                {LORE[system.loreStatus].live && <i className="live" />}
                {LORE[system.loreStatus].label}
              </span>
            </div>
            {system.loreStatus === 'ready' && system.lore && <LorePreview lore={system.lore} />}
            {system.loreStatus === 'failed' && (
              <p className="small faint">
                No usable voice was found in the setting material. The DM falls back to the tone you set.
              </p>
            )}
          </div>
          {settingDocs.length > 0 && (
            <div className="stack">
              {settingDocs.map((d) => (
                <DocCard key={d.id} doc={d} manage={admin && !locked} busy={busy} act={act} />
              ))}
            </div>
          )}
          {admin && !locked && (
            <>
              {!loreBusy && (system.lore || settingDocs.length > 0) && (
                <button type="button" className="btn block" onClick={() => setEditingLore(true)}>
                  {system.lore ? 'Edit the voice' : 'Write the voice by hand'}
                </button>
              )}
              <input
                ref={settingPicker}
                type="file"
                multiple
                className="sr-only"
                accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain"
                onChange={(e) => void upload(e.target.files, 'setting')}
                tabIndex={-1}
                aria-hidden="true"
              />
              <button
                type="button"
                className="btn block upload"
                disabled={!!uploading}
                onClick={() => settingPicker.current?.click()}
              >
                <IconUpload /> {uploadLabel('setting', 'Upload setting material')}
              </button>
            </>
          )}
          {editingLore && (
            <EditLore
              systemId={id}
              lore={system.lore}
              onClose={() => setEditingLore(false)}
              onSaved={() => void reloadSystems()}
            />
          )}
        </Group>
      )}

      {system && (admin || system.homebrew) && (
        <>
          <div className="section-title">
            <span>Whose rules</span>
          </div>
          <div className="card stack homebrew-card">
            {admin && !locked ? (
              <Segmented
                value={system.homebrew ? 'homebrew' : 'published'}
                options={HOMEBREW_OPTIONS}
                onChange={(v) =>
                  void run(
                    async () => {
                      await api(`/systems/${id}`, { method: 'PATCH', body: { homebrew: v === 'homebrew' } });
                      await reloadSystems();
                    },
                    v === 'homebrew' ? 'Marked as homebrew' : 'Marked as published',
                  )
                }
              />
            ) : (
              <span className="pill gold">Homebrew</span>
            )}
            <p className="small muted">
              {system.homebrew
                ? 'Tables playing this system have a rules desk: a side chat where players talk rules over with the GM, change them, steer the campaign and put right calls that went wrong. The GM follows what they settle on every turn.'
                : 'The GM plays these rules as written. Mark the system homebrew to give its tables a rules desk where the players can change them.'}
            </p>
          </div>
        </>
      )}

      {system && admin && !locked && (
        <>
          <div className="section-title">
            <span>GM instructions</span>
          </div>
          <GmInstructions systemId={id} value={system.gmInstructions ?? ''} onSaved={reloadSystems} />
        </>
      )}

      <div className="section-title">
        <span>Ask the rulebooks</span>
      </div>
      <form className="add-friend" onSubmit={search}>
        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="How does grappling work?"
          maxLength={300}
          enterKeyHint="search"
          aria-label="Search the rules"
        />
        <button
          type="submit"
          className="btn"
          disabled={searching || query.trim().length < 2}
          aria-label="Search"
        >
          <IconSearch />
        </button>
      </form>
      {hits && (
        <div className="stack hits">
          {hits.length === 0 && <p className="small muted">Nothing in these books matches that.</p>}
          {hits.map((h) => (
            <div key={h.chunkId} className="card hit">
              <p className="small gold truncate">{ruleSource(h.document, h.heading, h.page)}</p>
              <p className="excerpt">{h.text.length > 520 ? `${h.text.slice(0, 520)}…` : h.text}</p>
            </div>
          ))}
        </div>
      )}

      {admin && !locked && system && (
        <div className="danger-zone">
          <ConfirmButton
            className="btn danger block"
            confirmLabel="Tap again to delete this system"
            disabled={busy}
            onConfirm={() =>
              void run(async () => {
                await api(`/systems/${id}`, { method: 'DELETE' });
                navigate('/library', { replace: true });
              }, 'System deleted')
            }
          >
            Delete system
          </ConfirmButton>
        </div>
      )}
    </main>
  );
}
