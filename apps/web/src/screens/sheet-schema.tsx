import type { GameSystem, SheetFieldType, SheetSchema } from '@tavern/protocol';
import { useState } from 'react';
import { api } from '../api';
import { useAction } from '../app';
import { initialValues, SheetSections, type FieldInput, type FormValues } from '../play/sheet-fields';
import { SheetDraftControls } from './sheet-draft';
import { Sheet } from '../ui';

const TYPE_LABEL: Record<SheetFieldType, string> = {
  number: 'number',
  text: 'text',
  longtext: 'long text',
  select: 'choice',
  checkbox: 'yes/no',
  track: 'track',
  list: 'list',
  derived: 'worked out',
};

/** The sheet form as a player would see it, to try out. Nothing is saved. */
function Preview({ schema, onClose }: { schema: SheetSchema; onClose: () => void }) {
  const [values, setValues] = useState<FormValues>(() => initialValues(schema, {}));
  const set = (key: string, v: FieldInput) => setValues((s) => ({ ...s, [key]: v }));
  return (
    <Sheet title="The sheet, as players see it" onClose={onClose} tall>
      <div className="stack">
        <p className="small muted note">A preview to try out. Nothing you type here is saved.</p>
        <SheetSections schema={schema} values={values} onChange={set} newSheet />
      </div>
    </Sheet>
  );
}

/** Edit the schema as JSON: the way in before the AI workshop drafts it. */
function EditJson({
  systemId,
  schema,
  onClose,
  onSaved,
}: {
  systemId: string;
  schema: SheetSchema;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(schema, null, 2));
  const [problem, setProblem] = useState('');
  const [busy, run] = useAction();
  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setProblem(`That is not valid JSON: ${(err as Error).message}`);
      return;
    }
    setProblem('');
    // "renames": {"old key": "new key"} beside the schema carries values to a field's new name.
    const { renames: raw, ...schema } = (parsed ?? {}) as { renames?: unknown };
    const renames =
      raw && typeof raw === 'object'
        ? Object.entries(raw as Record<string, unknown>).map(([from, to]) => ({ from, to: String(to) }))
        : [];
    void run(async () => {
      await api(`/systems/${systemId}/sheet-schema`, { method: 'PUT', body: { schema, renames } });
      onSaved();
      onClose();
    }, 'Sheet published as a new version');
  };
  return (
    <Sheet title="Edit the sheet" onClose={onClose} tall>
      <div className="stack">
        <p className="small muted">
          Field types: number, text, longtext, select (with options), checkbox, track (current and maximum),
          list (with itemFields) and derived (with derivedFrom). Saving publishes a new version: campaigns
          already playing keep theirs until their host updates. To rename a field&apos;s key and keep its
          values, add <code>&quot;renames&quot;: &#123;&quot;old key&quot;: &quot;new key&quot;&#125;</code>{' '}
          beside the sections.
        </p>
        <textarea
          className="textarea json-input"
          rows={18}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Sheet schema as JSON"
        />
        {problem && <p className="small error-text">{problem}</p>}
        <button type="button" className="btn primary block" disabled={busy} onClick={save}>
          Save the sheet
        </button>
      </div>
    </Sheet>
  );
}

/**
 * What a character sheet holds in this system: its sections and fields at a
 * glance, a preview of the form, and (for admins) a way to change it.
 */
export function SheetSchemaPanel({
  system,
  manage,
  rulebooks,
  onSaved,
}: {
  system: GameSystem;
  manage: boolean;
  /** Library rulebooks that have finished indexing, which a draft is read from. */
  rulebooks: number;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState<'preview' | 'json' | null>(null);
  const schema = system.sheetSchema;
  const count = schema.sections.reduce((n, s) => n + s.fields.length, 0);
  return (
    <div className="card stack">
      <p className="small muted">
        {count
          ? `${count} field${count === 1 ? '' : 's'} in ${schema.sections.length} section${schema.sections.length === 1 ? '' : 's'}. ${schema.hp.label} are kept apart from the sheet.`
          : 'No fields yet: players write whatever their sheet needs.'}
        {system.sheetVersion > 1 &&
          ` Version ${system.sheetVersion}: new campaigns get it, and campaigns already playing move to it when their host updates.`}
      </p>
      {schema.sections.map((sec) => (
        <div key={sec.id} className="schema-section">
          <b className="small">{sec.label}</b>
          <div className="row wrap schema-fields">
            {sec.fields.map((f) => (
              <span key={f.key} className="pill" title={f.help ?? f.derivedFrom ?? ''}>
                {f.label} <span className="faint">· {TYPE_LABEL[f.type]}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
      {schema.createSteps.length > 0 && (
        <details className="schema-steps">
          <summary className="small">How a character is built ({schema.createSteps.length} steps)</summary>
          <ol className="small muted">
            {schema.createSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </details>
      )}
      {manage && <SheetDraftControls system={system} rulebooks={rulebooks} onChanged={onSaved} />}
      <div className="row wrap">
        {count > 0 && (
          <button type="button" className="btn sm" onClick={() => setOpen('preview')}>
            Preview the form
          </button>
        )}
        {manage && (
          <button type="button" className="btn sm ghost" onClick={() => setOpen('json')}>
            Edit as JSON
          </button>
        )}
      </div>
      {open === 'preview' && <Preview schema={schema} onClose={() => setOpen(null)} />}
      {open === 'json' && (
        <EditJson systemId={system.id} schema={schema} onClose={() => setOpen(null)} onSaved={onSaved} />
      )}
    </div>
  );
}
