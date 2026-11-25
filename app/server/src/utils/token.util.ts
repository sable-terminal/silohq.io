// Opaque bearer tokens: sessions (spec 60.1: "opaque server-side sessions, not JWT"),
// password resets, invitations, API client secrets, agent enrolment, OAuth state and
// webhook paths. A token is shown once; only its SHA-256 is stored, in the 32-byte
// token_hash column of its table.
//
// Each token is silo_<kind>_<43 base64url characters> (256 random bits). The prefix
// names the kind, so a token pasted into a log or a ticket is recognisable to the
// redaction scan (src/utils/redaction.util.ts) and to secret scanners.
//
// SCIM tokens are <organisation_id>.<random> (design: iam.scim_tokens), because the
// gateway sets app.org_id from the prefix before it can look the hash up under RLS.
//
// Session tokens carry their organisation and session ids before the random part:
// silo_ses_<86 base64url characters> (16 + 16 + 32 bytes). The hot copy in redis-session
// is keyed by both (design: sess:{<organisation_id>}:<session_id>), so a request resolves
// without a database lookup; the random part is still what proves the holder, checked
// against the stored hash.

import { base64url, randomBytes, sha256 } from './crypto.util.ts';
import { isUuid } from './id.util.ts';

export const TOKEN_KINDS = {
  session: 'ses',
  password_reset: 'rst',
  invitation: 'inv',
  api_client_secret: 'api',
  agent_enrolment: 'enr',
  oauth_state: 'ost',
  webhook_path: 'whk',
  signup: 'sup',
} as const;

export type TokenKind = keyof typeof TOKEN_KINDS;

export const TOKEN_RANDOM_BYTES = 32;
export const TOKEN_PATTERN = /silo_(?:ses|rst|inv|api|enr|ost|whk|sup)_[A-Za-z0-9_-]{43}(?:[A-Za-z0-9_-]{43})?/;

export interface IssuedToken {
  /** Give to the holder once. Never store or log it. */
  token: string;
  /** SHA-256 of the token: what the database stores. */
  hash: Buffer;
}

export function issueToken(kind: TokenKind): IssuedToken {
  const token = `silo_${TOKEN_KINDS[kind]}_${base64url(randomBytes(TOKEN_RANDOM_BYTES))}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return sha256(token);
}

// The kind a token claims, or undefined for anything that is not a Silo token. A lookup
// still goes by hash; this only lets a handler refuse the wrong kind before a query.
export function tokenKind(token: string): TokenKind | undefined {
  const match = /^silo_([a-z]{3})_[A-Za-z0-9_-]{43}(?:[A-Za-z0-9_-]{43})?$/.exec(token);
  if (!match) return undefined;
  return (Object.keys(TOKEN_KINDS) as TokenKind[]).find((kind) => TOKEN_KINDS[kind] === match[1]);
}

export function issueScimToken(organisationId: string): IssuedToken {
  if (!isUuid(organisationId)) throw new TypeError('organisation id must be a UUID');
  const token = `${organisationId}.${base64url(randomBytes(TOKEN_RANDOM_BYTES))}`;
  return { token, hash: hashToken(token) };
}

export function parseScimToken(token: string): { organisationId: string; hash: Buffer } | undefined {
  const dot = token.indexOf('.');
  const organisationId = token.slice(0, dot);
  if (dot <= 0 || !isUuid(organisationId) || !/^[A-Za-z0-9_-]{43}$/.test(token.slice(dot + 1))) return undefined;
  return { organisationId, hash: hashToken(token) };
}

const uuidBytes = (id: string): Buffer => Buffer.from(id.replaceAll('-', ''), 'hex');
const uuidText = (bytes: Buffer): string => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function issueSessionToken(organisationId: string, sessionId: string): IssuedToken {
  if (!isUuid(organisationId) || !isUuid(sessionId)) throw new TypeError('organisation and session ids must be UUIDs');
  const body = Buffer.concat([uuidBytes(organisationId), uuidBytes(sessionId), randomBytes(TOKEN_RANDOM_BYTES)]);
  const token = `silo_${TOKEN_KINDS.session}_${base64url(body)}`;
  return { token, hash: hashToken(token) };
}

/** The ids a session token carries, and its hash. Undefined for anything else. */
export function parseSessionToken(token: string): { organisationId: string; sessionId: string; hash: Buffer } | undefined {
  const match = /^silo_ses_([A-Za-z0-9_-]{86})$/.exec(token);
  if (!match) return undefined;
  const body = Buffer.from(match[1]!, 'base64url');
  if (body.length !== 64) return undefined;
  const organisationId = uuidText(body.subarray(0, 16));
  const sessionId = uuidText(body.subarray(16, 32));
  if (!isUuid(organisationId) || !isUuid(sessionId)) return undefined;
  return { organisationId, sessionId, hash: hashToken(token) };
}
