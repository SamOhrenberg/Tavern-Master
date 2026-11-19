import { randomInt } from 'node:crypto';

export interface Die {
  sides: number;
  value: number;
  /** False for dice dropped by keep-highest / keep-lowest. */
  kept: boolean;
}

export interface RollResult {
  expression: string;
  dice: Die[];
  modifier: number;
  total: number;
}

/** Returns an integer in [1, sides]. Injectable so tests are deterministic. */
export type Rng = (sides: number) => number;

/** Uniform, from the OS CSPRNG. The model never picks a number itself. */
export const systemRng: Rng = (sides) => randomInt(1, sides + 1);

export class DiceError extends Error {}

const MAX_DICE = 100;
const MAX_SIDES = 1000;
const TERM = /([+-])(?:(\d*)d(\d+|%)(?:(kh|kl|k)(\d+))?|(\d+))/gy;

/**
 * Roll standard dice notation: `d20`, `2d6+3`, `4d6kh3`, `2d20kl1+5`,
 * `1d8+1d6-1`, `d%`. Advantage is `2d20kh1`, disadvantage `2d20kl1`.
 */
export function roll(expression: string, rng: Rng = systemRng): RollResult {
  const compact = expression.toLowerCase().replace(/\s+/g, '');
  if (!compact || compact.length > 64) throw new DiceError('Dice expression is empty or too long');
  const src = /^[+-]/.test(compact) ? compact : `+${compact}`;

  const dice: Die[] = [];
  let modifier = 0;
  let total = 0;
  let pos = 0;
  TERM.lastIndex = 0;
  for (let m = TERM.exec(src); m; m = TERM.exec(src)) {
    pos = TERM.lastIndex;
    const sign = m[1] === '-' ? -1 : 1;
    if (m[6] !== undefined) {
      modifier += sign * Number(m[6]);
      total += sign * Number(m[6]);
      continue;
    }
    const count = m[2] ? Number(m[2]) : 1;
    const sides = m[3] === '%' ? 100 : Number(m[3]);
    if (count < 1 || dice.length + count > MAX_DICE)
      throw new DiceError(`Roll between 1 and ${MAX_DICE} dice`);
    if (sides < 2 || sides > MAX_SIDES) throw new DiceError(`Dice need between 2 and ${MAX_SIDES} sides`);
    const rolled: Die[] = Array.from({ length: count }, () => ({ sides, value: rng(sides), kept: true }));
    if (m[4]) {
      const keep = Number(m[5]);
      if (keep < 1 || keep > count) throw new DiceError('Cannot keep more dice than were rolled');
      const order = rolled
        .map((d, i) => ({ v: d.value, i }))
        .sort((a, b) => (m[4] === 'kl' ? a.v - b.v : b.v - a.v));
      for (const { i } of order.slice(keep)) rolled[i]!.kept = false;
    }
    for (const d of rolled) if (d.kept) total += sign * d.value;
    dice.push(...rolled);
  }
  if (pos !== src.length || (dice.length === 0 && modifier === 0 && !/\d/.test(src))) {
    throw new DiceError(`Could not read dice expression "${expression.slice(0, 40)}"`);
  }
  if (dice.length === 0) throw new DiceError('Expression has no dice in it');
  return { expression: compact, dice, modifier, total };
}

/** `2d6+3 → [4, 2] +3 = 9`; dropped dice are shown struck through as ~1~. */
export function describeRoll(r: RollResult): string {
  const faces = r.dice.map((d) => (d.kept ? String(d.value) : `~${d.value}~`)).join(', ');
  const mod = r.modifier ? ` ${r.modifier > 0 ? '+' : '-'}${Math.abs(r.modifier)}` : '';
  return `${r.expression} → [${faces}]${mod} = ${r.total}`;
}

/** What a roll had to reach, when it decides pass or fail. */
export interface RollTarget {
  target?: number | null;
  under?: boolean | null;
}

/**
 * The pass/fail fields a roll carries, from its total and what it had to
 * reach: meet or beat the target, or roll it or lower when `under` is set.
 * Nothing when the roll has no target.
 */
export function judgeRoll(
  total: number,
  t: RollTarget,
): { target?: number; under?: true; success?: boolean } {
  if (t.target === undefined || t.target === null) return {};
  const success = t.under ? total <= t.target : total >= t.target;
  return { target: t.target, ...(t.under ? { under: true as const } : {}), success };
}

/** " - SUCCESS (needed 15 or higher)", for the GM to read after a roll. */
export function describeOutcome(r: { target?: number; under?: boolean; success?: boolean }): string {
  if (r.target === undefined || r.success === undefined) return '';
  const need = r.under ? `${r.target} or lower` : `${r.target} or higher`;
  return ` - ${r.success ? 'SUCCESS' : 'FAILURE'} (needed ${need})`;
}
