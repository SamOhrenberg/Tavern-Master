import type { Character, DiceRoll, RollKind } from '@tavern/protocol';
import { useEffect, useRef, useState } from 'react';
import { IconClose, IconD20 } from '../icons';
import { RollChip } from './story';

export interface RollReq {
  expression: string;
  reason?: string;
  characterId?: string;
  kind?: RollKind;
}

const DICE = [4, 6, 8, 10, 12, 20, 100];
const KINDS: { value: RollKind; label: string }[] = [
  { value: 'check', label: 'Check' },
  { value: 'attack', label: 'To hit' },
  { value: 'damage', label: 'Damage' },
  { value: 'save', label: 'Save' },
  { value: 'initiative', label: 'Init' },
];

const reduceMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const d = (sides: number) => 1 + Math.floor(Math.random() * sides);

/**
 * A roll as it lands: it tumbles through random faces for a beat, then settles
 * on the server's authoritative value. Cosmetic only — the number never comes
 * from here. Reduced motion settles instantly.
 */
export function AnimatedRoll({ roll }: { roll: DiceRoll }) {
  const [rolling, setRolling] = useState(() => !reduceMotion());
  const [, bump] = useState(0);
  useEffect(() => {
    if (reduceMotion()) return;
    const tick = window.setInterval(() => bump((n) => n + 1), 70);
    const done = window.setTimeout(() => {
      window.clearInterval(tick);
      setRolling(false);
    }, 760);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(done);
    };
  }, []);

  if (!rolling) {
    return (
      <div className="rolls roll-pop">
        <RollChip roll={roll} />
      </div>
    );
  }
  // Show random faces while it tumbles; the real roll replaces them on settle.
  const faces = roll.dice.map((face) => ({ ...face, kept: true, value: d(face.sides) }));
  const shown: DiceRoll = {
    ...roll,
    dice: faces,
    total: faces.reduce((sum, f) => sum + f.value, 0),
  };
  return (
    <div className="rolls rolling" aria-hidden>
      <RollChip roll={shown} />
    </div>
  );
}

/**
 * A player's own dice. A quick d20, or a popover for any common die, a free
 * expression, what the roll is for, and an optional reason. The result is sent
 * to the server, which rolls and broadcasts it to the whole table.
 */
export function DiceTray({
  character,
  onRoll,
}: {
  /** The character the roll is attributed to, if the player runs one. */
  character: Character | undefined;
  onRoll: (req: RollReq) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expr, setExpr] = useState('1d20');
  const [reason, setReason] = useState('');
  const [kind, setKind] = useState<RollKind>('check');
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const fire = (expression: string, k: RollKind, why: string) => {
    if (!expression.trim()) return;
    if (onRoll({ expression, reason: why.trim() || undefined, characterId: character?.id, kind: k })) {
      setOpen(false);
      setReason('');
    }
  };

  return (
    <div className="dice-tray" ref={panel}>
      {open && (
        <div className="dice-pop" role="dialog" aria-label="Roll dice">
          <div className="dice-pop-head">
            <span>Roll{character ? ` as ${character.name}` : ''}</span>
            <button type="button" className="icon-btn sm" onClick={() => setOpen(false)} aria-label="Close">
              <IconClose />
            </button>
          </div>
          <div className="dice-grid">
            {DICE.map((sides) => (
              <button key={sides} type="button" className="die-btn" onClick={() => setExpr(`1d${sides}`)}>
                d{sides}
              </button>
            ))}
          </div>
          <input
            className="dice-expr"
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            placeholder="e.g. 2d6+3"
            maxLength={64}
            aria-label="Dice expression"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="dice-kinds" role="radiogroup" aria-label="What the roll is for">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={kind === k.value}
                className={kind === k.value ? 'on' : ''}
                onClick={() => setKind(k.value)}
              >
                {k.label}
              </button>
            ))}
          </div>
          <input
            className="dice-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            maxLength={120}
            aria-label="Reason"
          />
          <button type="button" className="btn block" onClick={() => fire(expr, kind, reason)}>
            Roll {expr || 'dice'}
          </button>
        </div>
      )}
      <div className="dice-bar">
        <button type="button" className="btn sm roll-quick" onClick={() => fire('1d20', 'check', '')}>
          <IconD20 />
          Roll d20
        </button>
        <button
          type="button"
          className="btn sm ghost"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          More dice
        </button>
      </div>
    </div>
  );
}
