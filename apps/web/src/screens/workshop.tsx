import type { GmGuide, GuideTopicId, Workshop, WorkshopEvent, WorkshopMessage } from '@tavern/protocol';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, apiStream, errorMessage } from '../api';
import { useAction, useMe, useToast } from '../app';
import { IconBook, IconGavel, IconSend } from '../icons';
import { Story } from '../play/story';
import { ConfirmButton, Empty, Loading, Segmented, Sheet, timeAgo } from '../ui';

/** The guide's topics, in the order the GM reads them. Kept in step with the server's gm-guide.ts. */
const TOPICS: { id: GuideTopicId; title: string; about: string }[] = [
  {
    id: 'resolution',
    title: 'Resolving actions',
    about: 'What is rolled, against what, and what results mean.',
  },
  {
    id: 'rolls',
    title: 'Calling for rolls',
    about: 'When to ask for a roll, who rolls, which sheet values count.',
  },
  {
    id: 'harm',
    title: 'Harm and recovery',
    about: 'Damage, conditions, healing, and what happens at the limits.',
  },
  { id: 'advancement', title: 'Advancement', about: 'How characters grow.' },
  { id: 'scenes', title: 'Running scenes', about: 'How play moves: structure, pacing, downtime.' },
  { id: 'other', title: 'Other notes', about: 'Anything else the GM needs to run this system well.' },
];

const STARTERS = [
  'Read the rulebooks and tell me what the character sheet is missing.',
  'Write the GM guide from the rulebooks, one topic at a time.',
  'Walk me through how a scene plays out in this system.',
  'This system is a homebrew. Here is what we changed:',
];

const TOOL_NOTE: Record<string, string> = {
  lookup_rules: 'Checking the rulebooks',
  read_sheet: 'Reading the sheet',
  change_sheet: 'Updating the sheet draft',
  write_guide: 'Writing the GM guide',
  add_ruling: 'Recording a ruling',
  retire_ruling: 'Retiring a ruling',
};

const coarse = () => window.matchMedia('(pointer: coarse)').matches;

function GuideTab({
  systemId,
  guide,
  onSaved,
}: {
  systemId: string;
  guide: GmGuide;
  onSaved: (guide: GmGuide) => void;
}) {
  const [editing, setEditing] = useState<GuideTopicId | null>(null);
  const [text, setText] = useState('');
  const [busy, run] = useAction();
  const written = guide.topics.length;
  return (
    <div className="stack">
      <p className="small muted">
        The GM of every table on this system reads this before it plays, beside the rulebooks.{' '}
        {written
          ? ''
          : 'Ask in the workshop to have it written from the rulebooks, or write a topic yourself.'}
      </p>
      {TOPICS.map((t) => {
        const topic = guide.topics.find((x) => x.id === t.id);
        const open = editing === t.id;
        return (
          <section key={t.id} className="card stack tight guide-topic">
            <div className="row">
              <b className="grow">{t.title}</b>
              {!open && (
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => {
                    setEditing(t.id);
                    setText(topic?.text ?? '');
                  }}
                >
                  {topic ? 'Edit' : 'Write'}
                </button>
              )}
            </div>
            {open ? (
              <>
                <textarea
                  className="textarea"
                  rows={6}
                  value={text}
                  maxLength={2000}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={t.about}
                  aria-label={t.title}
                />
                <div className="row">
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const out = await api<{ guide: GmGuide }>(`/systems/${systemId}/guide/${t.id}`, {
                          method: 'PUT',
                          body: { text },
                        });
                        onSaved(out.guide);
                        setEditing(null);
                      }, 'Guide saved')
                    }
                  >
                    Save
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : topic ? (
              <p className="guide-text">{topic.text}</p>
            ) : (
              <p className="small faint">{t.about}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RulingsTab({
  systemId,
  guide,
  onSaved,
}: {
  systemId: string;
  guide: GmGuide;
  onSaved: (guide: GmGuide) => void;
}) {
  const [busy, run] = useAction();
  if (!guide.rulings.length)
    return (
      <Empty icon={<IconGavel />} title="No rulings yet">
        When you settle something the rulebooks leave open, the workshop writes it down here. Every table on
        this system follows it from its next turn.
      </Empty>
    );
  return (
    <div className="stack rulings">
      {guide.rulings.map((r) => (
        <div key={r.id} className="card ruling">
          <p>{r.text}</p>
          <div className="row ruling-meta">
            <span className="small faint grow">{timeAgo(r.createdAt)}</span>
            <ConfirmButton
              className="btn sm ghost"
              confirmLabel="Strike it?"
              disabled={busy}
              onConfirm={() =>
                void run(async () => {
                  const out = await api<{ guide: GmGuide }>(`/systems/${systemId}/guide/rulings/${r.id}`, {
                    method: 'DELETE',
                  });
                  onSaved(out.guide);
                }, 'Ruling struck')
              }
            >
              Strike
            </ConfirmButton>
          </div>
        </div>
      ))}
      <p className="small faint">Struck rulings stop applying at every table from its next turn.</p>
    </div>
  );
}

/**
 * The workshop, for admins: talk a game system over with the AI before
 * anyone plays it. Sheet changes it proposes wait in the sheet's draft for
 * review; the GM guide and rulings it writes apply at every table at once.
 */
export function WorkshopSheet({
  systemId,
  systemName,
  onChanged,
  onClose,
}: {
  systemId: string;
  systemName: string;
  /** Something the workshop did may have changed the system (a sheet draft): fetch it again. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const me = useMe();
  const notify = useToast();
  const [workshop, setWorkshop] = useState<Workshop | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tab, setTab] = useState<'talk' | 'guide' | 'rulings'>('talk');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<WorkshopMessage | null>(null);
  const [live, setLive] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [busy, run] = useAction();
  const body = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      setWorkshop((await api<{ workshop: Workshop }>(`/systems/${systemId}/workshop`)).workshop);
      setFailed(null);
    } catch (err) {
      setFailed(errorMessage(err));
    }
  }, [systemId]);
  useEffect(() => {
    void load();
  }, [load]);

  // Claude answers through the connector, out of sight: look again now and then until it has.
  const waiting = !!workshop?.waiting;
  const wasWaiting = useRef(false);
  // The screen behind re-renders often (it polls while documents index), handing a new callback each
  // time: keep the latest in a ref, so the poll below is not restarted before it ever fires.
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  useEffect(() => {
    // Claude may have proposed sheet changes along with its answer: the panel behind fetches them.
    if (wasWaiting.current && !waiting) changedRef.current();
    wasWaiting.current = waiting;
    if (!waiting) return;
    const tick = window.setInterval(() => document.visibilityState === 'visible' && void load(), 5000);
    return () => window.clearInterval(tick);
  }, [waiting, load]);

  const setAnswerer = (answeredBy: Workshop['answeredBy']) =>
    run(async () => {
      await api(`/systems/${systemId}/workshop`, { method: 'PATCH', body: { answeredBy } });
      await load();
    });

  useLayoutEffect(() => {
    if (tab !== 'talk') return;
    const el = body.current?.closest('.sheet-body');
    if (el) el.scrollTop = el.scrollHeight;
  }, [workshop, pending, live, working, tab]);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const send = async (text: string) => {
    const said = text.trim();
    if (!said || !workshop || pending) return;
    setDraft('');
    setTab('talk');
    setPending({
      id: -1,
      role: 'user',
      content: said,
      author: { id: me.id, username: me.username, displayName: me.displayName },
      createdAt: new Date().toISOString(),
    });
    const claude = workshop.answeredBy === 'claude';
    if (!claude) setWorking('Thinking');
    let stored = false;
    let changed = false;
    try {
      await apiStream<WorkshopEvent>(`/systems/${systemId}/workshop/messages`, { text: said }, (ev) => {
        stored = true;
        if (ev.type === 'delta') {
          setWorking(null);
          setLive((t) => t + ev.text);
        } else if (ev.type === 'tool') {
          setWorking(TOOL_NOTE[ev.tool] ?? 'Working');
          setLive('');
          if (ev.tool === 'change_sheet') changed = true;
        } else if (ev.type === 'error') notify(ev.message, 'error');
      });
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
    if (!stored) setDraft(said);
    await load();
    setPending(null);
    setLive('');
    setWorking(null);
    if (changed) onChanged();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) {
      e.preventDefault();
      void send(draft);
    }
  };

  const messages = workshop ? [...workshop.messages, ...(pending ? [pending] : [])] : [];
  const guide = workshop?.guide;
  const setGuide = (g: GmGuide) => setWorkshop((w) => (w ? { ...w, guide: g } : w));
  const answering = !!pending || !!workshop?.answering;

  return (
    <Sheet
      title="Workshop"
      onClose={onClose}
      tall
      header={
        <div className="sheet-tabs">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'talk', label: 'Talk' },
              { value: 'guide', label: guide?.topics.length ? `Guide · ${guide.topics.length}` : 'Guide' },
              {
                value: 'rulings',
                label: guide?.rulings.length ? `Rulings · ${guide.rulings.length}` : 'Rulings',
              },
            ]}
          />
        </div>
      }
      footer={
        tab === 'talk' && (
          <div className="composer talk">
            <textarea
              ref={field}
              className="composer-field"
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder={answering ? 'The workshop is answering…' : `Talk ${systemName} over`}
              maxLength={4000}
              disabled={!workshop}
              enterKeyHint={coarse() ? 'enter' : 'send'}
              aria-label="Message to the workshop"
            />
            <button
              type="button"
              className="send"
              disabled={!draft.trim() || !workshop || answering}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void send(draft)}
              aria-label="Send"
            >
              <IconSend />
            </button>
          </div>
        )
      }
    >
      {failed ? (
        <div className="form-error">{failed}</div>
      ) : !workshop || !guide ? (
        <Loading />
      ) : tab === 'guide' ? (
        <GuideTab systemId={systemId} guide={guide} onSaved={setGuide} />
      ) : tab === 'rulings' ? (
        <RulingsTab systemId={systemId} guide={guide} onSaved={setGuide} />
      ) : (
        <div className="guide" ref={body}>
          <div className="row workshop-answerer">
            <span className="small muted grow">Answered by</span>
            {workshop.builtIn ? (
              <Segmented
                value={workshop.answeredBy}
                onChange={(v) => void setAnswerer(v)}
                options={[
                  { value: 'server', label: 'Built-in AI' },
                  { value: 'claude', label: 'Claude' },
                ]}
              />
            ) : (
              <span className="small">Claude</span>
            )}
          </div>
          {messages.length === 0 && (
            <div className="guide-intro">
              <IconBook />
              <p>
                Talk {systemName} over with the AI before anyone plays it. It reads the rulebooks, proposes
                what the character sheet needs (you review those changes under Character sheet), and writes
                the guide and rulings the GM of every table follows.
              </p>
              <div className="stack tight">
                {STARTERS.map((line) => (
                  <button key={line} type="button" className="opener" onClick={() => setDraft(line)}>
                    {line}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className={`msg action${m.author?.id === me.id ? ' mine' : ''}`}>
                <div className="action-body">
                  {m.author?.id !== me.id && (
                    <div className="action-who">
                      <b>{m.author?.displayName ?? 'A former admin'}</b>
                    </div>
                  )}
                  <div className="bubble">{m.content}</div>
                </div>
              </div>
            ) : (
              <article key={m.id} className="msg guide-msg">
                <div className="story">
                  <Story text={m.content} />
                </div>
              </article>
            ),
          )}
          {live && (
            <article className="msg guide-msg">
              <div className="story">
                <Story text={live} />
              </div>
            </article>
          )}
          {(working || (answering && !live)) && (
            <article className="msg guide-msg live" aria-live="polite">
              <div className="dm-tool">
                <span className="live-dot" />
                <span>{working ? `${working}…` : 'Someone else’s message is being answered…'}</span>
              </div>
            </article>
          )}
          {waiting && !pending && (
            <article className="msg guide-msg live" aria-live="polite">
              <div className="dm-tool">
                <span className="live-dot" />
                <span>{workshop.launcher ? 'Claude is on its way…' : 'Waiting for Claude…'}</span>
              </div>
              <p className="small faint workshop-claude-hint">
                {workshop.launcher ? (
                  'The DM launcher starts Claude for the workshop. Its answer shows up here in a minute or so.'
                ) : (
                  <>
                    Claude answers when an admin has it running: the DM launcher does it on its own. Or in
                    Claude, with the Tavern Master connector, say: &ldquo;Open the Tavern Master workshop for{' '}
                    {systemName} and answer it.&rdquo;
                  </>
                )}
              </p>
            </article>
          )}
          {messages.length > 0 && !answering && (
            <div className="workshop-reset">
              <ConfirmButton
                className="btn sm ghost"
                confirmLabel="Clear the conversation?"
                disabled={busy}
                onConfirm={() =>
                  void run(async () => {
                    await api(`/systems/${systemId}/workshop`, { method: 'DELETE' });
                    await load();
                  }, 'Conversation cleared. The sheet, draft and guide are kept.')
                }
              >
                Start the conversation over
              </ConfirmButton>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
