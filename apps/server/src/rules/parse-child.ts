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
  // Fillable sheets keep what the player typed in form fields, which are not
  // part of the page text. Short documents only: rulebooks have no forms worth reading.
  if (pdf.numPages <= FORM_PAGES) {
    for (let n = 1; n <= pdf.numPages; n++) {
      const filled = await formFields(pdf, n).catch(() => []);
      if (filled.length) text[n - 1] = `${text[n - 1] ?? ''}\n\nForm fields:\n${filled.join('\n')}`;
    }
  }
  return text;
}

const FORM_PAGES = 12;

interface Widget {
  subtype?: string;
  fieldName?: string;
  fieldValue?: unknown;
}

async function formFields(pdf: Awaited<ReturnType<typeof getDocumentProxy>>, pageNumber: number) {
  const page = await pdf.getPage(pageNumber);
  const widgets = (await page.getAnnotations()) as Widget[];
  return widgets.flatMap((w) => {
    const value = Array.isArray(w.fieldValue) ? w.fieldValue.join(', ') : w.fieldValue;
    if (w.subtype !== 'Widget' || !w.fieldName || typeof value !== 'string') return [];
    const shown = value.trim();
    // "Off" is how an unticked checkbox reads.
    return shown && shown !== 'Off' ? [`${w.fieldName}: ${shown.slice(0, 2000)}`] : [];
  });
}

run().then(
  (pages) => process.send?.({ ok: true, pages }, () => process.exit(0)),
  (err: unknown) =>
    process.send?.(
      { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : 'parse failed' },
      () => process.exit(1),
    ),
);
