import type { SheetField, SheetSchema, SheetSection } from '@tavern/protocol';
import { z } from 'zod';
import { draftField } from './agent/sheet-drafter.js';
import { parseSchema, tidySchema } from './sheet-schema.js';

/**
 * Small edits to a sheet schema, as the workshop AI (or Claude) makes them in
 * conversation: add, change, move or remove a field, rename or reorder a
 * section, rename hit points, set the creation steps. Easier for a model to
 * get right than rewriting the whole schema, and each one says what it did.
 */

const key = z.string().trim().min(1).max(60).describe('A field key on the sheet');
const sectionId = z.string().trim().min(1).max(60).describe('A section id; a new id makes a new section');

export const sheetOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_field'),
    section: sectionId,
    section_label: z.string().max(60).optional().describe('Label for a new section'),
    after: key.optional().describe('Put it after this field; left out, it goes last in the section'),
    field: draftField,
  }),
  z.object({
    op: z.literal('update_field'),
    key,
    changes: draftField
      .omit({ key: true })
      .partial()
      .describe('Only what changes; the rest of the field stays as it is'),
  }),
  z.object({ op: z.literal('move_field'), key, section: sectionId, after: key.optional() }),
  z.object({ op: z.literal('remove_field'), key }),
  z.object({
    op: z.literal('section'),
    id: sectionId,
    label: z.string().min(1).max(60),
    position: z.number().int().min(0).optional().describe('0 for first; left out, it stays where it is'),
  }),
  z.object({ op: z.literal('hp_label'), label: z.string().min(1).max(40) }),
  z.object({ op: z.literal('create_steps'), steps: z.array(z.string().max(300)).max(20) }),
]);
export type SheetOp = z.infer<typeof sheetOp>;

/** A change that cannot be made, with why, for the model to correct. */
export class SheetOpError extends Error {}

const low = (s: string) => s.trim().toLowerCase();
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'section';

/** Apply the edits in order to a copy of the schema, and check the result. */
export function applySheetOps(base: SheetSchema, ops: SheetOp[]): { schema: SheetSchema; done: string[] } {
  const sections: SheetSection[] = base.sections.map((s) => ({
    ...s,
    fields: s.fields.map((f) => ({ ...f })),
  }));
  let hp = base.hp;
  let steps = base.createSteps;
  const done: string[] = [];

  const find = (k: string) => {
    for (const s of sections) {
      const i = s.fields.findIndex((f) => low(f.key) === low(k));
      if (i >= 0) return { section: s, index: i, field: s.fields[i]! };
    }
    return undefined;
  };
  const section = (id: string, label?: string) => {
    const sid = slug(id);
    let s = sections.find((x) => x.id === sid);
    if (!s) {
      s = { id: sid, label: (label ?? id).trim().slice(0, 60) || sid, fields: [] };
      sections.push(s);
    }
    return s;
  };
  const put = (s: SheetSection, field: SheetField, after?: string) => {
    const i = after ? s.fields.findIndex((f) => low(f.key) === low(after)) : -1;
    if (after && i < 0) throw new SheetOpError(`There is no field "${after}" in ${s.label} to put it after.`);
    s.fields.splice(i < 0 ? s.fields.length : i + 1, 0, field);
  };

  for (const op of ops) {
    switch (op.op) {
      case 'add_field': {
        if (find(op.field.key))
          throw new SheetOpError(
            `There is already a field "${op.field.key}". Use update_field to change it.`,
          );
        put(section(op.section, op.section_label), op.field as SheetField, op.after);
        done.push(`added ${op.field.label}`);
        break;
      }
      case 'update_field': {
        const at = find(op.key);
        if (!at) throw new SheetOpError(`There is no field "${op.key}".`);
        // The key stays: a renamed key would leave every character's value behind.
        at.section.fields[at.index] = {
          ...at.field,
          ...(op.changes as Partial<SheetField>),
          key: at.field.key,
        };
        done.push(`changed ${at.field.label}`);
        break;
      }
      case 'move_field': {
        const at = find(op.key);
        if (!at) throw new SheetOpError(`There is no field "${op.key}".`);
        at.section.fields.splice(at.index, 1);
        put(section(op.section), at.field, op.after);
        done.push(`moved ${at.field.label}`);
        break;
      }
      case 'remove_field': {
        const at = find(op.key);
        if (!at) throw new SheetOpError(`There is no field "${op.key}".`);
        at.section.fields.splice(at.index, 1);
        done.push(`removed ${at.field.label}`);
        break;
      }
      case 'section': {
        const s = section(op.id, op.label);
        s.label = op.label.trim();
        if (op.position !== undefined) {
          sections.splice(sections.indexOf(s), 1);
          sections.splice(Math.min(op.position, sections.length), 0, s);
        }
        done.push(`section ${s.label}`);
        break;
      }
      case 'hp_label':
        hp = { label: op.label.trim() };
        done.push(`hit points called ${hp.label}`);
        break;
      case 'create_steps':
        steps = op.steps;
        done.push('creation steps');
        break;
    }
  }
  try {
    return {
      schema: parseSchema(tidySchema({ version: 2, hp, sections, createSteps: steps })),
      done,
    };
  } catch (err) {
    throw new SheetOpError(err instanceof Error ? err.message : String(err));
  }
}
