import type { CampaignDetail, ChatMessage, Citation, GameState, GameSystem } from '@tavern/protocol';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useAuth, useMe, useQuery, useToast, useVisualViewport } from '../app';
import { IconBack, IconChevron, IconDots, IconScroll, IconSparkle, IconUsers } from '../icons';
import { CharacterSheet } from '../play/character';
import { Composer, TurnBar, type Mode } from '../play/composer';
import { ManageSheet } from '../play/manage';
import { PartySheet } from '../play/party';
import { useTable } from '../play/socket';
import { LiveDm, MessageItem } from '../play/story';
import { Empty, Loading, Sheet, ruleSource } from '../ui';

const PAGE = 60;
const OPENERS = [
  'I take a slow look around. What do I see?',
  'I introduce myself to whoever is nearby.',
  'I check my gear and think about what I know of this place.',
];

function merge(prev: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function PlayScreen() {
  const { id = '' } = useParams();
  // Keyed so moving between campaigns starts from a clean slate.
  return <Play key={id} id={id} />;
}

function Play({ id }: { id: string }) {
  const me = useMe();
  const { setMe } = useAuth();
  const notify = useToast();
  const navigate = useNavigate();
  useVisualViewport(true);

  const campaign = useQuery(() => api<{ campaign: CampaignDetail }>(`/campaigns/${id}`), [id]);
  const state = useQuery(() => api<{ state: GameState }>(`/campaigns/${id}/state`), [id]);
  const systems = useQuery(() => api<{ systems: GameSystem[] }>('/systems'), []);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [panel, setPanel] = useState<'party' | 'manage' | 'character' | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const [unseen, setUnseen] = useState(false);

  const feed = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const restore = useRef<number | null>(null);

  const loadLatest = useCallback(async () => {
    try {
      const res = await api<{ messages: ChatMessage[] }>(`/campaigns/${id}/messages`);
      setMessages((prev) => merge(prev, res.messages));
      setHasMore((more) => more || res.messages.length === PAGE);
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setLoaded(true);
    }
  }, [id, notify]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  const c = campaign.data?.campaign;
  const reloadState = state.reload;
  const reloadCampaign = campaign.reload;
  const table = useTable(id, c?.status === 'active', {
    onMessage: (m) => {
      setMessages((prev) => merge(prev, [m]));
      if (!pinned.current && m.user?.id !== me.id) setUnseen(true);
    },
    onStateChanged: () => {
      void reloadState();
      void reloadCampaign();
    },
    onError: (text) => notify(text, 'error'),
    onReconnect: () => {
      void loadLatest();
      void reloadState();
    },
    onSignedOut: () => setMe(null),
  });

  // ---- scrolling: stay at the newest line unless the reader has scrolled up ----
  const toBottom = useCallback((smooth = false) => {
    const el = feed.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    pinned.current = true;
    setUnseen(false);
  }, []);

  const onScroll = () => {
    const el = feed.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    if (pinned.current) setUnseen(false);
  };

  useLayoutEffect(() => {
    const el = feed.current;
    if (!el) return;
    if (restore.current !== null) {
      // Older messages were added above: keep the same line under the thumb.
      el.scrollTop += el.scrollHeight - restore.current;
      restore.current = null;
    } else if (pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, table.stream, table.turn.status, loaded]);

  useEffect(() => {
    // The keyboard opening shrinks the feed; keep the newest line in view.
    const vv = window.visualViewport;
    const keep = () => pinned.current && toBottom();
    vv?.addEventListener('resize', keep);
    return () => vv?.removeEventListener('resize', keep);
  }, [toBottom]);

  const loadOlder = async () => {
    const first = messages[0];
    if (!first || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api<{ messages: ChatMessage[] }>(`/campaigns/${id}/messages?before=${first.id}`);
      restore.current = feed.current?.scrollHeight ?? null;
      setHasMore(res.messages.length === PAGE);
      setMessages((prev) => merge(prev, res.messages));
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const send = (mode: Mode, text: string): boolean => {
    const ok = table.send({ type: mode === 'act' ? 'action' : 'ooc', text });
    if (!ok) notify('Not connected to the table. Reconnecting…', 'error');
    else toBottom();
    return ok;
  };

  if (campaign.error || table.link === 'denied') {
    return (
      <main className="page">
        <Empty icon={<IconScroll />} title="This table is not open to you">
          {campaign.error ?? 'You are no longer part of this campaign.'}
        </Empty>
        <Link to="/" className="btn block back-home">
          Back to your campaigns
        </Link>
      </main>
    );
  }
  if (!c) {
    return (
      <main className="page">
        <Loading />
      </main>
    );
  }

  const game = state.data?.state;
  const mine = game?.characters.find((ch) => ch.userId === me.id);
  const template = systems.data?.systems.find((s) => s.id === c.systemId)?.sheetTemplate;
  const archived = c.status === 'archived';
  const others = table.present.filter((u) => u.id !== me.id).length;
  const subtitle = archived
    ? 'Archived'
    : table.link !== 'open'
      ? table.link === 'connecting'
        ? 'Joining the table…'
        : 'Reconnecting…'
      : others === 0
        ? 'Just you at the table'
        : `You and ${others} other${others > 1 ? 's' : ''} at the table`;

  return (
    <div className="play">
      <header className="play-head">
        <button
          type="button"
          className="icon-btn"
          onClick={() => navigate('/')}
          aria-label="Back to campaigns"
        >
          <IconBack />
        </button>
        <div className="grow play-title">
          <h1 className="truncate">{c.name}</h1>
          <p className={`truncate play-sub${table.link === 'open' && !archived ? ' on' : ''}`}>
            <i />
            {subtitle}
          </p>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setPanel('party')}
          aria-label="Party and world"
        >
          <IconUsers />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setPanel('manage')}
          aria-label="Campaign menu"
        >
          <IconDots />
        </button>
      </header>

      <div className="feed" ref={feed} onScroll={onScroll}>
        <div className="feed-inner">
          {hasMore && (
            <button
              type="button"
              className="btn sm ghost load-older"
              disabled={loadingMore}
              onClick={() => void loadOlder()}
            >
              {loadingMore ? 'Loading…' : 'Earlier in the story'}
            </button>
          )}
          {!loaded ? (
            <Loading />
          ) : messages.length === 0 ? (
            <div className="opening">
              <IconSparkle />
              <h2>{c.name}</h2>
              <p className="story-lede">
                {c.premise ||
                  'Every tale starts with someone doing something. The Dungeon Master is listening.'}
              </p>
              {!archived && (
                <div className="stack tight">
                  {OPENERS.map((line) => (
                    <button key={line} type="button" className="opener" onClick={() => setDraft(line)}>
                      {line}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            messages.map((m, i) => {
              const prev = messages[i - 1];
              const joined = m.kind === 'action' && prev?.kind === 'action' && prev.user?.id === m.user?.id;
              return (
                <MessageItem
                  key={m.id}
                  message={m}
                  mine={m.user?.id === me.id}
                  joined={joined}
                  onCite={setCitation}
                />
              );
            })
          )}
          {table.stream && <LiveDm stream={table.stream} />}
          {!table.stream && table.turn.status === 'resolving' && (
            <LiveDm stream={{ turnId: '', text: '', tools: [] }} />
          )}
        </div>
      </div>

      <footer className="play-foot">
        {unseen && (
          <button type="button" className="jump" onClick={() => toBottom(true)}>
            New in the story
          </button>
        )}
        {archived ? (
          <p className="archived-note">This campaign is archived. Its story stays here to read.</p>
        ) : (
          <>
            {loaded && game && !mine && (
              <button type="button" className="char-nudge" onClick={() => setPanel('character')}>
                <IconSparkle />
                <span className="grow">
                  <b>Create your character</b>
                  <small>So the DM knows who you are and what you can do.</small>
                </span>
                <IconChevron className="chev" />
              </button>
            )}
            <TurnBar
              turn={table.turn}
              members={c.members}
              meId={me.id}
              isOwner={c.role === 'owner'}
              onPass={() => table.send({ type: 'pass' })}
              onForce={() => table.send({ type: 'force' })}
            />
            <Composer
              characterName={mine?.name ?? null}
              resolving={table.turn.status === 'resolving'}
              draft={draft}
              onDraft={setDraft}
              onSend={send}
            />
          </>
        )}
      </footer>

      {panel === 'party' && game && (
        <PartySheet
          campaign={c}
          state={game}
          template={template}
          meId={me.id}
          present={table.present}
          onEdit={() => setPanel('character')}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'character' && (
        <CharacterSheet
          campaignId={id}
          template={template}
          character={mine}
          onClose={() => setPanel(null)}
          onSaved={() => {
            void reloadState();
            void reloadCampaign();
            setPanel(null);
          }}
        />
      )}
      {panel === 'manage' && (
        <ManageSheet
          campaign={c}
          present={table.present}
          busy={table.turn.status !== 'idle'}
          onChanged={() => void reloadCampaign()}
          onClose={() => setPanel(null)}
        />
      )}
      {citation && (
        <Sheet title={`Rule ${citation.ref}`} onClose={() => setCitation(null)}>
          <p className="small gold">{ruleSource(citation.document, citation.heading, citation.page)}</p>
          <p className="excerpt">{citation.excerpt}</p>
        </Sheet>
      )}
    </div>
  );
}
