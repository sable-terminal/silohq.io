import { randomBytes } from 'node:crypto';

/**
 * Reading a forwarded notification email as data.
 *
 * FOR SYSTEMS WITH NO API AND NO EXPORT. Plenty of business software will email
 * you a notification and offer nothing else. Forwarding those to a minted address
 * is the connector of last resort.
 *
 * EVERY VALUE IT PRODUCES IS LOW CONFIDENCE AND MUST BE LABELLED AS SUCH. This is
 * pattern matching against a layout somebody else may change without notice, and
 * a figure extracted from an email should never be presented with the same
 * authority as one read from an API.
 */

/**
 * A minted address, unguessable.
 *
 * THE LOCAL PART IS RANDOM, NOT DERIVED FROM THE ORGANISATION. Anything derived —
 * a slug, a hash of the name — is guessable, and a guessable inbound address is
 * an unauthenticated write endpoint that anybody can post to. The address is the
 * credential.
 */
export function mintAddress(domain: string): { address: string; secret: string } {
  const secret = randomBytes(16).toString('hex');
  return { address: `in-${secret}@${domain}`, secret };
}

export interface ParsedEmail {
  from: string;
  subject: string;
  body: string;
  receivedAt: Date;
}

export interface ExtractionRule {
  field: string;
  /** A capture group holds the value. */
  pattern: RegExp;
  transform?: 'number' | 'date' | 'money' | 'text';
}

export interface Extraction {
  field: string;
  value: string | number | null;
  confidence: number;
  /** The text it came from, so a human can check it. */
  evidence: string;
}

export function extract(email: ParsedEmail, rules: readonly ExtractionRule[]): Extraction[] {
  const results: Extraction[] = [];
  // Subject first: a value appearing there is usually the headline figure.
  const haystack = `${email.subject}\n${email.body}`;

  for (const rule of rules) {
    const match = rule.pattern.exec(haystack);
    if (!match) {
      results.push({ field: rule.field, value: null, confidence: 0, evidence: '' });
      continue;
    }

    const raw = (match[1] ?? match[0]).trim();
    results.push({
      field: rule.field,
      value: coerce(raw, rule.transform),
      /*
       * NEVER 1. This is a pattern against somebody else's email template, and
       * the template can change silently. Capping confidence keeps that visible
       * downstream rather than letting a regex masquerade as an API.
       */
      confidence: match.index < email.subject.length ? 0.75 : 0.6,
      evidence: raw.slice(0, 200),
    });
  }

  return results;
}

function coerce(raw: string, transform?: ExtractionRule['transform']): string | number | null {
  switch (transform) {
    case 'number':
    case 'money': {
      const value = Number(raw.replace(/[^\d.-]/g, ''));
      return Number.isNaN(value) ? null : value;
    }
    case 'date': {
      const parsed = Date.parse(raw);
      return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
    }
    default:
      return raw;
  }
}

/**
 * Whether this message may be trusted at all.
 *
 * THE ADDRESS BEING SECRET IS NOT ENOUGH, BECAUSE FROM HEADERS ARE FORGEABLE. A
 * minted address will eventually appear in a forwarded thread or a mailing list
 * archive; the sender must also be one the customer nominated. Both, or neither.
 */
export function isTrusted(email: ParsedEmail, allowedSenders: ReadonlySet<string>): boolean {
  const sender = email.from.toLowerCase().replace(/.*</, '').replace(/>.*/, '').trim();
  if (allowedSenders.has(sender)) return true;

  // A whole domain may be nominated: `@sage.com`.
  const domain = sender.slice(sender.indexOf('@'));
  return allowedSenders.has(domain);
}
