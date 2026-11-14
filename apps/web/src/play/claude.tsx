import type { CampaignDetail, ConnectorToken, DmStatus } from '@tavern/protocol';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { reloadMeta, useAction, useMeta, useQuery } from '../app';
import { IconCheck } from '../icons';
import { ConfirmButton, CopyRow, Segmented, Sheet, copyText, timeAgo } from '../ui';

/** Where Claude is, in a few words. */
export function dmLine(dm: DmStatus): string {
  switch (dm.state) {
    case 'listening':
      return 'Claude is at the table';
    case 'working':
      return 'Claude is working';
    case 'away':
      return `Claude is away · here ${timeAgo(dm.lastSeenAt)}`;
    case 'never':
      return 'Claude has not joined yet';
  }
}

/** A dot and a line saying whether Claude is at the table. */
export function DmChip({ dm }: { dm: DmStatus }) {
  return (
    <span className={`dm-chip ${dm.state}`} role="status">
      <i aria-hidden="true" />
      <span className="truncate">{dmLine(dm)}</span>
      {dm.waiting > 0 && dm.state !== 'working' && (
        <span className="dm-chip-count">{dm.waiting} waiting</span>
      )}
    </span>
  );
}

/** Claude is not at the table right now, so nothing will be answered until it is. */
export const dmAbsent = (dm: DmStatus | null | undefined): boolean =>
  !!dm && dm.mode === 'claude' && (dm.state === 'away' || dm.state === 'never');

/** The three lines for adding Tavern Master to Claude by signing in. */
export function SignInSteps() {
  return (
    <ol className="steps small">
      <li>
        In Claude, open <b>Customize → Connectors</b> and choose <b>Add custom connector</b>.
      </li>
      <li>Name it Tavern Master, paste the address, and press Connect.</li>
      <li>Approve the connection when Tavern Master asks.</li>
    </ol>
  );
}

function Step({
  n,
  done,
  title,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={`setup-step${done ? ' done' : ''}`}>
      <header className="row">
        <span className="setup-mark" aria-hidden="true">
          {done ? <IconCheck /> : n}
        </span>
        <h3 className="grow">{title}</h3>
        {done && <span className="sr-only">Done</span>}
      </header>
      <div className="setup-body">{children}</div>
    </section>
  );
}

/**
 * Connecting Claude to one campaign, for its owner: add the connector, give
 * Claude the campaign (a chat Project, or the folder that runs by itself),
 * and say hello. Each step ticks itself off as it happens.
 */
export function ClaudeSetupSheet({
  campaign: c,
  dm,
  onClose,
  onChanged,
}: {
  campaign: CampaignDetail;
  dm: DmStatus;
  onClose: () => void;
  onChanged: () => void;
}) {
  const meta = useMeta();
  const setup = useQuery(
    () =>
      api<{ url: string; pinnedUrl: string; projectInstructions: string; claudeConnected: boolean }>(
        `/campaigns/${c.id}/connector`,
      ),
    [c.id],
  );
  const conns = useQuery(() => api<{ tokens: ConnectorToken[] }>('/account/connector'), []);
  const [how, setHow] = useState<'chat' | 'folder'>('chat');
  const [busy, run] = useAction();

  const used = (conns.data?.tokens ?? []).map((t) => t.lastUsedAt).filter((t): t is string => !!t);
  const lastUsed = used.sort().at(-1) ?? null;
  const connected = !!lastUsed || !!meta?.claudeConnected;
  const hello = dm.state !== 'never';

  // Watch for the connection being made in another tab or on another device.
  const reloadConns = conns.reload;
  useEffect(() => {
    if (connected) return;
    const tick = window.setInterval(() => {
      void reloadConns();
      void reloadMeta();
    }, 10_000);
    return () => window.clearInterval(tick);
  }, [connected, reloadConns]);

  const switchToBuiltIn = () =>
    run(async () => {
      await api(`/campaigns/${c.id}`, { method: 'PATCH', body: { dm: 'server' } });
      onChanged();
      onClose();
    }, 'The built-in AI runs this campaign now');

  return (
    <Sheet title="Connect Claude" onClose={onClose} tall>
      <div className="stack setup">
        {how === 'chat' && (
          <Step n={1} done={connected} title="Add Tavern Master to Claude">
            {connected ? (
              <p className="small muted">
                Connected. Last used {timeAgo(lastUsed)}. <Link to="/you">Manage connections</Link>
              </p>
            ) : (
              <>
                <div className="list">{setup.data && <CopyRow label="Address" value={setup.data.url} />}</div>
                <SignInSteps />
              </>
            )}
          </Step>
        )}

        <Step n={how === 'chat' ? 2 : 1} done={hello} title="Give Claude this campaign">
          <Segmented
            value={how}
            onChange={setHow}
            options={[
              { value: 'chat', label: 'Claude app' },
              { value: 'folder', label: 'Runs by itself' },
            ]}
          />
          {how === 'chat' ? (
            <>
              <p className="small">
                Make a Project named <b>{c.name}</b>, paste these as its instructions, and turn the Tavern
                Master connector on.
              </p>
              {setup.data && (
                <div className="card stack">
                  <p className="small muted project-text">{setup.data.projectInstructions}</p>
                  <button
                    type="button"
                    className="btn block"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (!(await copyText(setup.data!.projectInstructions)))
                          throw new Error('Could not copy. Select the text and copy it instead.');
                      }, 'Instructions copied')
                    }
                  >
                    Copy instructions
                  </button>
                </div>
              )}
              <p className="small muted">
                Set the connector’s tools to <b>Always allow</b> so play is not interrupted. A chat runs while
                you keep it going: say <i>run the table</i>, and again when Claude stops.
              </p>
            </>
          ) : (
            <>
              <p className="small">
                Download this campaign’s folder, unzip it, and open it in Claude Desktop (Code tab) or run{' '}
                <span className="mono">claude</span> inside it. Type <span className="mono">/loop /dm</span>.
              </p>
              <a className="btn block wide-only" href={`/api/campaigns/${c.id}/connector/kit`} download>
                Download folder
              </a>
              <p className="small note narrow-only">Do this step on the computer that runs Claude.</p>
              <p className="small muted">
                The first time, Claude opens your browser to sign in to Tavern Master. Approve it.
              </p>
            </>
          )}
        </Step>

        <Step n={how === 'chat' ? 3 : 2} done={hello} title="Say hello">
          {hello ? (
            <p className="small muted">Claude opened this campaign {timeAgo(dm.lastSeenAt)}.</p>
          ) : (
            <>
              <p className="small">
                In Claude, say: <i>{how === 'chat' ? 'open the table' : '/dm'}</i>.
              </p>
              <DmChip dm={dm} />
            </>
          )}
          {hello && <DmChip dm={dm} />}
        </Step>

        {meta?.builtInAi && (
          <ConfirmButton
            className="btn ghost block"
            confirmLabel="Claude stops running this table. Tap again"
            disabled={busy}
            onConfirm={() => void switchToBuiltIn()}
          >
            Use the built-in AI instead
          </ConfirmButton>
        )}
      </div>
    </Sheet>
  );
}
