import { DocumentTooLong, readPdf } from '../../utils/pdfText.util';
import { FormatError, type FormatParser } from './contract.format';

/**
 * A PDF's text layer, page by page, with the position of every piece.
 *
 * TEXT THE PDF SAYS IT CONTAINS, AND NOTHING ELSE. A scanned invoice has no text
 * layer and reads as pages with no text — it is not guessed at here. Reading
 * pixels is a model, which is Import's carve-out, not a connector's.
 *
 * POSITIONS ARE KEPT because a supplier invoice is a layout: "the number to the
 * right of Total" is an expression over `items`, and it is the only way to read
 * a document whose text order is whatever the software that drew it chose.
 */
export const pdf: FormatParser = {
  name: 'pdf',
  contentTypes: ['application/pdf'],
  binary: true,
  async parse({ input }) {
    try {
      const pages = await readPdf(Buffer.isBuffer(input) ? input : Buffer.from(String(input)));
      return {
        pages: pages.map((page) => ({
          page: page.page,
          text: page.items.map((item) => item.text).join(' '),
          items: page.items,
        })),
        text: pages.map((page) => page.items.map((item) => item.text).join(' ')).join('\n'),
      };
    } catch (error) {
      if (error instanceof DocumentTooLong) throw new FormatError('pdf', error.message);
      throw new FormatError('pdf', `The file is not a PDF Silo can read: ${error instanceof Error ? error.message : 'unreadable'}.`);
    }
  },
};
