import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconAddSquare, IconCheck, IconChevronDown, IconClose, IconDots, IconShareIos } from './icons';

const DISMISSED_KEY = 'tavern.install.dismissed';
const OPEN_EVENT = 'tavern:open-install';

interface InstallEvent extends Event {
  prompt(): Promise<void>;
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone, iPod, or an iPad (which reports itself as a Mac but has a touch screen). */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPod|iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Real Safari, as opposed to another iOS browser or an in-app web view. */
function isIosSafari(): boolean {
  return (
    isIos() && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\/|Instagram|FBAN|FBAV/.test(navigator.userAgent)
  );
}

/** Open the install guide from anywhere (the Settings screen has a row for it). */
export function openInstallGuide(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function remember(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // private browsing: it will simply show again next visit
  }
}
function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * First-visit invitation to put the app on the Home Screen. iOS has no install
 * API, so on Safari this walks through the three taps; on browsers that do
 * offer one (Chrome, Edge) it shows a single Install button instead.
 */
export function InstallPrompt() {
  const [open, setOpen] = useState(false);
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const ios = isIos();

  useEffect(() => {
    if (isStandalone()) return;
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);

    let timer: number | undefined;
    if (isIosSafari() && !wasDismissed()) {
      // Let the first screen settle before sliding up.
      timer = window.setTimeout(() => setOpen(true), 1400);
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as InstallEvent);
      if (!wasDismissed()) setOpen(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.clearTimeout(timer);
    };
  }, []);

  const close = useCallback(() => {
    remember();
    setOpen(false);
  }, []);

  if (!open) return null;

  return createPortal(
    <div className="scrim install-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <section className="sheet install" role="dialog" aria-modal="true" aria-labelledby="install-title">
        <div className="sheet-grab" />
        <button type="button" className="icon-btn install-close" onClick={close} aria-label="Not now">
          <IconClose />
        </button>

        <div className="install-hero">
          <span className="install-halo" />
          <img className="install-icon" src="/icons/apple-touch-icon.png" width={84} height={84} alt="" />
        </div>
        <p className="install-eyebrow">Pull up a chair</p>
        <h2 id="install-title">Add Tavern Master to your Home Screen</h2>
        <p className="muted install-lede">
          It opens full screen like any other app, with no browser bars between you and the story.
        </p>

        {ios ? (
          <>
            <ol className="install-steps">
              <li>
                <span className="install-num">1</span>
                <span className="grow">
                  Tap <b>Share</b> in Safari&rsquo;s toolbar
                  <small>
                    On iOS 26, tap <IconDots className="inline-icon" /> first, then Share.
                  </small>
                </span>
                <span className="install-glyph">
                  <IconShareIos />
                </span>
              </li>
              <li>
                <span className="install-num">2</span>
                <span className="grow">
                  Scroll down and choose <b>Add to Home Screen</b>
                </span>
                <span className="install-glyph">
                  <IconAddSquare />
                </span>
              </li>
              <li>
                <span className="install-num">3</span>
                <span className="grow">
                  Tap <b>Add</b> in the top corner
                  <small>Then open Tavern from your Home Screen.</small>
                </span>
                <span className="install-glyph text">Add</span>
              </li>
            </ol>
            {!isIosSafari() && (
              <p className="small muted center">Open this page in Safari to add it to your Home Screen.</p>
            )}
            <button type="button" className="btn primary block" onClick={close}>
              <IconCheck /> Got it
            </button>
            <div className="install-pointer" aria-hidden="true">
              <IconChevronDown />
            </div>
          </>
        ) : (
          <div className="stack">
            {deferred ? (
              <button
                type="button"
                className="btn primary block"
                onClick={() => {
                  void deferred.prompt();
                  close();
                }}
              >
                Install app
              </button>
            ) : (
              <p className="small muted center">
                Use your browser&rsquo;s menu and choose <b>Install app</b> or <b>Add to Home screen</b>.
              </p>
            )}
            <button type="button" className="btn ghost block" onClick={close}>
              Not now
            </button>
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
