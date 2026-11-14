import type { ConnectRequest } from '@tavern/protocol';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useMe, useQuery } from '../app';
import { IconAlert, IconShield } from '../icons';
import { Avatar, Empty, Loading } from '../ui';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Where Claude sends you to approve a connection. Shown after signing in if
 * you were signed out, so the request survives that (and two-factor). The
 * client's name is text it chose for itself, so it is never the only thing
 * to go on: where you will be sent back to is always shown beside it.
 */
export function ConnectScreen() {
  const me = useMe();
  const [params] = useSearchParams();
  const error = params.get('error');
  const id = params.get('request');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const request = useQuery(
    () =>
      id
        ? api<{ request: ConnectRequest }>(`/oauth/requests/${encodeURIComponent(id)}`)
        : Promise.resolve(null),
    [id],
  );

  const answer = async (verb: 'approve' | 'deny') => {
    if (!id) return;
    setBusy(true);
    setFailed(null);
    try {
      const res = await api<{ redirect: string }>(`/oauth/requests/${encodeURIComponent(id)}/${verb}`, {
        method: 'POST',
      });
      window.location.assign(res.redirect);
    } catch (err) {
      setFailed(errorMessage(err));
      setBusy(false);
    }
  };

  const home = (
    <Link to="/" className="btn block">
      Back to your campaigns
    </Link>
  );

  if (error === 'bad_client' || error === 'bad_redirect' || !id) {
    return (
      <main className="page connect">
        <Empty icon={<IconAlert />} title="This connection request is not valid">
          Start again from Claude.
        </Empty>
        {home}
      </main>
    );
  }
  if (request.loading) {
    return (
      <main className="page connect">
        <Loading />
      </main>
    );
  }
  if (request.error || !request.data) {
    return (
      <main className="page connect">
        <Empty icon={<IconAlert />} title="This request cannot be approved">
          {request.error ?? 'This request has expired. Start again from Claude.'}
        </Empty>
        {home}
      </main>
    );
  }

  const r = request.data.request;
  const name = r.clientName.slice(0, 80) || 'An app';
  const local = LOOPBACK.has(r.redirectHost);
  return (
    <main className="page connect">
      <div className="card hero connect-card">
        <IconShield className="connect-icon" />
        <p className="eyebrow">Connection request</p>
        <h1 className="connect-title">Let {name} run your tables?</h1>
        <p className="connect-body">
          It will be able to act as Dungeon Master for{' '}
          {r.campaign ? (
            <>
              <b>{r.campaign.name}</b> only
            </>
          ) : (
            'every campaign you own'
          )}
          : read their state and history, narrate, roll dice and change characters and the world.
        </p>
        <p className="small muted">
          You will be sent back to <b>{r.redirectHost}</b>.{local && ' This is an app on this computer.'}
        </p>
        <div className="row connect-who">
          <Avatar name={me.displayName} seed={me.id} small />
          <span className="small muted grow truncate">Signed in as {me.displayName}</span>
        </div>
        {failed && <div className="form-error">{failed}</div>}
        <div className="stack tight">
          <button
            type="button"
            className="btn primary block"
            disabled={busy}
            onClick={() => void answer('approve')}
          >
            Approve
          </button>
          <button type="button" className="btn block" disabled={busy} onClick={() => void answer('deny')}>
            Deny
          </button>
        </div>
      </div>
    </main>
  );
}
