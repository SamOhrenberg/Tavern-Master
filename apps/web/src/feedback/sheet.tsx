import type { FeedbackItem, FeedbackKind, FeedbackList, FeedbackStatus } from '@tavern/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useMeta, useToast } from '../app';
import { IconChevronDown, IconClose, IconFeedback, IconImage, IconScreen } from '../icons';
import { Empty, Field, Loading, Segmented, Sheet, timeAgo } from '../ui';
import { FeedbackContext } from './context';

type Tab = 'send' | 'mine';

interface Attachment {
  source: 'screenshot' | 'photo';
  /** For the preview. */
  url: string;
  /** What is sent: base64 without the data: prefix. */
  data: string;
}

interface Draft {
  kind: FeedbackKind;
  title: string;
  body: string;
  screenshot: Attachment | null;
  photo: Attachment | null;
}

const EMPTY: Draft = { kind: 'bug', title: '', body: '', screenshot: null, photo: null };

const KINDS: { value: FeedbackKind; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'feedback', label: 'Feedback' },
];

const PLACEHOLDER: Record<FeedbackKind, { title: string; body: string }> = {
  bug: {
    title: 'e.g. The Pass button does nothing',
    body: 'What happened, and what did you expect? Steps to make it happen again help a lot.',
  },
  idea: { title: 'e.g. Let me mute table talk', body: 'What would you like, and what would it help with?' },
  feedback: { title: 'In a few words', body: 'Tell us what you think.' },
};

const STATUS: Record<FeedbackStatus, { label: string; tone: string }> = {
  sending: { label: 'Sending', tone: 'gold' },
  open: { label: 'Open', tone: 'arcane' },
  done: { label: 'Done', tone: 'jade' },
  closed: { label: 'Closed', tone: '' },
};

const SEEN_KEY = 'tm-feedback-seen';
const REFRESH_MS = 5 * 60_000;

function readSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}
function writeSeen(iso: string): void {
  try {
    localStorage.setItem(SEEN_KEY, iso);
  } catch {
    // Private mode: the dot simply comes back next time.
  }
}

/** Is there news on this item since `seen`: a reply, or the issue being closed? */
function newsSince(item: FeedbackItem, seen: string): boolean {
  return (
    item.replies.some((r) => r.createdAt > seen) ||
    ((item.status === 'done' || item.status === 'closed') && (item.updatedAt ?? '') > seen)
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image could not be read.'));
    img.src = src;
  });
}

/** Shrink an image to fit the box and re-encode it as JPEG, so a phone photo uploads quickly. */
async function shrink(src: string, maxW: number, maxH: number): Promise<string> {
  const img = await loadImage(src);
  const ratio = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot prepare images.');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read a font.'));
    reader.readAsDataURL(blob);
  });
}

let fontCss: Promise<string> | null = null;
/**
 * The app's @font-face rules with the font files inlined, for the screenshot.
 * The library would otherwise build them in a <style> element of its own,
 * which the server's CSP (style-src 'self') blocks; handed the CSS ready-made,
 * it skips that. Built once.
 */
function fontsForCapture(): Promise<string> {
  fontCss ??= (async () => {
    const rules: CSSFontFaceRule[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let list: CSSRuleList;
      try {
        list = sheet.cssRules;
      } catch {
        continue;
      }
      for (const r of Array.from(list)) if (r instanceof CSSFontFaceRule) rules.push(r);
    }
    const faces = await Promise.all(
      rules.map(async (r) => {
        const src = r.style.getPropertyValue('src');
        const m = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(src) ?? /url\(["']?([^"')]+)["']?\)/.exec(src);
        if (!m) return '';
        try {
          const url = new URL(m[1]!, r.parentStyleSheet?.href ?? location.href).href;
          const res = await fetch(url);
          if (!res.ok) return '';
          const data = await readAsDataUrl(await res.blob());
          const format = url.includes('.woff2') ? 'woff2' : url.includes('.woff') ? 'woff' : 'truetype';
          const props = ['font-family', 'font-style', 'font-weight', 'unicode-range']
            .map((p) => r.style.getPropertyValue(p))
            .map((v, i) =>
              v ? `${['font-family', 'font-style', 'font-weight', 'unicode-range'][i]}:${v};` : '',
            )
            .join('');
          return `@font-face{${props}src:url(${data}) format("${format}");}`;
        } catch {
          return '';
        }
      }),
    );
    return faces.filter(Boolean).join('\n');
  })();
  return fontCss;
}

/**
 * A picture of the page behind the sheet. The sheet is drawn outside #root,
 * so capturing #root leaves it out; toasts are skipped by their marker.
 */
async function captureScreen(): Promise<Attachment> {
  const [{ domToJpeg }, cssText] = await Promise.all([import('modern-screenshot'), fontsForCapture()]);
  const root = document.getElementById('root');
  if (!root) throw new Error('Nothing to capture.');
  const raw = await domToJpeg(root, {
    // Never let the library build font CSS itself (see fontsForCapture); without fonts, system ones stand in.
    font: cssText ? { cssText } : false,
    scale: Math.min(window.devicePixelRatio || 1, 2),
    quality: 0.85,
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#000',
    workerNumber: 0,
    timeout: 8000,
    filter: (node) => !(node instanceof HTMLElement && node.dataset.feedbackHide !== undefined),
  });
  const url = await shrink(raw, 1200, 4000);
  return { source: 'screenshot', url, data: base64Of(url) };
}

async function readPhoto(file: File): Promise<Attachment> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image.');
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That image could not be read.'));
    reader.readAsDataURL(file);
  });
  const url = await shrink(raw, 1600, 1600);
  return { source: 'photo', url, data: base64Of(url) };
}

function contextNow(path: string) {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    path,
    viewport: `${window.innerWidth}×${window.innerHeight} @${Math.round((window.devicePixelRatio || 1) * 100) / 100}x`,
    standalone: window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true,
  };
}

/**
 * Holds the feedback sheet for the whole signed-in app. The draft lives here,
 * so closing the sheet by accident keeps what was written; the list of what
 * this person sent is fetched now and then to light the button's dot when
 * there are replies.
 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const meta = useMeta();
  const enabled = !!meta?.feedback;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('send');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [list, setList] = useState<FeedbackList | null>(null);
  const [listError, setListError] = useState('');
  const [seen, setSeen] = useState(readSeen);
  const loadedAt = useRef(0);

  const reload = useCallback(async () => {
    loadedAt.current = Date.now();
    try {
      setList(await api<FeedbackList>('/feedback'));
      setListError('');
    } catch (err) {
      setListError(errorMessage(err));
    }
  }, []);

  // Now and then, while the app is in front, so the dot can appear on its own.
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > REFRESH_MS) void reload();
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(timer);
    };
  }, [enabled, reload]);

  const unread = useMemo(() => !!list?.items.some((i) => newsSince(i, seen)), [list, seen]);

  const markSeen = useCallback(() => {
    const now = new Date().toISOString();
    writeSeen(now);
    setSeen(now);
  }, []);

  const api_ = useMemo(
    () => ({
      enabled,
      unread,
      open: () => {
        setOpen(true);
        // News waiting: show it first.
        setTab(unread ? 'mine' : 'send');
        void reload();
      },
    }),
    [enabled, unread, reload],
  );

  return (
    <FeedbackContext.Provider value={api_}>
      {children}
      {open && (
        <FeedbackSheet
          tab={tab}
          onTab={setTab}
          draft={draft}
          onDraft={setDraft}
          list={list}
          listError={listError}
          seen={seen}
          onSeen={markSeen}
          onSent={() => {
            setDraft(EMPTY);
            setTab('mine');
            void reload();
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </FeedbackContext.Provider>
  );
}

function FeedbackSheet({
  tab,
  onTab,
  draft,
  onDraft,
  list,
  listError,
  seen,
  onSeen,
  onSent,
  onClose,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  draft: Draft;
  onDraft: (fn: (d: Draft) => Draft) => void;
  list: FeedbackList | null;
  listError: string;
  seen: string;
  onSeen: () => void;
  onSent: () => void;
  onClose: () => void;
}) {
  // What counted as new when this tab was opened, so items stay marked while being read.
  const [newSince] = useState(seen);
  useEffect(() => {
    if (tab === 'mine') onSeen();
  }, [tab, onSeen, list]);

  return (
    <Sheet
      title="Feedback"
      onClose={onClose}
      tall
      header={
        <div className="sheet-tabs">
          <Segmented
            value={tab}
            onChange={onTab}
            options={[
              { value: 'send', label: 'Send feedback' },
              { value: 'mine', label: `Yours${list?.items.length ? ` (${list.items.length})` : ''}` },
            ]}
          />
        </div>
      }
    >
      {tab === 'send' ? (
        <SendForm draft={draft} onDraft={onDraft} list={list} onSent={onSent} />
      ) : (
        <MyFeedback list={list} error={listError} newSince={newSince} />
      )}
    </Sheet>
  );
}

function SendForm({
  draft,
  onDraft,
  list,
  onSent,
}: {
  draft: Draft;
  onDraft: (fn: (d: Draft) => Draft) => void;
  list: FeedbackList | null;
  onSent: () => void;
}) {
  const notify = useToast();
  const location = useLocation();
  const [capturing, setCapturing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Draft>) => onDraft((d) => ({ ...d, ...patch }));
  const ph = PLACEHOLDER[draft.kind];

  const screenshot = async () => {
    setCapturing(true);
    setError('');
    try {
      const shot = await captureScreen();
      onDraft((d) => ({ ...d, screenshot: shot }));
    } catch (err) {
      setError(
        `The screenshot did not work: ${errorMessage(err)}. You can attach one from your device instead.`,
      );
    } finally {
      setCapturing(false);
    }
  };

  const photo = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setError('');
    try {
      const shot = await readPhoto(f);
      onDraft((d) => ({ ...d, photo: shot }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const send = async () => {
    if (draft.title.trim().length < 3) {
      setError('Give it a short title.');
      return;
    }
    setSending(true);
    setError('');
    try {
      await api('/feedback', {
        body: {
          kind: draft.kind,
          title: draft.title.trim(),
          body: draft.body.trim(),
          context: contextNow(location.pathname),
          images: [draft.screenshot, draft.photo]
            .filter((a): a is Attachment => !!a)
            .map((a) => ({ source: a.source, data: a.data })),
        },
      });
      notify('Thanks! Your feedback was sent.');
      onSent();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="stack feedback-form">
      <Field label="What is it?">
        <Segmented value={draft.kind} onChange={(kind) => set({ kind })} options={KINDS} />
      </Field>
      <Field label="Title">
        <input
          className="input"
          value={draft.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder={ph.title}
          maxLength={120}
          enterKeyHint="next"
        />
      </Field>
      <Field label="Details">
        <textarea
          className="textarea"
          rows={5}
          value={draft.body}
          onChange={(e) => set({ body: e.target.value })}
          placeholder={ph.body}
          maxLength={5000}
        />
      </Field>

      <div className="feedback-attach">
        {draft.screenshot ? (
          <Thumb
            attachment={draft.screenshot}
            label="Screenshot of this page"
            onRemove={() => set({ screenshot: null })}
          />
        ) : (
          <button
            type="button"
            className="btn sm ghost"
            disabled={capturing}
            onClick={() => void screenshot()}
          >
            <IconScreen />
            {capturing ? 'Capturing…' : 'Add a screenshot of this page'}
          </button>
        )}
        {draft.photo ? (
          <Thumb attachment={draft.photo} label="From your device" onRemove={() => set({ photo: null })} />
        ) : (
          <button type="button" className="btn sm ghost" onClick={() => file.current?.click()}>
            <IconImage />
            Add a picture from your device
          </button>
        )}
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void photo(e)} />
      </div>

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        className="btn primary block"
        disabled={sending || capturing}
        onClick={() => void send()}
      >
        {sending ? 'Sending…' : 'Send'}
      </button>
      <p className="small muted">
        This becomes {list?.publicRepo ? 'a public' : 'an'} issue on GitHub
        {list?.repo ? ` (${list.repo})` : ''}, without your name. Pictures stay on this server, where only
        admins can open them.
      </p>
    </div>
  );
}

function Thumb({
  attachment,
  label,
  onRemove,
}: {
  attachment: Attachment;
  label: string;
  onRemove: () => void;
}) {
  return (
    <div className="feedback-thumb">
      <img src={attachment.url} alt={label} />
      <span className="small muted grow">{label}</span>
      <button
        type="button"
        className="icon-btn sm"
        onClick={onRemove}
        aria-label={`Remove ${label.toLowerCase()}`}
      >
        <IconClose />
      </button>
    </div>
  );
}

function MyFeedback({
  list,
  error,
  newSince,
}: {
  list: FeedbackList | null;
  error: string;
  newSince: string;
}) {
  if (!list)
    return error ? (
      <div className="form-error" role="alert">
        {error}
      </div>
    ) : (
      <Loading />
    );
  if (!list.items.length) {
    return (
      <Empty icon={<IconFeedback />} title="Nothing sent yet">
        Bugs, ideas and thoughts you send show up here, with where they stand and any replies.
      </Empty>
    );
  }
  return (
    <div className="stack feedback-list">
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {list.items.map((item) => (
        <FeedbackCard
          key={item.id}
          item={item}
          isNew={newsSince(item, newSince)}
          linkIssue={!!list.publicRepo}
        />
      ))}
    </div>
  );
}

function FeedbackCard({
  item,
  isNew,
  linkIssue,
}: {
  item: FeedbackItem;
  isNew: boolean;
  linkIssue: boolean;
}) {
  const [expanded, setExpanded] = useState(isNew);
  const st = STATUS[item.status];
  return (
    <article className={`card feedback-card${isNew ? ' new' : ''}`}>
      <button
        type="button"
        className="feedback-card-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="grow">
          <span className="feedback-card-meta small muted">
            {KINDS.find((k) => k.value === item.kind)?.label} · {timeAgo(item.createdAt)}
            {item.replies.length > 0 &&
              ` · ${item.replies.length} ${item.replies.length === 1 ? 'reply' : 'replies'}`}
          </span>
          <b className="feedback-card-title">{item.title}</b>
        </span>
        <span className={`pill ${st.tone}`}>{st.label}</span>
        <IconChevronDown className={`feedback-chev${expanded ? ' up' : ''}`} />
      </button>
      {item.labels.length > 0 && (
        <div className="feedback-labels">
          {item.labels.map((l) => (
            <span key={l} className="pill">
              {l}
            </span>
          ))}
        </div>
      )}
      {expanded && (
        <div className="feedback-card-body">
          {item.body && <p className="feedback-text">{item.body}</p>}
          {item.images.length > 0 && (
            <div className="feedback-images">
              {item.images.map((img) => (
                <a
                  key={img.n}
                  href={`/api/feedback/${item.id}/images/${img.n}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={`/api/feedback/${item.id}/images/${img.n}`}
                    alt={img.source === 'screenshot' ? 'Screenshot' : 'Picture'}
                    loading="lazy"
                  />
                </a>
              ))}
            </div>
          )}
          {item.status === 'sending' && (
            <p className="small muted">Saved. It goes to the tracker as soon as GitHub answers.</p>
          )}
          {item.replies.length > 0 ? (
            <div className="feedback-replies">
              {item.replies.map((r, i) => (
                <div key={i} className="feedback-reply">
                  <span className="small muted">
                    {r.author} · {timeAgo(r.createdAt)}
                  </span>
                  <p className="feedback-text">{r.body}</p>
                </div>
              ))}
            </div>
          ) : (
            item.status !== 'sending' && <p className="small muted">No replies yet.</p>
          )}
          {linkIssue && item.issueUrl && (
            <a className="small" href={item.issueUrl} target="_blank" rel="noreferrer">
              #{item.issueNumber} on GitHub
            </a>
          )}
        </div>
      )}
    </article>
  );
}
