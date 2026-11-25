import { extractTextItems } from 'unpdf';
import type { DocumentPage } from '../models/document.model';

/**
 * A PDF's text and where each piece sits, page by page.
 *
 * ── Text a PDF says it contains, and nothing else ──────────────────────────
 *
 * The text layer only: a scanned page has none, and reads as a page with no
 * text rather than being guessed at. Reading pixels would be a model, and a
 * model is Import phase five and the carve-out, not this.
 *
 * ── Bounded ────────────────────────────────────────────────────────────────
 *
 * A file is already capped at 64 MB, but a small PDF can declare thousands of
 * pages. Past the cap the document is refused rather than read in part, because
 * a record assembled from the first pages of a document looks complete.
 */

const MAX_PAGES = 500;

export class DocumentTooLong extends Error {}

export async function readPdf(bytes: Buffer): Promise<DocumentPage[]> {
  /* A copy: the PDF reader may take ownership of the buffer it is given. */
  const { totalPages, items } = await extractTextItems(new Uint8Array(bytes));

  if (totalPages > MAX_PAGES) {
    throw new DocumentTooLong(`The document has ${totalPages} pages; at most ${MAX_PAGES} are read.`);
  }

  return items.map((pageItems, index) => ({
    page: index + 1,
    items: pageItems
      .filter((item) => item.str.trim() !== '')
      .map((item) => ({ text: item.str, x: item.x, y: item.y, width: item.width, height: item.height })),
  }));
}
