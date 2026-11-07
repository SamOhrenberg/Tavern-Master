import type { CampaignSummary, GameSystem } from '@tavern/protocol';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAction, useMe, useQuery } from '../app';
import { IconAlert, IconCampfire, IconChevron, IconCrown, IconPlus, IconUsers } from '../icons';
import { useInbox } from '../routes';
import { Avatar, Empty, Field, PageHead, Sheet, Skeletons } from '../ui';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Still awake';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function CampaignCard({ c }: { c: CampaignSummary }) {
  return (
    <Link to={`/c/${c.id}`} className={`card tap campaign${c.status === 'archived' ? ' archived' : ''}`}>
      <div className="row">
        <h2 className="grow truncate">{c.name}</h2>
        <IconChevron className="chev" />
      </div>
      {c.premise && <p className="campaign-premise">{c.premise}</p>}
      <div className="row wrap campaign-meta">
        <span className="pill gold">{c.systemName}</span>
        <span className="pill">
          <IconUsers className="pill-icon" />
          {c.memberCount}
        </span>
        {c.role === 'owner' && (
          <span className="pill arcane">
            <IconCrown className="pill-icon" />
            Yours
          </span>
        )}
        {c.status === 'archived' && <span className="pill">Archived</span>}
      </div>
    </Link>
  );
}

function NewCampaign({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const systems = useQuery(() => api<{ systems: GameSystem[] }>('/systems'), []);
  const [name, setName] = useState('');
  const [systemId, setSystemId] = useState('');
  const [premise, setPremise] = useState('');
  const [tone, setTone] = useState('');
  const [busy, run] = useAction();

  const list = systems.data?.systems ?? [];
  const chosen = systemId || list[0]?.id || '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<{ id: string }>('/campaigns', {
        body: { name, systemId: chosen, premise, tone },
      });
      navigate(`/c/${res.id}`);
    });
  };

  return (
    <Sheet title="New campaign" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="The Ashen Crown"
            minLength={2}
            maxLength={80}
            required
          />
        </Field>
        <Field label="Rules system" hint="The DM only looks rules up in this system's books.">
          <select className="select" value={chosen} onChange={(e) => setSystemId(e.target.value)} required>
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Premise" hint="A few lines to set the world and the opening. Optional.">
          <textarea
            className="textarea"
            rows={4}
            value={premise}
            onChange={(e) => setPremise(e.target.value)}
            placeholder="A border town on the edge of a drowned kingdom. Something is waking beneath the lake."
            maxLength={2000}
          />
        </Field>
        <Field label="Tone" hint="For example: grim and tense, or light-hearted with puns.">
          <input className="input" value={tone} onChange={(e) => setTone(e.target.value)} maxLength={300} />
        </Field>
        <button type="submit" className="btn primary block" disabled={busy || !chosen}>
          Begin the adventure
        </button>
      </form>
    </Sheet>
  );
}

export function CampaignsScreen() {
  const me = useMe();
  const inbox = useInbox();
  const navigate = useNavigate();
  const campaigns = useQuery(() => api<{ campaigns: CampaignSummary[] }>('/campaigns'), []);
  const [creating, setCreating] = useState(false);
  const [busy, run] = useAction();

  const all = campaigns.data?.campaigns ?? [];
  const active = all.filter((c) => c.status === 'active');
  const archived = all.filter((c) => c.status === 'archived');

  const respond = (id: string, accept: boolean) =>
    run(async () => {
      const res = await api<{ campaignId: string | null }>(`/campaign-invites/${id}/respond`, {
        body: { accept },
      });
      inbox.reload();
      if (res.campaignId) navigate(`/c/${res.campaignId}`);
    });

  return (
    <main className="page">
      <PageHead
        eyebrow={greeting()}
        title={me.displayName}
        action={
          <Link to="/you" aria-label="Your account">
            <Avatar name={me.displayName} seed={me.id} />
          </Link>
        }
      />

      {me.totpRequired && (
        <Link to="/you" className="banner">
          <IconAlert />
          <span className="grow">
            Finish securing this admin account: turn on two-factor sign-in to unlock invites and the rules
            library.
          </span>
          <IconChevron className="chev" />
        </Link>
      )}

      {inbox.invites.map((inv) => (
        <div key={inv.id} className="card hero invite-card">
          <p className="small gold">You have been invited</p>
          <h2>{inv.campaignName}</h2>
          <p className="small muted">{inv.inviter.displayName} saved you a seat at the table.</p>
          <div className="row">
            <button
              type="button"
              className="btn primary grow"
              disabled={busy}
              onClick={() => void respond(inv.id, true)}
            >
              Join
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void respond(inv.id, false)}>
              Decline
            </button>
          </div>
        </div>
      ))}

      <div className="section-title">
        <span>Campaigns</span>
      </div>
      {campaigns.loading ? (
        <Skeletons />
      ) : campaigns.error ? (
        <div className="form-error">{campaigns.error}</div>
      ) : active.length === 0 ? (
        <Empty icon={<IconCampfire />} title="The fire is lit, the table is empty">
          Start a campaign and invite a friend, or play solo. The Dungeon Master is ready when you are.
        </Empty>
      ) : (
        <div className="stack">
          {active.map((c) => (
            <CampaignCard key={c.id} c={c} />
          ))}
        </div>
      )}

      <button type="button" className="btn primary block new-campaign" onClick={() => setCreating(true)}>
        <IconPlus /> New campaign
      </button>

      {archived.length > 0 && (
        <>
          <div className="section-title">
            <span>Archived</span>
          </div>
          <div className="stack">
            {archived.map((c) => (
              <CampaignCard key={c.id} c={c} />
            ))}
          </div>
        </>
      )}

      {creating && <NewCampaign onClose={() => setCreating(false)} />}
    </main>
  );
}
