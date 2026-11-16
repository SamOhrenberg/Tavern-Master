import type { CampaignDetail, DmStatus, Friend, UsageTotals, UserRef } from '@tavern/protocol';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAction, useMe, useMeta, useQuery } from '../app';
import { IconCrown } from '../icons';
import { Avatar, ConfirmButton, Field, Sheet, formatTokens, formatUsd } from '../ui';
import { DmChip } from './claude';
import { Documents } from './documents';
import { WishesEditor } from './wishes';

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
  const claude = c.dm === 'claude';
  const status = dmStatus ?? c.dmStatus;
  const host = c.members.find((m) => m.role === 'owner')?.displayName ?? 'the host';
  const me = useMe();
  const navigate = useNavigate();
  const owner = c.role === 'owner';
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
        body: { name, premise, tone, gatherWindowSeconds: windowSeconds, sheets },
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
        <span>At the table</span>
        <span>{c.members.length}</span>
      </div>
      <div className="list">
        {c.members.map((m) => (
          <div key={m.id}>
            <Avatar name={m.characterName ?? m.displayName} seed={m.id} />
            <div className="grow">
              <div className="truncate">
                {m.displayName}
                {m.id === me.id && <span className="faint"> (you)</span>}
              </div>
              <div className="small muted truncate">
                {present.some((u) => u.id === m.id) && <i className="here" />}
                {m.characterName ?? 'No character yet'}
              </div>
            </div>
            {m.role === 'owner' ? (
              <span className="pill arcane">
                <IconCrown className="pill-icon" />
                Host
              </span>
            ) : (
              owner && (
                <ConfirmButton
                  className="btn sm danger"
                  confirmLabel="Remove?"
                  disabled={busy}
                  onConfirm={() =>
                    void act(() => api(`/campaigns/${c.id}/members/${m.id}`, { method: 'DELETE' }), 'Removed')
                  }
                >
                  Remove
                </ConfirmButton>
              )
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
            {claude && onClaudeSetup && (
              <button type="button" className="btn block" onClick={onClaudeSetup}>
                Claude setup
              </button>
            )}
            {claude ? (
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
                  ? 'After the first action, the DM waits until everyone present has tapped Done or passed. The owner can still tap Go now.'
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
            <button type="submit" className="btn block" disabled={busy}>
              Save changes
            </button>
          </form>
        </>
      )}

      {canHideAi && (
        <>
          <div className="section-title">
            <span>Your view</span>
          </div>
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
        </>
      )}

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
          </>
        ) : (
          <ConfirmButton
            className="btn danger block"
            confirmLabel="Tap again to leave"
            disabled={busy}
            onConfirm={() =>
              void act(
                () => api(`/campaigns/${c.id}/members/${me.id}`, { method: 'DELETE' }),
                'You left the campaign',
                true,
              )
            }
          >
            Leave campaign
          </ConfirmButton>
        )}
      </div>
    </Sheet>
  );
}
