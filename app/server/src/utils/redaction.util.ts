// Redaction, the second and later lines of defence against a record value or secret
// leaving its allowed places (spec 8.5, 13.1, 7.8). The first line is construction:
// typed logging (logger.infra.ts), typed model requests and value-free bus schemas.
//
// - Value patterns (spec 7.8): email addresses, card numbers, UK National Insurance
//   numbers and long digit strings, plus Silo tokens. The model gateway rejects text that
//   matches rather than stripping it, "so an upstream defect is found rather than
//   hidden"; the logger replaces a matching message and counts a redaction violation.
// - Key names and paths (spec 13.1): password, secret, token, authorization, cookie,
//   value, values, row, rows, record, payload, prompt, completion "and everything beneath
//   them" are removed from any structure before it is logged or reported.

import { TOKEN_PATTERN } from './token.util.ts';
import { AppError } from './errors.util.ts';

export type ValuePatternKind = 'email' | 'card_number' | 'national_insurance_number' | 'long_digit_string' | 'silo_token';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
// UK NINO: two prefix letters (excluding D, F, I, Q, U, V, and O as the second, and the
// unallocated pairs BG, GB, KN, NK, NT, TN, ZZ), six digits, suffix A to D.
const NINO = /\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/i;
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
// Ten or more digits in a row. A UUID is an identifier, never a value: its hex groups can
// hold a run of digits by chance (its last group, about once in forty), so UUIDs are set
// aside before the digits are looked at.
const LONG_DIGITS = /\d{10,}/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

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

export function findValuePatterns(text: string): ValuePatternKind[] {
  const found = new Set<ValuePatternKind>();
  if (EMAIL.test(text)) found.add('email');
  const withoutIds = text.replace(UUID, ' ');
  if (NINO.test(text)) found.add('national_insurance_number');
  for (const match of withoutIds.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) found.add('card_number');
  }
  if (LONG_DIGITS.test(withoutIds)) found.add('long_digit_string');
  if (TOKEN_PATTERN.test(text)) found.add('silo_token');
  return [...found];
}

// Refuses text that looks like it carries a value. The error names the kinds matched,
// never the text.
export function assertNoValuePatterns(text: string, where: string): void {
  const kinds = findValuePatterns(text);
  if (kinds.length > 0) {
    throw new AppError('validation', `${where} contains text matching a value pattern`, {
      code: 'redaction.value_pattern', details: { where, kinds: kinds.join(',') },
    });
  }
}

// Key words whose subtree is removed. A key is split into words (camelCase, snake_case,
// kebab-case): it is redacted when any word is in ANY, or its last word is in LAST.
// "rowCount" and "tokenHash" survive (a count, a hash); "newValue", "accessToken" and
// "rows" do not.
const ANY = new Set(['password', 'passwd', 'secret', 'authorization', 'cookie', 'prompt', 'completion', 'ciphertext', 'sealed', 'credential', 'credentials', 'plaintext']);
const LAST = new Set(['token', 'tokens', 'value', 'values', 'row', 'rows', 'record', 'records', 'payload', 'payloads', 'body', 'key', 'pin', 'otp', 'code']);
const SAFE_KEYS = new Set(['idempotencyKey', 'idempotency_key', 'orderingKey', 'ordering_key', 'errorCode', 'error_code', 'statusCode', 'status_code']);

export function isRedactedKey(key: string): boolean {
  if (SAFE_KEYS.has(key)) return false;
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_\-.]+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.some((w) => ANY.has(w)) || LAST.has(words[words.length - 1]!);
}

export const REDACTED = '[redacted]';

// A copy of value with every redacted key's subtree replaced. Depth-bounded, and cycles
// are cut, so any input is safe to pass.
export function redactKeys(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 12) return REDACTED;
  if (Array.isArray(value)) {
    if (seen.has(value)) return REDACTED;
    seen.add(value);
    return value.map((item) => redactKeys(item, depth + 1, seen));
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value) || Buffer.isBuffer(value)) return REDACTED;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isRedactedKey(key) ? REDACTED : redactKeys(child, depth + 1, seen);
    }
    return out;
  }
  return value;
}
