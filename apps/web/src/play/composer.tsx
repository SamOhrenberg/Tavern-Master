import type { CampaignMember, TurnState } from '@tavern/protocol';
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
  characterName,
  resolving,
  draft,
  onDraft,
  onSend,
}: {
  characterName: string | null;
  resolving: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onSend: (mode: Mode, text: string) => boolean;
}) {
  const [mode, setMode] = useState<Mode>('act');
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
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
        ? 'Your action will join the next turn…'
        : characterName
          ? `What does ${characterName} do?`
          : 'What do you do?';

  return (
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
        maxLength={2000}
        enterKeyHint={coarse() ? 'enter' : 'send'}
        aria-label={mode === 'act' ? 'Your action' : 'Table talk'}
      />
      <button
        type="button"
        className="send"
        disabled={!draft.trim()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={send}
        aria-label="Send"
      >
        <IconSend />
      </button>
    </div>
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

/** While a turn is gathering: who has acted, who the table is waiting for, and how long is left. */
export function TurnBar({
  turn,
  members,
  meId,
  isOwner,
  onPass,
  onForce,
}: {
  turn: TurnState;
  members: CampaignMember[];
  meId: string;
  isOwner: boolean;
  onPass: () => void;
  onForce: () => void;
}) {
  const seconds = useCountdown(turn.status === 'collecting' ? turn.deadline : null);
  if (turn.status !== 'collecting') return null;

  const nameOf = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m?.characterName ?? m?.displayName ?? 'Someone';
  };
  const waiting = turn.expected.filter((id) => !turn.acted.includes(id) && !turn.passed.includes(id));
  const mineOpen = waiting.includes(meId);
  const others = waiting.filter((id) => id !== meId);
  const status = mineOpen
    ? others.length
      ? 'The table is acting. Add yours, or pass.'
      : 'Everyone else is ready. Your move.'
    : `Waiting for ${others.map(nameOf).slice(0, 2).join(' and ')}${others.length > 2 ? ` +${others.length - 2}` : ''}`;
  const clock =
    seconds === null ? '' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <div className="turnbar" role="status">
      <div className="turn-people">
        {turn.expected.map((id) => {
          const done = turn.acted.includes(id);
          const passed = turn.passed.includes(id);
          return (
            <span key={id} className={`turn-person${done ? ' done' : passed ? ' passed' : ''}`}>
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
        <button type="button" className="btn sm" onClick={onPass}>
          Pass
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
