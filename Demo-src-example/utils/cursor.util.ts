import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Opaque pagination cursors across sources that page differently.
 *
 * ONE QUESTION MAY SPAN A SYSTEM USING OFFSETS, ONE USING KEYSET CURSORS AND ONE
 * USING PAGE TOKENS. A cursor here holds each source's own position, so resuming
 * asks each system to continue in the way that system understands.
 *
 * SIGNED, BECAUSE A CURSOR IS AN INPUT. Unsigned, it is a client-supplied blob
 * the server will use to build a query — a place to put an offset of minus one, a
 * page size of a million, or a connection id belonging to another tenant. The
 * signature makes it a value the server issued rather than one it was handed.
 *
 * IT IS NOT ENCRYPTED, ONLY AUTHENTICATED. The contents are positions, not
 * secrets. Anyone base64-decoding one learns which systems were queried, and they
 * asked the question.
 */

export interface CursorState {
  /** Per-connection position, in whatever form that connector paginates with. */
  positions: Record<string, string | number>;
  /** Which manifest this cursor belongs to. */
  manifestId: string;
  /** Issued for this tenant, checked on resume. */
  organisationId: string;
  issuedAt: number;
}

const SEPARATOR = '.';

export function encode(state: CursorState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}${SEPARATOR}${signature}`;
}

export interface CursorRejection {
  ok: false;
  reason: 'malformed' | 'bad-signature' | 'wrong-tenant' | 'wrong-manifest' | 'expired';
}

/**
 * Decode and verify.
 *
 * THE TENANT IS CHECKED, NOT JUST THE SIGNATURE. A validly signed cursor is still
 * one this organisation may not have issued: a user in two tenants could present
 * a cursor from the other one, and every position inside it names connections
 * they cannot see in this context.
 */
export function decode(
  cursor: string,
  secret: string,
  expect: { organisationId: string; manifestId: string; maxAgeMs?: number },
): ({ ok: true; state: CursorState }) | CursorRejection {
  const parts = cursor.split(SEPARATOR);
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };

  const [payload, signature] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');

  const given = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  if (given.length !== computed.length || !timingSafeEqual(given, computed)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let state: CursorState;
  try {
    state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CursorState;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (state.organisationId !== expect.organisationId) return { ok: false, reason: 'wrong-tenant' };
  if (state.manifestId !== expect.manifestId) return { ok: false, reason: 'wrong-manifest' };

  if (expect.maxAgeMs && Date.now() - state.issuedAt > expect.maxAgeMs) {
    // A day-old cursor resumes a scan against data that has moved underneath it,
    // producing a page that overlaps or skips.
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, state };
}
