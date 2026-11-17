import { log } from '../log.js';
import { callOutsideAi, findOutsideAi, OutsideAiError, type OutsideAi } from './outside.js';

/**
 * A second writer for the DM's narration. The DM (built-in or Claude) writes
 * the scene and runs the rules; when a campaign names an outside AI to polish
 * with, that AI then rewrites the finished draft for style before the table
 * sees it.
 *
 * What it must not touch is taken out of its hands rather than asked of it:
 * every player's own dialogue, codex links, rule citations and blacked-out
 * secrets are swapped for numbered markers before the draft is sent, and put
 * back afterwards. A reply that loses, repeats or invents a marker, or that
 * strays far from the draft's length, is thrown away and the draft is used as
 * it is. Polishing never stops a turn: any failure falls back to the draft.
 */

const POLISH_TIMEOUT_MS = 45_000;
/** The draft is posted as written when the polished text is shorter or longer than this, relative to it. */
const MIN_RATIO = 0.6;
const MAX_RATIO = 1.8;

const SYSTEM =
  'You are a prose editor for the Game Master of a tabletop role-playing game. You are given a passage ' +
  "of the Game Master's narration and rewrite it so it reads better: livelier wording, sharper rhythm, " +
  'vivid sensory detail and distinct voices for the non-player characters. You are an editor, not an ' +
  'author: the story stays exactly as written. Reply with only the rewritten passage.';

const marker = (n: number) => `⟦${n}⟧`;
const MARKER_RE = /⟦(\d+)⟧/g;

/** Quoted speech in a line of text, inner words only. */
function quotesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"\n]{2,})"|“([^”\n]{2,})”/g)) {
    const inner = (m[1] ?? m[2] ?? '').trim();
    if (inner.length >= 2) out.push(inner);
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

interface Span {
  start: number;
  end: number;
}

/**
 * The parts of the draft that must reach the table exactly as they are: what
 * the players said in their actions (wherever the draft repeats it, and any
 * quoted line in the draft taken from a player's action), codex links,
 * citations and redactions.
 */
export function protectedSpans(draft: string, playerLines: string[]): Span[] {
  const spans: Span[] = [];
  const add = (start: number, end: number) => {
    if (end > start) spans.push({ start, end });
  };
  const fixed = /\[\[[^\]\n]+\]\]|\[R\d+\]|▮▮▮/g;
  for (const m of draft.matchAll(fixed)) add(m.index!, m.index! + m[0].length);

  const said = playerLines.flatMap(quotesIn);
  // A player's spoken line, wherever the draft repeats it word for word.
  for (const line of said) {
    let at = draft.indexOf(line);
    while (at !== -1) {
      add(at, at + line.length);
      at = draft.indexOf(line, at + line.length);
    }
  }
  // A quoted line in the draft that a player wrote, even if the draft trimmed it or changed its case.
  const actions = playerLines.map(norm);
  const lines = said.map(norm);
  for (const m of draft.matchAll(/"([^"\n]{2,})"|“([^”\n]{2,})”/g)) {
    const inner = norm(m[1] ?? m[2] ?? '');
    if (inner.length < 3) continue;
    if (actions.some((a) => a.includes(inner)) || lines.some((l) => l.length >= 3 && inner.includes(l)))
      add(m.index!, m.index! + m[0].length);
  }

  // Merge overlaps so each protected stretch becomes one marker.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** The draft with every protected stretch replaced by a numbered marker, and what each stands for. */
export function maskDraft(draft: string, playerLines: string[]): { masked: string; kept: string[] } {
  const spans = protectedSpans(draft, playerLines);
  const kept: string[] = [];
  let masked = '';
  let at = 0;
  for (const s of spans) {
    masked += draft.slice(at, s.start) + marker(kept.length + 1);
    kept.push(draft.slice(s.start, s.end));
    at = s.end;
  }
  masked += draft.slice(at);
  return { masked, kept };
}

/**
 * Put the protected text back. Null when the polished text cannot be trusted:
 * a marker is missing, repeated or made up, or the length is far off.
 */
export function unmask(polished: string, kept: string[], draftLength: number): string | null {
  const seen = new Map<number, number>();
  for (const m of polished.matchAll(MARKER_RE)) {
    const n = Number(m[1]);
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  if (seen.size !== kept.length) return null;
  for (let n = 1; n <= kept.length; n++) if (seen.get(n) !== 1) return null;
  const out = polished.replace(MARKER_RE, (_m, n: string) => kept[Number(n) - 1]!);
  if (out.length < draftLength * MIN_RATIO || out.length > draftLength * MAX_RATIO) return null;
  return out;
}

export function polishRequest(masked: string, kept: number, tone: string): string {
  return [
    'Rewrite this narration so it reads better. Keep to these rules:',
    '- Keep every event, outcome, name, number and die result, in the same order. Add no new events, characters, items, injuries or discoveries, and leave nothing out.',
    '- The player characters do, say and feel only what the draft says they do. Do not invent their words, choices or feelings.',
    '- Keep how it ends: if it ends on a question or a prompt to the players, so does yours.',
    '- Keep the paragraphs, any Markdown formatting, and roughly the same length.',
    kept
      ? `- Markers like ${marker(1)} stand for text that must stay exactly as it is (what the players said, links and citations). Keep every marker exactly once, where it belongs in the sentence, and do not wrap a marker in extra quotation marks.`
      : '',
    tone ? `- The tone of this campaign: ${tone}` : '',
    '',
    '<narration>',
    masked,
    '</narration>',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * The draft as polished by the outside AI called `aiName`, or the draft as it
 * is when that AI is gone, slow, refuses, or changes what it was told to keep.
 * `playerLines` is what the people at the table wrote this turn.
 */
export async function polishNarration(
  aiName: string,
  draft: string,
  playerLines: string[],
  tone = '',
): Promise<{ text: string; polished: boolean }> {
  if (!aiName.trim()) return { text: draft, polished: false };
  try {
    const ai = await findOutsideAi(aiName);
    if (ai) return await polishWith(ai, draft, playerLines, tone);
    log().warn({ ai: aiName }, 'polishing AI is not set up; posting the draft');
  } catch (err) {
    log().warn({ err, ai: aiName }, 'could not look up the polishing AI; posting the draft');
  }
  return { text: draft, polished: false };
}

/** polishNarration with the AI in hand. `fetchImpl` is for tests. */
export async function polishWith(
  ai: OutsideAi,
  draft: string,
  playerLines: string[],
  tone = '',
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; polished: boolean }> {
  const asIs = { text: draft, polished: false };
  if (draft.trim().length < 40) return asIs;
  try {
    const { masked, kept } = maskDraft(draft, playerLines);
    const reply = await callOutsideAi(ai, polishRequest(masked, kept.length, tone), fetchImpl, {
      system: SYSTEM,
      timeoutMs: POLISH_TIMEOUT_MS,
      maxChars: Math.max(draft.length * 2, 2000),
    });
    const body = reply
      .replace(/^\s*<narration>\s*/i, '')
      .replace(/\s*<\/narration>\s*$/i, '')
      .trim();
    const text = unmask(body, kept, draft.length);
    if (!text) {
      log().warn(
        { ai: ai.name },
        'polished narration changed protected text or its length; posting the draft',
      );
      return asIs;
    }
    return { text, polished: true };
  } catch (err) {
    log().warn(
      { err: err instanceof OutsideAiError ? err.message : err, ai: ai.name },
      'could not polish narration; posting the draft',
    );
    return asIs;
  }
}
