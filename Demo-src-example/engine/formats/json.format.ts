import { FormatError, type FormatParser } from './contract.format';

/** JSON. The common case, and the only one most connectors ever meet. */
export const json: FormatParser = {
  name: 'json',
  contentTypes: ['application/json', 'text/json', '+json'],
  binary: false,
  parse({ input }) {
    const text = String(input);
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new FormatError('json', `The response is not JSON: ${error instanceof Error ? error.message : 'unreadable'}.`);
    }
  },
};
