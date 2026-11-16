import type { Character, TurnState } from '@tavern/protocol';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { IconChat, IconCheck, IconSend, IconSwords } from '../icons';
import { Avatar } from '../ui';

export type Mode = 'act' | 'talk';

const coarse = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * Where a player writes. "Act" goes to the DM as part of the turn; "Talk" is
 * table chatter the DM never sees. The field grows with the text and keeps
 * the keyboard open between messages.
 */
export function Composer({
  characters,
  companions,
  actingAs,
  onActAs,
  acted,
  resolving,
  draft,
  onDraft,
  onSend,
}: {
  /** The characters this player runs. */
  characters: Character[];
  /**
   * Party members the GM or their own AI play. Anyone may speak for one of
   * them for a line without taking it over.
   */
  companions: Character[];
  actingAs: Character | undefined;
  onActAs: (id: string) => void;
  /** Ids of this player's characters that have already acted this turn. */
  acted: string[];
  resolving: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onSend: (mode: Mode, text: string) => boolean;
}) {
  const [mode, setMode] = useState<Mode>('act');
  const characterName = actingAs?.name ?? null;
  const voicing = !!actingAs && companions.some((c) => c.id === actingAs.id);
  const choices = characters.length + companions.length;
  const field = useRef<HTMLTextAreaElement>(null);
  // While the DM is working on a turn, actions wait. Table talk stays open.
  const locked = mode === 'act' && resolving;

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const send = () => {
    const text = draft.trim();
    if (!text || locked) return;
    if (onSend(mode, text)) onDraft('');
    field.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // On a phone Return makes a new line; with a real keyboard it sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) {
      e.preventDefault();
      send();
    }
  };

  const placeholder =
    mode === 'talk'
      ? 'Table talk. The DM will not see this.'
      : resolving
        ? 'The DM is working. Switch to Talk to chat.'
        : voicing
          ? `What does ${characterName} say or do?`
          : characterName
            ? `What does ${characterName} do?`
            : 'What do you do?';

  return (
    <>
      {mode === 'act' && (choices > 1 || (!actingAs && companions.length > 0)) && (
        <label className={`act-as${voicing ? ' voicing' : ''}`}>
          {actingAs && <Avatar name={actingAs.name} seed={actingAs.id} small />}
          <span className="act-as-label">{voicing ? 'Speaking for' : 'Acting as'}</span>
          <select
            className="act-as-select"
            value={actingAs?.id ?? ''}
            onChange={(e) => onActAs(e.target.value)}
            aria-label="Who you act as"
          >
            {characters.length === 0 && <option value="">Yourself</option>}
            {characters.length > 0 && (
              <optgroup label={characters.length > 1 ? 'Your characters' : 'Your character'}>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {acted.includes(c.id) ? ' ✓' : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {companions.length > 0 && (
              <optgroup label="Companions">
                {companions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      )}
      <div className={`composer ${mode}`}>
        <button
          type="button"
          className="mode-toggle"
          onClick={() => setMode(mode === 'act' ? 'talk' : 'act')}
          aria-label={mode === 'act' ? 'Switch to table talk' : 'Switch to acting in the story'}
        >
          {mode === 'act' ? <IconSwords /> : <IconChat />}
          <span>{mode === 'act' ? 'Act' : 'Talk'}</span>
        </button>
        <textarea
          ref={field}
          className="composer-field"
          rows={1}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          disabled={locked}
          maxLength={2000}
          enterKeyHint={coarse() ? 'enter' : 'send'}
          aria-label={mode === 'act' ? 'Your action' : 'Table talk'}
        />
        <button
          type="button"
          className="send"
          disabled={!draft.trim() || locked}
          onMouseDown={(e) => e.preventDefault()}
          onClick={send}
          aria-label="Send"
        >
          <IconSend />
        </button>
      </div>
    </>
  );
}

function useCountdown(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
}

/**
 * While a turn is gathering: who is done, who the table is waiting for, and
 * how long is left. Players write as many messages as they like, then tap
 * Done (or Pass without writing); the DM gets the turn once everyone has.
 */
export function TurnBar({
  turn,
  meId,
  isOwner,
  onDone,
  onForce,
}: {
  turn: TurnState;
  meId: string;
  isOwner: boolean;
  onDone: () => void;
  onForce: () => void;
}) {
  const seconds = useCountdown(turn.status === 'collecting' ? turn.deadline : null);
  if (turn.status !== 'collecting') return null;

  // The table waits on seats: each player-run character, or a player without one.
  const seat = (id: string) => turn.seats.find((s) => s.id === id);
  const nameOf = (id: string) => seat(id)?.name ?? 'Someone';
  const isMine = (id: string) => !!seat(id)?.userIds.includes(meId);
  const waiting = turn.expected.filter((id) => !turn.done.includes(id) && !turn.passed.includes(id));
  const mine = waiting.filter(isMine);
  const mineOpen = mine.length > 0;
  // Written something this turn (as their own character or a companion), not done yet.
  const writing = turn.acted.some(isMine);
  const others = waiting.filter((id) => !isMine(id));
  const status = mineOpen
    ? writing
      ? 'Add more, or tap Done when your turn is finished.'
      : others.length
        ? 'The table is acting. Add yours, or pass.'
        : 'Everyone else is done. Your move.'
    : `Waiting for ${others.map(nameOf).slice(0, 2).join(' and ')}${others.length > 2 ? ` +${others.length - 2}` : ''}`;
  const clock =
    seconds === null ? '' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <div className="turnbar" role="status">
      <div className="turn-people">
        {turn.expected.map((id) => {
          const done = turn.done.includes(id);
          const passed = turn.passed.includes(id);
          const acting = !done && turn.acted.includes(id);
          return (
            <span
              key={id}
              className={`turn-person${done ? ' done' : passed ? ' passed' : acting ? ' acting' : ''}`}
            >
              <Avatar name={nameOf(id)} seed={id} small />
              {done && (
                <i>
                  <IconCheck />
                </i>
              )}
            </span>
          );
        })}
      </div>
      <div className="grow turn-text">
        <span className="truncate">{status}</span>
        <span className="turn-clock mono">{clock}</span>
      </div>
      {mineOpen && (
        <button type="button" className={`btn sm${writing ? ' primary' : ''}`} onClick={onDone}>
          {writing ? 'Done' : 'Pass'}
        </button>
      )}
      {isOwner && (
        <button type="button" className="btn sm ghost" onClick={onForce}>
          Go now
        </button>
      )}
    </div>
  );
}
