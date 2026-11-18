import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '../app';

/** Pictures are stored this many pixels square: sharp on a phone, small to send. */
const PORTRAIT_PX = 512;
/** The circle is never drawn smaller than this on screen, so its handles stay apart. */
const MIN_ON_SCREEN = 80;
/** Room around the picture, so a handle at its edge is still easy to grab. */
const PAD = 20;
/** A handle sits on the circle at 45°: it moves this much for each pixel the square grows. */
const HANDLE_TRAVEL = (1 + Math.SQRT1_2) / 2;
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

/** The square cut from the picture, in the picture's own pixels. */
export interface Crop {
  x: number;
  y: number;
  size: number;
}

interface Picture {
  el: HTMLImageElement;
  url: string;
  w: number;
  h: number;
}

type Gesture =
  | { kind: 'move'; crop: Crop; x: number; y: number }
  | { kind: 'resize'; crop: Crop; x: number; y: number; sx: number; sy: number }
  | { kind: 'pinch'; crop: Crop; dist: number; mx: number; my: number };

/**
 * The iPhone's own photo format. Every browser on an iPhone or a Mac (they are all Safari underneath)
 * opens it; Chrome, Edge and Firefox elsewhere do not.
 */
export const isHeic = (file: File) => /^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The middle of the picture (a little above centre on a tall one, where a face usually is). */
function startCrop(w: number, h: number): Crop {
  const size = Math.round(Math.min(w, h) * 0.9);
  return { x: (w - size) / 2, y: h > w ? (h - size) / 4 : (h - size) / 2, size };
}

/** Keep a square of the given size and centre inside the picture. */
function fit(cx: number, cy: number, size: number, w: number, h: number, min: number): Crop {
  const s = clamp(size, Math.min(min, w, h), Math.min(w, h));
  return { x: clamp(cx - s / 2, 0, w - s), y: clamp(cy - s / 2, 0, h - s), size: s };
}

/** Cut the square out, shrink it and encode it as JPEG: a phone photo of megabytes becomes kilobytes. */
function render(img: HTMLImageElement, c: Crop): Promise<Blob> {
  const out = Math.max(1, Math.round(Math.min(PORTRAIT_PX, c.size)));
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('This browser cannot prepare pictures.'));
  // JPEG has no transparency: give cut-out art a dark backdrop instead of black.
  ctx.fillStyle = '#26222e';
  ctx.fillRect(0, 0, out, out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, c.x, c.y, c.size, c.size, 0, 0, out, out);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('That picture could not be prepared.'))),
      'image/jpeg',
      0.86,
    ),
  );
}

/**
 * Choose what part of a picture a portrait shows: a circle with marching ants
 * over the picture, dragged to move, resized from its handles, by pinching or
 * with the scroll wheel. Arrow keys move it and + and − resize it.
 */
export function PortraitCropper({
  file,
  initial,
  onCancel,
  onDone,
}: {
  file: File;
  /** Where the circle was the last time this picture was cropped. */
  initial?: Crop;
  onCancel: () => void;
  onDone: (blob: Blob, crop: Crop) => void;
}) {
  const notify = useToast();
  const [pic, setPic] = useState<Picture | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [saving, setSaving] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  // The callbacks change on every render of the sheet behind; the effects below must not restart for that.
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const initialRef = useRef(initial);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    let live = true;
    const el = new Image();
    el.onload = () => {
      if (!live) return;
      const w = el.naturalWidth;
      const h = el.naturalHeight;
      setPic({ el, url, w, h });
      setCrop(initialRef.current ?? startCrop(w, h));
    };
    el.onerror = () => {
      if (!live) return;
      notifyRef.current(
        isHeic(file)
          ? 'This browser cannot open HEIC pictures, the iPhone’s own format. Safari can; elsewhere, save it as a JPEG first.'
          : 'That picture could not be read. Try a JPEG, PNG or WebP.',
        'error',
      );
      cancelRef.current();
    };
    el.src = url;
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Escape closes this, not the sheet behind it as well.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      cancelRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const scale = pic && stage.w > 0 ? Math.min((stage.w - PAD * 2) / pic.w, (stage.h - PAD * 2) / pic.h) : 0;
  const minSize = scale > 0 ? MIN_ON_SCREEN / scale : 1;

  // The scroll wheel (and a trackpad pinch, which arrives as ctrl+wheel) resizes. React's wheel
  // listener cannot stop the page zooming, so this one is added by hand.
  const live = useRef({ pic, crop, minSize });
  live.current = { pic, crop, minSize };
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { pic: p, crop: c, minSize: min } = live.current;
      if (!p || !c) return;
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setCrop(fit(c.x + c.size / 2, c.y + c.size / 2, c.size * factor, p.w, p.h, min));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /** Start the gesture again from where things stand, as a finger lands or lifts. */
  const restart = (target?: Element | null) => {
    if (!crop) return;
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
      gesture.current = {
        kind: 'pinch',
        crop,
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
    } else if (pts.length === 1) {
      const p = pts[0]!;
      const handle = target?.closest<HTMLElement>('[data-sx]');
      gesture.current = handle
        ? {
            kind: 'resize',
            crop,
            x: p.x,
            y: p.y,
            sx: Number(handle.dataset.sx),
            sy: Number(handle.dataset.sy),
          }
        : { kind: 'move', crop, x: p.x, y: p.y };
    } else gesture.current = null;
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!crop || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    restart(e.target as Element);
  };

  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g || !pic || scale <= 0) return;
    const c = g.crop;
    if (g.kind === 'move') {
      const dx = (e.clientX - g.x) / scale;
      const dy = (e.clientY - g.y) / scale;
      setCrop({ ...c, x: clamp(c.x + dx, 0, pic.w - c.size), y: clamp(c.y + dy, 0, pic.h - c.size) });
    } else if (g.kind === 'resize') {
      // The opposite corner of the square stays put; the handle follows the finger along the diagonal.
      const ax = g.sx > 0 ? c.x : c.x + c.size;
      const ay = g.sy > 0 ? c.y : c.y + c.size;
      const along = ((e.clientX - g.x) * g.sx + (e.clientY - g.y) * g.sy) / 2 / scale / HANDLE_TRAVEL;
      const room = Math.min(g.sx > 0 ? pic.w - ax : ax, g.sy > 0 ? pic.h - ay : ay);
      const size = clamp(c.size + along, Math.min(minSize, room), room);
      setCrop({ x: g.sx > 0 ? ax : ax - size, y: g.sy > 0 ? ay : ay - size, size });
    } else {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      setCrop(
        fit(
          c.x + c.size / 2 + (mx - g.mx) / scale,
          c.y + c.size / 2 + (my - g.my) / scale,
          (c.size * dist) / g.dist,
          pic.w,
          pic.h,
          minSize,
        ),
      );
    }
  };

  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    restart();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!pic || !crop) return;
    const step = Math.min(pic.w, pic.h) * (e.shiftKey ? 0.1 : 0.02);
    const cx = crop.x + crop.size / 2;
    const cy = crop.y + crop.size / 2;
    const to: Record<string, [number, number, number]> = {
      ArrowLeft: [cx - step, cy, crop.size],
      ArrowRight: [cx + step, cy, crop.size],
      ArrowUp: [cx, cy - step, crop.size],
      ArrowDown: [cx, cy + step, crop.size],
      '+': [cx, cy, crop.size + step * 2],
      '=': [cx, cy, crop.size + step * 2],
      '-': [cx, cy, crop.size - step * 2],
      _: [cx, cy, crop.size - step * 2],
    };
    const next = to[e.key];
    if (!next) return;
    e.preventDefault();
    setCrop(fit(...next, pic.w, pic.h, minSize));
  };

  const done = async () => {
    if (!pic || !crop) return;
    setSaving(true);
    try {
      onDone(await render(pic.el, crop), crop);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'That picture could not be prepared.', 'error');
      setSaving(false);
    }
  };

  const W = pic ? pic.w * scale : 0;
  const H = pic ? pic.h * scale : 0;
  const r = crop ? (crop.size * scale) / 2 : 0;
  const cx = crop ? crop.x * scale + r : 0;
  const cy = crop ? crop.y * scale + r : 0;
  const PREVIEW = 56;
  const k = crop ? PREVIEW / crop.size : 0;

  return createPortal(
    <div className="cropper" role="dialog" aria-modal="true" aria-label="Crop the picture">
      <header className="cropper-head">
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
        <h2>Crop picture</h2>
        <span className="cropper-head-end" />
      </header>
      <div
        ref={stageRef}
        className="cropper-stage"
        tabIndex={0}
        aria-label="Picture to crop. Arrow keys move the circle; plus and minus resize it."
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={onKey}
      >
        {pic && crop && scale > 0 ? (
          <div className="cropper-frame" style={{ width: W, height: H }}>
            <img src={pic.url} alt="" draggable={false} />
            <svg className="cropper-overlay" width={W} height={H} aria-hidden="true">
              <path
                className="cropper-shade"
                fillRule="evenodd"
                d={`M0 0H${W}V${H}H0Z M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`}
              />
              <circle className="cropper-ants-under" cx={cx} cy={cy} r={r} />
              <circle className="cropper-ants" cx={cx} cy={cy} r={r} />
            </svg>
            {CORNERS.map(([sx, sy]) => (
              <span
                key={`${sx}${sy}`}
                className="cropper-handle"
                data-sx={sx}
                data-sy={sy}
                style={{ left: cx + sx * r * Math.SQRT1_2, top: cy + sy * r * Math.SQRT1_2 }}
              />
            ))}
          </div>
        ) : (
          <span className="spinner" />
        )}
      </div>
      <footer className="cropper-foot">
        <div className="row">
          <span
            className="cropper-preview"
            aria-hidden="true"
            style={
              pic && crop
                ? {
                    backgroundImage: `url("${pic.url}")`,
                    backgroundSize: `${pic.w * k}px ${pic.h * k}px`,
                    backgroundPosition: `${-crop.x * k}px ${-crop.y * k}px`,
                  }
                : undefined
            }
          />
          <p className="small muted grow">Drag to move it. Drag a handle or pinch to resize.</p>
        </div>
        <button
          type="button"
          className="btn primary block"
          disabled={!crop || saving}
          onClick={() => void done()}
        >
          Use this picture
        </button>
      </footer>
    </div>,
    document.body,
  );
}
