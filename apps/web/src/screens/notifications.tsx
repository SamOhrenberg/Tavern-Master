import type { NotifyCategory, NotifyPrefs, NotifySettings, QuietHours } from '@tavern/protocol';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAction, useQuery } from '../app';
import { IconAlert, IconBell, IconClose } from '../icons';
import { openInstallGuide } from '../install';
import { disablePush, enablePush, pushState, type PushState } from '../push';
import { Sheet } from '../ui';

const CATEGORIES: { key: NotifyCategory; title: string; detail: string }[] = [
  { key: 'narration', title: 'The story moves on', detail: 'The DM narrates what happens next.' },
  { key: 'rolls', title: 'Your roll', detail: 'The DM asks one of your characters to roll.' },
  {
    key: 'waiting',
    title: 'Waiting on you',
    detail: 'A turn has been waiting a few minutes for your move.',
  },
  { key: 'actions', title: 'Party actions', detail: 'Other players and AI companions act.' },
  { key: 'chat', title: 'Table talk', detail: 'Out-of-character chat.' },
  { key: 'sessions', title: 'Sessions', detail: 'A campaign begins or the next session starts.' },
  { key: 'invites', title: 'Invitations', detail: 'Campaign invitations and friend requests.' },
];

/** What the summary row under You says. */
export function pushSummary(state: PushState | undefined): string {
  switch (state) {
    case 'on':
      return 'On for this device';
    case 'off':
      return 'Off';
    case 'denied':
      return 'Blocked in settings';
    case 'install':
      return 'Add to Home Screen first';
    case 'unsupported':
      return 'Not available in this browser';
    default:
      return '';
  }
}

export function usePushState(): [PushState | undefined, (s: PushState) => void] {
  const [state, setState] = useState<PushState>();
  useEffect(() => {
    let live = true;
    const check = () => void pushState().then((s) => live && setState(s));
    check();
    // Coming back from the system settings may have changed the permission.
    document.addEventListener('visibilitychange', check);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return [state, setState];
}

export function NotificationsSheet({ onClose }: { onClose: () => void }) {
  const [state, setState] = usePushState();
  const settings = useQuery(() => api<NotifySettings>('/notifications'), []);
  const [prefs, setPrefs] = useState<NotifyPrefs>();
  const [busy, run] = useAction();
  const shown = prefs ?? settings.data?.prefs;

  const toggle = (key: NotifyCategory, on: boolean) => {
    if (!shown) return;
    const before = shown;
    setPrefs({ ...shown, [key]: on });
    void run(async () => {
      const res = await api<{ prefs: NotifyPrefs }>('/notifications/prefs', {
        method: 'PUT',
        body: { prefs: { [key]: on } },
      });
      setPrefs(res.prefs);
    }).then((saved) => {
      // Not saved: show what the server still has, not what was tapped.
      if (!saved) setPrefs(before);
    });
  };

  return (
    <Sheet title="Notifications" onClose={onClose}>
      <div className="stack">
        <p className="small muted">
          A nudge when something happens at a table while you are away. Nothing is sent about a campaign you
          have open on screen.
        </p>

        {state === 'install' && (
          <button type="button" className="banner" onClick={openInstallGuide}>
            <IconAlert />
            <span className="grow">
              On iPhone and iPad, notifications only work once Tavern Master is on your Home Screen. Add it,
              open it from there, and come back here.
            </span>
          </button>
        )}
        {state === 'denied' && (
          <p className="small note">
            Notifications are blocked for this app. Allow them in your device&rsquo;s settings (on iPhone:
            Settings, Notifications, Tavern Master), then come back.
          </p>
        )}
        {state === 'unsupported' && <p className="small note">This browser cannot receive notifications.</p>}

        {(state === 'off' || state === 'on') && (
          <label className="card row view-toggle">
            <div className="grow">
              <b>On this device</b>
              <div className="small muted">
                {state === 'on'
                  ? 'This device will be notified.'
                  : 'Your phone will ask once whether to allow them.'}
              </div>
            </div>
            <input
              type="checkbox"
              checked={state === 'on'}
              disabled={busy}
              onChange={(e) => {
                const on = e.target.checked;
                void run(
                  async () => {
                    if (on) setState(await enablePush());
                    else {
                      await disablePush();
                      setState('off');
                    }
                    await settings.reload();
                  },
                  on ? undefined : 'Notifications off for this device',
                );
              }}
            />
          </label>
        )}

        {state === 'on' && (
          <button
            type="button"
            className="btn block"
            disabled={busy}
            onClick={() =>
              void run(() => api('/notifications/test', { method: 'POST' }).then(() => undefined), 'Sent')
            }
          >
            Send a test notification
          </button>
        )}

        {shown && (
          <>
            <div className="section-title">
              <span>Notify me about</span>
              {settings.data && settings.data.devices > 0 && (
                <span>
                  {settings.data.devices} device{settings.data.devices === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div className="stack">
              {CATEGORIES.map((c) => (
                <label key={c.key} className="card row view-toggle">
                  <div className="grow">
                    <b>{c.title}</b>
                    <div className="small muted">{c.detail}</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={shown[c.key]}
                    onChange={(e) => toggle(c.key, e.target.checked)}
                  />
                </label>
              ))}
            </div>
            <p className="small faint">
              Table talk and party actions are spaced out so a busy table does not buzz your phone nonstop. To
              mute a single campaign, use its menu.
            </p>

            <div className="section-title">
              <span>Quiet hours</span>
            </div>
            <QuietHoursCard initial={settings.data?.quiet ?? null} />
          </>
        )}
      </div>
    </Sheet>
  );
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * A daily stretch without notifications. Times are this device's time zone;
 * what arrives meanwhile is held and comes as one summary per campaign.
 */
function QuietHoursCard({ initial }: { initial: QuietHours | null }) {
  const [quiet, setQuiet] = useState<QuietHours | null>(initial);
  const [busy, run] = useAction();
  const zone = localZone();

  const save = (next: QuietHours | null) => {
    const before = quiet;
    setQuiet(next);
    void run(async () => {
      await api('/notifications/quiet', { method: 'PUT', body: { quiet: next } });
    }).then((saved) => {
      if (!saved) setQuiet(before);
    });
  };

  return (
    <div className="card stack quiet-hours">
      <label className="row view-toggle">
        <div className="grow">
          <b>Pause notifications overnight</b>
          <div className="small muted">
            What happens meanwhile waits, and arrives as one summary per campaign when they end.
          </div>
        </div>
        <input
          type="checkbox"
          checked={!!quiet}
          disabled={busy}
          onChange={(e) => save(e.target.checked ? { start: '22:00', end: '08:00', timeZone: zone } : null)}
        />
      </label>
      {quiet && (
        <>
          <div className="quiet-times">
            <label>
              <span className="small muted">From</span>
              <input
                className="input"
                type="time"
                value={quiet.start}
                required
                onChange={(e) => e.target.value && save({ ...quiet, start: e.target.value, timeZone: zone })}
              />
            </label>
            <label>
              <span className="small muted">Until</span>
              <input
                className="input"
                type="time"
                value={quiet.end}
                required
                onChange={(e) => e.target.value && save({ ...quiet, end: e.target.value, timeZone: zone })}
              />
            </label>
          </div>
          <p className="small faint">
            {quiet.timeZone === zone
              ? `Times are in ${zone.replace(/_/g, ' ')}.`
              : `Set in ${quiet.timeZone.replace(/_/g, ' ')}. Change a time to switch to ${zone.replace(/_/g, ' ')}.`}
          </p>
        </>
      )}
    </div>
  );
}

/** The campaign menu's switch: notifications for this one campaign. */
export function CampaignNotifyToggle({ campaignId }: { campaignId: string }) {
  const muted = useQuery(
    () => api<{ muted: boolean }>(`/campaigns/${campaignId}/notifications`),
    [campaignId],
  );
  const [on, setOn] = useState<boolean>();
  const [busy, run] = useAction();
  const shown = on ?? (muted.data ? !muted.data.muted : undefined);
  if (shown === undefined) return null;
  return (
    <label className="card row view-toggle">
      <div className="grow">
        <b>Notifications</b>
        <div className="small muted">
          Get notified about this campaign while you are away. Choose what kinds under You, Notifications.
        </div>
      </div>
      <input
        type="checkbox"
        checked={shown}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          void run(async () => {
            await api(`/campaigns/${campaignId}/notifications`, { method: 'PUT', body: { muted: !next } });
          }).then((saved) => {
            if (!saved) setOn(!next);
          });
        }}
      />
    </label>
  );
}

const NUDGED_KEY = 'tavern.push.nudged';

function nudged(): boolean {
  try {
    return localStorage.getItem(NUDGED_KEY) === '1';
  } catch {
    return true;
  }
}

/**
 * The one time the table offers notifications: right after you have sent
 * something, when waiting for the others is what comes next. Only for a
 * device that has never been asked, and never again once answered or
 * dismissed (Settings has the switch from then on).
 */
export function PushNudge({ armed }: { armed: boolean }) {
  const [state, setState] = usePushState();
  const [gone, setGone] = useState(nudged);
  const [busy, run] = useAction();
  const never = typeof Notification !== 'undefined' && Notification.permission === 'default';
  if (!armed || gone || state !== 'off' || !never) return null;

  const done = () => {
    try {
      localStorage.setItem(NUDGED_KEY, '1');
    } catch {
      // private browsing: it may ask again next visit
    }
    setGone(true);
  };

  return (
    <div className="char-nudge push-nudge" role="region" aria-label="Notifications">
      <IconBell />
      <span className="grow">
        <b>Get a nudge when it is your move</b>
        <small>When the DM answers or someone acts while you are away.</small>
      </span>
      <button
        type="button"
        className="btn sm primary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const next = await enablePush();
            setState(next);
            done();
          }, 'Notifications on')
        }
      >
        Turn on
      </button>
      <button type="button" className="icon-btn" aria-label="Not now" onClick={done}>
        <IconClose />
      </button>
    </div>
  );
}
