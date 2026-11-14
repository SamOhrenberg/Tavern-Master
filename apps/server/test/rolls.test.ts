import { describe, expect, it } from 'vitest';
import { buildPlayerRoll } from '../src/realtime/rolls.js';
import { character } from './fake-store.js';

const party = [
  character({ id: 'c-thorn', name: 'Thorn', playerIds: ['u-ann'] }),
  character({ id: 'c-mira', name: 'Mira', playerIds: ['u-bob'] }),
  character({ id: 'c-bot', name: 'Grib', controller: 'agent', playerIds: [] }),
];

describe('player dice rolls', () => {
  it('rolls a valid expression and snapshots the character name and kind', () => {
    const out = buildPlayerRoll(
      { expression: '2d6+3', reason: 'Longsword damage', characterId: 'c-thorn', kind: 'damage' },
      { userId: 'u-ann', characters: party, rng: () => 4 },
    );
    expect(out).toMatchObject({
      ok: true,
      roll: {
        expression: '2d6+3',
        total: 11,
        character: 'Thorn',
        kind: 'damage',
        reason: 'Longsword damage',
      },
    });
  });

  it('defaults kind to "other" and allows an unattributed roll', () => {
    const out = buildPlayerRoll(
      { expression: '1d20' },
      { userId: 'u-ann', characters: party, rng: () => 15 },
    );
    expect(out).toMatchObject({ ok: true, roll: { kind: 'other', character: null, total: 15, reason: '' } });
  });

  it('rejects rolling as a character the player does not run', () => {
    const out = buildPlayerRoll(
      { expression: '1d20', characterId: 'c-mira' },
      { userId: 'u-ann', characters: party, rng: () => 10 },
    );
    expect(out).toEqual({ ok: false, code: 'not_your_character', message: expect.any(String) });
  });

  it('rejects rolling as an AI-run party member', () => {
    const out = buildPlayerRoll(
      { expression: '1d20', characterId: 'c-bot' },
      { userId: 'u-ann', characters: party, rng: () => 10 },
    );
    expect(out).toMatchObject({ ok: false, code: 'not_your_character' });
  });

  it('rejects an unknown character id', () => {
    const out = buildPlayerRoll(
      { expression: '1d20', characterId: 'c-nope' },
      { userId: 'u-ann', characters: party },
    );
    expect(out).toMatchObject({ ok: false, code: 'not_your_character' });
  });

  it('reports a malformed expression as bad_dice rather than throwing', () => {
    const out = buildPlayerRoll({ expression: 'banana' }, { userId: 'u-ann', characters: party });
    expect(out).toMatchObject({ ok: false, code: 'bad_dice' });
  });
});
