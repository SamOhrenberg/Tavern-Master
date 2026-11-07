import type { GameSystem, RuleDocument, RuleHit } from '@tavern/protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useAction, useMe, useQuery, useToast } from '../app';
import { IconAlert, IconBook, IconChevron, IconPlus, IconSearch, IconTrash, IconUpload } from '../icons';
import { ConfirmButton, Empty, Field, PageHead, Sheet, Skeletons, ruleSource } from '../ui';

const DEFAULT_ABILITIES = 'Strength, Dexterity, Constitution, Intelligence, Wisdom, Charisma';

function useCanManage(): { admin: boolean; locked: boolean } {
  const me = useMe();
  return { admin: me.role === 'admin', locked: me.totpRequired };
}

function TwoFactorNotice() {
  return (
    <Link to="/you" className="banner">
      <IconAlert />
      <span className="grow">Turn on two-factor sign-in to add systems and upload rulebooks.</span>
      <IconChevron className="chev" />
    </Link>
  );
}

function NewSystem({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [abilities, setAbilities] = useState(DEFAULT_ABILITIES);
  const [busy, run] = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<{ id: string }>('/systems', {
        body: {
          name,
          description,
          abilities: abilities
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
        },
      });
      navigate(`/library/${res.id}`);
    }, 'System created');
  };

  return (
    <Sheet title="New game system" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Blades in the Dark"
            minLength={2}
            maxLength={80}
            required
          />
        </Field>
        <Field label="Description">
          <textarea
            className="textarea"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={600}
          />
        </Field>
        <Field
          label="Ability scores"
          hint="Comma separated. These become the boxes on every character sheet."
        >
          <input className="input" value={abilities} onChange={(e) => setAbilities(e.target.value)} />
        </Field>
        <button type="submit" className="btn primary block" disabled={busy}>
          Create system
        </button>
      </form>
    </Sheet>
  );
}

export function LibraryScreen() {
  const { admin, locked } = useCanManage();
  const systems = useQuery(() => api<{ systems: GameSystem[] }>('/systems'), []);
  const [creating, setCreating] = useState(false);
  const list = systems.data?.systems ?? [];

  return (
    <main className="page">
      <PageHead
        eyebrow="Rules library"
        title="Game systems"
        action={
          admin &&
          !locked && (
            <button
              type="button"
              className="icon-btn tinted"
              onClick={() => setCreating(true)}
              aria-label="New system"
            >
              <IconPlus />
            </button>
          )
        }
      />
      {admin && locked && <TwoFactorNotice />}

      {systems.loading ? (
        <Skeletons />
      ) : systems.error ? (
        <div className="form-error">{systems.error}</div>
      ) : list.length === 0 ? (
        <Empty icon={<IconBook />} title="The shelves are bare">
          {admin
            ? 'Create a game system, then upload its rulebooks.'
            : 'Whoever runs this server has not added any rules yet.'}
        </Empty>
      ) : (
        <div className="stack">
          {list.map((s) => (
            <Link key={s.id} to={`/library/${s.id}`} className="card tap">
              <div className="row">
                <span className="tome">
                  <IconBook />
                </span>
                <div className="grow">
                  <h2 className="truncate">{s.name}</h2>
                  <p className="small muted">
                    {s.documentCount} {s.documentCount === 1 ? 'book' : 'books'} ·{' '}
                    {s.chunkCount.toLocaleString()} passages
                  </p>
                </div>
                <IconChevron className="chev" />
              </div>
              {s.description && <p className="small muted system-desc">{s.description}</p>}
            </Link>
          ))}
        </div>
      )}
      <p className="small faint library-note">
        The Dungeon Master searches a campaign&rsquo;s own system for rulings, and cites the passage it used.
      </p>
      {creating && <NewSystem onClose={() => setCreating(false)} />}
    </main>
  );
}
