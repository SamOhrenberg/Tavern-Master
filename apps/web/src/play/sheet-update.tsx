import type { CampaignDetail, SheetUpdate } from '@tavern/protocol';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useAction, useToast } from '../app';
import { ProposalBody } from '../screens/sheet-draft';
import { ConfirmButton, Loading, Sheet } from '../ui';

/**
 * For the host: the version of the system's sheet this campaign is on, and a
 * way to move to a newer one when an admin has published it.
 */
export function SheetVersionCard({
  campaign: c,
  onChanged,
}: {
  campaign: CampaignDetail;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!c.sheetUpdate) {
    return (
      <p className="small muted">
        {c.systemName}&rsquo;s character sheet, version {c.sheetVersion}: the latest.
      </p>
    );
  }
  return (
    <div className="card stack sheet-version">
      <div>
        <b>A newer character sheet is out</b>
        <p className="small muted">
          An admin changed what {c.systemName} sheets hold. This campaign is on version {c.sheetVersion};
          version {c.sheetUpdate.version} is the latest. Nothing changes here until you update.
        </p>
      </div>
      <button type="button" className="btn block" onClick={() => setOpen(true)}>
        See what changes
      </button>
      {open && <UpdateSheet campaignId={c.id} onClose={() => setOpen(false)} onDone={onChanged} />}
    </div>
  );
}

function UpdateSheet({
  campaignId,
  onClose,
  onDone,
}: {
  campaignId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [update, setUpdate] = useState<SheetUpdate | null | undefined>(undefined);
  const [busy, run] = useAction();
  const notify = useToast();

  const load = useCallback(
    () =>
      api<{ update: SheetUpdate | null }>(`/campaigns/${campaignId}/sheet-update`)
        .then((r) => setUpdate(r.update))
        .catch((err) => notify(errorMessage(err), 'error')),
    [campaignId, notify],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const affected = (update?.characters ?? []).filter((ch) => ch.moved.length || ch.kept.length);

  return (
    <Sheet title="Update the character sheet" onClose={onClose} tall>
      {update === undefined ? (
        <Loading />
      ) : update === null ? (
        <p className="muted">This campaign is on the latest version of the sheet.</p>
      ) : (
        <div className="stack">
          <p className="small muted">
            Version {update.from} → {update.to}. Every character&rsquo;s values come along: a field that is
            gone keeps its value under &ldquo;More on the sheet&rdquo;.
          </p>
          {update.changes.length === 0 ? (
            <p className="small muted">The fields are the same; only how they are kept differs.</p>
          ) : (
            update.changes.map((p) => (
              <div key={p.id} className={`proposal kind-${p.kind} on`}>
                <span className="proposal-body">
                  <ProposalBody p={p} />
                </span>
              </div>
            ))
          )}
          {affected.length > 0 && (
            <>
              <div className="section-title">
                <span>On the party&rsquo;s sheets</span>
              </div>
              {affected.map((ch) => (
                <div key={ch.name} className="card">
                  <b>{ch.name}</b>
                  <ul className="proposal-lines">
                    {ch.moved.map((m) => (
                      <li key={`m-${m.from}`}>
                        {m.from} moves to {m.to}
                      </li>
                    ))}
                    {ch.kept.map((k) => (
                      <li key={`k-${k.field}`}>
                        {k.field} no longer fits the new sheet: kept as &ldquo;{k.as}&rdquo; to sort out by
                        hand
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
          <ConfirmButton
            className="btn primary block"
            confirmLabel="Every sheet in the campaign changes. Tap again"
            disabled={busy}
            onConfirm={() =>
              void run(async () => {
                try {
                  await api(`/campaigns/${campaignId}/sheet-update`, { body: { version: update.to } });
                } catch (err) {
                  // A newer version came out while this was open: show that one instead.
                  await load();
                  throw err;
                }
                onDone();
                onClose();
              }, `The campaign is on version ${update.to} of the sheet`)
            }
          >
            Update to version {update.to}
          </ConfirmButton>
        </div>
      )}
    </Sheet>
  );
}
