import type { DiceRoll, RollKind, RollRequest } from '@tavern/protocol';
import { useEffect, useState } from 'react';
import { IconD20 } from '../icons';
import { RollChip } from './story';

const KIND_LABEL: Record<RollKind, string> = {
  check: 'a check',
  attack: 'an attack',
  damage: 'damage',
  save: 'a saving throw',
  initiative: 'initiative',
  other: 'a roll',
};

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
  // Whether it succeeded stays hidden until the dice settle.
  const { target: _target, under: _under, success: _success, ...unjudged } = roll;
  const shown: DiceRoll = {
    ...unjudged,
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
 * The rolls the DM has asked this player to make, and nothing otherwise:
 * players roll only when asked. Each shows who rolls, what for and the dice;
 * the server rolls exactly that expression, and the result goes into the turn
 * as the character's action so the DM reads it.
 */
export function DiceTray({
  requests,
  onRoll,
}: {
  /** Open roll requests for characters this player runs. */
  requests: RollRequest[];
  onRoll: (requestId: string) => boolean;
}) {
  // Sent but not yet confirmed: the button stays disabled so a double tap cannot fire twice.
  const [sent, setSent] = useState<string[]>([]);
  const open = requests.filter((r) => !sent.includes(r.id));
  if (!open.length) return null;
  return (
    <div className="dice-tray" role="region" aria-label="Rolls the DM asked for">
      {open.map((r) => (
        <div key={r.id} className="roll-ask">
          <div className="grow roll-ask-text">
            <b>{r.characterName}</b>, the DM asks for a roll: {r.reason || KIND_LABEL[r.kind]}{' '}
            <span className="mono muted">{r.expression}</span>
          </div>
          <button
            type="button"
            className="btn sm primary roll-quick"
            onClick={() => {
              if (!onRoll(r.id)) return;
              setSent((s) => [...s, r.id]);
              // Normally the request is gone by then; if the server turned the roll down, it is back.
              window.setTimeout(() => setSent((s) => s.filter((x) => x !== r.id)), 6000);
            }}
          >
            <IconD20 />
            Roll
          </button>
        </div>
      ))}
    </div>
  );
}
