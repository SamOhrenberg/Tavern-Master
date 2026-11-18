import type { GameSystem, SheetDraftView, SheetField, SheetProposal } from '@tavern/protocol';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useAction, useToast } from '../app';
import { IconSparkle } from '../icons';
import { Loading, Sheet } from '../ui';

const KIND_LABEL: Record<SheetField['type'], string> = {
  number: 'number',
  text: 'text',
  longtext: 'long text',
  select: 'choice',
  checkbox: 'yes/no',
  track: 'track',
  list: 'list',
  derived: 'worked out',
};

/** What a new field would hold, in a line or two. */
function FieldSummary({ field }: { field: SheetField }) {
  const bits = [
    field.options?.length ? `Choices: ${field.options.join(', ')}` : '',
    field.itemFields?.length ? `Each row: ${field.itemFields.map((f) => f.label).join(', ')}` : '',
    field.derivedFrom ? `Worked out: ${field.derivedFrom}` : '',
    field.help ?? '',
    field.gmNote ? `For the GM: ${field.gmNote}` : '',
  ].filter(Boolean);
  return bits.length ? (
    <ul className="proposal-lines">
      {bits.map((b, i) => (
        <li key={i}>{b}</li>
      ))}
    </ul>
  ) : null;
}

function ProposalBody({ p }: { p: SheetProposal }) {
  switch (p.kind) {
    case 'add':
      return (
        <>
          <b>
            Add {p.field.label} <span className="faint">· {KIND_LABEL[p.field.type]}</span>
          </b>
          <span className="small muted">in {p.section}</span>
          <FieldSummary field={p.field} />
        </>
      );
    case 'change':
      return (
        <>
          <b>Change {p.before.label}</b>
          <ul className="proposal-lines">
            {p.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      );
    case 'remove':
      return (
        <>
          <b>Remove {p.field.label}</b>
          <span className="small muted">
            From {p.section}. Values already on sheets stay, under &ldquo;More on the sheet&rdquo;.
          </span>
        </>
      );
    case 'hp':
      return (
        <>
          <b>Call hit points &ldquo;{p.after}&rdquo;</b>
          <span className="small muted">Now &ldquo;{p.before}&rdquo;</span>
        </>
      );
    case 'steps':
      return (
        <>
          <b>How a character is built</b>
          <ol className="proposal-lines">
            {p.after.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </>
      );
    case 'sections':
      return (
        <>
          <b>Sections: {p.after.join(' · ')}</b>
          <span className="small muted">Now {p.before.join(' · ')}</span>
        </>
      );
  }
}

/** Removals take something off every sheet, so they start unticked; everything else starts ticked. */
const startsAccepted = (p: SheetProposal) => p.kind !== 'remove';

/**
 * Go through a draft change by change: tick what to keep, then apply. Only
 * the ticked changes reach the sheet; the draft is let go either way.
 */
function Review({
  systemId,
  onClose,
  onDone,
}: {
  systemId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [view, setView] = useState<SheetDraftView | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [busy, run] = useAction();
  const notify = useToast();

  useEffect(() => {
    api<SheetDraftView>(`/systems/${systemId}/sheet-draft`)
      .then((v) => {
        setView(v);
        setAccepted(new Set(v.proposals.filter(startsAccepted).map((p) => p.id)));
      })
      .catch((err) => notify(errorMessage(err), 'error'));
  }, [systemId, notify]);

  const toggle = (id: string) =>
    setAccepted((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const proposals = view?.proposals ?? [];
  const chosen = proposals.filter((p) => accepted.has(p.id)).length;

  return (
    <Sheet title="Review the draft" onClose={onClose} tall>
      {!view ? (
        <Loading />
      ) : (
        <div className="stack">
          {view.notes.length > 0 && (
            <div className="sheet-checks">
              <div className="sheet-checks-head">
                <IconSparkle />
                <b>The rulebooks left these open</b>
              </div>
              <ul className="proposal-lines">
                {view.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          {proposals.length === 0 ? (
            <p className="muted">The draft matches the sheet you have. There is nothing to change.</p>
          ) : (
            <>
              <div className="row">
                <p className="small muted grow">
                  Tick what to keep. Removals start unticked, because they take a field off every sheet.
                </p>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() =>
                    setAccepted(chosen === proposals.length ? new Set() : new Set(proposals.map((p) => p.id)))
                  }
                >
                  {chosen === proposals.length ? 'Untick all' : 'Tick all'}
                </button>
              </div>
              {proposals.map((p) => (
                <label key={p.id} className={`proposal kind-${p.kind}${accepted.has(p.id) ? ' on' : ''}`}>
                  <span className="proposal-body">
                    <ProposalBody p={p} />
                  </span>
                  <input type="checkbox" checked={accepted.has(p.id)} onChange={() => toggle(p.id)} />
                </label>
              ))}
            </>
          )}
          <button
            type="button"
            className="btn primary block"
            disabled={busy || chosen === 0}
            onClick={() =>
              void run(
                async () => {
                  await api(`/systems/${systemId}/sheet-draft/apply`, { body: { accept: [...accepted] } });
                  onDone();
                  onClose();
                },
                `Sheet updated with ${chosen} change${chosen === 1 ? '' : 's'}`,
              )
            }
          >
            {chosen ? `Apply ${chosen} change${chosen === 1 ? '' : 's'}` : 'Tick a change to apply it'}
          </button>
          <button
            type="button"
            className="btn ghost block"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`/systems/${systemId}/sheet-draft`, { method: 'DELETE' });
                onDone();
                onClose();
              }, 'Draft discarded')
            }
          >
            Discard the draft
          </button>
        </div>
      )}
    </Sheet>
  );
}

/**
 * For admins: have the AI draft the sheet from the rulebooks, follow it while
 * it works, and review what it proposes.
 */
export function SheetDraftControls({
  system,
  rulebooks,
  onChanged,
}: {
  system: GameSystem;
  /** Library rulebooks that have finished indexing. */
  rulebooks: number;
  onChanged: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, run] = useAction();
  const status = system.sheetDraftStatus ?? 'none';
  const hasFields = system.sheetSchema.sections.some((s) => s.fields.length);

  // Why the last attempt failed is kept with the draft; fetch it when there is one to show.
  useEffect(() => {
    if (status !== 'failed') return setFailure(null);
    api<SheetDraftView>(`/systems/${system.id}/sheet-draft`)
      .then((v) => setFailure(v.error))
      .catch(() => setFailure(null));
  }, [status, system.id]);

  const start = () =>
    run(async () => {
      await api(`/systems/${system.id}/sheet-draft`, { method: 'POST', body: {} });
      onChanged();
    }, 'Drafting has started. It takes a minute or two.');

  if (status === 'queued' || status === 'drafting')
    return (
      <div className="draft-state">
        <span className="pill arcane">
          <i className="live" /> {status === 'queued' ? 'Waiting to draft' : 'Reading the rulebooks'}
        </span>
        <span className="small muted">
          The AI is drafting this sheet. It changes nothing until you review it.
        </span>
      </div>
    );

  return (
    <>
      {status === 'ready' && (
        <div className="draft-state ready">
          <IconSparkle />
          <span className="grow small">The AI has drafted this sheet from the rulebooks.</span>
          <button type="button" className="btn sm primary" onClick={() => setReviewing(true)}>
            Review
          </button>
        </div>
      )}
      {status === 'failed' && (
        <p className="small error-text">The last draft did not work{failure ? `: ${failure}` : '.'}</p>
      )}
      {status !== 'ready' && (
        <button
          type="button"
          className="btn sm"
          disabled={busy || rulebooks === 0}
          onClick={() => void start()}
          title={rulebooks === 0 ? 'Upload a rulebook first' : undefined}
        >
          <IconSparkle /> {hasFields ? 'Redraft from the rulebooks' : 'Draft from the rulebooks'}
        </button>
      )}
      {status !== 'ready' && rulebooks === 0 && (
        <p className="small faint">Upload a rulebook first: the draft is read from it.</p>
      )}
      {reviewing && <Review systemId={system.id} onClose={() => setReviewing(false)} onDone={onChanged} />}
    </>
  );
}
