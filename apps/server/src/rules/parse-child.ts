// Runs in a short-lived child process started by parse.ts. It only extracts
// text: nothing from the document is executed, and the parent enforces the
// memory and time limits.
import { readFile } from 'node:fs/promises';
import { extractText, getDocumentProxy } from 'unpdf';

const [file, maxPagesArg] = process.argv.slice(2);

async function run(): Promise<string[]> {
  if (!file) throw new Error('no file given');
  const maxPages = Number(maxPagesArg) || 1500;
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)), { isEvalSupported: false });
  if (pdf.numPages > maxPages) throw new Error(`PDF has ${pdf.numPages} pages; the limit is ${maxPages}`);
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

run().then(
  (pages) => process.send?.({ ok: true, pages }, () => process.exit(0)),
  (err: unknown) =>
    process.send?.(
      { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : 'parse failed' },
      () => process.exit(1),
    ),
);
