import type { DiceRoll, RollKind } from '@tavern/protocol';
import { DiceError, judgeRoll, roll as rollDice, systemRng, type Rng } from '../agent/dice.js';
import type { CharRow } from '../agent/store.js';

export interface RollRequest {
  expression: string;
  reason?: string;
  characterId?: string;
  kind?: RollKind;
  /** What it must reach to succeed, when the DM set that. */
  target?: number | null;
  under?: boolean;
}

export type RollOutcome =
  | { ok: true; roll: Omit<DiceRoll, 'id'> }
  | { ok: false; code: 'not_your_character' | 'bad_dice'; message: string };

/**
 * Validate and resolve a player-initiated roll before it is recorded: the
 * player must run the character they name, the expression must parse, and the
 * character name is snapshotted now so later renames do not rewrite history.
 * Pure and rng-injectable so the rules it enforces can be tested directly; the
 * server never lets the client decide the result.
 */
export function buildPlayerRoll(
  req: RollRequest,
  opts: { userId: string; characters: CharRow[]; rng?: Rng },
): RollOutcome {
  let character: string | null = null;
  if (req.characterId) {
    const c = opts.characters.find((x) => x.id === req.characterId);
    if (!c || c.controller !== 'player' || !c.playerIds.includes(opts.userId)) {
      return { ok: false, code: 'not_your_character', message: 'You do not run that character.' };
    }
    character = c.name;
  }
  let result;
  try {
    result = rollDice(req.expression, opts.rng ?? systemRng);
  } catch (err) {
    if (err instanceof DiceError) return { ok: false, code: 'bad_dice', message: err.message };
    throw err;
  }
  return {
    ok: true,
    roll: {
      expression: result.expression,
      reason: req.reason?.trim().slice(0, 120) || '',
      character,
      dice: result.dice,
      total: result.total,
      kind: req.kind ?? 'other',
      ...judgeRoll(result.total, req),
    },
  };
}
