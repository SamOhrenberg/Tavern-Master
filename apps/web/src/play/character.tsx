import type { Character, InventoryItem, SheetTemplate } from '@tavern/protocol';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAction } from '../app';
import { IconPlus, IconTrash } from '../icons';
import { Field, Sheet } from '../ui';

const LONG = /feature|spell|proficien|skill|trait|background|equipment|note|talent|power/i;

/** Sheet keys may only hold letters, digits, underscores and spaces. */
const keyOf = (label: string) =>
  label
    .replace(/[^\w ]+/g, ' ')
    .trim()
    .slice(0, 40);
const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const int = (s: string, fallback: number) => {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
};

interface Row extends InventoryItem {
  id: number;
}

/**
 * Create or edit your own character. The form is drawn from the game
 * system's sheet template, so it fits whatever rules the campaign uses.
 */
export function CharacterSheet({
  campaignId,
  template,
  character,
  onClose,
  onSaved,
}: {
  campaignId: string;
  template: SheetTemplate | undefined;
  character: Character | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const abilities = template?.abilities ?? [];
  const fields = template?.fields ?? [];
  const [name, setName] = useState(character?.name ?? '');
  const [maxHp, setMaxHp] = useState(String(character?.maxHp ?? 10));
  const [hp, setHp] = useState(String(character?.hp ?? ''));
  const [sheet, setSheet] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const a of abilities) init[keyOf(a)] = text(character?.sheet[keyOf(a)]);
    for (const f of fields) init[f.key] = text(character?.sheet[f.key]);
    return init;
  });
  const [items, setItems] = useState<Row[]>(() =>
    (character?.inventory ?? []).map((item, id) => ({ ...item, id })),
  );
  const [notes, setNotes] = useState(character?.privateNotes ?? '');
  const [busy, run] = useAction();

  const set = (key: string, value: string) => setSheet((s) => ({ ...s, [key]: value }));
  const setItem = (id: number, patch: Partial<Row>) =>
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Keep anything on the sheet this form does not know about.
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(character?.sheet ?? {})) {
      if (typeof v === 'string' || typeof v === 'number') out[k] = v;
    }
    for (const a of abilities) {
      const raw = (sheet[keyOf(a)] ?? '').trim();
      if (raw === '') delete out[keyOf(a)];
      else out[keyOf(a)] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    }
    for (const f of fields) {
      const raw = (sheet[f.key] ?? '').trim();
      if (raw === '') delete out[f.key];
      else out[f.key] = raw;
    }
    const max = Math.max(1, int(maxHp, 10));
    void run(
      async () => {
        await api(`/campaigns/${campaignId}/character`, {
          method: 'PUT',
          body: {
            name: name.trim(),
            maxHp: max,
            ...(character && hp.trim() !== '' ? { hp: Math.max(0, Math.min(max, int(hp, max))) } : {}),
            sheet: out,
            inventory: items
              .filter((item) => item.name.trim())
              .map((item) => ({
                name: item.name.trim(),
                qty: Math.max(1, item.qty || 1),
                ...(item.notes ? { notes: item.notes } : {}),
              })),
            privateNotes: notes,
          },
        });
        onSaved();
      },
      character ? 'Character saved' : 'Welcome to the party',
    );
  };

  return (
    <Sheet title={character ? 'Edit character' : 'Create your character'} onClose={onClose} tall>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Kara Emberfall"
            maxLength={60}
            required
          />
        </Field>

        <div className="row top">
          <Field label="Max hit points">
            <input
              className="input"
              inputMode="numeric"
              pattern="[0-9]*"
              value={maxHp}
              onChange={(e) => setMaxHp(e.target.value)}
              required
            />
          </Field>
          {character && (
            <Field label="Current">
              <input
                className="input"
                inputMode="numeric"
                pattern="[0-9]*"
                value={hp}
                onChange={(e) => setHp(e.target.value)}
              />
            </Field>
          )}
        </div>

        {abilities.length > 0 && (
          <div>
            <span className="label">Abilities</span>
            <div className="ability-inputs">
              {abilities.map((a) => (
                <label key={a} className="ability-input">
                  <span>{a}</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={sheet[keyOf(a)] ?? ''}
                    onChange={(e) => set(keyOf(a), e.target.value)}
                    placeholder="10"
                    maxLength={6}
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        {fields.map((f) => (
          <Field key={f.key} label={f.label}>
            {LONG.test(f.key) || LONG.test(f.label) ? (
              <textarea
                className="textarea"
                rows={3}
                value={sheet[f.key] ?? ''}
                onChange={(e) => set(f.key, e.target.value)}
                maxLength={1500}
              />
            ) : (
              <input
                className="input"
                value={sheet[f.key] ?? ''}
                onChange={(e) => set(f.key, e.target.value)}
                maxLength={200}
              />
            )}
          </Field>
        ))}

        <div>
          <span className="label">Inventory</span>
          <div className="stack tight item-rows">
            {items.map((item) => (
              <div key={item.id} className="row item-row">
                <input
                  className="input grow"
                  value={item.name}
                  onChange={(e) => setItem(item.id, { name: e.target.value })}
                  placeholder="Item"
                  maxLength={80}
                  aria-label="Item name"
                />
                <input
                  className="input qty-input"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={item.qty || ''}
                  onChange={(e) => setItem(item.id, { qty: int(e.target.value, 0) })}
                  aria-label="Quantity"
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setItems((list) => list.filter((x) => x.id !== item.id))}
                  aria-label={`Remove ${item.name || 'item'}`}
                >
                  <IconTrash />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn sm ghost add-item"
              onClick={() =>
                setItems((list) => [
                  ...list,
                  { id: Math.max(-1, ...list.map((x) => x.id)) + 1, name: '', qty: 1 },
                ])
              }
            >
              <IconPlus /> Add an item
            </button>
          </div>
        </div>

        <Field label="Private notes" hint="Only you can read these. The DM and other players cannot.">
          <textarea
            className="textarea"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={4000}
          />
        </Field>

        <button type="submit" className="btn primary block" disabled={busy}>
          {character ? 'Save character' : 'Join the party'}
        </button>
      </form>
    </Sheet>
  );
}
