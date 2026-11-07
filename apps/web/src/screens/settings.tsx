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
