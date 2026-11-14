import type {
  CampaignDetail,
  ChatMessage,
  Citation,
  DiceRoll,
  Entity,
  GameState,
  GameSystem,
} from '@tavern/protocol';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useAction, useAuth, useMe, useQuery, useToast, useVisualViewport, type Query } from '../app';
import { IconBack, IconChevron, IconDots, IconScroll, IconSparkle, IconUsers } from '../icons';
import { CastPanels, runsIt, type CastPanel } from '../play/cast';
import { CodexSheet } from '../play/codex';
import { Composer, TurnBar, type Mode } from '../play/composer';
import { AnimatedRoll, DiceTray, type RollReq } from '../play/dice';
import { ManageSheet } from '../play/manage';
import { PartySheet } from '../play/party';
import { ClaudeSetupSheet, dmAbsent, dmLine } from '../play/claude';
import { useTable } from '../play/socket';
import { LiveDm, MessageItem } from '../play/story';
import { Empty, Loading, Sheet, ruleSource } from '../ui';
import { Prep } from './prep';

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
  return <Table key={id} id={id} />;
}

/** One campaign: its lobby while it is being prepared, the story once it has begun. */
function Table({ id }: { id: string }) {
  useVisualViewport(true);
  const campaign = useQuery(() => api<{ campaign: CampaignDetail }>(`/campaigns/${id}`), [id]);
  const state = useQuery(() => api<{ state: GameState }>(`/campaigns/${id}/state`), [id]);
  const systems = useQuery(() => api<{ systems: GameSystem[] }>('/systems'), []);

  const c = campaign.data?.campaign;
  if (campaign.error) {
    return (
      <main className="page">
        <Empty icon={<IconScroll />} title="This table is not open to you">
          {campaign.error}
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
  const template = systems.data?.systems.find((s) => s.id === c.systemId)?.sheetTemplate;
  const shared = { id, campaign, state, template };
  // Keyed by phase so beginning the campaign swaps the lobby for a fresh play screen.
  return c.phase === 'prep' ? <Prep key="prep" {...shared} /> : <Play key="play" {...shared} />;
}

export interface TableProps {
  id: string;
  campaign: Query<{ campaign: CampaignDetail }>;
  state: Query<{ state: GameState }>;
  template: GameSystem['sheetTemplate'] | undefined;
}

function Play({ id, campaign, state, template }: TableProps) {
  const me = useMe();
  const { setMe } = useAuth();
  const notify = useToast();
  const navigate = useNavigate();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Standalone player rolls, each pinned after the message that was newest when it arrived.
  const [rolls, setRolls] = useState<{ roll: DiceRoll; afterId: number }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [panel, setPanel] = useState<'party' | 'manage' | null>(null);
  const [cast, setCast] = useState<CastPanel>(null);
  const [actAs, setActAs] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const [entry, setEntry] = useState<Entity | null>(null);
  const [unseen, setUnseen] = useState(false);
  const [guideSignal, setGuideSignal] = useState(0);
  const [settingUp, setSettingUp] = useState(false);
  const [busy, run] = useAction();

  const feed = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const restore = useRef<number | null>(null);
  // The newest message id, so an arriving roll can anchor after it without a render dependency.
  const latestId = useRef(0);

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
    onRoll: (roll) => {
      setRolls((rs) => [...rs, { roll, afterId: latestId.current }]);
      if (!pinned.current) setUnseen(true);
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
    onGuide: () => setGuideSignal((n) => n + 1),
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

  useEffect(() => {
    latestId.current = messages[messages.length - 1]?.id ?? 0;
  }, [messages]);

  // Rolls grouped by the message they were anchored after (0 = before any message).
  const rollsAfter = useMemo(() => {
    const map = new Map<number, DiceRoll[]>();
    for (const { roll, afterId } of rolls) map.set(afterId, [...(map.get(afterId) ?? []), roll]);
    return map;
  }, [rolls]);

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
  }, [messages, rolls, table.stream, table.turn.status, loaded]);

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

  const game = state.data?.state;
  // Open the scoped codex entry a narration link points to, from the state we already hold.
  const entities = game?.entities;
  const openRef = useCallback(
    (entityId: string) => {
      const found = entities?.find((e) => e.id === entityId);
      if (found) setEntry(found);
    },
    [entities],
  );
  // The characters this player speaks for, and which of them the next action is for.
  // Their own character comes first, ahead of companions and characters they share.
  const mine = (game?.characters ?? [])
    .filter((ch) => runsIt(ch, me.id))
    .sort(
      (x, y) =>
        Number(x.kind === 'npc') - Number(y.kind === 'npc') || x.playerIds.length - y.playerIds.length,
    );
  const acted = mine.filter((ch) => table.turn.acted.includes(ch.id)).map((ch) => ch.id);
  const actingAs = mine.find((ch) => ch.id === actAs) ?? mine.find((ch) => !acted.includes(ch.id)) ?? mine[0];

  const send = (mode: Mode, text: string): boolean => {
    const ok = table.send(
      mode === 'act' ? { type: 'action', text, characterId: actingAs?.id } : { type: 'ooc', text },
    );
    if (!ok) notify('Not connected to the table. Reconnecting…', 'error');
    else {
      toBottom();
      // Having acted with one character, move on to the next that has not.
      if (mode === 'act') setActAs(null);
    }
    return ok;
  };

  const roll = (req: RollReq): boolean => {
    const ok = table.send({ type: 'roll', ...req });
    if (!ok) notify('Not connected to the table. Reconnecting…', 'error');
    else toBottom();
    return ok;
  };

  if (table.link === 'denied') {
    return (
      <main className="page">
        <Empty icon={<IconScroll />} title="This table is not open to you">
          You are no longer part of this campaign.
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

  const archived = c.status === 'archived';
  const opening = table.turn.status === 'resolving' && messages.length === 0;
  const others = table.present.filter((u) => u.id !== me.id).length;
  const claude = c.dm === 'claude';
  const dm = table.dm ?? c.dmStatus;
  const host = c.members.find((m) => m.role === 'owner')?.displayName ?? 'The host';
  const people = others === 0 ? 'just you' : `${others} other${others > 1 ? 's' : ''} here`;
  const subtitle = archived
    ? 'Archived'
    : table.link !== 'open'
      ? table.link === 'connecting'
        ? 'Joining the table…'
        : 'Reconnecting…'
      : claude
        ? `${dmLine(dm)} · ${people}`
        : others === 0
          ? 'Just you at the table'
          : `You and ${others} other${others > 1 ? 's' : ''} at the table`;
  // A turn is waiting for a Claude that is not there to take it.
  const stalled = claude && !table.stream && table.turn.status === 'resolving' && dmAbsent(dm);

  const giveBack = () =>
    run(async () => {
      await api(`/campaigns/${id}/desk/release`, { method: 'POST' });
    }, 'The turn was handed back. Act again when Claude is here.');

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
          {claude && c.role === 'owner' && !archived ? (
            <button
              type="button"
              className={`truncate play-sub${table.link === 'open' ? ' on' : ''}`}
              onClick={() => setSettingUp(true)}
            >
              <i />
              {subtitle}
            </button>
          ) : (
            <p className={`truncate play-sub${table.link === 'open' && !archived ? ' on' : ''}`}>
              <i />
              {subtitle}
            </p>
          )}
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
          ) : messages.length === 0 && rolls.length === 0 && !opening ? (
            <div className="opening">
              <IconSparkle />
              <h2>{c.name}</h2>
              <p className="story-lede">
                {claude
                  ? 'Claude will write the opening scene when it is at the table.'
                  : c.premise ||
                    'Every tale starts with someone doing something. The Dungeon Master is listening.'}
              </p>
              {!archived && !claude && (
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
            <>
              {(rollsAfter.get(0) ?? []).map((r) => (
                <AnimatedRoll key={r.id} roll={r} />
              ))}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const joined = m.kind === 'action' && prev?.kind === 'action' && prev.user?.id === m.user?.id;
                return (
                  <Fragment key={m.id}>
                    <MessageItem
                      message={m}
                      mine={m.user?.id === me.id}
                      joined={joined}
                      onCite={setCitation}
                      onRef={openRef}
                    />
                    {(rollsAfter.get(m.id) ?? []).map((r) => (
                      <AnimatedRoll key={r.id} roll={r} />
                    ))}
                  </Fragment>
                );
              })}
            </>
          )}
          {table.stream && <LiveDm stream={table.stream} />}
          {!table.stream && table.turn.status === 'resolving' && (
            <LiveDm
              stream={{ turnId: '', text: '', tools: [] }}
              waitingOn={
                stalled
                  ? `Waiting for Claude. ${host} runs the Dungeon Master from their Claude app.`
                  : undefined
              }
            >
              {stalled && c.role === 'owner' && (
                <button
                  type="button"
                  className="btn sm ghost give-back"
                  disabled={busy}
                  onClick={() => void giveBack()}
                >
                  Give the turn back
                </button>
              )}
            </LiveDm>
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
            {loaded && game && mine.length === 0 && (
              <button type="button" className="char-nudge" onClick={() => setCast({ kind: 'add' })}>
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
              meId={me.id}
              isOwner={c.role === 'owner'}
              onPass={() => table.send({ type: 'pass' })}
              onForce={() => table.send({ type: 'force' })}
            />
            <DiceTray character={actingAs} onRoll={roll} />
            <Composer
              characters={mine}
              actingAs={actingAs}
              onActAs={setActAs}
              acted={acted}
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
          onOpen={(next) => {
            setPanel(null);
            setCast(next);
          }}
          onClose={() => setPanel(null)}
        />
      )}
      <CastPanels
        panel={cast}
        setPanel={setCast}
        campaign={c}
        state={game}
        template={template}
        dm={table.dm}
        guideSignal={guideSignal}
        onChanged={() => {
          void reloadState();
          void reloadCampaign();
        }}
      />
      {panel === 'manage' && (
        <ManageSheet
          campaign={c}
          present={table.present}
          busy={table.turn.status !== 'idle'}
          dm={dm}
          onClaudeSetup={() => {
            setPanel(null);
            setSettingUp(true);
          }}
          onChanged={() => void reloadCampaign()}
          onClose={() => setPanel(null)}
        />
      )}
      {settingUp && (
        <ClaudeSetupSheet
          campaign={c}
          dm={dm}
          onChanged={() => void reloadCampaign()}
          onClose={() => setSettingUp(false)}
        />
      )}
      {citation && (
        <Sheet title={`Rule ${citation.ref}`} onClose={() => setCitation(null)}>
          <p className="small gold">{ruleSource(citation.document, citation.heading, citation.page)}</p>
          <p className="excerpt">{citation.excerpt}</p>
        </Sheet>
      )}
      {entry && <CodexSheet entity={entry} onClose={() => setEntry(null)} />}
    </div>
  );
}
