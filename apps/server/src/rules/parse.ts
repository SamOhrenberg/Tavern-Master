import { fork } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { Page } from './chunk.js';

export type DocKind = 'pdf' | 'text';

/**
 * Decide what a file really is from its bytes. The browser-supplied MIME type
 * and extension are only hints: a PDF must start with %PDF-, and anything
 * else must be plain UTF-8 text with a text extension.
 */
export function sniff(head: Buffer, fileName: string): DocKind | undefined {
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (!/\.(md|markdown|txt)$/i.test(fileName)) return undefined;
  if (head.includes(0)) return undefined;
  try {
    // Cut at a character boundary so a split multi-byte sequence is not an error.
    let end = head.length;
    while (end > 0 && (head[end - 1]! & 0xc0) === 0x80) end--;
    if (end > 0 && head[end - 1]! >= 0xc0) end--;
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, end));
    return 'text';
  } catch {
    return undefined;
  }
}

/** Recognise a photo or scan from its first bytes. */
export function sniffImage(head: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  return undefined;
}

export async function sniffFile(path: string, fileName: string): Promise<DocKind | undefined> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return sniff(buf.subarray(0, bytesRead), fileName);
  } finally {
    await fh.close();
  }
}

/**
 * Parse a PDF in a throwaway child process: it gets a heap limit, a wall-clock
 * limit and an empty environment (no database URL, no API keys), and is killed
 * if it overruns. A hostile PDF can at worst fail its own ingestion.
 */
function parsePdf(path: string): Promise<Page[]> {
  const cfg = config();
  const isTs = import.meta.url.endsWith('.ts');
  const child = fileURLToPath(new URL(isTs ? './parse-child.ts' : './parse-child.js', import.meta.url));
  return new Promise((resolve, reject) => {
    const proc = fork(child, [path, String(cfg.MAX_PDF_PAGES)], {
      execArgv: [`--max-old-space-size=${cfg.PARSE_MEMORY_MB}`, ...(isTs ? ['--import', 'tsx'] : [])],
      env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill('SIGKILL');
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`PDF parsing exceeded ${cfg.PARSE_TIMEOUT_SECONDS} seconds`))),
      cfg.PARSE_TIMEOUT_SECONDS * 1000,
    );
    proc.on('message', (msg: { ok: boolean; pages?: string[]; error?: string }) => {
      if (msg.ok && Array.isArray(msg.pages)) {
        const pages = msg.pages.map((text, i) => ({ page: i + 1, text: String(text) }));
        done(() => resolve(pages));
      } else {
        done(() => reject(new Error(msg.error ?? 'PDF could not be parsed')));
      }
    });
    proc.on('error', (err) => done(() => reject(err)));
    proc.on('exit', (code) =>
      done(() =>
        reject(
          new Error(`PDF parser stopped unexpectedly (code ${code}); the file may be too large or damaged`),
        ),
      ),
    );
  });
}

export async function parseDocument(path: string, kind: DocKind): Promise<Page[]> {
  if (kind === 'pdf') return parsePdf(path);
  return [{ page: null, text: (await readFile(path)).toString('utf8') }];
}
