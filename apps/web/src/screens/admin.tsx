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

function PlayerSheet({
  player,
  onClose,
  onChanged,
}: {
  player: Player;
  onClose: () => void;
  onChanged: () => void;
}) {
  const me = useMe();
  const [budget, setBudget] = useState(
    player.dailyTokenBudget === null ? '' : String(player.dailyTokenBudget),
  );
  const [busy, run] = useAction();
  const self = player.id === me.id;
  const patch = (body: Record<string, unknown>, done: string) =>
    run(async () => {
      await api(`/admin/users/${player.id}`, { method: 'PATCH', body });
      onChanged();
      onClose();
    }, done);

  return (
    <Sheet title={player.displayName} onClose={onClose}>
      <div className="stack">
        <dl className="kv card">
          <div className="kv-row">
            <dt>Username</dt>
            <dd className="mono">{player.username}</dd>
          </div>
          <div className="kv-row">
            <dt>Last sign-in</dt>
            <dd>{timeAgo(player.lastLoginAt)}</dd>
          </div>
          <div className="kv-row">
            <dt>Two-factor</dt>
            <dd>{player.totpEnabled ? 'On' : 'Off'}</dd>
          </div>
        </dl>
        <Field label="Daily token budget" hint="Blank uses the server default. 0 means unlimited.">
          <input
            className="input"
            inputMode="numeric"
            pattern="[0-9]*"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="Server default"
          />
        </Field>
        <button
          type="button"
          className="btn block"
          disabled={busy}
          onClick={() =>
            void patch(
              { dailyTokenBudget: budget.trim() === '' ? null : Number.parseInt(budget, 10) || 0 },
              'Budget saved',
            )
          }
        >
          Save budget
        </button>
        {!self && (
          <>
            <button
              type="button"
              className="btn block"
              disabled={busy}
              onClick={() =>
                void patch(
                  { role: player.role === 'admin' ? 'user' : 'admin' },
                  player.role === 'admin' ? 'Now a player' : 'Now an admin',
                )
              }
            >
              {player.role === 'admin' ? 'Make a regular player' : 'Make an admin'}
            </button>
            <ConfirmButton
              className="btn danger block"
              confirmLabel={player.status === 'active' ? 'Tap again to disable' : 'Tap again to restore'}
              disabled={busy}
              onConfirm={() =>
                void patch(
                  { status: player.status === 'active' ? 'disabled' : 'active' },
                  player.status === 'active' ? 'Account disabled and signed out' : 'Account restored',
                )
              }
            >
              {player.status === 'active' ? 'Disable account' : 'Restore account'}
            </ConfirmButton>
          </>
        )}
      </div>
    </Sheet>
  );
}

function Players() {
  const users = useQuery(() => api<{ users: Player[] }>('/admin/users'), []);
  const [open, setOpen] = useState<Player | null>(null);
  if (users.loading) return <Skeletons />;
  return (
    <>
      <div className="list">
        {(users.data?.users ?? []).map((u) => (
          <button key={u.id} type="button" onClick={() => setOpen(u)}>
            <Avatar name={u.displayName} seed={u.id} />
            <span className="grow">
              <span className="truncate row-title">{u.displayName}</span>
              <span className="small muted truncate row-detail">
                @{u.username} · seen {timeAgo(u.lastLoginAt)}
              </span>
            </span>
            {u.status === 'disabled' ? (
              <span className="pill ember">Disabled</span>
            ) : (
              u.role === 'admin' && <span className="pill arcane">Admin</span>
            )}
            <IconChevron className="chev" />
          </button>
        ))}
      </div>
      {open && (
        <PlayerSheet player={open} onClose={() => setOpen(null)} onChanged={() => void users.reload()} />
      )}
    </>
  );
}

function Usage() {
  const [span, setSpan] = useState<'24h' | '30d'>('24h');
  const report = useQuery(() => api<UsageReport>(`/admin/usage?window=${span}`), [span]);
  const rows = (items: { key: string; name: string; totals: UsageTotals }[]) =>
    items.length === 0 ? (
      <p className="small muted">Nothing in this window.</p>
    ) : (
      <dl className="kv card">
        {items.map((r) => (
          <div key={r.key} className="kv-row">
            <dt className="truncate">{r.name}</dt>
            <dd>
              {formatTokens(total(r.totals))} · {formatUsd(r.totals.costUsd)}
            </dd>
          </div>
        ))}
      </dl>
    );
  return (
    <>
      <Segmented
        value={span}
        onChange={setSpan}
        options={[
          { value: '24h', label: 'Last 24 hours' },
          { value: '30d', label: 'Last 30 days' },
        ]}
      />
      <div className="section-title">
        <span>By player</span>
      </div>
      {report.data ? (
        rows(report.data.byUser.map((r) => ({ key: r.user.id, name: r.user.displayName, totals: r })))
      ) : (
        <Skeletons count={1} />
      )}
      <div className="section-title">
        <span>By campaign</span>
      </div>
      {report.data ? (
        rows(report.data.byCampaign.map((r) => ({ key: r.campaignId, name: r.name, totals: r })))
      ) : (
        <Skeletons count={1} />
      )}
      <p className="small faint cost-note">Costs are estimates from the price table, not a bill.</p>
    </>
  );
}

function Audit() {
  const log = useQuery(() => api<{ entries: AuditEntry[] }>('/admin/audit'), []);
  if (log.loading) return <Skeletons />;
  const entries = log.data?.entries ?? [];
  if (!entries.length) return <Empty icon={<IconAlert />} title="Nothing logged yet" />;
  return (
    <ul className="timeline">
      {entries.map((e) => (
        <li key={e.id}>
          <span>
            <b className="mono">{e.action}</b>
            {e.actor && <span className="muted"> · {e.actor}</span>}
          </span>
          <time>{timeAgo(e.at)}</time>
        </li>
      ))}
    </ul>
  );
}

export function AdminScreen() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('invites');

  return (
    <main className="page">
      <PageHead eyebrow="Server" title="Admin" />
      {me.totpRequired ? (
        <>
          <Link to="/you" className="banner">
            <IconAlert />
            <span className="grow">Turn on two-factor sign-in to use admin tools.</span>
            <IconChevron className="chev" />
          </Link>
          <p className="small muted locked-note">
            Admin accounts can invite people and change the rules library, so they need a second factor before
            those tools unlock.
          </p>
        </>
      ) : (
        <>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'invites', label: 'Invites' },
              { value: 'players', label: 'Players' },
              { value: 'usage', label: 'Usage' },
              { value: 'audit', label: 'Audit' },
            ]}
          />
          <div className="admin-body">
            {tab === 'invites' && <Invites />}
            {tab === 'players' && <Players />}
            {tab === 'usage' && <Usage />}
            {tab === 'audit' && <Audit />}
          </div>
        </>
      )}
    </main>
  );
}
