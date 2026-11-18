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
import { IconBack, IconChevron, IconDots, IconGavel, IconScroll, IconSparkle, IconUsers } from '../icons';
import { CastPanels, runsIt, type CastPanel } from '../play/cast';
import { CodexSheet } from '../play/codex';
import { Composer, TurnBar, type Mode } from '../play/composer';
import { FeedbackButton } from '../feedback/button';
import { AnimatedRoll, DiceTray } from '../play/dice';
import { MessageMenu } from '../play/history';
import { ManageSheet } from '../play/manage';
import { RecapView, TalkBox } from '../play/recap';
import { RulesSheet } from '../play/rules';
import { PartySheet } from '../play/party';
import { ClaudeSetupSheet, dmAbsent, dmLine } from '../play/claude';
import { useTable } from '../play/socket';
import { LiveDm, MessageItem, sameSpeaker } from '../play/story';
import { Empty, Loading, Sheet, ruleSource } from '../ui';
import { PushNudge } from './notifications';
import { Prep } from './prep';
import { clearNotifications } from '../push';

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
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesSignal, setRulesSignal] = useState(0);
  // The message whose menu (edit, rewind) is open.
  const [menuFor, setMenuFor] = useState<ChatMessage | null>(null);
  // Between sessions, reading the full story instead of the recap.
  const [reading, setReading] = useState(false);
  // This player's own choice to keep AI companion messages off their screen.
  // Sent something this visit: the moment to offer notifications for the wait that follows.
  const [sentOnce, setSentOnce] = useState(false);
  const [hideAi, setHideAi] = useState(() => {
    try {
      return localStorage.getItem(`hideAi:${id}`) === '1';
    } catch {
      return false;
    }
  });
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

  // What this campaign's notifications said is on screen now: clear them from the lock screen and badge.
  useEffect(() => {
    const clear = () => {
      if (document.visibilityState === 'visible') void clearNotifications(id);
    };
    clear();
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, [id]);

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
    onRules: () => setRulesSignal((n) => n + 1),
    // The story was rewound or corrected: what is on screen may no longer have been said.
    onHistoryChanged: () => {
      setMessages([]);
      setRolls([]);
      setHasMore(false);
      setMenuFor(null);
      void loadLatest();
      void reloadState();
      void reloadCampaign();
    },
  });

  // A new break between sessions opens on the recap, not on the story.
  const restingSince = c?.restingSince ?? null;
  useEffect(() => setReading(false), [restingSince]);

  // ---- scrolling: stay at the newest line unless the reader has scrolled up ----
  const toBottom = useCallback((smooth = false) => {
    const el = feed.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    pinned.current = true;
    setUnseen(false);
  }, []);

  const toggleHideAi = (next: boolean) => {
    setHideAi(next);
    try {
      localStorage.setItem(`hideAi:${id}`, next ? '1' : '0');
    } catch {
      // A private window with storage blocked: the choice lasts the session only.
    }
  };

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
  // Actions name the character who acted, so its picture is found by name.
  const portraits = useMemo(
    () => new Map((game?.characters ?? []).flatMap((ch) => (ch.portrait ? [[ch.name, ch.portrait]] : []))),
    [game?.characters],
  );
  // Party members the GM or their own AI play: anyone may speak for one without taking it over.
  const companions = (game?.characters ?? []).filter((ch) => ch.controller !== 'player');
  const acted = mine.filter((ch) => table.turn.acted.includes(ch.id)).map((ch) => ch.id);
  // The choice stays until the player changes it back.
  const actingAs =
    [...mine, ...companions].find((ch) => ch.id === actAs) ??
    mine.find((ch) => !acted.includes(ch.id)) ??
    mine[0];

  const send = (mode: Mode, text: string): boolean => {
    const ok = table.send(
      mode === 'act' ? { type: 'action', text, characterId: actingAs?.id } : { type: 'ooc', text },
    );
    if (!ok) notify('Not connected to the table. Reconnecting…', 'error');
    else {
      toBottom();
      setSentOnce(true);
    }
    return ok;
  };

  // Rolls the DM asked for, for characters this player runs. Nobody else sees dice.
  const asks = (game?.rollRequests ?? []).filter((r) => mine.some((ch) => ch.id === r.characterId));
  const roll = (requestId: string): boolean => {
    const ok = table.send({ type: 'roll', requestId });
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
  const resting = !!c.restingSince && !archived;
  // What this player has chosen to see: companion messages drop out when hidden.
  const shown = hideAi ? messages.filter((m) => !m.ai) : messages;
  // Whether any companion message exists, so the toggle only shows when it can do something.
  const hasAi = messages.some((m) => m.ai);
  // Table talk since the break began, for the recap.
  const talk = messages.filter((m) => m.kind === 'ooc' && m.createdAt >= (c.restingSince ?? ''));
  const owner = c.role === 'owner';
  // The host may edit any narration or action; a player, their own actions.
  const canEdit = (m: ChatMessage) =>
    !archived &&
    ((owner && (m.kind === 'dm' || m.kind === 'action')) || (m.kind === 'action' && m.user?.id === me.id));
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
  // Nothing has been said yet and Claude writes the opening scene: say where that stands, live,
  // instead of leaving the table looking at an empty story. Its tool calls show up as a stream.
  const awaitingOpening =
    claude &&
    loaded &&
    !archived &&
    !resting &&
    messages.length === 0 &&
    rolls.length === 0 &&
    table.turn.status === 'idle' &&
    !table.stream;
  const openingWait = !dmAbsent(dm)
    ? 'Claude is at the table, preparing the opening scene…'
    : owner
      ? dm.state === 'never'
        ? 'Waiting for Claude to join. Start the Dungeon Master from your Claude app; it writes the opening scene first.'
        : 'Waiting for Claude. Start the Dungeon Master again from your Claude app to get the opening scene.'
      : dm.state === 'never'
        ? `Waiting for Claude to join. ${host} runs the Dungeon Master from their Claude app; the opening scene comes once it is here.`
        : `Waiting for Claude to come back. ${host} runs the Dungeon Master from their Claude app.`;

  const giveBack = () =>
    run(async () => {
      await api(`/campaigns/${id}/desk/release`, { method: 'POST' });
    }, 'Stopped waiting. Act again when Claude is here.');

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
              className={`truncate play-sub${table.link === 'open' && !dmAbsent(dm) ? ' on' : ''}`}
              onClick={() => setSettingUp(true)}
            >
              <i />
              {subtitle}
            </button>
          ) : (
            <p
              className={`truncate play-sub${table.link === 'open' && !archived && (!claude || !dmAbsent(dm)) ? ' on' : ''}`}
            >
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
        {c.homebrew && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setRulesOpen(true)}
            aria-label="Rules desk"
          >
            <IconGavel />
          </button>
        )}
        <FeedbackButton />
        <button
          type="button"
          className="icon-btn"
          onClick={() => setPanel('manage')}
          aria-label="Campaign menu"
        >
          <IconDots />
        </button>
      </header>

      {resting && !reading ? (
        <RecapView
          campaign={c}
          meId={me.id}
          talk={talk}
          onTalk={(text) => send('talk', text)}
          onChanged={reloadCampaign}
          onRead={() => setReading(true)}
        />
      ) : (
        <>
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
                    {c.premise ||
                      (claude
                        ? 'The story starts with an opening scene from the Dungeon Master.'
                        : 'Every tale starts with someone doing something. The Dungeon Master is listening.')}
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
                  {shown.map((m, i) => {
                    const prev = shown[i - 1];
                    const joined = m.kind === 'action' && prev?.kind === 'action' && sameSpeaker(prev, m);
                    return (
                      <Fragment key={m.id}>
                        <MessageItem
                          message={m}
                          mine={m.user?.id === me.id}
                          joined={joined}
                          portrait={m.characterName ? portraits.get(m.characterName) : undefined}
                          onCite={setCitation}
                          onRef={openRef}
                          canEdit={canEdit(m)}
                          onMenu={setMenuFor}
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
              {awaitingOpening && (
                <LiveDm stream={{ turnId: 'opening', text: '', tools: [] }} waitingOn={openingWait}>
                  {owner && dmAbsent(dm) && (
                    <div className="give-back">
                      <button type="button" className="btn sm ghost" onClick={() => setSettingUp(true)}>
                        Claude setup
                      </button>
                    </div>
                  )}
                </LiveDm>
              )}
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
                    <div className="give-back">
                      <p className="small muted">
                        Claude isn't connected, so this turn is stuck. Stop waiting to unlock the table.
                        Everyone's actions stay in the story; send one again once Claude is back.
                      </p>
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={busy}
                        onClick={() => void giveBack()}
                      >
                        Stop waiting for Claude
                      </button>
                    </div>
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
            ) : resting ? (
              <>
                <TalkBox onTalk={(text) => send('talk', text)} />
                <button type="button" className="btn primary block" onClick={() => setReading(false)}>
                  Back to the recap
                </button>
              </>
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
                <PushNudge armed={sentOnce} />
                <TurnBar
                  turn={table.turn}
                  meId={me.id}
                  isOwner={c.role === 'owner'}
                  dmWorking={!!table.stream || awaitingOpening}
                  onDone={() => table.send({ type: 'done' })}
                  onPass={() => {
                    if (table.send({ type: 'pass' })) toBottom();
                    else notify('Not connected to the table. Reconnecting…', 'error');
                  }}
                  onForce={() => table.send({ type: 'force' })}
                />
                <DiceTray requests={asks} onRoll={roll} />
                <Composer
                  characters={mine}
                  companions={companions}
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
        </>
      )}

      {menuFor && (
        <MessageMenu campaignId={id} message={menuFor} owner={owner} onClose={() => setMenuFor(null)} />
      )}
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
          hideAi={hideAi}
          canHideAi={hasAi || hideAi}
          onHideAi={toggleHideAi}
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
      {rulesOpen && (
        <RulesSheet
          campaignId={id}
          owner={c.role === 'owner'}
          claude={c.dm === 'claude'}
          dm={dm}
          hostName={c.members.find((m) => m.role === 'owner')?.displayName ?? 'the host'}
          signal={rulesSignal}
          onClose={() => setRulesOpen(false)}
        />
      )}
    </div>
  );
}
