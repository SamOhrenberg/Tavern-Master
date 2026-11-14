import type { BuilderEvent, BuilderMessage, BuilderThread, DmStatus } from '@tavern/protocol';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, apiStream, errorMessage } from '../api';
import { useToast } from '../app';
import { IconScroll, IconSend, IconSparkle } from '../icons';
import { Loading, Sheet } from '../ui';
import type { Control } from './character';
import { dmAbsent } from './claude';
import { RollChip, Story } from './story';

const STARTERS = [
  'I already have an idea. Let me describe it.',
  'I am not sure yet. Ask me some questions.',
  'Surprise me with three options that fit this campaign.',
];
const COMPANION_STARTERS = [
  'A loyal veteran who has seen too much.',
  'Someone useful the party cannot quite trust.',
  'Suggest three companions that would round out this party.',
];

const TOOL_NOTE: Record<string, string> = {
  roll_dice: 'Rolling',
  lookup_rules: 'Checking the rulebook',
  search_documents: 'Reading the campaign notes',
  save_character: 'Writing it on the sheet',
};

const coarse = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * A private chat with the character-building guide. What the two of you
 * agree on is written to the sheet as you go, so closing the chat loses
 * nothing and it can be picked up again later.
 */
export function GuideSheet({
  campaignId,
  characterId,
  control,
  onClose,
  onChanged,
  onOpenSheet,
  claude = false,
  dm = null,
  hostName = 'the host',
  guideSignal = 0,
}: {
  campaignId: string;
  characterId?: string;
  control?: Control;
  /** Claude is the guide: replies arrive later, through the table's connection. */
  claude?: boolean;
  dm?: DmStatus | null;
  hostName?: string;
  /** Bumped by the parent when a guide reply arrives, to fetch it. */
  guideSignal?: number;
  onClose: () => void;
  /** The sheet was written to. */
  onChanged: () => void;
  onOpenSheet: (characterId: string) => void;
}) {
  const notify = useToast();
  const [thread, setThread] = useState<BuilderThread | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [messages, setMessages] = useState<BuilderMessage[]>([]);
  const [saved, setSaved] = useState<string | null>(characterId ?? null);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState<{ text: string; note: string } | null>(null);
  // Claude has the player's message and has not answered yet.
  const [waiting, setWaiting] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const next = useRef(-1);

  useEffect(() => {
    let live = true;
    api<{ thread: BuilderThread }>(`/campaigns/${campaignId}/builder`, { body: { characterId, control } })
      .then((res) => {
        if (!live) return;
        setThread(res.thread);
        setMessages(res.thread.messages);
        setSaved(res.thread.characterId);
        if (claude && res.thread.messages.at(-1)?.role === 'user') setWaiting(true);
      })
      .catch((err: unknown) => live && setFailed(errorMessage(err)));
    return () => {
      live = false;
    };
    // One chat per opening of the sheet.
  }, []);

  // Keep the newest line in view while the reply is being written.
  useLayoutEffect(() => {
    const el = body.current?.closest('.sheet-body');
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, reply, waiting]);

  const threadId = thread?.id;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  /** Fetch the chat again, to pick up what Claude wrote. */
  const refresh = useCallback(async () => {
    if (!threadId) return;
    try {
      const res = await api<{ thread: BuilderThread }>(`/campaigns/${campaignId}/builder/${threadId}`);
      setMessages(res.thread.messages);
      setSaved(res.thread.characterId);
      if (res.thread.messages.at(-1)?.role === 'assistant') {
        setWaiting(false);
        changedRef.current();
      }
    } catch {
      // Tried again on the next signal or tick.
    }
  }, [campaignId, threadId]);

  // A reply arrived over the table's connection.
  useEffect(() => {
    if (guideSignal) void refresh();
  }, [guideSignal, refresh]);

  // While waiting, look again now and then and on returning to the app, in case a signal was missed.
  useEffect(() => {
    if (!waiting) return;
    const tick = window.setInterval(() => void refresh(), 20_000);
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [waiting, refresh]);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const send = async (text: string) => {
    const said = text.trim();
    if (!said || !thread || reply) return;
    setDraft('');
    const mine: BuilderMessage = {
      id: next.current--,
      role: 'user',
      content: said,
      createdAt: new Date().toISOString(),
    };
    setMessages((list) => [...list, mine]);
    setReply({ text: '', note: '' });
    let done = false;
    let wrote = false;
    try {
      await apiStream<BuilderEvent>(
        `/campaigns/${campaignId}/builder/${thread.id}/messages`,
        { text: said },
        (ev) => {
          if (ev.type === 'delta') setReply((r) => ({ text: (r?.text ?? '') + ev.text, note: '' }));
          else if (ev.type === 'tool') {
            wrote ||= ev.tool === 'save_character';
            setReply((r) => ({ text: r?.text ?? '', note: TOOL_NOTE[ev.tool] ?? 'Working' }));
          } else if (ev.type === 'done') {
            done = true;
            setMessages((list) => [...list, ev.message]);
            setSaved(ev.characterId);
          } else if (ev.type === 'queued') {
            // Stored and handed to Claude; the answer comes later.
            done = true;
            setWaiting(true);
          } else if (ev.type === 'error') {
            notify(ev.message, 'error');
          }
        },
      );
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
    if (!done) {
      // Nothing came back: give the words back so they can be sent again.
      setMessages((list) => list.filter((m) => m.id !== mine.id));
      setDraft(said);
    }
    setReply(null);
    if (wrote) onChanged();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) {
      e.preventDefault();
      void send(draft);
    }
  };

  const companion = control?.kind === 'npc';
  const away = dmAbsent(dm);
  return (
    <Sheet
      title={
        claude
          ? companion
            ? 'Companion with Claude'
            : 'Build with Claude'
          : companion
            ? 'Companion guide'
            : 'Character guide'
      }
      onClose={onClose}
      tall
      action={
        saved && (
          <button type="button" className="btn sm" onClick={() => onOpenSheet(saved)}>
            <IconScroll /> Sheet
          </button>
        )
      }
      footer={
        <div className="composer talk">
          <textarea
            ref={field}
            className="composer-field"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              reply
                ? 'The guide is writing…'
                : waiting
                  ? 'Add more while you wait'
                  : 'Say what you have in mind'
            }
            maxLength={2000}
            disabled={!thread}
            enterKeyHint={coarse() ? 'enter' : 'send'}
            aria-label="Message to the guide"
          />
          <button
            type="button"
            className="send"
            disabled={!draft.trim() || !thread || !!reply}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void send(draft)}
            aria-label="Send"
          >
            <IconSend />
          </button>
        </div>
      }
    >
      <div className="guide" ref={body}>
        {failed ? (
          <div className="form-error">{failed}</div>
        ) : !thread ? (
          <Loading />
        ) : (
          <>
            {messages.length === 0 && (
              <div className="guide-intro">
                <IconSparkle />
                <p>
                  {companion
                    ? `Describe the companion you want at the party’s side. ${claude ? 'Claude' : 'The guide'} writes the sheet and their personality as you talk.`
                    : `Talk your character into being. ${claude ? 'Claude' : 'The guide'} knows this table’s rules, rolls real dice, and writes the sheet as you go.`}
                </p>
                <div className="stack tight">
                  {(companion ? COMPANION_STARTERS : STARTERS).map((line) => (
                    <button key={line} type="button" className="opener" onClick={() => void send(line)}>
                      {line}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="msg action mine">
                  <div className="action-body">
                    <div className="bubble">{m.content}</div>
                  </div>
                </div>
              ) : (
                <article key={m.id} className="msg guide-msg">
                  {m.rolls && m.rolls.length > 0 && (
                    <div className="rolls">
                      {m.rolls.map((r) => (
                        <RollChip key={r.id} roll={r} />
                      ))}
                    </div>
                  )}
                  <div className="story">
                    <Story text={m.content} />
                  </div>
                </article>
              ),
            )}
            {waiting && !reply && (
              <article className="msg guide-msg live" aria-live="polite">
                <div className="dm-tool">
                  {!away && <span className="live-dot" />}
                  <span>
                    {away
                      ? `Claude is away. Your message is saved and will be answered when ${hostName} has Claude running.`
                      : 'Sent to Claude…'}
                  </span>
                </div>
              </article>
            )}
            {reply && (
              <article className="msg guide-msg live" aria-live="polite">
                {(reply.note || !reply.text) && (
                  <div className="dm-tool">
                    <span className="live-dot" />
                    <span>{reply.note || 'Thinking'}…</span>
                  </div>
                )}
                {reply.text && (
                  <div className="story">
                    <Story text={reply.text} />
                  </div>
                )}
              </article>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
