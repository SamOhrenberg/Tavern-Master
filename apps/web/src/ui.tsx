import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useAction } from './app';
import { IconBack, IconCheck, IconClose, IconCopy } from './icons';
import { FeedbackButton } from './feedback/button';

/** Stable colour per person so avatars are recognisable at a glance. */
function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 6;
}

export function Avatar({ name, seed, small }: { name: string; seed?: string; small?: boolean }) {
  return (
    <span className={`avatar h${hue(seed ?? name)}${small ? ' sm' : ''}`} aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function Loading() {
  return (
    <div className="loading" role="status" aria-label="Loading">
      <div className="spinner" />
    </div>
  );
}

export function Skeletons({ count = 3 }: { count?: number }) {
  return (
    <div className="stack" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p className="small">{children}</p>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  body: string;
  disabled?: boolean;
  /** Shown under the body, e.g. why an option cannot be picked. */
  note?: string;
}

/** A short list of options, each with a line of explanation. One is always picked. */
export function Choices<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ChoiceOption<T>[];
  label?: string;
}) {
  return (
    <div className="choices" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`choice${o.value === value ? ' on' : ''}`}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          <span className="choice-mark">{o.value === value && <IconCheck />}</span>
          <span className="grow">
            <b>{o.title}</b>
            <small>{o.body}</small>
            {o.note && <small className="choice-note">{o.note}</small>}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * A panel that slides up from the bottom on phones and sits centred on wide
 * screens. Closes on the scrim, the close button or Escape.
 */
export function Sheet({
  title,
  onClose,
  children,
  tall,
  header,
  footer,
  action,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  tall?: boolean;
  header?: ReactNode;
  /** Pinned under the scrolling body (a chat's composer). */
  footer?: ReactNode;
  /** A control beside the close button. */
  action?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return createPortal(
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className={`sheet${tall ? ' tall' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grab" />
        <header className="sheet-head">
          <h2 className="truncate">{title}</h2>
          {action}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </header>
        {header}
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </section>
    </div>,
    document.body,
  );
}

/** The title block at the top of a tab screen, with an optional back link and action. */
export function PageHead({
  eyebrow,
  title,
  back,
  action,
}: {
  eyebrow?: string;
  title: string;
  back?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-head">
      {back && (
        <Link to={back} className="icon-btn page-back" aria-label="Back">
          <IconBack />
        </Link>
      )}
      <div className="grow">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="truncate">{title}</h1>
      </div>
      {action}
      <FeedbackButton />
    </header>
  );
}

/** A button for things that cannot be undone: the first tap arms it, the second acts. */
export function ConfirmButton({
  className = 'btn danger',
  children,
  confirmLabel = 'Tap again to confirm',
  onConfirm,
  disabled,
}: {
  className?: string;
  children: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={`${className}${armed ? ' armed' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}

/** Hit points as a bar that shifts from green to gold to red as they drop. */
export function HpBar({ hp, max, temp = 0 }: { hp: number; max: number; temp?: number }) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
  const tone = ratio > 0.5 ? '' : ratio > 0.25 ? ' mid' : ' low';
  return (
    <div className="hp">
      <div className={`bar${tone}`} role="img" aria-label={`${hp} of ${max} hit points`}>
        <i style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="hp-num">
        {hp}
        <span className="faint">/{max}</span>
        {temp > 0 && <span className="hp-temp">+{temp}</span>}
      </span>
    </div>
  );
}

/** "Book · Section › Subsection · p. 12", without repeating the book's title inside the section path. */
export function ruleSource(document: string, heading: string, page: number | null): string {
  let section = heading;
  if (section.startsWith(document)) section = section.slice(document.length).replace(/^\s*[›>:·-]\s*/, '');
  return [document, section, page ? `p. ${page}` : ''].filter(Boolean).join(' · ');
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

export function formatUsd(n: number): string {
  return n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

export function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** One value to copy, such as the connector address or a new token. */
export function CopyRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [busy, run] = useAction();
  return (
    <div>
      <div className="grow">
        <div className="small muted">{label}</div>
        <div className={`mono small ${secret ? 'secret-value' : 'truncate'}`}>{value}</div>
      </div>
      <button
        type="button"
        className="btn sm"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            if (!(await copyText(value)))
              throw new Error('Could not copy. Select the text and copy it instead.');
          }, 'Copied')
        }
      >
        <IconCopy /> Copy
      </button>
    </div>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
