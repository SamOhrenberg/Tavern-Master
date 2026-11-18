import type { SheetProposal, SheetSchema } from '@tavern/protocol';
import { describe, expect, it } from 'vitest';
import { publicSummary } from '../src/agent/loop.js';
import { dispatchTool } from '../src/agent/tools.js';
import { suggestRenames } from '../src/sheet-proposals.js';
import { gmSheetGuide } from '../src/sheet-schema.js';
import { carrySheet, checkRenames } from '../src/sheet-versions.js';
import { character, context, FakeStore } from './fake-store.js';

const v1: SheetSchema = {
  version: 2,
  hp: { label: 'Health' },
  sections: [
    {
      id: 'core',
      label: 'Core',
      fields: [
        { key: 'str', label: 'Strength', type: 'number' },
        { key: 'mood', label: 'Mood', type: 'text' },
        { key: 'luck', label: 'Luck', type: 'text' },
      ],
    },
  ],
  createSteps: [],
};

const v2: SheetSchema = {
  version: 2,
  hp: { label: 'Health' },
  sections: [
    {
      id: 'core',
      label: 'Core',
      fields: [
        { key: 'Strength', label: 'Strength', type: 'number' },
        { key: 'mood', label: 'Mood', type: 'text' },
        // Was free text; now a number.
        { key: 'luck', label: 'Luck', type: 'number' },
        {
          key: 'stress',
          label: 'Stress',
          type: 'track',
          min: 0,
          max: 9,
          gmNote: 'At 9 they take a trauma.',
        },
      ],
    },
  ],
  createSteps: [],
};

describe('carrying a sheet to a new version', () => {
  it('moves renamed values, fits each to its new kind and keeps what does not fit', () => {
    const out = carrySheet({ str: '14', mood: 'grim', luck: 'plenty', Notes: 'kept', empty: '' }, v2, {
      str: 'Strength',
    });
    expect(out.sheet).toEqual({ Strength: 14, mood: 'grim', 'Previous Luck': 'plenty', Notes: 'kept' });
    expect(out.moved).toEqual([{ from: 'str', to: 'Strength' }]);
    expect(out.kept).toEqual([{ field: 'luck', as: 'Previous Luck' }]);
  });

  it('lets a renamed value win over a stray entry under the new name', () => {
    const out = carrySheet({ strength: 3, str: 12 }, v2, { str: 'Strength' });
    expect(out.sheet).toEqual({ Strength: 12 });
  });

  it('accepts only renames from a field taken away to a field added', () => {
    expect(checkRenames(v1, v2, [{ from: 'STR', to: 'strength' }])).toEqual({ str: 'Strength' });
    expect(() => checkRenames(v1, v2, [{ from: 'mood', to: 'Strength' }])).toThrow(/takes away/);
    expect(() => checkRenames(v1, v2, [{ from: 'str', to: 'luck' }])).toThrow(/adds/);
  });

  it('suggests pairing a removed field with an added one of the same label', () => {
    const field = (key: string, label: string) => ({ key, label, type: 'number' as const });
    const proposals: SheetProposal[] = [
      { id: 'remove:str', kind: 'remove', section: 'Core', field: field('str', 'Strength') },
      { id: 'remove:wis', kind: 'remove', section: 'Core', field: field('wis', 'Wisdom') },
      { id: 'add:strength', kind: 'add', section: 'Core', field: field('Strength', 'Strength') },
      { id: 'add:grit', kind: 'add', section: 'Core', field: field('grit', 'Grit') },
    ];
    expect(suggestRenames(proposals)).toEqual([{ from: 'str', to: 'Strength' }]);
  });
});

describe('the GM’s adjust_track', () => {
  const setup = (sheet: Record<string, unknown> = { stress: { current: 2, max: 9 } }) => {
    const store = new FakeStore();
    store.schema = v2;
    store.chars = [character({ id: 'c1', name: 'Thorn', playerIds: ['u-ann'], sheet })];
    const ctx = context();
    const call = (input: Record<string, unknown>) =>
      dispatchTool('adjust_track', { character: 'Thorn', reason: 'a close call', ...input }, ctx, store);
    return { store, ctx, call };
  };

  it('moves a track by its label, within its limits, and logs it for the table', async () => {
    const { store, ctx, call } = setup();
    const out = await call({ track: 'stress', change: 3 });
    expect(out).toEqual({ isError: false, content: "Thorn's Stress: 2/9 → 5/9 (a close call)" });
    expect(store.chars[0]!.sheet.stress).toEqual({ current: 5, max: 9 });
    expect(store.events[0]!.summary).toBe(out.content);
    expect(ctx.stateChanged).toBe(true);
    expect((await call({ track: 'Stress', change: -20 })).content).toContain(
      '0/9 (a close call) (it stops at 0)',
    );
  });

  it('tells the GM, and only the GM, what the rules say at the limit', async () => {
    const { call } = setup();
    const out = await call({ track: 'Stress', change: 10 });
    const [line, note] = out.content.split('\n');
    expect(line).toBe("Thorn's Stress: 2/9 → 9/9 (a close call) (it stops at its maximum, 9)");
    expect(note).toBe('Stress is now full. Your note on it: At 9 they take a trauma.');
    expect(publicSummary('adjust_track', {}, out.content)).toBe(line!.slice(0, 160));
  });

  it('sets a track a sheet does not have yet only with its value and maximum', async () => {
    const { store, call } = setup({});
    expect((await call({ track: 'stress', change: 1 })).content).toMatch(/give its value with set/);
    // The field's own maximum stands in when none is given.
    expect((await call({ track: 'stress', set: 1 })).isError).toBe(false);
    expect(store.chars[0]!.sheet.stress).toEqual({ current: 1, max: 9 });
  });

  it('sends hit points to update_character and names the tracks there are', async () => {
    const { call } = setup();
    expect((await call({ track: 'Health', change: -2 })).content).toMatch(/update_character/);
    expect((await call({ track: 'mood', change: 1 })).content).toBe(
      '"mood" is not a track on this sheet. Its tracks: Stress ("stress").',
    );
    expect((await call({ track: 'stress', change: 1, set: 2 })).content).toMatch(/not both/);
  });

  it('is offered in the GM’s instructions only when the sheet has tracks', () => {
    expect(gmSheetGuide(v2)).toContain('record it with adjust_track');
    expect(gmSheetGuide(v1)).not.toContain('adjust_track');
  });
});
