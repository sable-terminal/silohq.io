/**
 * Making the same real-world thing look the same across systems.
 *
 * THIS IS WHAT MAKES ENTITY RESOLUTION POSSIBLE. `ACME Ltd.`, `Acme Limited` and
 * `acme  ltd` are one supplier in the world and three strings in three systems.
 * Normalisation is the step that lets a match key be compared at all.
 *
 * IT IS LOSSY ON PURPOSE AND THE ORIGINAL IS ALWAYS KEPT. A normalised value is a
 * comparison key, never a display value and never something written back. Showing
 * `acme ltd` where the customer's ledger says `ACME Ltd.` is a product that looks
 * broken; writing it back is data loss.
 */

/** Legal-form suffixes, which differ by system and by who typed the record. */
const COMPANY_SUFFIXES = [
  'ltd', 'limited', 'llc', 'llp', 'lp', 'plc', 'inc', 'incorporated', 'corp',
  'corporation', 'co', 'company', 'gmbh', 'ag', 'sa', 'sas', 'sarl', 'bv', 'nv',
  'ab', 'as', 'oy', 'spa', 'srl', 'pty', 'holdings', 'group',
];

export function companyName(value: string): string {
  let name = value
    .toLowerCase()
    .normalize('NFKD')
    // Strip diacritics, so `Nestlé` and `Nestle` are one supplier.
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Suffixes are stripped repeatedly: `Acme Holdings Ltd` has two.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of COMPANY_SUFFIXES) {
      if (name.endsWith(` ${suffix}`)) {
        name = name.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }

  return name;
}

/**
 * A postcode in its canonical form.
 *
 * UK POSTCODES ARE STORED EVERY WAY IMAGINABLE. `SW1A 1AA`, `sw1a1aa`,
 * `SW1A  1AA`. The outward and inward codes are always split by exactly one
 * space, and the inward code is always the last three characters.
 */
export function postcode(value: string): string {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length < 5 || compact.length > 7) return compact;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

/** An address line reduced to a comparison key. */
export function addressLine(value: string): string {
  const abbreviations: Record<string, string> = {
    street: 'st', road: 'rd', avenue: 'ave', drive: 'dr', lane: 'ln',
    court: 'ct', place: 'pl', square: 'sq', boulevard: 'blvd',
    apartment: 'apt', suite: 'ste', floor: 'fl', building: 'bldg',
    north: 'n', south: 's', east: 'e', west: 'w',
  };

  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => abbreviations[word] ?? word)
    .join(' ');
}

/**
 * A phone number in E.164, given a default country.
 *
 * WITHOUT A DEFAULT COUNTRY THIS IS UNANSWERABLE. `020 7946 0958` is a London
 * number only if you already know it is British; the same digits are a valid
 * local number elsewhere. Returns null rather than guessing, because a wrong
 * country code is worse than no number.
 */
export function phone(value: string, defaultCountry = '44'): string | null {
  const digits = value.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  // A national number: drop the trunk prefix, prepend the country.
  if (digits.startsWith('0')) return `+${defaultCountry}${digits.slice(1)}`;
  if (digits.length < 7) return null;
  return `+${defaultCountry}${digits}`;
}

/**
 * A date, as an ISO date string.
 *
 * `01/02/2026` IS AMBIGUOUS AND IS REFUSED. It is January the second in one
 * system and February the first in another, and there is no way to tell from the
 * string. Guessing silently misdates a record; refusing surfaces the ambiguity to
 * whoever configured the connector, who knows which system it came from.
 */
export function isoDate(value: string): string | null {
  const trimmed = value.trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);

  // Unambiguous only when one component cannot be a month.
  const slashed = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (slashed) {
    const [, a, b, year] = slashed as unknown as [string, string, string, string];
    const first = Number(a);
    const second = Number(b);
    if (first > 12 && second <= 12) return `${year}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    if (second > 12 && first <= 12) return `${year}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
    return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

/**
 * Money as minor units and a currency.
 *
 * NEVER A FLOAT. `0.1 + 0.2` is not `0.3` in binary floating point, and a ledger
 * that drifts by fractions of a penny across a million rows is a ledger nobody
 * can reconcile. Integers of the minor unit, always.
 */
export function money(value: string | number, currency = 'GBP'): { minor: number; currency: string } | null {
  const raw = typeof value === 'number' ? String(value) : value;
  const cleaned = raw.replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return null;

  // `1.234,56` is European; `1,234.56` is British. The last separator is the
  // decimal one.
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalised = cleaned;

  if (lastComma > lastDot) {
    normalised = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    normalised = cleaned.replace(/,/g, '');
  }

  const amount = Number(normalised);
  if (Number.isNaN(amount)) return null;

  return { minor: Math.round(amount * 100), currency };
}
