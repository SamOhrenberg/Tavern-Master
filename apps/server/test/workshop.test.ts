import type { SheetSchema } from '@tavern/protocol';
import { describe, expect, it } from 'vitest';
import { systemPrompt } from '../src/agent/context.js';
import { guideText, toGuide, withoutRuling, withRuling, withTopic, EMPTY_GUIDE } from '../src/gm-guide.js';
import { applySheetOps, SheetOpError } from '../src/sheet-ops.js';

const sheet: SheetSchema = {
  version: 2,
  hp: { label: 'Hit points' },
  sections: [
    {
      id: 'core',
      label: 'Core',
      fields: [
        { key: 'class', label: 'Class', type: 'text' },
        { key: 'level', label: 'Level', type: 'number' },
      ],
    },
    { id: 'gear', label: 'Gear', fields: [{ key: 'pack', label: 'Pack', type: 'longtext' }] },
  ],
  createSteps: [],
};

describe('the GM guide', () => {
  it('keeps one entry per known topic, in the guide’s order, and drops the rest', () => {
    const guide = toGuide({
      topics: [
        { id: 'scenes', text: 'Cut to the action.' },
        { id: 'resolution', text: 'Roll 2d6 + stat.' },
        { id: 'resolution', text: 'A later duplicate wins.' },
        { id: 'astrology', text: 'Not a topic.' },
        { id: 'harm', text: '   ' },
      ],
      rulings: [
        { id: 'a1', text: 'Fumbles break weapons.', createdAt: '2026-01-01T00:00:00Z' },
        { text: 'no id' },
      ],
    });
    expect(guide.topics).toEqual([
      { id: 'resolution', text: 'A later duplicate wins.' },
      { id: 'scenes', text: 'Cut to the action.' },
    ]);
    expect(guide.rulings.map((r) => r.id)).toEqual(['a1']);
    expect(toGuide('nonsense')).toEqual(EMPTY_GUIDE);
  });

  it('rewrites a topic, adds and retires rulings', () => {
    let guide = withTopic(EMPTY_GUIDE, 'rolls', 'Ask for a roll only when failure is interesting.');
    guide = withTopic(guide, 'resolution', 'Roll 2d6 + stat: 10+ succeeds, 7–9 at a cost.');
    expect(guide.topics.map((t) => t.id)).toEqual(['resolution', 'rolls']);
    expect(withTopic(guide, 'rolls', '').topics.map((t) => t.id)).toEqual(['resolution']);

    const added = withRuling(guide, 'Healing potions take an action.')!;
    expect(added.guide.rulings).toHaveLength(1);
    expect(withoutRuling(added.guide, added.id)!.rulings).toEqual([]);
    expect(withoutRuling(added.guide, 'nope')).toBeUndefined();
  });

  it('reads to the GM topic by topic, with the rulings last, and as nothing when empty', () => {
    const guide = withRuling(
      withTopic(EMPTY_GUIDE, 'harm', 'At 0 HP a character is out, not dead.'),
      'No crits on saves.',
    )!.guide;
    expect(guideText(guide)).toBe(
      '### Harm and recovery\nAt 0 HP a character is out, not dead.\n\n### Rulings for every table\n- No crits on saves.',
    );
    expect(guideText(EMPTY_GUIDE)).toBe('');

    const info = { id: 'c', name: 'Crow Court', premise: '', tone: '', systemName: 'Crow Rules' };
    expect(systemPrompt({ ...info, gmGuide: guideText(guide) })).toContain('## Running Crow Rules');
    expect(systemPrompt(info)).not.toContain('## Running');
  });
});

describe('editing a sheet in small steps', () => {
  it('adds, changes, moves and removes fields, and keeps keys as they are', () => {
    const { schema, done } = applySheetOps(sheet, [
      {
        op: 'add_field',
        section: 'core',
        after: 'class',
        field: { key: 'stress', label: 'Stress', type: 'track' },
      },
      {
        op: 'update_field',
        key: 'CLASS',
        changes: { label: 'Playbook', type: 'select', options: ['Cutter'] },
      },
      { op: 'move_field', key: 'level', section: 'gear' },
      { op: 'remove_field', key: 'pack' },
      { op: 'section', id: 'harm', label: 'Harm', position: 0 },
      { op: 'add_field', section: 'harm', field: { key: 'trauma', label: 'Trauma', type: 'longtext' } },
      { op: 'hp_label', label: 'Harm' },
      { op: 'create_steps', steps: ['Choose a playbook.'] },
    ]);
    expect(schema.sections.map((s) => [s.label, s.fields.map((f) => f.key)])).toEqual([
      ['Harm', ['trauma']],
      ['Core', ['class', 'stress']],
      ['Gear', ['level']],
    ]);
    expect(schema.sections[1]!.fields[0]).toMatchObject({ key: 'class', label: 'Playbook', type: 'select' });
    expect(schema.hp.label).toBe('Harm');
    expect(schema.createSteps).toEqual(['Choose a playbook.']);
    expect(done).toContain('added Stress');
  });

  it('says what is wrong instead of guessing', () => {
    expect(() => applySheetOps(sheet, [{ op: 'remove_field', key: 'ghost' }])).toThrow(SheetOpError);
    expect(() =>
      applySheetOps(sheet, [
        { op: 'add_field', section: 'core', field: { key: 'Level', label: 'Lvl', type: 'number' } },
      ]),
    ).toThrow(/already a field "Level"/);
    expect(() =>
      applySheetOps(sheet, [
        { op: 'add_field', section: 'core', after: 'nowhere', field: { key: 'x', label: 'X', type: 'text' } },
      ]),
    ).toThrow(/no field "nowhere"/);
    // A select without options is put right by the tidy-up rather than refused.
    const { schema } = applySheetOps(sheet, [
      { op: 'update_field', key: 'class', changes: { type: 'select' } },
    ]);
    expect(schema.sections[0]!.fields[0]!.type).toBe('text');
  });
});
