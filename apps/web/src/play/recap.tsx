import type { CampaignDetail, ChatMessage, Recap } from '@tavern/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAction, useQuery } from '../app';
import { IconCheck, IconScroll, IconSend } from '../icons';
import { Empty, Skeletons } from '../ui';
import { nameList, playersOf, ReadyList } from './ready';
import { hostOf } from './cast';

/**
 * A line of table talk for between sessions, when there is no composer:
 * players waiting on someone can say so. The DM never sees it.
 */
export function TalkBox({ onTalk }: { onTalk: (text: string) => boolean }) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const line = text.trim();
    if (line && onTalk(line)) setText('');
  };
  return (
    <form className="talk-box" onSubmit={submit}>
      <input
        className="input"
        value={text}
        maxLength={2000}
        placeholder="Table talk. The DM will not see this."
        aria-label="Table talk"
        enterKeyHint="send"
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="icon-btn send" aria-label="Send" disabled={!text.trim()}>
        <IconSend />
      </button>
    </form>
  );
}

/**
 * Between sessions. The host ended one: the table reads the story so far,
 * every player readies up, and the host starts the next session.
 */
export function RecapView({
  campaign: c,
  meId,
  talk,
  onTalk,
  onChanged,
  onRead,
}: {
  campaign: CampaignDetail;
  meId: string;
  /** Table talk since the break began. */
  talk: ChatMessage[];
  onTalk: (text: string) => boolean;
  onChanged: () => Promise<unknown> | void;
  /** Read the full story instead. */
  onRead: () => void;
}) {
  const recap = useQuery(() => api<Recap>(`/campaigns/${c.id}/recap`), [c.id, c.restingSince]);
  const [busy, run] = useAction();
  const owner = c.role === 'owner';
  // Owners share the host's controls, but only the host is exempt from the ready check.
  const isHost = c.ownerId === meId;
  const sessions = recap.data?.sessions ?? [];
  const arcs = recap.data?.arcs ?? [];
  const latest = sessions[sessions.length - 1];
  // Only while a summary is really on its way; otherwise there is nothing to wait for.
  const writing = sessions.some((s) => s.pending);
  const reloadRecap = recap.reload;

  // The chronicle of the session just ended is written in the background: look again until it is in.
  useEffect(() => {
    if (!writing) return;
    const timer = window.setInterval(() => void reloadRecap(), 8000);
    return () => window.clearInterval(timer);
  }, [writing, reloadRecap]);

  const { waitingOn } = playersOf(c.members, c.ownerId);
  const iAmReady = c.members.find((m) => m.id === meId)?.ready ?? false;
  const othersWaiting = waitingOn.filter((m) => m.id !== meId);
  const host = hostOf(c)?.displayName ?? 'The host';
  const next = (latest?.number ?? 0) + 1;

  const setReady = (ready: boolean) =>
    run(
      async () => {
        await api(`/campaigns/${c.id}/ready`, { method: 'PUT', body: { ready } });
        await onChanged();
      },
      ready ? 'You are ready' : 'Not ready yet',
    );

  const resume = (anyway = false) =>
    run(async () => {
      await api(`/campaigns/${c.id}/resume`, { method: 'POST', body: anyway ? { anyway: true } : {} });
      await onChanged();
    }, `Session ${next} begins`);

  return (
    <>
      <div className="feed">
        <div className="feed-inner prep-body">
          <div className="card hero">
            <p className="small gold">Between sessions</p>
            <p className="prep-lede">
              {latest ? `Session ${latest.number} is over.` : 'The session is over.'} Here is the story so
              far.
            </p>
          </div>

          <section>
            <div className="section-title">
              <span>The story so far</span>
            </div>
            {recap.loading ? (
              <Skeletons count={2} />
            ) : arcs.length === 0 && sessions.length === 0 ? (
              <Empty icon={<IconScroll />} title="Nothing to tell yet" />
            ) : (
              <div className="stack">
                {arcs.map((text, i) => (
                  <div key={`arc-${i}`} className="card recap-session">
                    <p>{text}</p>
                  </div>
                ))}
                {sessions.map((s) => (
                  <div key={s.number} className="card recap-session">
                    <h3>Session {s.number}</h3>
                    {s.summary ? (
                      <p>{s.summary}</p>
                    ) : s.pending === 'claude' ? (
                      <p className="small muted">
                        <span className="live-dot" /> Claude writes this when it is next at the table.
                      </p>
                    ) : s.pending ? (
                      <p className="small muted">
                        <span className="live-dot" /> The chronicler is still writing this session&apos;s
                        story.
                      </p>
                    ) : (
                      <p className="small muted">No summary for this session.</p>
                    )}
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="btn block ghost under-field" onClick={onRead}>
              Read the full story
            </button>
          </section>

          <ReadyList members={c.members} hostId={c.ownerId} meId={meId} title="Ready for the next session" />

          {talk.length > 0 && (
            <section>
              <div className="section-title">
                <span>Table talk</span>
              </div>
              <div className="list talk-list">
                {talk.slice(-12).map((m) => (
                  <p key={m.id}>
                    <b>{m.user?.id === meId ? 'You' : (m.user?.displayName ?? 'Someone')}</b> {m.content}
                  </p>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      <footer className="play-foot">
        <TalkBox onTalk={onTalk} />
        {!isHost && (
          <div className="stack tight">
            <button
              type="button"
              className={`btn block${iAmReady ? '' : ' primary'}`}
              disabled={busy}
              aria-pressed={iAmReady}
              onClick={() => void setReady(!iAmReady)}
            >
              {iAmReady ? (
                <>
                  <IconCheck /> Ready · tap to undo
                </>
              ) : (
                "I'm ready for the next session"
              )}
            </button>
            {!owner && (
              <p className="small faint center">
                {!iAmReady
                  ? `${host} starts the next session once everyone is ready.`
                  : othersWaiting.length > 0
                    ? `Waiting for ${nameList(othersWaiting.map((m) => m.displayName))} to ready up.`
                    : `Everyone is ready. Waiting for ${host} to start.`}
              </p>
            )}
          </div>
        )}
        {owner && (
          <div className="stack tight">
            <button
              type="button"
              className="btn primary block"
              disabled={busy || waitingOn.length > 0}
              onClick={() => void resume()}
            >
              Start session {next}
            </button>
            <p className="small faint center">
              {waitingOn.length > 0
                ? `Waiting for ${nameList(waitingOn.map((m) => (m.id === meId ? 'you' : m.displayName)))} to ready up.`
                : 'Everyone is ready.'}
            </p>
            {othersWaiting.length > 0 && (
              <button
                type="button"
                className="btn sm ghost block"
                disabled={busy}
                onClick={() => void resume(true)}
              >
                Start without {nameList(othersWaiting.map((m) => m.displayName))}
              </button>
            )}
          </div>
        )}
      </footer>
    </>
  );
}
