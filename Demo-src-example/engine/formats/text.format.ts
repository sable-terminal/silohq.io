import type { FormatParser } from './contract.format';

/**
 * The body as text, for an expression to take apart itself.
 *
 * IT CLAIMS NO CONTENT TYPE. `text/plain` is what a great many JSON APIs answer
 * with, so under `auto` it is sniffed first and read as text only when it is
 * neither JSON nor XML.
 */
export const text: FormatParser = {
  name: 'text',
  contentTypes: [],
  binary: false,
  parse: ({ input }) => String(input),
};

/**
 * The body as bytes. The runner turns it into a blob handle, so a download step
 * can hand a file to a later step's `source` without it passing through an
 * expression.
 */
export const binary: FormatParser = {
  name: 'binary',
  contentTypes: [],
  binary: true,
  parse: ({ input }) => (Buffer.isBuffer(input) ? input : Buffer.from(String(input))),
};
