// A record value as the client shows it (spec 23.4, 23.5, 31): by its property's kind, in
// British English. A disputed value is never resolved here, an empty one is a dash, and one no
// system could be asked about says so rather than looking empty.

const numbers = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 });
const dates = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
const moments = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export type DataType = 'array' | 'boolean' | 'date' | 'decimal' | 'duration' | 'enum' | 'geopoint' | 'geoshape' | 'integer' | 'money' | 'string' | 'struct' | 'timestamp';
export type ValueState = 'declared' | 'agreed' | 'only' | 'disputed' | 'empty' | 'unchecked';

export function formatValue(dataType: DataType | undefined, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (dataType) {
    case 'integer':
    case 'decimal':
    case 'money':
      return typeof value === 'number' ? numbers.format(value) : String(value);
    case 'boolean':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    case 'date': {
      const parsed = typeof value === 'string' ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
      return Number.isNaN(parsed) ? String(value) : dates.format(parsed);
    }
    case 'timestamp': {
      const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
      return Number.isNaN(parsed) ? String(value) : moments.format(parsed);
    }
    default:
      if (typeof value === 'number') return numbers.format(value);
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/** What a cell says when its state is not a plain value. */
export function stateText(state: ValueState | undefined): string | undefined {
  if (state === 'disputed') return 'Systems disagree';
  if (state === 'unchecked') return 'Not checked: a system could not be asked';
  return undefined;
}
