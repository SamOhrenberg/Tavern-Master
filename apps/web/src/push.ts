import { api } from './api';
import { isIos, isStandalone } from './install';

/**
 * Push notifications for this device.
 *
 * - `unsupported`: this browser cannot receive them at all.
 * - `install`: an iPhone or iPad in Safari. Apple only delivers notifications
 *   to web apps added to the Home Screen, so that comes first.
 * - `denied`: blocked in the browser or system settings; only the user can undo it there.
 * - `off`: allowed or not yet asked, but this device is not subscribed.
 * - `on`: this device receives notifications.
 */
export type PushState = 'unsupported' | 'install' | 'denied' | 'off' | 'on';

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  // The worker is registered on load in a build; it never exists in dev.
  return navigator.serviceWorker.getRegistration();
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !isStandalone() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  if (!reg) return 'unsupported';
  // Whoever asks is about to show a switch for this; have the key ready for the tap.
  void serverKey().catch(() => undefined);
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

let key: Promise<string> | undefined;

/**
 * The server's public key, fetched once and early: subscribing has to follow
 * the permission prompt directly, with no network round trip in between.
 */
function serverKey(): Promise<string> {
  key ??= api<{ publicKey: string }>('/notifications/key')
    .then((r) => r.publicKey)
    .catch((err: unknown) => {
      key = undefined;
      throw err;
    });
  return key;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Whether a subscription was made with this server key. One made with another (the server was reset) can never be delivered to. */
function madeWith(sub: PushSubscription, publicKey: string): boolean {
  const current = sub.options.applicationServerKey;
  return (
    !!current &&
    btoa(String.fromCharCode(...new Uint8Array(current)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '') === publicKey
  );
}

/** This device's subscription for the server's current key, made if needed. Says whether it is new. */
async function subscribe(
  reg: ServiceWorkerRegistration,
  publicKey: string,
  existing: PushSubscription | null,
): Promise<{ sub: PushSubscription; made: boolean }> {
  if (existing && madeWith(existing, publicKey)) return { sub: existing, made: false };
  if (existing) await existing.unsubscribe().catch(() => undefined);
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  });
  return { sub, made: true };
}

async function register(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  await api('/notifications/subscriptions', {
    body: { endpoint: json.endpoint, keys: json.keys },
  });
}

/**
 * Ask for permission and subscribe this device. Call it straight from a tap:
 * Safari only shows the prompt, and only lets the page subscribe, in
 * response to one. So the prompt is asked for first, everything else is
 * fetched while it is open, and the subscription follows it directly.
 */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return pushState();
  const asked = Notification.requestPermission();
  const ready = Promise.all([registration(), serverKey()]).then(async ([reg, publicKey]) => ({
    reg,
    publicKey,
    existing: (await reg?.pushManager.getSubscription()) ?? null,
  }));
  ready.catch(() => undefined);
  const permission = await asked;
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const { reg, publicKey, existing } = await ready;
  if (!reg) return 'unsupported';
  const { sub, made } = await subscribe(reg, publicKey, existing);
  try {
    await register(sub);
  } catch (err) {
    // The server does not know this device: do not leave it looking switched on.
    if (made) await sub.unsubscribe().catch(() => undefined);
    throw err;
  }
  return 'on';
}

/** Stop notifications on this device only. */
export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api('/notifications/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(
    () => undefined,
  );
  await sub.unsubscribe().catch(() => undefined);
}

/**
 * On every launch: tell the server this device still holds its subscription.
 * Push services rotate subscriptions now and then, and Safari does not say
 * when, so this is how a changed one reaches the server. Never prompts.
 */
export async function syncPush(): Promise<void> {
  if (!supported() || Notification.permission !== 'granted') return;
  const reg = await registration();
  if (!reg) return;
  const existing = await reg.pushManager.getSubscription();
  // Allowed but not subscribed means it was switched off here on purpose; leave it.
  if (!existing) return;
  const { sub } = await subscribe(reg, await serverKey(), existing);
  await register(sub);
}

/** Clear a campaign's notifications from the lock screen and the app badge once it is open. */
export async function clearNotifications(campaignId?: string): Promise<void> {
  const reg = await registration().catch(() => undefined);
  if (!reg) return;
  const shown = await reg.getNotifications(campaignId ? { tag: `campaign:${campaignId}` } : undefined);
  for (const n of shown) n.close();
  const left = (await reg.getNotifications()).length;
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  await (left ? nav.setAppBadge?.(left) : nav.clearAppBadge?.())?.catch(() => undefined);
}
