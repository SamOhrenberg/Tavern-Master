import type { SheetSchema } from '@tavern/protocol';
import { describe, expect, it } from 'vitest';
import { draftFromRecord } from '../src/agent/sheets.js';
import { dispatchTool } from '../src/agent/tools.js';
import {
  inventoryList,
  inventoryOf,
  putInventory,
  schemaGuide,
  writesInventory,
} from '../src/sheet-schema.js';
import { SRD_SHEET } from '../src/srd-sheet.js';
import { character, context, FakeStore } from './fake-store.js';

/** A sheet that keeps its own inventory, as Dungeon Crawler Carl's does, beside equipped gear. */
const OWN_LIST: SheetSchema = {
  version: 2,
  hp: { label: 'HP' },
  sections: [
    {
      id: 'gear',
      label: 'Gear',
      fields: [
        {
          key: 'equipList',
          label: 'Equipped gear',
          type: 'list',
          itemFields: [{ key: 'name', label: 'Item', type: 'text' }],
        },
        {
          key: 'invList',
          label: 'Inventory',
          type: 'list',
          itemFields: [
            { key: 'name', label: 'Item', type: 'text' },
            { key: 'qty', label: 'Qty', type: 'number' },
            { key: 'rarity', label: 'Rarity', type: 'select', options: ['Bronze', 'Silver'] },
            { key: 'notes', label: 'Notes', type: 'text' },
          ],
        },
      ],
    },
  ],
  createSteps: [],
};

describe("a sheet's own inventory list", () => {
  it('is found by name or label, and not mistaken for equipped gear', () => {
    expect(inventoryList(OWN_LIST)).toMatchObject({ name: 'name', qty: 'qty', notes: 'notes' });
    expect(inventoryList(OWN_LIST)?.field.key).toBe('invList');
    expect(inventoryList(SRD_SHEET)).toBeUndefined();
    expect(writesInventory(OWN_LIST, ['Inventory'])).toBe(true);
    expect(writesInventory(OWN_LIST, ['equipList'])).toBe(false);
  });

  it('reads as the inventory, and takes changes keeping its other columns', () => {
    const sheet: Record<string, unknown> = {
      invList: [
        { name: 'Health potion', qty: 3, rarity: 'Bronze' },
        { name: 'Rope', rarity: 'Silver', notes: '50 ft' },
      ],
    };
    expect(inventoryOf(OWN_LIST, sheet, [{ name: 'Ignored', qty: 1 }])).toEqual([
      { name: 'Health potion', qty: 3 },
      { name: 'Rope', qty: 1, notes: '50 ft' },
    ]);
    expect(inventoryOf(SRD_SHEET, sheet, [{ name: 'Kept', qty: 1 }])).toEqual([{ name: 'Kept', qty: 1 }]);

    expect(
      putInventory(OWN_LIST, sheet, [
        { name: 'health potion', qty: 2 },
        { name: 'Torch', qty: 1 },
      ]),
    ).toBe(true);
    expect(sheet.invList).toEqual([
      { name: 'health potion', qty: 2, rarity: 'Bronze' },
      { name: 'Torch', qty: 1 },
    ]);
    expect(putInventory(SRD_SHEET, {}, [])).toBe(false);
  });

  it('tells a model to write belongings in the list', () => {
    expect(schemaGuide(OWN_LIST)).toContain('Belongings are the "invList" list');
    expect(schemaGuide(SRD_SHEET)).not.toContain('Belongings are');
  });

  it('takes the items of an uploaded sheet when its list is empty', () => {
    const draft = draftFromRecord({ name: 'Carl', inventory: [{ name: 'Torch', qty: 2 }] }, OWN_LIST);
    expect(draft?.sheet.invList).toEqual([{ name: 'Torch', qty: 2 }]);
    expect(draft?.inventory).toEqual([{ name: 'Torch', qty: 2 }]);
  });

  it("is where the GM's inventory changes land", async () => {
    const store = new FakeStore();
    store.schema = OWN_LIST;
    store.chars = [
      character({
        id: 'c1',
        playerIds: ['u-ann'],
        name: 'Thorn',
        sheet: { invList: [{ name: 'Health potion', qty: 3, rarity: 'Bronze' }] },
      }),
    ];
    const done = await dispatchTool(
      'modify_inventory',
      { character: 'Thorn', remove: [{ name: 'Health potion', qty: 1 }], add: [{ name: 'Torch', qty: 2 }] },
      context(),
      store,
    );
    expect(done.isError).toBeFalsy();
    expect(store.chars[0]!.sheet.invList).toEqual([
      { name: 'Health potion', qty: 2, rarity: 'Bronze' },
      { name: 'Torch', qty: 2 },
    ]);
  });
});
