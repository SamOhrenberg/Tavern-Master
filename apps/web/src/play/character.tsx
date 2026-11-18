import type {
  Character,
  CharacterController,
  CharacterDraft,
  CharacterKind,
  InventoryItem,
  SheetSuggestion,
  SheetTemplate,
} from '@tavern/protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { useAction, useToast } from '../app';
import { IconCheck, IconImage, IconPlus, IconSparkle, IconTrash } from '../icons';
import { Avatar, ConfirmButton, Field, Sheet } from '../ui';

const LONG = /feature|spell|proficien|skill|trait|background|equipment|note|talent|power/i;

/** Who will run a character that does not exist yet. */
export interface Control {
  kind: CharacterKind;
  controller: CharacterController;
  playerIds: string[];
}

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

/** Pictures are stored this many pixels square: sharp on a phone, small to send. */
const PORTRAIT_PX = 512;

/**
 * Cut the middle square out of a picture (a little above centre on a tall one,
 * where a face usually is), shrink it and encode it as JPEG, so a phone photo
 * of several megabytes uploads as a few dozen kilobytes.
 */
async function squarePortrait(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That picture could not be read. Try a PNG or JPEG.'));
      i.src = url;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const side = Math.min(w, h);
    const out = Math.min(PORTRAIT_PX, side);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot prepare pictures.');
    // JPEG has no transparency: give cut-out art a dark backdrop instead of black.
    ctx.fillStyle = '#26222e';
    ctx.fillRect(0, 0, out, out);
    ctx.drawImage(img, (w - side) / 2, (h - side) / 4, side, side, 0, 0, out, out);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('That picture could not be prepared.'))),
        'image/jpeg',
        0.86,
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface Row extends InventoryItem {
  id: number;
}
interface Extra {
  id: number;
  key: string;
  value: string;
}

/**
 * Create or edit a character sheet by hand. The form is drawn from the game
 * system's sheet template, and anything else on the sheet (fields the DM, the
 * guide or an uploaded sheet added) is listed underneath so nothing is hidden.
 *
 * `draft` pre-fills a new sheet from an upload the AI has read; nothing is
 * saved until the player presses the button.
 */
export function CharacterSheet({
  campaignId,
  template,
  character,
  draft,
  control,
  mine,
  canDelete,
  onClose,
  onSaved,
}: {
  campaignId: string;
  template: SheetTemplate | undefined;
  character?: Character;
  draft?: CharacterDraft;
  /** For a new character. Left out, it is the player's own. */
  control?: Control;
  /** True when the viewer is one of the players who run it (private notes are theirs). */
  mine: boolean;
  canDelete?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const abilities = template?.abilities ?? [];
  const fields = template?.fields ?? [];
  const source: Record<string, unknown> = character?.sheet ?? draft?.sheet ?? {};
  // An uploaded sheet may spell a field differently from the template ("strength" for "Strength").
  const lookup = (key: string) => {
    const hit = Object.keys(source).find((k) => k.toLowerCase() === key.toLowerCase());
    return hit === undefined ? '' : text(source[hit]);
  };
  const known = new Set([
    ...abilities.map((a) => keyOf(a).toLowerCase()),
    ...fields.map((f) => f.key.toLowerCase()),
  ]);

  const [name, setName] = useState(character?.name ?? draft?.name ?? '');
  const [maxHp, setMaxHp] = useState(String(character?.maxHp ?? draft?.maxHp ?? 10));
  const [hp, setHp] = useState(String(character?.hp ?? ''));
  const [sheet, setSheet] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const a of abilities) init[keyOf(a)] = lookup(keyOf(a));
    for (const f of fields) init[f.key] = lookup(f.key);
    return init;
  });
  const [extras, setExtras] = useState<Extra[]>(() =>
    Object.entries(source)
      .filter(([k, v]) => !known.has(k.toLowerCase()) && text(v) !== '')
      .map(([key, v], id) => ({ id, key, value: text(v) })),
  );
  const [items, setItems] = useState<Row[]>(() =>
    (character?.inventory ?? draft?.inventory ?? []).map((item, id) => ({ ...item, id })),
  );
  const [persona, setPersona] = useState(character?.persona ?? draft?.persona ?? '');
  const [notes, setNotes] = useState(character?.privateNotes ?? '');
  // Changes the rules check proposed on an uploaded draft, until applied or waved off.
  const [suggestions, setSuggestions] = useState<SheetSuggestion[]>(draft?.suggestions ?? []);
  // A picture chosen here goes up with the sheet; until then it is only previewed.
  const [picture, setPicture] = useState<{ blob: Blob; url: string } | null>(null);
  const [dropPicture, setDropPicture] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const notify = useToast();
  const [busy, run] = useAction();
  useEffect(
    () => () => {
      if (picture) URL.revokeObjectURL(picture.url);
    },
    [picture],
  );
  const shownPicture = picture?.url ?? (dropPicture ? undefined : character?.portrait);

  const choosePicture = async (file: File | undefined) => {
    if (picker.current) picker.current.value = '';
    if (!file) return;
    try {
      const blob = await squarePortrait(file);
      setPicture({ blob, url: URL.createObjectURL(blob) });
      setDropPicture(false);
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  /** Send the picture change, if any, once the character exists. */
  const savePicture = async (id: string) => {
    const path = `/campaigns/${campaignId}/characters/${id}/portrait`;
    if (picture) {
      const form = new FormData();
      form.append('file', picture.blob, 'portrait.jpg');
      await api(path, { method: 'PUT', form });
    } else if (dropPicture && character?.portrait) {
      await api(path, { method: 'DELETE' });
    }
  };

  const companion = (character?.kind ?? control?.kind) === 'npc';
  const aiRun = (character?.controller ?? control?.controller ?? 'player') !== 'player';

  const set = (key: string, value: string) => setSheet((s) => ({ ...s, [key]: value }));
  const setItem = (id: number, patch: Partial<Row>) =>
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  const setExtra = (id: number, patch: Partial<Extra>) =>
    setExtras((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const dismiss = (s: SheetSuggestion) => setSuggestions((list) => list.filter((x) => x !== s));

  /** Write a suggested value into the matching field, then clear the suggestion. */
  const apply = (s: SheetSuggestion) => {
    const value = String(s.suggested);
    if (s.field === 'maxHp') setMaxHp(value);
    else {
      const lower = s.field.toLowerCase();
      const stateKey = [...abilities.map(keyOf), ...fields.map((f) => f.key)].find(
        (k) => k.toLowerCase() === lower,
      );
      if (stateKey) set(stateKey, value);
      else
        setExtras((list) => {
          const idx = list.findIndex((x) => keyOf(x.key).toLowerCase() === lower);
          if (idx >= 0) return list.map((x, i) => (i === idx ? { ...x, value } : x));
          return [...list, { id: Math.max(-1, ...list.map((e) => e.id)) + 1, key: s.field, value }];
        });
    }
    dismiss(s);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const out: Record<string, string | number> = {};
    const put = (key: string, raw: string, numeric: boolean) => {
      const value = raw.trim();
      if (!key || value === '') return;
      out[key] = numeric && /^-?\d+$/.test(value) ? Number(value) : value;
    };
    for (const a of abilities) put(keyOf(a), sheet[keyOf(a)] ?? '', true);
    for (const f of fields) put(f.key, sheet[f.key] ?? '', false);
    for (const x of extras) put(keyOf(x.key), x.value, true);
    const max = Math.max(1, int(maxHp, 10));
    const body = {
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
      persona,
      ...(mine ? { privateNotes: notes } : {}),
    };
    void run(
      async () => {
        let id = character?.id;
        if (character) {
          await api(`/campaigns/${campaignId}/characters/${character.id}`, { method: 'PUT', body });
        } else {
          ({ id } = await api<{ id: string }>(`/campaigns/${campaignId}/characters`, {
            body: { character: body, control },
          }));
        }
        // The sheet is saved either way: a picture that fails to send must not leave the form
        // open for a second "Join the party" that would make the character twice.
        if (id)
          await savePicture(id).catch((err) =>
            notify(`The sheet is saved, but the picture was not: ${errorMessage(err)}`, 'error'),
          );
        onSaved();
      },
      character ? 'Sheet saved' : companion ? `${body.name} joins the party` : 'Welcome to the party',
    );
  };

  const remove = () =>
    run(async () => {
      await api(`/campaigns/${campaignId}/characters/${character!.id}`, { method: 'DELETE' });
      onSaved();
    }, `${character!.name} has left the party`);

  const title = character
    ? `${character.name}’s sheet`
    : draft
      ? 'Check the sheet'
      : companion
        ? 'New companion'
        : 'New character';

  return (
    <Sheet title={title} onClose={onClose} tall>
      <form className="stack" onSubmit={submit}>
        {draft && !character && (
          <p className="small muted note">
            This is what was read from your upload. Fix anything that came out wrong, then save.
          </p>
        )}
        {suggestions.length > 0 && (
          <div className="sheet-checks">
            <div className="sheet-checks-head">
              <IconSparkle />
              <b>The rules suggest a few changes</b>
            </div>
            {suggestions.map((s, i) => (
              <div key={i} className="sheet-check">
                <div className="grow">
                  <div className="sheet-check-what">
                    <span className="sheet-check-field">
                      {s.field === 'maxHp' ? 'Max hit points' : s.field}
                    </span>
                    <span className="sheet-check-change">
                      <s>{s.current}</s> → <b>{String(s.suggested)}</b>
                    </span>
                  </div>
                  <p className="small muted">{s.reason}</p>
                </div>
                <div className="sheet-check-acts">
                  <button type="button" className="btn sm" onClick={() => apply(s)}>
                    <IconCheck /> Apply
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => dismiss(s)}>
                    Ignore
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="portrait-pick">
          <button
            type="button"
            className="portrait-btn"
            onClick={() => picker.current?.click()}
            aria-label={shownPicture ? 'Change the picture' : 'Add a picture'}
          >
            <Avatar name={name || '?'} seed={character?.id ?? name} src={shownPicture} large />
            <span className="portrait-badge" aria-hidden="true">
              <IconImage />
            </span>
          </button>
          <div className="portrait-acts">
            <button type="button" className="btn sm ghost" onClick={() => picker.current?.click()}>
              {shownPicture ? 'Change picture' : 'Add a picture'}
            </button>
            {shownPicture && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  setPicture(null);
                  setDropPicture(true);
                }}
              >
                Remove
              </button>
            )}
          </div>
          <input
            ref={picker}
            type="file"
            className="sr-only"
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
            onChange={(e) => void choosePicture(e.target.files?.[0])}
            tabIndex={-1}
            aria-hidden="true"
          />
        </div>

        <Field label="Name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={companion ? 'Bram Stoutheart' : 'Kara Emberfall'}
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
          <span className="label">More on the sheet</span>
          <div className="stack tight item-rows">
            {extras.map((x) => (
              <div key={x.id} className="extra-row">
                <div className="row">
                  <input
                    className="input grow"
                    value={x.key}
                    onChange={(e) => setExtra(x.id, { key: e.target.value })}
                    placeholder="Field, e.g. Languages"
                    maxLength={40}
                    aria-label="Field name"
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setExtras((list) => list.filter((e) => e.id !== x.id))}
                    aria-label={`Remove ${x.key || 'field'}`}
                  >
                    <IconTrash />
                  </button>
                </div>
                <textarea
                  className="textarea"
                  rows={x.value.length > 60 ? 3 : 1}
                  value={x.value}
                  onChange={(e) => setExtra(x.id, { value: e.target.value })}
                  maxLength={1500}
                  aria-label={`${x.key || 'Field'} value`}
                />
              </div>
            ))}
            <button
              type="button"
              className="btn sm ghost add-item"
              onClick={() =>
                setExtras((list) => [
                  ...list,
                  { id: Math.max(-1, ...list.map((e) => e.id)) + 1, key: '', value: '' },
                ])
              }
            >
              <IconPlus /> Add a field
            </button>
          </div>
        </div>

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

        <Field
          label="Who they are"
          hint={
            aiRun
              ? 'Personality, voice, motives. The AI plays this character from what you write here.'
              : 'Personality, looks, history, goals. The DM reads this; so can the party.'
          }
        >
          <textarea
            className="textarea"
            rows={4}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            maxLength={2000}
          />
        </Field>

        {mine && (
          <Field label="Private notes" hint="Only you can read these. The DM and other players cannot.">
            <textarea
              className="textarea"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={4000}
            />
          </Field>
        )}

        <button type="submit" className="btn primary block" disabled={busy}>
          {character ? 'Save sheet' : companion ? 'Add to the party' : 'Join the party'}
        </button>
        {character && canDelete && (
          <ConfirmButton
            className="btn danger block"
            confirmLabel={`Tap again to remove ${character.name}`}
            disabled={busy}
            onConfirm={() => void remove()}
          >
            Remove from the party
          </ConfirmButton>
        )}
      </form>
    </Sheet>
  );
}
