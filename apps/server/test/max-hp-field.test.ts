import type { SheetSchema } from '@tavern/protocol';
import { describe, expect, it } from 'vitest';
import { draftFromRecord, suggestionsFromChanges } from '../src/agent/sheets.js';
import {
  EMPTY_SCHEMA,
  maxHpField,
  readMaxHp,
  schemaGuide,
  settleMaxHp,
  writesMaxHp,
} from '../src/sheet-schema.js';
import { SRD_SHEET } from '../src/srd-sheet.js';

/** A sheet that works out its own maximum, as Dungeon Crawler Carl's does. */
const OWN_MAX: SheetSchema = {
  version: 2,
  hp: { label: 'HP' },
  sections: [
    {
      id: 'stats',
      label: 'Stats',
      fields: [
        { key: 'Constitution', label: 'Constitution', type: 'number' },
        {
          key: 'maxhp',
          label: 'Max HP',
          type: 'derived',
          derivedFrom: '10 + 2.5 × Constitution + 3 × Level',
        },
      ],
    },
  ],
  createSteps: [],
};

describe("a sheet's own Max HP field", () => {
  it('is found by name or label, and only where the sheet has one', () => {
    expect(maxHpField(OWN_MAX)?.key).toBe('maxhp');
    expect(maxHpField(SRD_SHEET)).toBeUndefined();
    expect(maxHpField(EMPTY_SCHEMA)).toBeUndefined();
  });

  it('does not take a plain HP track or number for the maximum', () => {
    const track: SheetSchema = {
      ...OWN_MAX,
      sections: [{ id: 's', label: 'S', fields: [{ key: 'HP', label: 'HP', type: 'track' }] }],
    };
    const plain: SheetSchema = {
      ...OWN_MAX,
      sections: [{ id: 's', label: 'S', fields: [{ key: 'hp', label: 'HP', type: 'number' }] }],
    };
    expect(maxHpField(track)).toBeUndefined();
    expect(maxHpField(plain)).toBeUndefined();
  });

  it('reads as a whole number', () => {
    expect(readMaxHp(27.5)).toBe(27);
    expect(readMaxHp('27 (10 + 2.5 × 5 + 3 × 1)')).toBe(27);
    expect(readMaxHp('')).toBeUndefined();
    expect(readMaxHp(0)).toBeUndefined();
  });

  it('sets the maximum when written, and takes a max_hp given alone', () => {
    const sheet: Record<string, unknown> = { maxhp: 25 };
    expect(settleMaxHp(OWN_MAX, sheet, 40, true)).toBe(25);
    expect(settleMaxHp(OWN_MAX, sheet, 30, false)).toBe(30);
    expect(sheet.maxhp).toBe(30);
    expect(settleMaxHp(SRD_SHEET, {}, 30, false)).toBeUndefined();
    expect(writesMaxHp(OWN_MAX, ['Max HP'])).toBe(true);
    expect(writesMaxHp(OWN_MAX, ['Constitution'])).toBe(false);
  });

  it('tells a model to write the maximum in the field, not max_hp', () => {
    expect(schemaGuide(OWN_MAX)).toContain('their maximum is the "maxhp" field');
    expect(schemaGuide(SRD_SHEET)).toContain('their maximum is max_hp');
  });

  it('decides an uploaded draft, and gets the rules check’s HP correction', () => {
    const both = draftFromRecord(
      { name: 'Marcus', max_hp: 25, fields: [{ field: 'Max HP', value: 27 }] },
      OWN_MAX,
    );
    expect(both?.maxHp).toBe(27);
    const alone = draftFromRecord({ name: 'Marcus', max_hp: 25 }, OWN_MAX);
    expect(alone?.maxHp).toBe(25);
    expect(alone?.sheet.maxhp).toBe(25);

    const s = suggestionsFromChanges([{ field: 'maxHp', suggested: 30, reason: 'rules' }], both!, OWN_MAX);
    expect(s).toEqual([{ field: 'maxhp', current: '27', suggested: 30, reason: 'rules' }]);
    const box = suggestionsFromChanges([{ field: 'maxHp', suggested: 30, reason: 'rules' }], both!);
    expect(box[0]?.field).toBe('maxHp');
  });
});

describe('a rules check on a track', () => {
  const MANA: SheetSchema = {
    version: 2,
    hp: { label: 'HP' },
    sections: [
      {
        id: 'status',
        label: 'Status',
        fields: [
          { key: 'Mana', label: 'Mana', type: 'track' },
          { key: 'Intelligence', label: 'Intelligence', type: 'number' },
        ],
      },
    ],
    createSteps: [],
  };

  it('reads a track the model wrote as JSON text, or as an object, as "current/max"', () => {
    const draft = draftFromRecord({ name: 'Ryan', fields: [{ field: 'Intelligence', value: 4 }] }, MANA)!;
    const reason = 'Max mana equals Intelligence (4).';
    const asText = suggestionsFromChanges(
      [{ field: 'Mana', suggested: '{"current": 4, "max": 4}', reason }],
      draft,
      MANA,
    );
    expect(asText).toEqual([{ field: 'Mana', current: '(not set)', suggested: '4/4', reason }]);
    const asObject = suggestionsFromChanges(
      [{ field: 'mana', suggested: { current: 3, max: 4 }, reason }],
      draft,
      MANA,
    );
    expect(asObject[0]?.suggested).toBe('3/4');
    // A value that cannot be read as a track is dropped rather than shown.
    expect(suggestionsFromChanges([{ field: 'Mana', suggested: 'lots', reason }], draft, MANA)).toEqual([]);
  });
});
