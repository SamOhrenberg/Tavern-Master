import type { Me, UsageTotals } from '@tavern/protocol';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { useAction, useAuth, useMe, useQuery } from '../app';
import {
  IconAlert,
  IconChevron,
  IconClock,
  IconKey,
  IconLogout,
  IconPhone,
  IconShield,
  IconSparkle,
  IconUsers,
} from '../icons';
import { isStandalone, openInstallGuide } from '../install';
import { Avatar, ConfirmButton, Field, PageHead, Sheet, formatTokens, formatUsd, timeAgo } from '../ui';
import { TwoFactorSheet } from './twofactor';

type Panel = 'profile' | 'password' | 'twofactor' | 'devices' | 'apikey' | null;

function Row({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick}>
      <span className="row-icon">{icon}</span>
      <span className="grow">
        <span className="truncate row-title">{title}</span>
        {detail && <span className="small muted truncate row-detail">{detail}</span>}
      </span>
      <IconChevron className="chev" />
    </button>
  );
}

function ProfileSheet({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const { setMe } = useAuth();
  const [displayName, setDisplayName] = useState(me.displayName);
  const [email, setEmail] = useState(me.email ?? '');
  const [busy, run] = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<{ user: Me }>('/account/profile', {
        method: 'PATCH',
        body: { displayName, email },
      });
      setMe(res.user);
      onClose();
    }, 'Profile saved');
  };
  return (
    <Sheet title="Profile" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Display name" hint="What the table calls you.">
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={40}
            required
          />
        </Field>
        <Field label="Email" hint="Optional. Only the server admin can see it.">
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoCapitalize="none"
          />
        </Field>
        <button type="submit" className="btn primary block" disabled={busy}>
          Save
        </button>
      </form>
    </Sheet>
  );
}

function PasswordSheet({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [busy, run] = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/account/password', { body: { currentPassword, newPassword } });
      onClose();
    }, 'Password changed. Other devices were signed out.');
  };
  return (
    <Sheet title="Change password" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {/* Lets a password manager attach the new password to the right account. */}
        <input
          type="text"
          className="sr-only"
          autoComplete="username"
          value={me.username}
          readOnly
          tabIndex={-1}
        />
        <Field label="Current password">
          <input
            className="input"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Field label="New password" hint="At least 10 characters.">
          <input
            className="input"
            type="password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            autoComplete="new-password"
            minLength={10}
            required
          />
        </Field>
        <button type="submit" className="btn primary block" disabled={busy}>
          Change password
        </button>
      </form>
    </Sheet>
  );
}

interface Device {
  id: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

function deviceName(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows PC'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /CriOS|Chrome\//.test(ua)
      ? 'Chrome'
      : /FxiOS|Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return browser ? `${device} · ${browser}` : device;
}

function DevicesSheet({ onClose }: { onClose: () => void }) {
  const sessions = useQuery(() => api<{ sessions: Device[] }>('/account/sessions'), []);
  const [busy, run] = useAction();
  return (
    <Sheet title="Signed-in devices" onClose={onClose}>
      <div className="list">
        {(sessions.data?.sessions ?? []).map((s) => (
          <div key={s.id}>
            <span className="row-icon">
              <IconPhone />
            </span>
            <div className="grow">
              <div className="truncate">{deviceName(s.userAgent)}</div>
              <div className="small muted truncate">
                {s.current ? 'This device' : `Active ${timeAgo(s.lastSeenAt)}`}
                {s.ip ? ` · ${s.ip}` : ''}
              </div>
            </div>
            {!s.current && (
              <button
                type="button"
                className="btn sm danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/account/sessions/${s.id}`, { method: 'DELETE' });
                    await sessions.reload();
                  }, 'Signed out')
                }
              >
                Sign out
              </button>
            )}
          </div>
        ))}
      </div>
    </Sheet>
  );
}

interface StoredKey {
  provider: 'anthropic' | 'openai' | 'openrouter';
  hint: string;
  modelNarration: string | null;
  modelUtility: string | null;
}

function ApiKeySheet({ onClose }: { onClose: () => void }) {
  const stored = useQuery(() => api<{ apiKey: StoredKey | null }>('/account/api-key'), []);
  const [provider, setProvider] = useState<StoredKey['provider']>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [modelNarration, setNarration] = useState('');
  const [modelUtility, setUtility] = useState('');
  const [busy, run] = useAction();
  const current = stored.data?.apiKey;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/account/api-key', {
        method: 'PUT',
        body: {
          provider,
          apiKey,
          ...(modelNarration.trim() ? { modelNarration: modelNarration.trim() } : {}),
          ...(modelUtility.trim() ? { modelUtility: modelUtility.trim() } : {}),
        },
      });
      setApiKey('');
      await stored.reload();
    }, 'Key saved');
  };

  return (
    <Sheet title="Your own API key" onClose={onClose}>
      <div className="stack">
        <p className="small muted">
          Campaigns you host will use this key instead of the server&rsquo;s. It is stored encrypted and never
          shown again.
        </p>
        {current && (
          <div className="card row">
            <div className="grow">
              <div>
                {current.provider} <span className="mono muted">{current.hint}</span>
              </div>
              {current.modelNarration && <div className="small muted truncate">{current.modelNarration}</div>}
            </div>
            <ConfirmButton
              className="btn sm danger"
              confirmLabel="Remove?"
              disabled={busy}
              onConfirm={() =>
                void run(async () => {
                  await api('/account/api-key', { method: 'DELETE' });
                  await stored.reload();
                }, 'Key removed')
              }
            >
              Remove
            </ConfirmButton>
          </div>
        )}
        <form className="stack" onSubmit={submit}>
          <Field label="Provider">
            <select
              className="select"
              value={provider}
              onChange={(e) => setProvider(e.target.value as StoredKey['provider'])}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </Field>
          <Field label="API key">
            <input
              className="input mono"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              minLength={16}
              required
            />
          </Field>
          <Field
            label="Narration model"
            hint={
              provider === 'anthropic'
                ? 'Leave blank to use the server default.'
                : 'Required for this provider.'
            }
          >
            <input
              className="input mono"
              value={modelNarration}
              onChange={(e) => setNarration(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required={provider !== 'anthropic'}
            />
          </Field>
          <Field label="Utility model" hint="Used for summaries and memory.">
            <input
              className="input mono"
              value={modelUtility}
              onChange={(e) => setUtility(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required={provider !== 'anthropic'}
            />
          </Field>
          <button type="submit" className="btn primary block" disabled={busy}>
            {current ? 'Replace key' : 'Save key'}
          </button>
        </form>
      </div>
    </Sheet>
  );
}

const total = (u: UsageTotals) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

export function SettingsScreen() {
  const me = useMe();
  const { logout } = useAuth();
  const usage = useQuery(() => api<{ day: UsageTotals; month: UsageTotals }>('/account/usage'), []);
  const [panel, setPanel] = useState<Panel>(null);
  const close = () => setPanel(null);

  return (
    <main className="page">
      <PageHead eyebrow="Your seat" title="You" />

      <button type="button" className="card tap profile" onClick={() => setPanel('profile')}>
        <Avatar name={me.displayName} seed={me.id} />
        <span className="grow">
          <span className="profile-name truncate">{me.displayName}</span>
          <span className="small muted truncate">@{me.username}</span>
        </span>
        {me.role === 'admin' && <span className="pill arcane">Admin</span>}
        <IconChevron className="chev" />
      </button>

      {me.totpRequired && (
        <button type="button" className="banner" onClick={() => setPanel('twofactor')}>
          <IconAlert />
          <span className="grow">
            Admin tools stay locked until two-factor sign-in is on. It takes about a minute.
          </span>
          <IconChevron className="chev" />
        </button>
      )}

      <div className="section-title">
        <span>Security</span>
      </div>
      <div className="list">
        <Row
          icon={<IconShield />}
          title="Two-factor sign-in"
          detail={me.totpEnabled ? 'On' : 'Off'}
          onClick={() => setPanel('twofactor')}
        />
        <Row icon={<IconKey />} title="Password" onClick={() => setPanel('password')} />
        <Row icon={<IconUsers />} title="Signed-in devices" onClick={() => setPanel('devices')} />
      </div>

      <div className="section-title">
        <span>Dungeon Master</span>
      </div>
      <div className="list">
        <Row
          icon={<IconSparkle />}
          title="Your own API key"
          detail="Optional. Pays for campaigns you host."
          onClick={() => setPanel('apikey')}
        />
        <div>
          <span className="row-icon">
            <IconClock />
          </span>
          <span className="grow">
            <span className="row-title">Your usage</span>
            <span className="small muted row-detail">
              {usage.data
                ? `${formatTokens(total(usage.data.day))} tokens today (${formatUsd(usage.data.day.costUsd)}) · ${formatTokens(total(usage.data.month))} in 30 days (${formatUsd(usage.data.month.costUsd)})`
                : 'Loading…'}
            </span>
          </span>
        </div>
      </div>

      {!isStandalone() && (
        <>
          <div className="section-title">
            <span>App</span>
          </div>
          <div className="list">
            <Row
              icon={<IconPhone />}
              title="Add to Home Screen"
              detail="Full screen, one tap from your phone"
              onClick={openInstallGuide}
            />
          </div>
        </>
      )}

      <button type="button" className="btn block signout" onClick={() => void logout()}>
        <IconLogout /> Sign out
      </button>
      <p className="small faint center about">Tavern Master · self-hosted</p>

      {panel === 'profile' && <ProfileSheet onClose={close} />}
      {panel === 'password' && <PasswordSheet onClose={close} />}
      {panel === 'twofactor' && <TwoFactorSheet onClose={close} />}
      {panel === 'devices' && <DevicesSheet onClose={close} />}
      {panel === 'apikey' && <ApiKeySheet onClose={close} />}
    </main>
  );
}
