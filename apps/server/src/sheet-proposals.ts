import type { SheetField, SheetProposal, SheetRename, SheetSchema, SheetSection } from '@tavern/protocol';
import { parseSchema } from './sheet-schema.js';

/**
 * A draft sheet (from the AI drafter, the workshop or Claude) set against the
 * sheet a system has now, as a list of changes an admin applies or ignores
 * one by one. Applying merges only the accepted changes into the current
 * sheet, so nothing the admin did not choose ever reaches the players.
 */

const low = (key: string) => key.toLowerCase();

/** A field with its properties in a fixed order and unset ones left out, to compare by content. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined && x !== false && !(Array.isArray(x) && !x.length))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canon(x)]),
    );
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

interface Placed {
  field: SheetField;
  section: SheetSection;
}

function placesOf(schema: SheetSchema): Map<string, Placed> {
  const out = new Map<string, Placed>();
  for (const section of schema.sections)
    for (const field of section.fields) out.set(low(field.key), { field, section });
  return out;
}

const TYPE_NAME: Record<SheetField['type'], string> = {
  number: 'number',
  text: 'text',
  longtext: 'long text',
  select: 'choice',
  checkbox: 'yes/no',
  track: 'track',
  list: 'list',
  derived: 'worked out',
};

/** What differs between two versions of a field, one short line each. */
function describeChange(before: SheetField, after: SheetField): string[] {
  const out: string[] = [];
  if (before.label !== after.label) out.push(`name: ${before.label} → ${after.label}`);
  if (before.type !== after.type) out.push(`kind: ${TYPE_NAME[before.type]} → ${TYPE_NAME[after.type]}`);
  if (!same(before.options, after.options))
    out.push(after.options?.length ? `choices: ${after.options.join(', ')}` : 'choices removed');
  if (!same(before.itemFields, after.itemFields))
    out.push(
      after.itemFields?.length
        ? `row fields: ${after.itemFields.map((f) => f.label).join(', ')}`
        : 'row fields removed',
    );
  if (before.min !== after.min || before.max !== after.max)
    out.push(`range: ${after.min ?? '…'} to ${after.max ?? '…'}`);
  const textual: [keyof SheetField, string][] = [
    ['derivedFrom', 'rule'],
    ['help', 'help text'],
    ['gmNote', 'note for the GM'],
  ];
  for (const [prop, name] of textual) {
    if (before[prop] === after[prop]) continue;
    out.push(!before[prop] ? `${name} added` : !after[prop] ? `${name} removed` : `${name} rewritten`);
  }
  if ((before.setAt ?? 'creation') !== (after.setAt ?? 'creation'))
    out.push(after.setAt === 'play' ? 'changes during play' : 'set when the character is made');
  if ((before.editableBy ?? 'both') !== (after.editableBy ?? 'both'))
    out.push(after.editableBy === 'gm' ? 'the GM keeps it' : 'players keep it');
  if (!!before.showOnCard !== !!after.showOnCard)
    out.push(after.showOnCard ? 'shown on the party card' : 'taken off the party card');
  return out;
}

/** Every change the draft would make to the current sheet. */
export function proposalsFor(current: SheetSchema, draft: SheetSchema): SheetProposal[] {
  const now = placesOf(current);
  const next = placesOf(draft);
  const out: SheetProposal[] = [];

  for (const section of draft.sections) {
    for (const field of section.fields) {
      const was = now.get(low(field.key));
      if (!was) {
        out.push({ id: `add:${low(field.key)}`, kind: 'add', section: section.label, field });
        continue;
      }
      // The current spelling of the name is kept, so values already on sheets stay where they are.
      const after = { ...field, key: was.field.key };
      const changes = describeChange(was.field, after);
      if (was.section.id !== section.id) changes.push(`moved to ${section.label}`);
      if (changes.length)
        out.push({
          id: `change:${low(field.key)}`,
          kind: 'change',
          section: section.label,
          field: after,
          before: was.field,
          changes,
        });
    }
  }
  for (const [key, was] of now) {
    if (!next.has(key))
      out.push({ id: `remove:${key}`, kind: 'remove', section: was.section.label, field: was.field });
  }
  if (current.hp.label !== draft.hp.label)
    out.push({ id: 'hp', kind: 'hp', before: current.hp.label, after: draft.hp.label });
  if (!same(current.createSteps, draft.createSteps))
    out.push({ id: 'steps', kind: 'steps', before: current.createSteps, after: draft.createSteps });

  // Sections both sheets have: a different name or order is one change of its own.
  const shared = new Set(
    current.sections.map((s) => s.id).filter((id) => draft.sections.some((d) => d.id === id)),
  );
  const before = current.sections.filter((s) => shared.has(s.id)).map((s) => s.label);
  const after = draft.sections.filter((s) => shared.has(s.id)).map((s) => s.label);
  if (!same(before, after)) out.push({ id: 'sections', kind: 'sections', before, after });
  return out;
}

/**
 * The current sheet with the accepted changes made, checked. Ids the draft
 * no longer proposes are ignored. Sections left with no fields are dropped.
 */
export function applyProposals(current: SheetSchema, draft: SheetSchema, accept: string[]): SheetSchema {
  const ok = new Set(accept);
  const chosen = proposalsFor(current, draft).filter((p) => ok.has(p.id));
  const sections: SheetSection[] = current.sections.map((s) => ({ ...s, fields: [...s.fields] }));
  const draftPlaces = placesOf(draft);

  const take = (key: string) => {
    for (const s of sections) {
      const i = s.fields.findIndex((f) => low(f.key) === low(key));
      if (i >= 0) return { section: s, index: i, field: s.fields.splice(i, 1)[0]! };
    }
    return undefined;
  };
  const sectionFor = (draftSection: SheetSection) => {
    let s = sections.find((x) => x.id === draftSection.id);
    if (!s) {
      s = { id: draftSection.id, label: draftSection.label, fields: [] };
      sections.push(s);
    }
    return s;
  };
  /** Put a field where the draft has it: after the nearest field before it that is there too. */
  const place = (field: SheetField, draftSection: SheetSection) => {
    const target = sectionFor(draftSection);
    const order = draftSection.fields.map((f) => low(f.key));
    let at = 0;
    for (let i = order.indexOf(low(field.key)) - 1; i >= 0; i--) {
      const j = target.fields.findIndex((f) => low(f.key) === order[i]);
      if (j >= 0) {
        at = j + 1;
        break;
      }
    }
    target.fields.splice(at, 0, field);
  };

  for (const p of chosen) if (p.kind === 'remove') take(p.field.key);
  for (const p of chosen) {
    if (p.kind !== 'change') continue;
    const was = take(p.field.key);
    const home = draftPlaces.get(low(p.field.key))!.section;
    // A field that stays in its section keeps its place there.
    if (was && was.section.id === home.id) was.section.fields.splice(was.index, 0, p.field);
    else place(p.field, home);
  }
  for (const p of chosen) if (p.kind === 'add') place(p.field, draftPlaces.get(low(p.field.key))!.section);

  let ordered = sections;
  if (ok.has('sections') && chosen.some((p) => p.kind === 'sections')) {
    const rank = new Map(draft.sections.map((s, i) => [s.id, i]));
    ordered = [
      ...sections.filter((s) => rank.has(s.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!),
      ...sections.filter((s) => !rank.has(s.id)),
    ].map((s) => ({ ...s, label: draft.sections.find((d) => d.id === s.id)?.label ?? s.label }));
  }

  return parseSchema({
    version: 2,
    hp: ok.has('hp') && chosen.some((p) => p.kind === 'hp') ? draft.hp : current.hp,
    sections: ordered.filter((s) => s.fields.length),
    createSteps:
      ok.has('steps') && chosen.some((p) => p.kind === 'steps') ? draft.createSteps : current.createSteps,
  });
}

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Fields the draft seems to replace with a new one: a field it removes and a
 * field it adds under the same label (or the same name but for spelling).
 * Usually a drafter that named a field afresh, whose values should follow.
 */
export function suggestRenames(proposals: SheetProposal[]): SheetRename[] {
  const removed = proposals.filter((p) => p.kind === 'remove');
  const added = proposals.filter((p) => p.kind === 'add');
  const out: SheetRename[] = [];
  const used = new Set<string>();
  for (const r of removed) {
    const match = added.find(
      (a) =>
        !used.has(a.field.key) &&
        (plain(a.field.label) === plain(r.field.label) || plain(a.field.key) === plain(r.field.key)),
    );
    if (!match) continue;
    used.add(match.field.key);
    out.push({ from: r.field.key, to: match.field.key });
  }
  return out;
}
