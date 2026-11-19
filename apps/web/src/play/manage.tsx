import type { CampaignDetail, DmStatus, Friend, UsageTotals, UserRef } from '@tavern/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { reloadMeta, useAction, useMe, useMeta, useQuery } from '../app';
import { IconCrown } from '../icons';
import { CampaignNotifyToggle } from '../screens/notifications';
import { Avatar, ConfirmButton, Field, Presence, Sheet, formatTokens, formatUsd } from '../ui';
import { DmChip } from './claude';
import { Documents } from './documents';
import { SheetVersionCard } from './sheet-update';
import { WishesEditor } from './wishes';
import { hostOf } from './cast';

const WINDOWS = [
  { seconds: 10, label: '10 seconds' },
  { seconds: 20, label: '20 seconds' },
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 0, label: 'Until everyone is ready' },
];

const total = (u: UsageTotals) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** The campaign menu: who is here, invitations, settings, and the ways out. */
export function ManageSheet({
  campaign: c,
  present,
  busy: turnBusy,
  dm: dmStatus,
  hideAi,
  canHideAi,
  onHideAi,
  onClaudeSetup,
  onChanged,
  onClose,
}: {
  campaign: CampaignDetail;
  present: UserRef[];
  busy: boolean;
  /** Where the campaign's AI is, live from the table. */
  dm?: DmStatus;
  /** This player's choice to hide AI companion messages on their own screen. */
  hideAi: boolean;
  /** Whether the choice can do anything: there are companions, or it is already on. */
  canHideAi: boolean;
  onHideAi: (next: boolean) => void;
  /** Open the Claude setup sheet. */
  onClaudeSetup?: () => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const meta = useMeta();
  // The AIs to polish with change on the admin page, maybe on another device: ask again when settings open.
  useEffect(() => {
    void reloadMeta();
  }, []);
  const claude = c.dm === 'claude';
  const status = dmStatus ?? c.dmStatus;
  const host = hostOf(c)?.displayName ?? 'the host';
  const me = useMe();
  const navigate = useNavigate();
  const owner = c.role === 'owner';
  // The host made the campaign: their AI or Claude runs it, and only they make others owners.
  const isHost = c.ownerId === me.id;
  const friends = useQuery(
    () => (owner ? api<{ friends: Friend[] }>('/friends') : Promise.resolve({ friends: [] })),
    [owner],
  );
  const usage = useQuery(
    () => api<{ day: UsageTotals; month: UsageTotals }>(`/campaigns/${c.id}/usage`),
    [c.id],
  );
  const [busy, run] = useAction();

  const [name, setName] = useState(c.name);
  const [premise, setPremise] = useState(c.premise);
  const [tone, setTone] = useState(c.settings.tone);
  const [windowSeconds, setWindowSeconds] = useState(c.settings.gatherWindowSeconds);
  const [sheets, setSheets] = useState(c.settings.sheets);
  const [polishWith, setPolishWith] = useState(c.settings.polishWith ?? '');
  // Polishing needs another AI an admin set up; keep showing a choice that was made before one was removed.
  const polishers = meta?.outsideAis ?? [];
  const canPolish = polishers.length > 0 || !!polishWith;
  const prep = c.phase === 'prep';

  const invitable = (friends.data?.friends ?? []).filter(
    (f) =>
      f.status === 'accepted' &&
      !c.members.some((m) => m.id === f.user.id) &&
      !c.pendingInvites.some((p) => p.invitee.id === f.user.id),
  );

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(`/campaigns/${c.id}`, {
        method: 'PATCH',
        body: {
          name,
          premise,
          tone,
          gatherWindowSeconds: windowSeconds,
          sheets,
          ...(canPolish ? { polishWith } : {}),
        },
      });
      onChanged();
    }, 'Campaign updated');
  };

  const act = (fn: () => Promise<unknown>, done?: string, leave = false) =>
    run(async () => {
      await fn();
      if (leave) navigate('/', { replace: true });
      else onChanged();
    }, done);

  return (
    <Sheet title={c.name} onClose={onClose} tall>
      <div className="section-title first">
        <span>In the campaign</span>
        <span>
          {c.members.length} · {c.members.filter((m) => present.some((u) => u.id === m.id)).length} online
        </span>
      </div>
      <div className="list">
        {c.members.map((m) => (
          <div key={m.id}>
            <Avatar
              name={m.characterName ?? m.displayName}
              seed={m.id}
              online={present.some((u) => u.id === m.id)}
            />
            <div className="grow">
              <div className="truncate">
                {m.displayName}
                {m.id === me.id && <span className="faint"> (you)</span>}
              </div>
              <div className="small muted truncate">
                <Presence online={present.some((u) => u.id === m.id)} /> ·{' '}
                {m.characterName ?? 'No character yet'}
              </div>
            </div>
            {m.id === c.ownerId ? (
              <span className="pill arcane">
                <IconCrown className="pill-icon" />
                Host
              </span>
            ) : (
              <div className="row member-acts">
                {m.role === 'owner' && !isHost && <span className="pill">Owner</span>}
                {isHost && (
                  <button
                    type="button"
                    className={`btn sm${m.role === 'owner' ? ' on' : ''}`}
                    aria-pressed={m.role === 'owner'}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () =>
                          api(`/campaigns/${c.id}/members/${m.id}/role`, {
                            method: 'PUT',
                            body: { role: m.role === 'owner' ? 'player' : 'owner' },
                          }),
                        m.role === 'owner'
                          ? `${m.displayName} is a player again`
                          : `${m.displayName} is now an owner`,
                      )
                    }
                  >
                    {m.role === 'owner' && <IconCrown className="pill-icon" />}
                    Owner
                  </button>
                )}
                {(isHost || (owner && m.role !== 'owner')) && (
                  <ConfirmButton
                    className="btn sm danger"
                    confirmLabel="Remove?"
                    disabled={busy}
                    onConfirm={() =>
                      void act(
                        () => api(`/campaigns/${c.id}/members/${m.id}`, { method: 'DELETE' }),
                        'Removed',
                      )
                    }
                  >
                    Remove
                  </ConfirmButton>
                )}
              </div>
            )}
          </div>
        ))}
        {c.pendingInvites.map((p) => (
          <div key={p.id}>
            <Avatar name={p.invitee.displayName} seed={p.invitee.id} />
            <div className="grow">
              <div className="truncate">{p.invitee.displayName}</div>
              <div className="small muted">Invited, not yet answered</div>
            </div>
          </div>
        ))}
      </div>

      {owner && (
        <>
          <div className="section-title">
            <span>Invite a friend</span>
          </div>
          {invitable.length > 0 ? (
            <div className="list">
              {invitable.map((f) => (
                <div key={f.friendshipId}>
                  <Avatar name={f.user.displayName} seed={f.user.id} />
                  <div className="grow truncate">{f.user.displayName}</div>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => api(`/campaigns/${c.id}/invites`, { body: { userId: f.user.id } }),
                        `Invitation sent to ${f.user.displayName}`,
                      )
                    }
                  >
                    Invite
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="small muted">
              Everyone on your friends list is already here. <Link to="/friends">Add a friend</Link> to invite
              someone new.
            </p>
          )}

          <div className="section-title">
            <span>Dungeon Master</span>
          </div>
          <div className="card dm-section">
            <div className="row">
              <b className="grow">{claude ? 'Claude' : 'Built-in AI'}</b>
            </div>
            {claude && <DmChip dm={status} />}
            {isHost && claude && onClaudeSetup && (
              <button type="button" className="btn block" onClick={onClaudeSetup}>
                Claude setup
              </button>
            )}
            {!isHost ? (
              <p className="small muted">
                {claude ? `Runs on ${host}’s Claude.` : `Runs on ${host}’s AI.`} Only {host} can change who
                runs the table.
              </p>
            ) : claude ? (
              meta?.builtInAi && (
                <ConfirmButton
                  className="btn ghost block"
                  confirmLabel="Claude stops running this table. Tap again"
                  disabled={busy}
                  onConfirm={() =>
                    void act(
                      () => api(`/campaigns/${c.id}`, { method: 'PATCH', body: { dm: 'server' } }),
                      'The built-in AI runs this campaign now',
                    )
                  }
                >
                  Switch to the built-in AI
                </ConfirmButton>
              )
            ) : (
              <ConfirmButton
                className="btn ghost block"
                confirmLabel="Turns will wait for your Claude app. Tap again"
                disabled={busy}
                onConfirm={() =>
                  void run(async () => {
                    await api(`/campaigns/${c.id}`, { method: 'PATCH', body: { dm: 'claude' } });
                    onChanged();
                    onClaudeSetup?.();
                  }, 'Claude runs this campaign now')
                }
              >
                Switch to Claude
              </ConfirmButton>
            )}
          </div>

          <div className="section-title">
            <span>Character sheet</span>
          </div>
          <SheetVersionCard campaign={c} onChanged={onChanged} />

          <div className="section-title">
            <span>Campaign</span>
          </div>
          <form className="stack" onSubmit={save}>
            <Field label="Name">
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                minLength={2}
                maxLength={80}
                required
              />
            </Field>
            <Field
              label="Premise"
              hint={prep ? 'Leave it empty and the DM will invent the story.' : undefined}
            >
              <textarea
                className="textarea"
                rows={4}
                value={premise}
                onChange={(e) => setPremise(e.target.value)}
                maxLength={2000}
              />
            </Field>
            <Field label="Tone">
              <input
                className="input"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                maxLength={300}
              />
            </Field>
            <Field
              label="Wait for other players"
              hint={
                windowSeconds === 0
                  ? 'After the first action, the DM waits until every player has tapped Done or passed, even players who are away. The owner can still tap Go now.'
                  : 'After the first action, the DM answers once everyone present has tapped Done or passed, or when this runs out.'
              }
            >
              <select
                className="select"
                value={windowSeconds}
                onChange={(e) => setWindowSeconds(Number(e.target.value))}
              >
                {!WINDOWS.some((w) => w.seconds === windowSeconds) && (
                  <option value={windowSeconds}>{windowSeconds} seconds</option>
                )}
                {WINDOWS.map((w) => (
                  <option key={w.seconds} value={w.seconds}>
                    {w.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Character sheets"
              hint={
                sheets === 'gm'
                  ? 'The DM updates sheets itself as characters level up and change.'
                  : 'The DM tracks hit points, conditions and inventory; players edit the rest.'
              }
            >
              <select
                className="select"
                value={sheets}
                onChange={(e) => setSheets(e.target.value as 'players' | 'gm')}
              >
                <option value="players">Players keep them</option>
                <option value="gm">The DM keeps them</option>
              </select>
            </Field>
            {canPolish && (
              <Field
                label="Polish the narration"
                hint={
                  polishWith
                    ? `The DM writes each scene, then ${polishWith} rewrites it for style before the table sees it. What players wrote is kept word for word.`
                    : 'The DM’s narration goes to the table as the DM writes it.'
                }
              >
                <select className="select" value={polishWith} onChange={(e) => setPolishWith(e.target.value)}>
                  <option value="">Off</option>
                  {!polishers.some((n) => n.toLowerCase() === polishWith.toLowerCase()) && polishWith && (
                    <option value={polishWith}>{polishWith} (no longer set up)</option>
                  )}
                  {polishers.map((n) => (
                    <option key={n} value={n}>
                      With {n}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <button type="submit" className="btn block" disabled={busy}>
              Save changes
            </button>
          </form>
        </>
      )}

      <div className="section-title">
        <span>Your view</span>
      </div>
      <div className="stack">
        <CampaignNotifyToggle campaignId={c.id} />
        {canHideAi && (
          <label className="card row view-toggle">
            <div className="grow">
              <b>Hide companion messages</b>
              <div className="small muted">
                Keeps AI companions off your screen. You still see player and DM messages. This is just for
                you.
              </div>
            </div>
            <input type="checkbox" checked={hideAi} onChange={(e) => onHideAi(e.target.checked)} />
          </label>
        )}
      </div>

      {!prep && (
        <>
          <div className="section-title">
            <span>Your wishes for the story</span>
          </div>
          <WishesEditor campaignId={c.id} saved={c.myWishes} inPlay onSaved={onChanged} />
        </>
      )}

      {!prep && (
        <>
          <div className="section-title">
            <span>Campaign documents</span>
          </div>
          <Documents campaignId={c.id} />
        </>
      )}

      <div className="section-title">
        <span>Model usage</span>
      </div>
      {claude ? (
        <p className="card small muted">
          Runs on {host}’s Claude plan. The server spends nothing on this campaign.
        </p>
      ) : (
        <dl className="kv card">
          <div className="kv-row">
            <dt>Last 24 hours</dt>
            <dd>
              {usage.data
                ? `${formatTokens(total(usage.data.day))} tokens · ${formatUsd(usage.data.day.costUsd)}`
                : '…'}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Last 30 days</dt>
            <dd>
              {usage.data
                ? `${formatTokens(total(usage.data.month))} tokens · ${formatUsd(usage.data.month.costUsd)}`
                : '…'}
            </dd>
          </div>
        </dl>
      )}

      <div className="section-title">
        <span>{owner ? 'Session and campaign' : 'Leave'}</span>
      </div>
      <div className="stack">
        {owner ? (
          <>
            {c.status === 'active' && !prep && !c.restingSince && (
              <>
                <ConfirmButton
                  className="btn block"
                  confirmLabel="Tap again to end the session"
                  disabled={busy || turnBusy}
                  onConfirm={() =>
                    void act(
                      () => api(`/campaigns/${c.id}/end-session`, { method: 'POST' }),
                      claude
                        ? 'Session ended. Claude will write the recap.'
                        : 'Session ended. The recap is being written.',
                    )
                  }
                >
                  End tonight&rsquo;s session
                </ConfirmButton>
                <p className="small faint">
                  Everyone goes to a recap of the story so far. The next session starts when every player has
                  readied up and you start it.
                </p>
              </>
            )}
            {c.status === 'active' && !prep && (
              <>
                <ConfirmButton
                  className="btn block"
                  confirmLabel="Tap again: everything in this session is deleted"
                  disabled={busy || turnBusy}
                  onConfirm={() =>
                    void act(
                      () => api(`/campaigns/${c.id}/restart-session`, { method: 'POST' }),
                      'The session starts over',
                    )
                  }
                >
                  Restart this session
                </ConfirmButton>
                <p className="small faint">
                  Deletes everything said in the latest session and puts the game back as it stood when it
                  began. To go back only part of the way, tap ⋯ on one of the DM&apos;s scenes and rewind to
                  it.
                </p>
              </>
            )}
            <button
              type="button"
              className="btn block"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    api(`/campaigns/${c.id}`, {
                      method: 'PATCH',
                      body: { status: c.status === 'active' ? 'archived' : 'active' },
                    }),
                  c.status === 'active' ? 'Campaign archived' : 'Campaign restored',
                )
              }
            >
              {c.status === 'active' ? 'Archive campaign' : 'Restore campaign'}
            </button>
            {isHost ? (
              <ConfirmButton
                className="btn danger block"
                confirmLabel="Tap again to delete everything"
                disabled={busy}
                onConfirm={() =>
                  void act(() => api(`/campaigns/${c.id}`, { method: 'DELETE' }), 'Campaign deleted', true)
                }
              >
                Delete campaign
              </ConfirmButton>
            ) : (
              <LeaveButton campaignId={c.id} meId={me.id} busy={busy} act={act} />
            )}
          </>
        ) : (
          <LeaveButton campaignId={c.id} meId={me.id} busy={busy} act={act} />
        )}
      </div>
    </Sheet>
  );
}

/** Leave the campaign: for anyone but the host, who deletes or archives it instead. */
function LeaveButton({
  campaignId,
  meId,
  busy,
  act,
}: {
  campaignId: string;
  meId: string;
  busy: boolean;
  act: (fn: () => Promise<unknown>, done?: string, leave?: boolean) => unknown;
}) {
  return (
    <ConfirmButton
      className="btn danger block"
      confirmLabel="Tap again to leave"
      disabled={busy}
      onConfirm={() =>
        void act(
          () => api(`/campaigns/${campaignId}/members/${meId}`, { method: 'DELETE' }),
          'You left the campaign',
          true,
        )
      }
    >
      Leave campaign
    </ConfirmButton>
  );
}
