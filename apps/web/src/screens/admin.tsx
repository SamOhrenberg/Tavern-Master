import type { Role, UsageReport, UsageTotals } from '@tavern/protocol';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAction, useMe, useQuery, useToast } from '../app';
import { IconAlert, IconChevron, IconCopy, IconPlus, IconShareIos } from '../icons';
import {
  Avatar,
  ConfirmButton,
  Empty,
  Field,
  PageHead,
  Segmented,
  Sheet,
  Skeletons,
  copyText,
  formatTokens,
  formatUsd,
  timeAgo,
} from '../ui';

type Tab = 'invites' | 'players' | 'usage' | 'audit';

interface Invite {
  id: string;
  hint: string;
  role: Role;
  note: string;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  revoked: boolean;
}

interface Player {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
  totpEnabled: boolean;
  dailyTokenBudget: number | null;
  lastLoginAt: string | null;
}

interface AuditEntry {
  id: number;
  at: string;
  action: string;
  actor: string | null;
  ip: string | null;
}

const total = (u: UsageTotals) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

function NewInvite({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const notify = useToast();
  const [note, setNote] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [maxUses, setMaxUses] = useState('1');
  const [code, setCode] = useState<string | null>(null);
  const [busy, run] = useAction();
  const link = code ? `${window.location.origin}/join?code=${encodeURIComponent(code)}` : '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<{ code: string }>('/admin/invites', {
        body: { note, role, maxUses: Math.max(1, Math.min(50, Number.parseInt(maxUses, 10) || 1)) },
      });
      setCode(res.code);
      onCreated();
    });
  };

  const share = async () => {
    const data = { title: 'Tavern Master', text: 'Join my table on Tavern Master', url: link };
    if (navigator.share) {
      await navigator.share(data).catch(() => undefined);
    } else {
      notify((await copyText(link)) ? 'Invite link copied' : 'Could not copy the link');
    }
  };

  if (code) {
    return (
      <Sheet title="Invite ready" onClose={onClose}>
        <div className="stack">
          <p className="small muted">
            Send this to your friend. The code is shown only once and works{' '}
            {maxUses === '1' ? 'once' : `${maxUses} times`}.
          </p>
          <div className="code-box">{code}</div>
          <button type="button" className="btn primary block" onClick={() => void share()}>
            <IconShareIos /> Share invite link
          </button>
          <button
            type="button"
            className="btn block"
            onClick={() => void copyText(code).then((ok) => notify(ok ? 'Code copied' : 'Could not copy'))}
          >
            <IconCopy /> Copy code
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="New invite" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Who is it for?" hint="A note for yourself. Optional.">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} />
        </Field>
        <div className="row top">
          <Field label="Role">
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="user">Player</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <Field label="Uses">
            <input
              className="input"
              inputMode="numeric"
              pattern="[0-9]*"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
            />
          </Field>
        </div>
        <p className="small faint">Invites expire after 14 days.</p>
        <button type="submit" className="btn primary block" disabled={busy}>
          Create invite
        </button>
      </form>
    </Sheet>
  );
}

function Invites() {
  const invites = useQuery(() => api<{ invites: Invite[] }>('/admin/invites'), []);
  const [creating, setCreating] = useState(false);
  const [busy, run] = useAction();
  const list = invites.data?.invites ?? [];
  const state = (i: Invite) =>
    i.revoked
      ? 'Revoked'
      : i.uses >= i.maxUses
        ? 'Used'
        : i.expiresAt && new Date(i.expiresAt).getTime() < Date.now()
          ? 'Expired'
          : null;

  return (
    <>
      <button type="button" className="btn primary block" onClick={() => setCreating(true)}>
        <IconPlus /> New invite
      </button>
      {invites.loading ? (
        <Skeletons count={2} />
      ) : (
        list.length > 0 && (
          <div className="list spaced">
            {list.map((i) => {
              const spent = state(i);
              return (
                <div key={i.id} className={spent ? 'spent' : ''}>
                  <div className="grow">
                    <div className="truncate">
                      <span className="mono">{i.hint}…</span>{' '}
                      {i.note && <span className="muted">· {i.note}</span>}
                    </div>
                    <div className="small muted">
                      {spent ?? `${i.uses}/${i.maxUses} used`}
                      {i.role === 'admin' ? ' · admin' : ''}
                    </div>
                  </div>
                  {!spent && (
                    <ConfirmButton
                      className="btn sm ghost"
                      confirmLabel="Revoke?"
                      disabled={busy}
                      onConfirm={() =>
                        void run(async () => {
                          await api(`/admin/invites/${i.id}`, { method: 'DELETE' });
                          await invites.reload();
                        }, 'Invite revoked')
                      }
                    >
                      Revoke
                    </ConfirmButton>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
      {creating && <NewInvite onClose={() => setCreating(false)} onCreated={() => void invites.reload()} />}
    </>
  );
}
