import type { SheetSchema } from '@tavern/protocol';
import { describe, expect, it } from 'vitest';
import {
  checkSheet,
  coerce,
  EMPTY_SCHEMA,
  formatValue,
  gmSheetGuide,
  fromTemplate,
  keepGmFields,
  parseSchema,
  schemaGuide,
  schemaSchema,
  toSchema,
} from '../src/sheet-schema.js';
import { SRD_SHEET, SRD_TEMPLATE_V1 } from '../src/srd-sheet.js';

const schema: SheetSchema = {
  version: 2,
  hp: { label: 'Health' },
  sections: [
    {
      id: 'core',
      label: 'Core',
      fields: [
        { key: 'Insight', label: 'Insight', type: 'number', min: 0, max: 4 },
        { key: 'playbook', label: 'Playbook', type: 'select', options: ['Cutter', 'Hound', 'Whisper'] },
        { key: 'stress', label: 'Stress', type: 'track', setAt: 'play', gmNote: 'Trauma at 9.' },
        { key: 'heat', label: 'Heat', type: 'number', editableBy: 'gm' },
        { key: 'veteran', label: 'Veteran', type: 'checkbox' },
        { key: 'armour', label: 'Armour', type: 'derived', derivedFrom: '1 + heavy armour' },
        {
          key: 'abilities',
          label: 'Special abilities',
          type: 'list',
          itemFields: [
            { key: 'name', label: 'Ability', type: 'text' },
            { key: 'tier', label: 'Tier', type: 'number' },
          ],
        },
      ],
    },
  ],
  createSteps: ['Choose a playbook.', 'Assign four action dots.'],
};
const field = (key: string) => schema.sections[0]!.fields.find((f) => f.key === key)!;

describe('sheet schemas', () => {
  it('reads the original template as a schema under the same field names', () => {
    const s = toSchema(SRD_TEMPLATE_V1);
    expect(s.version).toBe(2);
    expect(s.sections.map((x) => x.id)).toEqual(['abilities', 'details']);
    expect(s.sections[0]!.fields[0]).toMatchObject({ key: 'Strength', type: 'number', showOnCard: true });
    const details = s.sections[1]!.fields;
    expect(details.find((f) => f.key === 'features')!.type).toBe('longtext');
    // The first three short fields are the ones the party card showed.
    expect(details.filter((f) => f.showOnCard).map((f) => f.key)).toEqual(['class', 'level', 'species']);
    expect(toSchema(undefined)).toEqual(EMPTY_SCHEMA);
  });

  it('ships a starter sheet that is valid and keeps every original field name', () => {
    expect(schemaSchema.safeParse(SRD_SHEET).success).toBe(true);
    const keys = SRD_SHEET.sections.flatMap((s) => s.fields.map((f) => f.key));
    for (const k of [...SRD_TEMPLATE_V1.abilities, ...SRD_TEMPLATE_V1.fields.map((f) => f.key)])
      expect(keys).toContain(k);
  });

  it('refuses a schema with a repeated field, a select without options or a list without rows', () => {
    const bad = (fields: unknown[]) => () =>
      parseSchema({ version: 2, hp: { label: 'HP' }, sections: [{ id: 'a', label: 'A', fields }] });
    expect(
      bad([
        { key: 'x', label: 'X', type: 'text' },
        { key: 'X', label: 'Y', type: 'text' },
      ]),
    ).toThrow(/Two fields are called/);
    expect(bad([{ key: 'x', label: 'X', type: 'select' }])).toThrow(/options/);
    expect(bad([{ key: 'x', label: 'X', type: 'list' }])).toThrow(/rows/);
    expect(bad([{ key: 'x!', label: 'X', type: 'text' }])).toThrow(/letters/);
  });

  it('reads values forgivingly in each field’s shape', () => {
    expect(coerce(field('Insight'), '3 dots')).toBe(3);
    expect(coerce(field('playbook'), 'cutter')).toBe('Cutter');
    // An option that has since gone is kept as written.
    expect(coerce(field('playbook'), 'Leech')).toBe('Leech');
    expect(coerce(field('stress'), '4/9')).toEqual({ current: 4, max: 9 });
    expect(coerce(field('stress'), { value: 2, maximum: 9 })).toEqual({ current: 2, max: 9 });
    expect(coerce(field('stress'), 6)).toEqual({ current: 6, max: 6 });
    expect(coerce(field('veteran'), 'yes')).toBe(true);
    expect(coerce(field('armour'), '+1')).toBe('+1');
    expect(coerce(field('armour'), '2')).toBe(2);
    expect(coerce(field('abilities'), ['Battleborn', { Ability: 'Bodyguard', tier: '2' }])).toEqual([
      { name: 'Battleborn' },
      { name: 'Bodyguard', tier: 2 },
    ]);
    expect(coerce(field('abilities'), 'Ghost Fighter; Not to be trifled with')).toEqual([
      { name: 'Ghost Fighter' },
      { name: 'Not to be trifled with' },
    ]);
  });

  it('checks a sheet, settling spelling and dropping empty values', () => {
    expect(
      checkSheet(schema, { insight: '2', STRESS: '1/9', notes: 'Owes Lyssa', veteran: false, playbook: '' }),
    ).toEqual({ Insight: 2, stress: { current: 1, max: 9 }, notes: 'Owes Lyssa', veteran: false });
    expect(() => checkSheet(schema, { Insight: 'lots' })).toThrow(/Insight should be a number/);
    expect(() => checkSheet(schema, { stress: 'bad' })).toThrow(/Stress should be a current and a maximum/);
    expect(() => checkSheet(schema, { 'bad/key': 1 })).toThrow(/cannot be a field name/);
    // Something structured under a name the schema does not know is kept as text.
    expect(checkSheet(schema, { contacts: [{ name: 'Lyssa' }] })).toEqual({ contacts: 'Lyssa' });
  });

  it('lets a player fill in a GM-kept field only while it is empty', () => {
    expect(keepGmFields(schema, {}, { heat: 2 })).toEqual({ heat: 2 });
    expect(keepGmFields(schema, { heat: 4 }, { heat: 0, Insight: 1 })).toEqual({ heat: 4, Insight: 1 });
    expect(keepGmFields(schema, { heat: 4 }, {})).toEqual({ heat: 4 });
  });

  it('formats every kind of value as one line', () => {
    expect(formatValue({ current: 3, max: 9 })).toBe('3/9');
    expect(formatValue([{ name: 'Longsword', bonus: '+5' }, { name: 'Dagger' }])).toBe(
      'Longsword (bonus: +5); Dagger',
    );
    expect(formatValue(true)).toBe('yes');
  });

  it('describes the sheet to a model, with GM notes and steps only when asked', () => {
    const guide = schemaGuide(schema);
    expect(guide).toContain('"stress" (Stress) [track: {"current": n, "max": n}; changes during play]');
    expect(guide).toContain('"playbook" (Playbook) [one of: Cutter, Hound, Whisper]');
    expect(guide).toContain('"heat" (Heat) [number; the GM keeps this]');
    expect(guide).toContain('Health are this system');
    expect(guide).not.toContain('Trauma at 9');
    expect(guide).not.toContain('Choose a playbook');
    const full = schemaGuide(schema, { forGm: true, steps: true });
    expect(full).toContain('GM: Trauma at 9.');
    expect(full).toContain('1. Choose a playbook.');
  });

  it('keeps the original fields a template defined', () => {
    expect(fromTemplate({ abilities: ['Wits'], fields: [] }).sections[0]!.fields[0]!.key).toBe('Wits');
  });
});

describe('the GM’s view of the sheet', () => {
  it('is empty for a free-form system and names each field with its GM note otherwise', () => {
    expect(gmSheetGuide(undefined)).toBe('');
    expect(gmSheetGuide({ abilities: [], fields: [] })).toBe('');
    expect(gmSheetGuide(SRD_SHEET)).toContain('GM: Award after encounters');
  });
});
