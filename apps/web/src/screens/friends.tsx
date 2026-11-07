import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAction, useMe, useToast } from '../app';
import { IconPlus, IconUsers } from '../icons';
import { useInbox } from '../routes';
import { Avatar, ConfirmButton, Empty, PageHead } from '../ui';

export function FriendsScreen() {
  const me = useMe();
  const inbox = useInbox();
  const notify = useToast();
  const [username, setUsername] = useState('');
  const [busy, run] = useAction();

  const incoming = inbox.friends.filter((f) => f.status === 'pending' && f.direction === 'incoming');
  const outgoing = inbox.friends.filter((f) => f.status === 'pending' && f.direction === 'outgoing');
  const accepted = inbox.friends.filter((f) => f.status === 'accepted');

  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim().replace(/^@/, '');
    if (!name) return;
    void run(async () => {
      const res = await api<{ accepted: boolean }>('/friends', { body: { username: name } });
      setUsername('');
      inbox.reload();
      // If they had already asked, sending a request back accepts theirs.
      notify(res.accepted ? 'You are now friends' : 'Friend request sent');
    });
  };

  const act = (fn: () => Promise<unknown>, done: string) =>
    run(async () => {
      await fn();
      inbox.reload();
    }, done);

  return (
    <main className="page">
      <PageHead eyebrow="Your party" title="Friends" />

      <form className="add-friend" onSubmit={add}>
        <input
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Add by username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          aria-label="Username to add"
        />
        <button
          type="submit"
          className="btn primary"
          disabled={busy || !username.trim()}
          aria-label="Send request"
        >
          <IconPlus />
        </button>
      </form>
      <p className="small faint under-field">
        Your username is <b className="mono">{me.username}</b>. Friends can be invited to your campaigns.
      </p>

      {incoming.length > 0 && (
        <>
          <div className="section-title">
            <span>Requests</span>
            <span>{incoming.length}</span>
          </div>
          <div className="list">
            {incoming.map((f) => (
              <div key={f.friendshipId}>
                <Avatar name={f.user.displayName} seed={f.user.id} />
                <div className="grow">
                  <div className="truncate">{f.user.displayName}</div>
                  <div className="small muted truncate">@{f.user.username}</div>
                </div>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api(`/friends/${f.friendshipId}/accept`, { method: 'POST' }),
                      `You and ${f.user.displayName} are now friends`,
                    )
                  }
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api(`/friends/${f.friendshipId}`, { method: 'DELETE' }),
                      'Request declined',
                    )
                  }
                >
                  Decline
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">
        <span>Friends</span>
        {accepted.length > 0 && <span>{accepted.length}</span>}
      </div>
      {accepted.length === 0 ? (
        <Empty icon={<IconUsers />} title="No companions yet">
          Add a friend by their username. Once they accept, you can invite them into a campaign.
        </Empty>
      ) : (
        <div className="list">
          {accepted.map((f) => (
            <div key={f.friendshipId}>
              <Avatar name={f.user.displayName} seed={f.user.id} />
              <div className="grow">
                <div className="truncate">{f.user.displayName}</div>
                <div className="small muted truncate">@{f.user.username}</div>
              </div>
              <ConfirmButton
                className="btn sm ghost"
                confirmLabel="Remove?"
                disabled={busy}
                onConfirm={() =>
                  void act(() => api(`/friends/${f.friendshipId}`, { method: 'DELETE' }), 'Friend removed')
                }
              >
                Remove
              </ConfirmButton>
            </div>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <>
          <div className="section-title">
            <span>Sent</span>
          </div>
          <div className="list">
            {outgoing.map((f) => (
              <div key={f.friendshipId}>
                <Avatar name={f.user.displayName} seed={f.user.id} />
                <div className="grow">
                  <div className="truncate">{f.user.displayName}</div>
                  <div className="small muted">Waiting for an answer</div>
                </div>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api(`/friends/${f.friendshipId}`, { method: 'DELETE' }),
                      'Request cancelled',
                    )
                  }
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
