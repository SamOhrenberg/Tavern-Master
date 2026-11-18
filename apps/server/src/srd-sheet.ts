import type { SheetSchema } from '@tavern/protocol';

/**
 * The starter system's original template. Kept so a server that still has it
 * unchanged can be moved to {@link SRD_SHEET}; one an admin has edited is left alone.
 */
export const SRD_TEMPLATE_V1 = {
  abilities: ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'],
  fields: [
    { key: 'class', label: 'Class' },
    { key: 'level', label: 'Level' },
    { key: 'species', label: 'Species' },
    { key: 'background', label: 'Background' },
    { key: 'armorClass', label: 'Armor Class' },
    { key: 'speed', label: 'Speed' },
    { key: 'proficiencies', label: 'Proficiencies' },
    { key: 'features', label: 'Features & spells' },
  ],
};

const ability = (key: string) => ({
  key,
  label: key,
  type: 'number' as const,
  min: 1,
  max: 30,
  showOnCard: true,
  gmNote: `Modifier: (${key} − 10) ÷ 2, rounded down. Checks and saves add it.`,
});

/**
 * A fifth-edition character sheet, written by hand rather than drafted from the
 * documents. It keeps every field name of the original template, so sheets
 * made before it read the same.
 */
export const SRD_SHEET: SheetSchema = {
  version: 2,
  hp: { label: 'Hit points' },
  sections: [
    {
      id: 'identity',
      label: 'Who they are',
      fields: [
        { key: 'class', label: 'Class', type: 'text', showOnCard: true, help: 'With subclass once chosen.' },
        { key: 'level', label: 'Level', type: 'number', min: 1, max: 20, setAt: 'play', showOnCard: true },
        { key: 'species', label: 'Species', type: 'text', showOnCard: true },
        { key: 'background', label: 'Background', type: 'text' },
        {
          key: 'alignment',
          label: 'Alignment',
          type: 'select',
          options: [
            'Lawful good',
            'Neutral good',
            'Chaotic good',
            'Lawful neutral',
            'Neutral',
            'Chaotic neutral',
            'Lawful evil',
            'Neutral evil',
            'Chaotic evil',
          ],
        },
        {
          key: 'experience',
          label: 'Experience points',
          type: 'number',
          min: 0,
          setAt: 'play',
          editableBy: 'gm',
          gmNote: 'Award after encounters and milestones; level up at the thresholds in the rules.',
        },
      ],
    },
    {
      id: 'abilities',
      label: 'Abilities',
      fields: ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'].map(ability),
    },
    {
      id: 'combat',
      label: 'Combat',
      fields: [
        {
          key: 'armorClass',
          label: 'Armor Class',
          type: 'derived',
          derivedFrom: '10 + Dexterity modifier unarmoured, or as the armour worn says; +2 with a shield',
          showOnCard: true,
        },
        { key: 'initiative', label: 'Initiative', type: 'derived', derivedFrom: 'Dexterity modifier' },
        { key: 'speed', label: 'Speed', type: 'text', help: 'In feet, e.g. 30 ft.' },
        {
          key: 'proficiencyBonus',
          label: 'Proficiency bonus',
          type: 'derived',
          derivedFrom: '+2 at levels 1–4, +3 at 5–8, +4 at 9–12, +5 at 13–16, +6 at 17–20',
        },
        {
          key: 'hitDice',
          label: 'Hit dice',
          type: 'track',
          setAt: 'play',
          help: 'One per level; spent to heal on a short rest, half regained on a long rest.',
          gmNote:
            'On a short rest a character may spend hit dice: roll each plus Constitution modifier to heal.',
        },
        {
          key: 'attacks',
          label: 'Attacks',
          type: 'list',
          itemFields: [
            { key: 'name', label: 'Weapon or attack', type: 'text' },
            { key: 'bonus', label: 'To hit', type: 'text' },
            { key: 'damage', label: 'Damage', type: 'text' },
          ],
          gmNote: 'Ask for attack rolls with the listed bonus, and damage with the listed dice.',
        },
      ],
    },
    {
      id: 'proficiencies',
      label: 'Proficiencies',
      fields: [
        {
          key: 'savingThrows',
          label: 'Saving throws',
          type: 'text',
          help: 'The two the class is proficient in.',
        },
        {
          key: 'skills',
          label: 'Skills',
          type: 'longtext',
          help: 'Proficient skills with their bonus, e.g. Stealth +5.',
        },
        {
          key: 'proficiencies',
          label: 'Proficiencies',
          type: 'longtext',
          help: 'Armour, weapons, tools and languages.',
        },
      ],
    },
    {
      id: 'features',
      label: 'Features & spells',
      fields: [
        { key: 'features', label: 'Features & traits', type: 'longtext', setAt: 'play' },
        {
          key: 'spellSaveDc',
          label: 'Spell save DC',
          type: 'derived',
          derivedFrom: '8 + proficiency bonus + spellcasting ability modifier',
        },
        {
          key: 'spellSlots',
          label: 'Spell slots',
          type: 'list',
          setAt: 'play',
          itemFields: [
            { key: 'level', label: 'Spell level', type: 'number' },
            { key: 'total', label: 'Slots', type: 'number' },
            { key: 'used', label: 'Used', type: 'number' },
          ],
          gmNote: 'Casting a levelled spell uses a slot of its level or higher; a long rest restores them.',
        },
        {
          key: 'spells',
          label: 'Spells',
          type: 'list',
          setAt: 'play',
          itemFields: [
            { key: 'name', label: 'Spell', type: 'text' },
            { key: 'level', label: 'Level', type: 'number', help: '0 for a cantrip' },
            { key: 'prepared', label: 'Prepared', type: 'checkbox' },
          ],
        },
      ],
    },
  ],
  createSteps: [
    'Choose a species and a class, and talk through the concept.',
    'Set ability scores: the standard array (15, 14, 13, 12, 10, 8), point buy, or roll 4d6 and drop the lowest.',
    'Choose a background; note its skill and tool proficiencies.',
    'Record class features, saving throws and skill choices for level 1.',
    'Work out hit points (class hit die maximum + Constitution modifier), Armor Class and attacks.',
    'For a spellcaster, choose cantrips and spells and note spell slots.',
    'Pick equipment, then write who they are: personality, looks, history and goals.',
  ],
};
