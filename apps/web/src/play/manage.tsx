import type { CampaignDetail, Friend, UsageTotals, UserRef } from '@tavern/protocol';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAction, useMe, useQuery } from '../app';
import { IconCrown } from '../icons';
import { Avatar, ConfirmButton, Field, Sheet, formatTokens, formatUsd } from '../ui';

const WINDOWS = [
  { seconds: 10, label: '10 seconds' },
  { seconds: 20, label: '20 seconds' },
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 300, label: '5 minutes' },
];

const total = (u: UsageTotals) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** The campaign menu: who is here, invitations, settings, and the ways out. */
export function ManageSheet({
  campaign: c,
  present,
  busy: turnBusy,
  onChanged,
  onClose,
}: {
  campaign: CampaignDetail;
  present: UserRef[];
  busy: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
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
        body: { name, premise, tone, gatherWindowSeconds: windowSeconds },
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
            <Field label="Premise">
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
              hint="After the first action, the DM answers once everyone present has acted or passed, or when this runs out."
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
            <button type="submit" className="btn block" disabled={busy}>
              Save changes
            </button>
          </form>
        </>
      )}

      <div className="section-title">
        <span>Model usage</span>
      </div>
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

      <div className="section-title">
        <span>{owner ? 'Session and campaign' : 'Leave'}</span>
      </div>
      <div className="stack">
        {owner ? (
          <>
            {c.status === 'active' && (
              <button
                type="button"
                className="btn block"
                disabled={busy || turnBusy}
                onClick={() =>
                  void act(
                    () => api(`/campaigns/${c.id}/end-session`, { method: 'POST' }),
                    'Session closed. The chronicle is being written.',
                  )
                }
              >
                End tonight&rsquo;s session
              </button>
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
