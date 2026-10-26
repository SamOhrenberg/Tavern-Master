export interface Page {
  /** 1-based page number, or null for formats without pages. */
  page: number | null;
  text: string;
}

export interface Chunk {
  ordinal: number;
  heading: string;
  pageStart: number | null;
  pageEnd: number | null;
  content: string;
  tokenCount: number;
}

/** Rough token estimate (about four characters per token for English prose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TARGET_CHARS = 1400;
const MAX_CHARS = 2200;

function headingOf(line: string): { level: number; title: string } | undefined {
  const md = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
  if (md) return { level: md[1]!.length, title: md[2]! };
  // PDFs have no markup: treat short all-caps lines as section titles.
  const t = line.trim();
  if (
    t.length >= 4 &&
    t.length <= 60 &&
    /[A-Z]{3}/.test(t) &&
    t === t.toUpperCase() &&
    !/[.:;,]$/.test(t) &&
    !/\d{3}/.test(t)
  ) {
    return { level: 3, title: t.replace(/\s+/g, ' ') };
  }
  return undefined;
}

function splitLong(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHARS) return [paragraph];
  const parts: string[] = [];
  let buf = '';
  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    if (buf && buf.length + sentence.length + 1 > TARGET_CHARS) {
      parts.push(buf);
      buf = '';
    }
    buf = buf ? `${buf} ${sentence}` : sentence;
    while (buf.length > MAX_CHARS) {
      parts.push(buf.slice(0, MAX_CHARS));
      buf = buf.slice(MAX_CHARS);
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/**
 * Split a document into retrieval chunks. Chunks never cross a heading, carry
 * the heading trail ("Combat › Making an Attack") and remember their pages so
 * the DM can cite them.
 */
export function chunkPages(pages: Page[]): Chunk[] {
  const chunks: Chunk[] = [];
  const trail: { level: number; title: string }[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let pageStart: number | null = null;
  let pageEnd: number | null = null;

  const flush = () => {
    const content = buf.join('\n\n').trim();
    if (content.length >= 20) {
      chunks.push({
        ordinal: chunks.length,
        heading: trail.map((h) => h.title).join(' › '),
        pageStart,
        pageEnd,
        content,
        tokenCount: estimateTokens(content),
      });
    }
    buf = [];
    bufLen = 0;
    pageStart = null;
    pageEnd = null;
  };

  const add = (paragraph: string, page: number | null) => {
    for (const part of splitLong(paragraph)) {
      if (bufLen && bufLen + part.length > TARGET_CHARS) flush();
      buf.push(part);
      bufLen += part.length + 2;
      pageStart ??= page;
      pageEnd = page;
    }
  };

  for (const { page, text } of pages) {
    let para: string[] = [];
    const endPara = () => {
      const p = para
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
      para = [];
      if (p) add(p, page);
    };
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trimEnd();
      const h = headingOf(line);
      if (h) {
        endPara();
        flush();
        while (trail.length && trail[trail.length - 1]!.level >= h.level) trail.pop();
        trail.push(h);
      } else if (!line.trim()) {
        endPara();
      } else if (/^\s*([-*•]|\d+\.)\s|^\|/.test(line)) {
        // Keep list items and table rows on their own lines.
        endPara();
        add(line.trim(), page);
      } else {
        para.push(line.trim());
      }
    }
    endPara();
  }
  flush();
  return chunks;
}
