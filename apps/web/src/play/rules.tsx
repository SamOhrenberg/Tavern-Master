import type { DmStatus, Ruling, RulingKind, RulesDesk, RulesEvent, RulesMessage } from '@tavern/protocol';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, apiStream, errorMessage } from '../api';
import { useAction, useMe, useToast } from '../app';
import { IconGavel, IconSend } from '../icons';
import { ConfirmButton, Empty, Loading, Segmented, Sheet, timeAgo } from '../ui';
import { dmAbsent } from './claude';
import { Story } from './story';

const STARTERS = [
  'How does this rule actually work?',
  'I think a call went wrong last turn.',
  'Can we change how a rule works?',
  'Here is what we want more of in this campaign.',
];

const KIND: Record<RulingKind, { label: string; plural: string; tone: string }> = {
  rule: { label: 'House rule', plural: 'House rules', tone: 'gold' },
  direction: { label: 'Direction', plural: 'Direction for the story', tone: 'arcane' },
  correction: { label: 'Correction', plural: 'Corrections', tone: 'jade' },
};

const TOOL_NOTE: Record<string, string> = {
  lookup_rules: 'Checking the rulebook',
  get_state: 'Looking at the party',
  recall: 'Checking what happened',
  search_documents: 'Reading the campaign notes',
  update_character: 'Putting it right',
  modify_inventory: 'Putting it right',
  edit_sheet: 'Updating the sheet',
  record_ruling: 'Writing down the ruling',
  retire_ruling: 'Striking a ruling',
};

const coarse = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * The rules desk, for tables on a homebrew system: a chat the whole table
 * shares with the GM, out of character, about the rules, the direction of
 * the campaign and calls that went wrong. What they settle there is kept as
 * a ruling, listed on the second tab, and followed from then on.
 */
export function RulesSheet({
  campaignId,
  owner,
  claude,
  dm,
  hostName,
  signal,
  onClose,
}: {
  campaignId: string;
  /** The owner can strike rulings by hand. */
  owner: boolean;
  /** Claude is the GM: answers arrive later, through the table's connection. */
  claude: boolean;
  dm: DmStatus | null;
  hostName: string;
  /** Bumped by the parent when the desk changes, to fetch it again. */
  signal: number;
  onClose: () => void;
}) {
  const me = useMe();
  const notify = useToast();
  const [desk, setDesk] = useState<RulesDesk | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tab, setTab] = useState<'talk' | 'rulings'>('talk');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<RulesMessage | null>(null);
  // The built-in GM is answering this person's message: what it is doing now.
  const [working, setWorking] = useState<string | null>(null);
  const [busy, run] = useAction();
  const body = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const fetchDesk = useCallback(
    async () => (await api<{ desk: RulesDesk }>(`/campaigns/${campaignId}/rules`)).desk,
    [campaignId],
  );
  const load = useCallback(async () => {
    try {
      setDesk(await fetchDesk());
      setFailed(null);
    } catch (err) {
      setFailed(errorMessage(err));
    }
  }, [fetchDesk]);

  useEffect(() => {
    void load();
  }, [load, signal]);

  // Waiting on Claude: look again now and then and on returning to the app, in case a signal was missed.
  const waiting = !!desk?.waiting && !working;
  useEffect(() => {
    if (!waiting) return;
    const tick = window.setInterval(() => void load(), 20_000);
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [waiting, load]);

  useLayoutEffect(() => {
    if (tab !== 'talk') return;
    const el = body.current?.closest('.sheet-body');
    if (el) el.scrollTop = el.scrollHeight;
  }, [desk, pending, working, tab]);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const send = async (text: string) => {
    const said = text.trim();
    if (!said || !desk || pending) return;
    setDraft('');
    setTab('talk');
    setPending({
      id: -1,
      role: 'user',
      content: said,
      author: { id: me.id, username: me.username, displayName: me.displayName },
      createdAt: new Date().toISOString(),
    });
    let stored = false;
    try {
      await apiStream<RulesEvent>(`/campaigns/${campaignId}/rules/messages`, { text: said }, (ev) => {
        // Any line at all means the message was stored, whether or not it was answered.
        stored = true;
        if (ev.type === 'tool') setWorking(TOOL_NOTE[ev.tool] ?? 'Working');
        else if (ev.type === 'error') notify(ev.message, 'error');
      });
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
    // Nothing was stored: give the words back so they can be sent again.
    if (!stored) setDraft(said);
    setWorking(null);
    try {
      const fresh = await fetchDesk();
      setDesk(fresh);
    } catch {
      // The next signal fetches it again.
    }
    // In the same tick as the fresh desk, so the message is never shown twice.
    setPending(null);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) {
      e.preventDefault();
      void send(draft);
    }
  };

  const retire = (r: Ruling) =>
    run(async () => {
      await api(`/campaigns/${campaignId}/rulings/${r.id}`, { method: 'DELETE' });
      await load();
    }, 'Ruling struck');

  const messages = desk ? [...desk.messages, ...(pending ? [pending] : [])] : [];
  const rulings = desk?.rulings ?? [];
  const away = claude && dmAbsent(dm);

  return (
    <Sheet
      title="Rules desk"
      onClose={onClose}
      tall
      header={
        <div className="sheet-tabs">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'talk', label: 'Talk' },
              { value: 'rulings', label: rulings.length ? `Rulings · ${rulings.length}` : 'Rulings' },
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
              placeholder={working ? 'The GM is answering…' : 'Talk rules with the GM'}
              maxLength={2000}
              disabled={!desk}
              enterKeyHint={coarse() ? 'enter' : 'send'}
              aria-label="Message to the rules desk"
            />
            <button
              type="button"
              className="send"
              disabled={!draft.trim() || !desk || !!pending}
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
      ) : !desk ? (
        <Loading />
      ) : tab === 'rulings' ? (
        <Rulings rulings={rulings} owner={owner} busy={busy} onRetire={(r) => void retire(r)} />
      ) : (
        <div className="guide" ref={body}>
          {messages.length === 0 && (
            <div className="guide-intro">
              <IconGavel />
              <p>
                Talk the rules over with the GM, out of character. Everyone at the table can read and join in.
                Ask how something works, change a rule, steer the campaign, or point out a call that went
                wrong. What you settle is written down and the GM follows it from then on.
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
                      <b>{m.author?.displayName ?? 'A former player'}</b>
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
          {(working || pending || desk.waiting) && (
            <article className="msg guide-msg live" aria-live="polite">
              <div className="dm-tool">
                {!away && <span className="live-dot" />}
                <span>
                  {working
                    ? `${working}…`
                    : away
                      ? `Claude is away. This is saved and will be answered when ${hostName} has Claude running.`
                      : claude
                        ? 'With Claude…'
                        : 'The GM is answering…'}
                </span>
              </div>
            </article>
          )}
        </div>
      )}
    </Sheet>
  );
}

function Rulings({
  rulings,
  owner,
  busy,
  onRetire,
}: {
  rulings: Ruling[];
  owner: boolean;
  busy: boolean;
  onRetire: (r: Ruling) => void;
}) {
  if (!rulings.length) {
    return (
      <Empty icon={<IconGavel />} title="Nothing ruled yet">
        When the table settles something with the GM at the desk, it is written down here and followed on
        every turn after.
      </Empty>
    );
  }
  return (
    <div className="stack rulings">
      {(['rule', 'direction', 'correction'] as const).map((kind) => {
        const list = rulings.filter((r) => r.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind} className="stack tight">
            <div className="section-title">
              <span>{KIND[kind].plural}</span>
              <span>{list.length}</span>
            </div>
            {list.map((r) => (
              <div key={r.id} className="card ruling">
                <p>{r.content}</p>
                <div className="row ruling-meta">
                  <span className={`pill ${KIND[kind].tone}`}>{KIND[kind].label}</span>
                  <span className="small faint grow truncate">
                    {r.requestedBy ? `${r.requestedBy.displayName} · ` : ''}
                    {timeAgo(r.createdAt)}
                  </span>
                  {owner && (
                    <ConfirmButton
                      className="btn sm ghost"
                      confirmLabel="Strike it?"
                      disabled={busy}
                      onConfirm={() => onRetire(r)}
                    >
                      Strike
                    </ConfirmButton>
                  )}
                </div>
              </div>
            ))}
          </section>
        );
      })}
      <p className="small faint">
        {owner
          ? 'Struck rulings stop applying from the next turn. To change one, talk it over at the desk.'
          : 'To change a ruling, talk it over at the desk. The host has the last word.'}
      </p>
    </div>
  );
}
