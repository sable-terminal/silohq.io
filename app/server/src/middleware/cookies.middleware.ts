// The session cookies (spec 60: opaque server-side sessions): the person's on the public
// API and the member of staff's on the staff console. The browser holds a token only here:
// - __Host- prefix: the browser accepts it only with Secure, Path=/ and no Domain, so it
//   is host-only and a sibling subdomain cannot set or overwrite it;
// - HttpOnly: page script cannot read it, so an injected script cannot carry it off;
// - SameSite=Strict: no other site's page, link or form sends it. Each web client is
//   same-origin, so nothing legitimate is lost;
// - it expires with the session's absolute lifetime; the idle timeout is enforced
//   server-side on every request.
// The two cookies have different names, so the two listeners never read each other's.

import { sessionToken } from '../contracts/auth/session.contract.ts';

export const SESSION_COOKIE = '__Host-silo_session';
export const STAFF_COOKIE = '__Host-silo_staff';

const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict';
const STAFF_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The named cookie's value, or undefined. The first occurrence wins. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

const setCookie = (name: string, token: string, absoluteExpiresAt: string, now: number): string =>
  `${name}=${token}; ${ATTRIBUTES}; Max-Age=${Math.max(0, Math.floor((Date.parse(absoluteExpiresAt) - now) / 1000))}`;

/** The session token from the request's cookie, if it has the shape of one. */
export function sessionTokenOf(header: string | undefined): string | undefined {
  const value = readCookie(header, SESSION_COOKIE);
  return value !== undefined && sessionToken.safeParse(value).success ? value : undefined;
}

export const sessionCookie = (token: string, absoluteExpiresAt: string, now = Date.now()): string =>
  setCookie(SESSION_COOKIE, token, absoluteExpiresAt, now);

export const clearedSessionCookie = (): string => `${SESSION_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;

/** The staff session token from the request's cookie, if it has the shape of one. */
export function staffTokenOf(header: string | undefined): string | undefined {
  const value = readCookie(header, STAFF_COOKIE);
  return value !== undefined && STAFF_TOKEN.test(value) ? value : undefined;
}

export const staffCookie = (token: string, absoluteExpiresAt: string, now = Date.now()): string =>
  setCookie(STAFF_COOKIE, token, absoluteExpiresAt, now);

export const clearedStaffCookie = (): string => `${STAFF_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;
