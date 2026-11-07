import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { useAction, useAuth, useMe, useToast } from '../app';
import { IconCheck, IconCopy } from '../icons';
import { Field, Sheet, copyText } from '../ui';

interface Setup {
  secret: string;
  uri: string;
  qr: string;
}

/**
 * Turn two-factor sign-in on or off. Setup shows a QR code for a second
 * device, and a link that opens the authenticator app when you are already
 * on your phone.
 */
export function TwoFactorSheet({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const { refresh } = useAuth();
  const notify = useToast();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [busy, run] = useAction();

  // Each setup call replaces the pending secret on the server, so ask exactly once.
  const asked = useRef(false);
  useEffect(() => {
    if (me.totpEnabled || asked.current) return;
    asked.current = true;
    void (async () => {
      try {
        const res = await api<{ secret: string; uri: string }>('/account/totp/setup', { method: 'POST' });
        const qr = await QRCode.toDataURL(res.uri, {
          margin: 1,
          width: 440,
          color: { dark: '#17120a', light: '#fbf1d8' },
        });
        setSetup({ ...res, qr });
      } catch (err) {
        notify(errorMessage(err), 'error');
      }
    })();
  }, [me.totpEnabled, notify]);

  const enable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<{ recoveryCodes: string[] }>('/account/totp/enable', {
        body: { code: code.replace(/\s+/g, '') },
      });
      setRecovery(res.recoveryCodes);
      await refresh();
    }, 'Two-factor sign-in is on');
  };

  const disable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/account/totp/disable', { body: { password } });
      await refresh();
      onClose();
    }, 'Two-factor sign-in is off');
  };

  const copy = async (text: string, label: string) => {
    notify((await copyText(text)) ? `${label} copied` : 'Could not copy. Select and copy it by hand.');
  };

  if (recovery) {
    return (
      <Sheet title="Save your recovery codes" onClose={onClose}>
        <div className="stack">
          <p className="small muted">
            Each code signs you in once if you lose your authenticator. They are not shown again, so keep them
            somewhere safe.
          </p>
          <div className="recovery">
            {recovery.map((c) => (
              <span key={c} className="mono">
                {c}
              </span>
            ))}
          </div>
          <button type="button" className="btn block" onClick={() => void copy(recovery.join('\n'), 'Codes')}>
            <IconCopy /> Copy codes
          </button>
          <button type="button" className="btn primary block" onClick={onClose}>
            <IconCheck /> I have saved them
          </button>
        </div>
      </Sheet>
    );
  }

  if (me.totpEnabled) {
    return (
      <Sheet title="Two-factor sign-in" onClose={onClose}>
        <form className="stack" onSubmit={disable}>
          <p className="small muted">
            Two-factor sign-in is on. Turning it off needs your password
            {me.role === 'admin' ? ', and locks admin tools until it is back on.' : '.'}
          </p>
          <Field label="Password">
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <button type="submit" className="btn danger block" disabled={busy}>
            Turn off two-factor
          </button>
        </form>
      </Sheet>
    );
  }

  return (
    <Sheet title="Two-factor sign-in" onClose={onClose}>
      <form className="stack" onSubmit={enable}>
        <p className="small muted">
          Scan this with an authenticator app (Passwords, 1Password, Authy, Google Authenticator), then enter
          the six-digit code it shows.
        </p>
        <div className="qr">
          {setup ? <img src={setup.qr} alt="Two-factor QR code" /> : <div className="spinner" />}
        </div>
        {setup && (
          <>
            <a className="btn block" href={setup.uri}>
              Open in authenticator app
            </a>
            <button
              type="button"
              className="code-box totp-secret"
              onClick={() => void copy(setup.secret, 'Secret')}
            >
              {setup.secret}
            </button>
          </>
        )}
        <Field label="Six-digit code">
          <input
            className="input mono code-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            maxLength={7}
            required
          />
        </Field>
        <button type="submit" className="btn primary block" disabled={busy || !setup}>
          Turn on two-factor
        </button>
      </form>
    </Sheet>
  );
}
