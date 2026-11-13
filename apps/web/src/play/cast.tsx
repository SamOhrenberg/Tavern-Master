import type {
  CampaignDetail,
  Character,
  CharacterController,
  CharacterDraft,
  CharacterKind,
  GameState,
  SheetTemplate,
} from '@tavern/protocol';
import { useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { useAction, useMe, useToast } from '../app';
import { IconChat, IconCheck, IconChevron, IconD20, IconScroll, IconSparkle, IconUpload } from '../icons';
import { Avatar, Field, Segmented, Sheet } from '../ui';
import { CharacterSheet, type Control } from './character';
import { GuideSheet } from './guide';

/** Which of the party sheets is open. Shared by the lobby and the play screen. */
export type CastPanel =
  | { kind: 'add' }
  | { kind: 'edit'; character?: Character; draft?: CharacterDraft; control?: Control }
  | { kind: 'guide'; characterId?: string; control?: Control }
  | { kind: 'control'; character: Character }
  | null;

/** Mirrors the server's rule; the server is what enforces it. */
export function canEdit(c: Character, meId: string, owner: boolean): boolean {
  if (c.controller === 'player' && c.playerIds.includes(meId)) return true;
  return owner && (c.controller !== 'player' || c.playerIds.length === 0);
}

export const runsIt = (c: Character, meId: string) => c.controller === 'player' && c.playerIds.includes(meId);

/** "Played by …" in a few words. */
export function playedBy(c: Character, campaign: CampaignDetail, meId: string): string {
  if (c.controller === 'gm') return 'Played by the Dungeon Master';
  if (c.controller === 'agent') return 'Played by its own AI';
  if (!c.playerIds.length) return 'Nobody plays them yet';
  const names = c.playerIds.map((id) =>
    id === meId ? 'You' : (campaign.members.find((m) => m.id === id)?.displayName ?? 'A player'),
  );
  // "You" first, then everyone else.
  names.sort((a, b) => Number(b === 'You') - Number(a === 'You'));
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

const CONTROLLERS: { value: CharacterController; title: string; body: string }[] = [
  {
    value: 'player',
    title: 'Players',
    body: 'One or more people at the table speak for this character.',
  },
  {
    value: 'gm',
    title: 'The Dungeon Master',
    body: 'The same AI that runs the game plays them. Cheapest, and it knows the whole story.',
  },
  {
    value: 'agent',
    title: 'An AI of their own',
    body: 'A separate AI plays them knowing only what the character has seen, so they cannot act on the DM’s secrets.',
  },
];

function ControllerChoice({
  value,
  onChange,
  options = CONTROLLERS,
}: {
  value: CharacterController;
  onChange: (value: CharacterController) => void;
  options?: typeof CONTROLLERS;
}) {
  return (
    <div className="choices" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`choice${o.value === value ? ' on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          <span className="choice-mark">{o.value === value && <IconCheck />}</span>
          <span className="grow">
            <b>{o.title}</b>
            <small>{o.body}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

/** The first step of adding someone to the party: whose they are, and how to make the sheet. */
function AddCharacterSheet({
  campaign,
  onPick,
  onClose,
}: {
  campaign: CampaignDetail;
  onPick: (panel: CastPanel) => void;
  onClose: () => void;
}) {
  const me = useMe();
  const notify = useToast();
  const owner = campaign.role === 'owner';
  const [whose, setWhose] = useState<'mine' | 'companion'>('mine');
  const [controller, setController] = useState<CharacterController>('agent');
  const [reading, setReading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const control: Control =
    whose === 'mine'
      ? { kind: 'pc', controller: 'player', playerIds: [me.id] }
      : { kind: 'npc', controller, playerIds: [] };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api<{ draft: CharacterDraft }>(`/campaigns/${campaign.id}/characters/import`, {
        form,
      });
      onPick({ kind: 'edit', draft: res.draft, control });
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setReading(false);
      if (picker.current) picker.current.value = '';
    }
  };

  return (
    <Sheet title="Add to the party" onClose={onClose}>
      <div className="stack">
        {owner && (
          <Segmented
            value={whose}
            onChange={setWhose}
            options={[
              { value: 'mine', label: 'My character' },
              { value: 'companion', label: 'A companion' },
            ]}
          />
        )}
        {whose === 'companion' && (
          <div>
            <span className="label">Who plays them?</span>
            <ControllerChoice
              value={controller}
              onChange={setController}
              options={CONTROLLERS.filter((c) => c.value !== 'player')}
            />
            <p className="small faint under-field">
              You can hand a companion to a player later from the party list.
            </p>
          </div>
        )}

        <div className="list">
          <button type="button" onClick={() => onPick({ kind: 'guide', control })}>
            <span className="row-icon">
              <IconChat />
            </span>
            <span className="grow">
              <b>Build with the guide</b>
              <small className="row-detail">
                Talk it through with an AI that knows the rules and rolls for you.
              </small>
            </span>
            <IconChevron className="chev" />
          </button>
          <button type="button" onClick={() => onPick({ kind: 'edit', control })}>
            <span className="row-icon">
              <IconScroll />
            </span>
            <span className="grow">
              <b>Fill in the sheet yourself</b>
              <small className="row-detail">A blank sheet for this game system.</small>
            </span>
            <IconChevron className="chev" />
          </button>
          <button type="button" disabled={reading} onClick={() => picker.current?.click()}>
            <span className="row-icon">{reading ? <span className="spinner" /> : <IconUpload />}</span>
            <span className="grow">
              <b>{reading ? 'Reading your sheet…' : 'Upload a character sheet'}</b>
              <small className="row-detail">
                A PDF, a text file or a photo. You check it before it is saved.
              </small>
            </span>
            <IconChevron className="chev" />
          </button>
        </div>
        <input
          ref={picker}
          type="file"
          className="sr-only"
          accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain,image/png,image/jpeg,image/webp"
          onChange={(e) => void upload(e.target.files?.[0])}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
    </Sheet>
  );
}

/** The owner decides who speaks for a party member. */
function ControlSheet({
  campaign,
  character,
  onClose,
  onSaved,
}: {
  campaign: CampaignDetail;
  character: Character;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<CharacterKind>(character.kind);
  const [controller, setController] = useState<CharacterController>(character.controller);
  const [players, setPlayers] = useState<string[]>(character.playerIds);
  const [busy, run] = useAction();

  const toggle = (id: string) =>
    setPlayers((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const save = () =>
    run(async () => {
      await api(`/campaigns/${campaign.id}/characters/${character.id}/control`, {
        method: 'PUT',
        body: { kind, controller, playerIds: controller === 'player' ? players : [] },
      });
      onSaved();
    }, `${character.name} updated`);

  return (
    <Sheet title={`Who plays ${character.name}?`} onClose={onClose} tall>
      <div className="stack">
        <ControllerChoice value={controller} onChange={setController} />

        {controller === 'player' && (
          <div>
            <span className="label">Players</span>
            <div className="list">
              {campaign.members.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="checkbox"
                  aria-checked={players.includes(m.id)}
                  onClick={() => toggle(m.id)}
                >
                  <Avatar name={m.displayName} seed={m.id} />
                  <span className="grow truncate">{m.displayName}</span>
                  <span className={`tick${players.includes(m.id) ? ' on' : ''}`}>
                    {players.includes(m.id) && <IconCheck />}
                  </span>
                </button>
              ))}
            </div>
            <p className="small faint under-field">
              {players.length > 1
                ? 'Any of them can act for the character each turn.'
                : players.length === 0
                  ? 'Pick at least one, or the character will sit out.'
                  : 'Add a second player to share the character.'}
            </p>
          </div>
        )}

        <Field
          label="In the story they are"
          hint="A companion travels with the party in a supporting role, whoever plays them."
        >
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'pc', label: 'A player character' },
              { value: 'npc', label: 'A companion' },
            ]}
          />
        </Field>

        <button type="button" className="btn primary block" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Sheet>
  );
}

/** Renders whichever party sheet is open. */
export function CastPanels({
  panel,
  setPanel,
  campaign,
  state,
  template,
  onChanged,
}: {
  panel: CastPanel;
  setPanel: (panel: CastPanel) => void;
  campaign: CampaignDetail;
  state: GameState | undefined;
  template: SheetTemplate | undefined;
  onChanged: () => void;
}) {
  const me = useMe();
  const owner = campaign.role === 'owner';
  const close = () => setPanel(null);
  if (!panel) return null;

  if (panel.kind === 'add')
    return <AddCharacterSheet campaign={campaign} onPick={setPanel} onClose={close} />;

  if (panel.kind === 'edit') {
    const c = panel.character;
    return (
      <CharacterSheet
        campaignId={campaign.id}
        template={template}
        character={c}
        draft={panel.draft}
        control={panel.control}
        mine={c ? runsIt(c, me.id) : (panel.control?.controller ?? 'player') === 'player'}
        canDelete={!!c && (owner || (c.playerIds.length === 1 && c.playerIds[0] === me.id))}
        onClose={close}
        onSaved={() => {
          onChanged();
          close();
        }}
      />
    );
  }

  if (panel.kind === 'guide') {
    return (
      <GuideSheet
        campaignId={campaign.id}
        characterId={panel.characterId}
        control={panel.control}
        onClose={close}
        onChanged={onChanged}
        onOpenSheet={(id) => {
          const character = state?.characters.find((ch) => ch.id === id);
          if (character) setPanel({ kind: 'edit', character });
        }}
      />
    );
  }

  return (
    <ControlSheet
      campaign={campaign}
      character={panel.character}
      onClose={close}
      onSaved={() => {
        onChanged();
        close();
      }}
    />
  );
}

/** One row of buttons for a character: its sheet, the guide, and (for the owner) who plays it. */
export function CastActions({
  character,
  campaign,
  onOpen,
}: {
  character: Character;
  campaign: CampaignDetail;
  onOpen: (panel: CastPanel) => void;
}) {
  const me = useMe();
  const owner = campaign.role === 'owner';
  const editable = canEdit(character, me.id, owner);
  if (!editable && !owner) return null;
  return (
    <div className="row wrap cast-actions">
      {editable && (
        <button type="button" className="btn sm" onClick={() => onOpen({ kind: 'edit', character })}>
          <IconScroll /> Sheet
        </button>
      )}
      {editable && (
        <button
          type="button"
          className="btn sm"
          onClick={() => onOpen({ kind: 'guide', characterId: character.id })}
        >
          <IconSparkle /> Guide
        </button>
      )}
      {owner && (
        <button type="button" className="btn sm ghost" onClick={() => onOpen({ kind: 'control', character })}>
          <IconD20 /> Who plays
        </button>
      )}
    </div>
  );
}
