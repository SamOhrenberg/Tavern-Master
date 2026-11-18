import type {
  Character,
  CharacterController,
  CharacterDraft,
  CharacterKind,
  InventoryItem,
  SheetSuggestion,
  SheetSchema,
} from '@tavern/protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { useAction, useToast } from '../app';
import { IconCheck, IconImage, IconPlus, IconSparkle, IconTrash } from '../icons';
import { Avatar, ConfirmButton, Field, Sheet } from '../ui';
import {
  fieldsOf,
  formatValue,
  initialValues,
  inventoryListField,
  maxHpField,
  readMaxHp,
  SheetSections,
  sheetFromValues,
  type FieldInput,
  type FormValues,
} from './sheet-fields';
import { PortraitCropper, type Crop } from './portrait-crop';

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
const int = (s: string, fallback: number) => {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
};

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
 * system's sheet schema, and anything else on the sheet (fields the DM, the
 * guide or an uploaded sheet added) is listed underneath so nothing is hidden.
 *
 * `draft` pre-fills a new sheet from an upload the AI has read; nothing is
 * saved until the player presses the button.
 */
export function CharacterSheet({
  campaignId,
  schema,
  character,
  draft,
  control,
  mine,
  canDelete,
  onClose,
  onSaved,
}: {
  campaignId: string;
  schema: SheetSchema | undefined;
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
  const fields = fieldsOf(schema);
  const hpLabel = schema?.hp.label ?? 'Hit points';
  // A sheet with its own Max HP field (worked out by the rules) holds the maximum there, not in the box.
  const ownMax = maxHpField(schema);
  // Likewise a sheet with its own inventory list holds the belongings there.
  const ownInventory = !!inventoryListField(schema);
  const source: Record<string, unknown> = character?.sheet ?? draft?.sheet ?? {};
  // Names the schema does not know (fields the DM, the guide or an upload added) are listed underneath.
  const known = new Set(fields.map((f) => f.key.toLowerCase()));

  const [name, setName] = useState(character?.name ?? draft?.name ?? '');
  const [maxHp, setMaxHp] = useState(String(character?.maxHp ?? draft?.maxHp ?? 10));
  const [hp, setHp] = useState(String(character?.hp ?? ''));
  const [values, setValues] = useState<FormValues>(() => initialValues(schema, source));
  const [extras, setExtras] = useState<Extra[]>(() =>
    Object.entries(source)
      .filter(([k, v]) => !known.has(k.toLowerCase()) && formatValue(v) !== '')
      .map(([key, v], id) => ({ id, key, value: formatValue(v) })),
  );
  const [items, setItems] = useState<Row[]>(() =>
    (character?.inventory ?? draft?.inventory ?? []).map((item, id) => ({ ...item, id })),
  );
  const [persona, setPersona] = useState(character?.persona ?? draft?.persona ?? '');
  const [notes, setNotes] = useState(character?.privateNotes ?? '');
  // Changes the rules check proposed on an uploaded draft, until applied or waved off.
  const [suggestions, setSuggestions] = useState<SheetSuggestion[]>(draft?.suggestions ?? []);
  // A picture chosen here goes up with the sheet; until then it is only previewed. The original
  // and the crop are kept so it can be cropped again.
  const [picture, setPicture] = useState<{ blob: Blob; url: string; file: File; crop: Crop } | null>(null);
  const [dropPicture, setDropPicture] = useState(false);
  const [cropping, setCropping] = useState<{ file: File; crop?: Crop } | null>(null);
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

  const choosePicture = (file: File | undefined) => {
    if (picker.current) picker.current.value = '';
    if (file) setCropping({ file });
  };

  const cropped = (blob: Blob, crop: Crop) => {
    if (cropping) setPicture({ blob, url: URL.createObjectURL(blob), file: cropping.file, crop });
    setDropPicture(false);
    setCropping(null);
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

  const set = (key: string, value: FieldInput) => setValues((s) => ({ ...s, [key]: value }));
  const setItem = (id: number, patch: Partial<Row>) =>
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  const setExtra = (id: number, patch: Partial<Extra>) =>
    setExtras((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const dismiss = (s: SheetSuggestion) => setSuggestions((list) => list.filter((x) => x !== s));

  /** Write a suggested value into the matching field, then clear the suggestion. */
  const apply = (s: SheetSuggestion) => {
    const value = String(s.suggested);
    if (s.field === 'maxHp' && !ownMax) setMaxHp(value);
    else if (s.field === 'maxHp' && ownMax) set(ownMax.key, value);
    else {
      const lower = s.field.toLowerCase();
      const field = fields.find((f) => f.key.toLowerCase() === lower);
      if (field?.type === 'track') {
        const [current, max = current] = value.split('/').map((x) => x.trim());
        set(field.key, { current: current ?? '', max: max ?? '' });
      } else if (field?.type === 'checkbox') set(field.key, /^(yes|true)$/i.test(value));
      // A list is not something one suggested value can replace; the suggestion stays to read.
      else if (field?.type === 'list') return;
      else if (field) set(field.key, value);
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
    const out = sheetFromValues(schema, values, source);
    for (const x of extras) {
      const key = keyOf(x.key);
      const value = x.value.trim();
      if (key && value) out[key] = /^-?\d+$/.test(value) ? Number(value) : value;
    }
    // With its own Max HP field, the server reads the maximum from the sheet.
    const max = ownMax
      ? (readMaxHp(values[ownMax.key]) ?? character?.maxHp ?? 10)
      : Math.max(1, int(maxHp, 10));
    const body = {
      name: name.trim(),
      ...(ownMax ? {} : { maxHp: max }),
      ...(character && hp.trim() !== '' ? { hp: Math.max(0, Math.min(max, int(hp, max))) } : {}),
      sheet: out,
      ...(ownInventory
        ? {}
        : {
            inventory: items
              .filter((item) => item.name.trim())
              .map((item) => ({
                name: item.name.trim(),
                qty: Math.max(1, item.qty || 1),
                ...(item.notes ? { notes: item.notes } : {}),
              })),
          }),
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
                      {s.field === 'maxHp'
                        ? (ownMax?.label ?? `Max ${hpLabel.toLowerCase()}`)
                        : (fields.find((f) => f.key.toLowerCase() === s.field.toLowerCase())?.label ??
                          s.field)}
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
            {picture && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => setCropping({ file: picture.file, crop: picture.crop })}
              >
                Crop again
              </button>
            )}
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
            // The extensions too: Windows does not always know HEIC's type, and would hide the files.
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
            onChange={(e) => choosePicture(e.target.files?.[0])}
            tabIndex={-1}
            aria-hidden="true"
          />
          {cropping && (
            <PortraitCropper
              file={cropping.file}
              initial={cropping.crop}
              onCancel={() => setCropping(null)}
              onDone={cropped}
            />
          )}
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

        {(!ownMax || character) && (
          <div className="row top">
            {!ownMax && (
              <Field label={`Max ${hpLabel.toLowerCase()}`}>
                <input
                  className="input"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={maxHp}
                  onChange={(e) => setMaxHp(e.target.value)}
                  required
                />
              </Field>
            )}
            {character && (
              <Field label={ownMax ? `Current ${hpLabel}` : 'Current'}>
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
        )}

        <SheetSections schema={schema} values={values} onChange={set} newSheet={!character} />

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

        {!ownInventory && (
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
        )}

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
