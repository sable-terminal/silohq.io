// What looks like a record value in free text (spec 7.8, 8.5): the same patterns the server
// refuses in a support ticket, checked as the person types so they can describe it instead before
// they send. The server's check is the one that counts; this only warns early.

export type ValueKind = 'email' | 'card_number' | 'national_insurance_number' | 'long_digit_string' | 'silo_token';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const NINO = /\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/i;
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
const LONG_DIGITS = /\d{10,}/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TOKEN = /silo_(?:ses|rst|inv|api|enr|ost|whk|sup)_[A-Za-z0-9_-]{43}(?:[A-Za-z0-9_-]{43})?/;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function valuesIn(text: string): ValueKind[] {
  const found = new Set<ValueKind>();
  if (EMAIL.test(text)) found.add('email');
  const withoutIds = text.replace(UUID, ' ');
  if (NINO.test(text)) found.add('national_insurance_number');
  for (const match of withoutIds.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) found.add('card_number');
  }
  if (LONG_DIGITS.test(withoutIds)) found.add('long_digit_string');
  if (TOKEN.test(text)) found.add('silo_token');
  return [...found];
}

const WORDS: Record<ValueKind, string> = {
  email: 'an email address', card_number: 'a card number', national_insurance_number: 'a National Insurance number',
  long_digit_string: 'a long number, such as an account number', silo_token: 'a Silo token',
};

/** What to say when text looks like it holds a value, or undefined when it does not. */
export function valueWarning(text: string): string | undefined {
  const kinds = valuesIn(text);
  if (kinds.length === 0) return undefined;
  return `This looks like it holds ${kinds.map((k) => WORDS[k]).join(' and ')}. Silo support never needs your data: describe it instead, and refer to things by choosing them.`;
}
