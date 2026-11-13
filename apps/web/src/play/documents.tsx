import type { CampaignDocKind, CampaignDocument } from '@tavern/protocol';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { useAction, useQuery, useToast } from '../app';
import { IconTrash, IconUpload } from '../icons';
import { ConfirmButton, Skeletons } from '../ui';

const KINDS: { value: CampaignDocKind; label: string }[] = [
  { value: 'setting', label: 'Setting' },
  { value: 'adventure', label: 'Adventure' },
  { value: 'rules', label: 'House rules' },
  { value: 'character', label: 'Character' },
  { value: 'handout', label: 'Handout' },
  { value: 'other', label: 'Other' },
];

const STATUS: Record<CampaignDocument['status'], { label: string; tone: string; live: boolean }> = {
  queued: { label: 'Queued', tone: '', live: true },
  parsing: { label: 'Reading', tone: 'gold', live: true },
  embedding: { label: 'Indexing', tone: 'arcane', live: true },
  ready: { label: 'Ready', tone: 'jade', live: false },
  failed: { label: 'Failed', tone: 'ember', live: false },
};

const size = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Still being read, indexed or described by the DM. */
const working = (d: CampaignDocument) => STATUS[d.status].live || (d.status === 'ready' && d.kind === null);

/**
 * Documents that belong to this campaign: a setting, an adventure, house
 * rules, backstories. The DM reads and catalogues each one and looks things
 * up in them during play. They are never shown back to the table as files.
 */
export function Documents({ campaignId }: { campaignId: string }) {
  const notify = useToast();
  const docs = useQuery(
    () => api<{ documents: CampaignDocument[] }>(`/campaigns/${campaignId}/documents`),
    [campaignId],
  );
  const [uploading, setUploading] = useState(false);
  const [busy, run] = useAction();
  const picker = useRef<HTMLInputElement>(null);

  const list = docs.data?.documents ?? [];
  const pending = list.some(working);
  const reload = docs.reload;

  // Reading and cataloguing happen in the background: poll while anything is in flight.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => void reload(), 2500);
    return () => window.clearInterval(timer);
  }, [pending, reload]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('title', file.name.replace(/\.[^.]+$/, ''));
      form.append('file', file);
      await api(`/campaigns/${campaignId}/documents`, { form });
      notify('Uploaded. The DM is reading it.');
      await reload();
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = '';
    }
  };

  const act = (fn: () => Promise<unknown>, done?: string) =>
    run(async () => {
      await fn();
      await reload();
    }, done);
  const patch = (d: CampaignDocument, body: Partial<Pick<CampaignDocument, 'audience' | 'kind'>>) =>
    act(() => api(`/campaigns/${campaignId}/documents/${d.id}`, { method: 'PATCH', body }));

  return (
    <div className="stack">
      {docs.loading ? (
        <Skeletons count={1} />
      ) : docs.error ? (
        <div className="form-error">{docs.error}</div>
      ) : (
        list.map((d) => {
          const st = STATUS[d.status];
          const cataloguing = d.status === 'ready' && d.kind === null;
          return (
            <div key={d.id} className="card doc">
              <div className="row">
                <div className="grow">
                  <h3 className="truncate">{d.title}</h3>
                  <p className="small muted truncate">
                    {size(d.sizeBytes)}
                    {d.uploadedBy ? ` · from ${d.uploadedBy.displayName}` : ''}
                  </p>
                </div>
                <span className={`pill ${cataloguing ? 'arcane' : st.tone}`}>
                  {(st.live || cataloguing) && <i className="live" />}
                  {cataloguing ? 'Cataloguing' : st.label}
                </span>
              </div>
              {d.status === 'failed' && (
                <p className="small danger doc-error">{d.error ?? 'Could not be read.'}</p>
              )}
              {d.summary && <p className="small muted doc-summary">{d.summary}</p>}
              {d.audience === 'gm' && !d.summary && d.status === 'ready' && (
                <p className="small faint doc-summary">For the DM’s eyes only.</p>
              )}
              {d.canEdit ? (
                <div className="doc-controls">
                  <select
                    className="select sm"
                    value={d.kind ?? 'other'}
                    disabled={busy || d.status !== 'ready'}
                    onChange={(e) => void patch(d, { kind: e.target.value as CampaignDocKind })}
                    aria-label="Kind of document"
                  >
                    {KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="select sm"
                    value={d.audience}
                    disabled={busy}
                    onChange={(e) => void patch(d, { audience: e.target.value as 'table' | 'gm' })}
                    aria-label="Who it is for"
                  >
                    <option value="table">For everyone</option>
                    <option value="gm">DM only</option>
                  </select>
                  {d.status === 'failed' && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => api(`/campaigns/${campaignId}/documents/${d.id}/retry`, { method: 'POST' }),
                          'Trying again',
                        )
                      }
                    >
                      Retry
                    </button>
                  )}
                  <ConfirmButton
                    className="btn sm ghost"
                    confirmLabel="Delete?"
                    disabled={busy}
                    onConfirm={() =>
                      void act(
                        () => api(`/campaigns/${campaignId}/documents/${d.id}`, { method: 'DELETE' }),
                        'Document removed',
                      )
                    }
                  >
                    <IconTrash /> Remove
                  </ConfirmButton>
                </div>
              ) : (
                d.kind && (
                  <div className="row wrap doc-controls">
                    <span className="pill">{KINDS.find((k) => k.value === d.kind)?.label}</span>
                    {d.audience === 'gm' && <span className="pill arcane">DM only</span>}
                  </div>
                )
              )}
            </div>
          );
        })
      )}

      <input
        ref={picker}
        type="file"
        className="sr-only"
        accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain"
        onChange={(e) => void upload(e.target.files?.[0])}
        tabIndex={-1}
        aria-hidden="true"
      />
      <button
        type="button"
        className="btn block"
        disabled={uploading}
        onClick={() => picker.current?.click()}
      >
        <IconUpload /> {uploading ? 'Uploading…' : 'Add a document'}
      </button>
      <p className="small faint">
        PDF, Markdown or text. The DM reads each one, notes what it holds, and looks things up in it during
        play. Mark an adventure “for the DM only” to keep its surprises.
      </p>
    </div>
  );
}
