import { describe, expect, it } from 'vitest';
import { describeRoll, DiceError, roll, systemRng } from '../src/agent/dice.js';

/** Returns the given faces in order, so results are exact. */
const fixed = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('dice', () => {
  it('rolls a single die', () => {
    const r = roll('d20', fixed(17));
    expect(r.total).toBe(17);
    expect(r.dice).toEqual([{ sides: 20, value: 17, kept: true }]);
  });

  it('adds several dice and a modifier', () => {
    const r = roll('2d6+3', fixed(4, 2));
    expect(r.total).toBe(9);
    expect(r.modifier).toBe(3);
    expect(describeRoll(r)).toBe('2d6+3 → [4, 2] +3 = 9');
  });

  it('handles subtraction, mixed dice and whitespace', () => {
    expect(roll(' 1d8 + 1d6 - 2 ', fixed(5, 3)).total).toBe(6);
    expect(roll('1d20-1d4', fixed(10, 4)).total).toBe(6);
  });

  it('keeps the highest dice (4d6kh3)', () => {
    const r = roll('4d6kh3', fixed(1, 6, 4, 5));
    expect(r.total).toBe(15);
    expect(r.dice.filter((d) => !d.kept).map((d) => d.value)).toEqual([1]);
  });

  it('supports advantage and disadvantage', () => {
    expect(roll('2d20kh1+5', fixed(3, 18)).total).toBe(23);
    expect(roll('2d20kl1', fixed(3, 18)).total).toBe(3);
    expect(describeRoll(roll('2d20kl1', fixed(3, 18)))).toContain('~18~');
  });

  it('treats d% as d100', () => {
    expect(roll('d%', fixed(73)).dice[0]).toMatchObject({ sides: 100, value: 73 });
  });

  it.each(['', 'banana', '2d', 'd1', '0d6', '101d6', '1d1001', '2d6kh3', '5', '1d6+', '1d6 drop table'])(
    'rejects %j',
    (expr) => {
      expect(() => roll(expr, fixed(1))).toThrow(DiceError);
    },
  );

  it('stays in range with the real generator', () => {
    for (let i = 0; i < 500; i++) {
      const v = systemRng(6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
    const seen = new Set(Array.from({ length: 400 }, () => roll('1d6').total));
    expect(seen.size).toBe(6);
  });
});
