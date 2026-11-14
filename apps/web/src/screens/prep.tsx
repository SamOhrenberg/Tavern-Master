import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAction, useAuth, useMe, useToast } from '../app';
import { IconBack, IconBook, IconDots, IconPlus, IconSparkle, IconUsers } from '../icons';
import { CastPanels, runsIt, type CastPanel } from '../play/cast';
import { DmChip, dmLine } from '../play/claude';
import { Documents } from '../play/documents';
import { ManageSheet } from '../play/manage';
import { CharacterCard } from '../play/party';
import { useTable } from '../play/socket';
import { Avatar, ConfirmButton, Empty, Field, Segmented } from '../ui';
import type { TableProps } from './play';

/**
 * The lobby before a campaign begins. Everyone gets their character ready
 * (by hand, with the guide, or from an upload), the owner decides who plays
 * each party member, the table adds its documents and each player may tell
 * the DM what they hope the story holds. Then the owner begins.
 */
export function Prep({ id, campaign, state, template }: TableProps) {
  const me = useMe();
  const { setMe } = useAuth();
  const notify = useToast();
  const navigate = useNavigate();
  const c = campaign.data!.campaign;
  const game = state.data?.state;
  const owner = c.role === 'owner';

  const [cast, setCast] = useState<CastPanel>(null);
  const [managing, setManaging] = useState(false);
  const [wishes, setWishes] = useState(c.myWishes);
  const [busy, run] = useAction();

  const reloadState = state.reload;
  const reloadCampaign = campaign.reload;
  const reload = () => {
    void reloadState();
    void reloadCampaign();
  };
  // The live connection tells the lobby when the party changes and when play begins.
  const table = useTable(id, c.status === 'active', {
    onMessage: () => undefined,
    onRoll: () => undefined,
    onStateChanged: reload,
    onError: (text) => notify(text, 'error'),
    onReconnect: reload,
    onSignedOut: () => setMe(null),
  });
  useEffect(() => {
    if (table.link === 'denied') navigate('/', { replace: true });
  }, [table.link, navigate]);

  const characters = game?.characters ?? [];
  const mine = characters.filter((ch) => runsIt(ch, me.id));
  const without = c.members.filter((m) => !characters.some((ch) => runsIt(ch, m.id)));
  const host = c.members.find((m) => m.role === 'owner');
  const others = table.present.filter((u) => u.id !== me.id).length;
  const claude = c.dm === 'claude';
  const dm = table.dm ?? c.dmStatus;
  const people = others === 0 ? 'just you here' : `${others + 1} here`;

  const saveWishes = () =>
    run(async () => {
      await api(`/campaigns/${id}/wishes`, { method: 'PUT', body: { wishes } });
      await reloadCampaign();
    }, 'The DM will keep it in mind');

  const setSheets = (sheets: 'players' | 'gm') =>
    run(async () => {
      await api(`/campaigns/${id}`, { method: 'PATCH', body: { sheets } });
      await reloadCampaign();
    });

  const begin = () =>
    run(async () => {
      await api(`/campaigns/${id}/start`, { method: 'POST' });
      await reloadCampaign();
    });

  return (
    <div className="play prep">
      <header className="play-head">
        <button
          type="button"
          className="icon-btn"
          onClick={() => navigate('/')}
          aria-label="Back to campaigns"
        >
          <IconBack />
        </button>
        <div className="grow play-title">
          <h1 className="truncate">{c.name}</h1>
          <p className={`truncate play-sub${table.link === 'open' ? ' on' : ''}`}>
            <i />
            {table.link !== 'open'
              ? 'Joining the table…'
              : claude
                ? `${dmLine(dm)} · ${people}`
                : `Getting ready · ${people}`}
          </p>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setManaging(true)}
          aria-label="Campaign menu"
        >
          <IconDots />
        </button>
      </header>

      <div className="feed">
        <div className="feed-inner prep-body">
          <div className="card hero">
            <p className="small gold">Before the first scene</p>
            <p className="prep-lede">
              {c.premise ||
                'No premise yet. Leave it that way and the Dungeon Master will invent the story, or add one from the menu.'}
            </p>
            <div className="row wrap campaign-meta">
              <span className="pill gold">{c.systemName}</span>
              {c.settings.tone && <span className="pill">{c.settings.tone}</span>}
            </div>
          </div>

          {claude && (
            <div className="card dm-card">
              <div className="row">
                <h3 className="grow">Dungeon Master</h3>
              </div>
              <DmChip dm={dm} />
              {!owner && (
                <p className="small muted">
                  {host?.displayName ?? 'The host'} runs the Dungeon Master from Claude.
                </p>
              )}
            </div>
          )}

          <section>
            <div className="section-title with-icon">
              <span>
                <IconUsers />
                The party
              </span>
              {characters.length > 0 && <span>{characters.length}</span>}
            </div>
            <div className="stack">
              {!game ? null : characters.length === 0 ? (
                <Empty icon={<IconSparkle />} title="Nobody has a character yet">
                  {claude
                    ? 'Build one with Claude, fill in a sheet, or upload one you already have.'
                    : 'Build one with the guide, fill in a sheet, or upload one you already have.'}
                </Empty>
              ) : (
                characters.map((ch) => (
                  <CharacterCard
                    key={ch.id}
                    ch={ch}
                    campaign={c}
                    template={template}
                    meId={me.id}
                    present={table.present}
                    onOpen={setCast}
                  />
                ))
              )}
              {without
                .filter((m) => m.id !== me.id)
                .map((m) => (
                  <div key={m.id} className="card char pending">
                    <div className="row">
                      <Avatar name={m.displayName} seed={m.id} />
                      <div className="grow">
                        <h3 className="truncate">{m.displayName}</h3>
                        <p className="small muted">Has not made a character yet</p>
                      </div>
                    </div>
                  </div>
                ))}
              <button
                type="button"
                className={`btn block${mine.length === 0 ? ' primary' : ''}`}
                onClick={() => setCast({ kind: 'add' })}
              >
                <IconPlus /> {mine.length === 0 ? 'Create your character' : 'Add to the party'}
              </button>
              {owner && (
                <p className="small faint">
                  {claude
                    ? 'Add companions to fill out the party. A player can run one, or Claude will.'
                    : 'Add companions to fill out the party. Each one can be played by a player, by the Dungeon Master, or by an AI of its own that knows only what the character knows.'}
                </p>
              )}
            </div>
          </section>

          <section>
            <div className="section-title">
              <span>Your wishes for the story</span>
            </div>
            <div className="stack">
              <Field
                label="Optional"
                hint="Things you would love to see, and anything you would rather avoid. Only you and the DM read this. Leave it empty to be surprised."
              >
                <textarea
                  className="textarea"
                  rows={3}
                  value={wishes}
                  onChange={(e) => setWishes(e.target.value)}
                  placeholder="A heist. A rival who keeps turning up. No spiders."
                  maxLength={1200}
                />
              </Field>
              {wishes.trim() !== c.myWishes && (
                <button type="button" className="btn block" disabled={busy} onClick={() => void saveWishes()}>
                  Save for the DM
                </button>
              )}
            </div>
          </section>

          <section>
            <div className="section-title with-icon">
              <span>
                <IconBook />
                Campaign documents
              </span>
            </div>
            <Documents campaignId={id} />
          </section>

          {owner && (
            <section>
              <div className="section-title">
                <span>Character sheets</span>
              </div>
              <Segmented
                value={c.settings.sheets}
                onChange={(v) => void setSheets(v)}
                options={[
                  { value: 'players', label: 'Players keep them' },
                  { value: 'gm', label: 'The DM keeps them' },
                ]}
              />
              <p className="small faint under-field">
                {c.settings.sheets === 'gm'
                  ? 'The DM updates sheets itself as characters level up and change. You can still edit your own at any time.'
                  : 'The DM tracks hit points, conditions and inventory. Everything else on a sheet changes only when its player edits it.'}
              </p>
            </section>
          )}
        </div>
      </div>

      <footer className="play-foot">
        {owner ? (
          <div className="stack tight">
            <ConfirmButton
              className="btn primary block"
              confirmLabel={
                claude && dm.state === 'never'
                  ? 'Claude has not joined yet. Begin anyway? Tap again'
                  : characters.length === 0
                    ? 'Begin with no characters? Tap again'
                    : without.length > 0
                      ? `${without.length === 1 ? without[0]!.displayName + ' has' : without.length + ' players have'} no character. Tap again`
                      : 'Tap again to begin'
              }
              disabled={busy}
              onConfirm={() => void begin()}
            >
              Begin the adventure
            </ConfirmButton>
            <p className="small faint center">
              {claude
                ? 'Claude plans the story and writes the opening scene when it is at the table.'
                : 'The DM plans the story, then sets the opening scene.'}
            </p>
          </div>
        ) : (
          <p className="archived-note">
            {mine.length > 0 ? 'You are ready. ' : ''}
            Waiting for {host?.displayName ?? 'the host'} to begin.
          </p>
        )}
      </footer>

      <CastPanels
        panel={cast}
        setPanel={setCast}
        campaign={c}
        state={game}
        template={template}
        onChanged={reload}
      />
      {managing && (
        <ManageSheet
          campaign={c}
          present={table.present}
          busy={false}
          onChanged={() => void reloadCampaign()}
          onClose={() => setManaging(false)}
        />
      )}
    </div>
  );
}
