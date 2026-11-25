import { X509Certificate } from 'node:crypto';

/**
 * When a credential stops working, read from the credential itself.
 *
 * THREE WAYS TO KNOW, IN ORDER OF CERTAINTY. A certificate says so in its
 * `notAfter`; a signed token says so in its `exp`; a connector can declare that
 * the system issues keys for so many days. The earliest wins — a connection is
 * as dead as its first lapsed part. Nothing here is a guess: a value that says
 * nothing about its own lifetime gives no date, not an invented one.
 */

export interface Expiry {
  at: Date;
  source: 'certificate' | 'token' | 'declared';
}

const CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const JWT = /^eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]*$/;

function fromValue(value: string): Expiry | null {
  let earliest: Expiry | null = null;
  const consider = (candidate: Expiry | null) => {
    if (candidate && !Number.isNaN(candidate.at.getTime()) && (!earliest || candidate.at < earliest.at)) earliest = candidate;
  };
  for (const pem of value.match(CERTIFICATE) ?? []) {
    try {
      consider({ at: new Date(new X509Certificate(pem).validTo), source: 'certificate' });
    } catch {
      /* not a certificate Node can read: it says nothing about when it lapses */
    }
  }
  const jwt = JWT.exec(value.trim());
  if (jwt) {
    try {
      const payload = JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
      if (typeof payload.exp === 'number') consider({ at: new Date(payload.exp * 1000), source: 'token' });
    } catch {
      /* a token whose payload is not JSON has no exp to read */
    }
  }
  return earliest;
}

export function expiryOf(fields: Record<string, string>, declaredDays: Record<string, number | undefined>, now: Date = new Date()): Expiry | null {
  let earliest: Expiry | null = null;
  for (const [name, value] of Object.entries(fields)) {
    const read = fromValue(value);
    const days = declaredDays[name];
    const declared: Expiry | null = days ? { at: new Date(now.getTime() + days * 86_400_000), source: 'declared' } : null;
    for (const candidate of [read, declared]) {
      if (candidate && (!earliest || candidate.at < earliest.at)) earliest = candidate;
    }
  }
  return earliest;
}
