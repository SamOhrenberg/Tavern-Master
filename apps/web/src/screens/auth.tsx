import type { Me } from '@tavern/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiFailure, api, errorMessage } from '../api';
import { useAuth } from '../app';
import { Field, Segmented } from '../ui';

type Mode = 'login' | 'register';

/** Sign in, or join with an invite code. A link like /join?code=… opens on the join tab. */
export function AuthScreen() {
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const linkCode = params.get('code') ?? '';
  const [mode, setMode] = useState<Mode>(
    linkCode || window.location.pathname === '/join' ? 'register' : 'login',
  );
  const [open, setOpen] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState(linkCode);
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ openRegistration: boolean }>('/public-config')
      .then((c) => setOpen(c.openRegistration))
      .catch(() => undefined);
  }, []);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setNeedCode(false);
    setCode('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body =
        mode === 'login'
          ? { username, password, ...(needCode && code ? { code } : {}) }
          : {
              username,
              password,
              ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
              ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
            };
      const res = await api<{ user: Me | null }>(`/auth/${mode}`, { body, quiet401: true });
      // Leave /join behind so a refresh does not land on the form again.
      navigate('/', { replace: true });
      setMe(res.user);
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'totp_required') {
        setNeedCode(true);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <div className="auth-brand">
        <span className="auth-halo" />
        <img src="/icons/icon-192.png" width={88} height={88} alt="" />
        <h1>Tavern Master</h1>
        <p className="muted">Your table, your rules, a Dungeon Master who never tires.</p>
      </div>

      <form className="auth-card stack" onSubmit={submit}>
        <Segmented
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'login', label: 'Sign in' },
            { value: 'register', label: 'Join with invite' },
          ]}
        />

        {mode === 'register' && (
          <Field
            label="Invite code"
            hint={open ? 'Optional on this server.' : 'Ask whoever runs this server for one.'}
          >
            <input
              className="input mono"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required={!open}
            />
          </Field>
        )}

        <Field label="Username">
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </Field>

        {mode === 'register' && (
          <Field label="Display name" hint="What the table calls you.">
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
              maxLength={40}
            />
          </Field>
        )}

        <Field label="Password" hint={mode === 'register' ? 'At least 10 characters.' : undefined}>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'register' ? 10 : undefined}
            required
          />
        </Field>

        {mode === 'login' && needCode && (
          <Field label="Two-factor code" hint="From your authenticator app, or a recovery code.">
            <input
              className="input mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
            />
          </Field>
        )}

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        <button type="submit" className="btn primary block" disabled={busy}>
          {busy ? 'One moment…' : mode === 'login' ? 'Enter the tavern' : 'Create my account'}
        </button>
      </form>
    </main>
  );
}
