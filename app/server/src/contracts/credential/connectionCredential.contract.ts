// The credential service's connection endpoints (spec 15.2, 61.3). Every auth field a
// person gives a connection is sealed here; the manifest decides which are secret. A secret
// never leaves: the service places it in the request itself, sends the request to the host
// the manifest names, and returns the response. Connection parameters are not credentials:
// they are public data on the connection row.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const fieldName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

/** Unwrap reasons a connection credential may be opened for (spec 61.3; idp, mfa_verify and sso_assert are not). */
export const CONNECTION_UNWRAP_REASONS = ['connect', 'query', 'mutation', 'read_back', 'refresh', 'probe', 'rotation', 'change_stream'] as const;

export const storeConnectionCredentials = defineContract({
  service: 'credential', name: 'storeConnectionCredentials', method: 'POST', path: '/v1/connection-credentials',
  callers: ['connect-registry'],
  // Each value replaces the live one for its field; storing the same value again leaves
  // the connection as it was.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ connectionId: z.uuid(), values: z.record(fieldName, z.string().min(1).max(16_384)) }),
  response: z.object({
    fields: z.array(z.object({ name: z.string(), kind: z.enum(['secret', 'public']), lastFour: z.string().nullable() })),
  }),
  maxBodyBytes: 128 * 1024,
});

export const revokeConnectionCredentials = defineContract({
  service: 'credential', name: 'revokeConnectionCredentials', method: 'POST', path: '/v1/connection-credentials/revocations',
  callers: ['connect-registry'],
  // Revoking what is already revoked revokes nothing more.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ connectionId: z.uuid() }),
  response: z.object({ revoked: z.number().int().min(0) }),
  maxBodyBytes: 1_024,
});

const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/);

/** A prepared request: a path on the manifest's base URL, never a host. */
export const preparedRequest = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().max(4_096).regex(/^\/[^\s]*$/),
  query: z.record(z.string().min(1).max(200), z.string().max(4_096)),
  headers: z.record(headerName, z.string().max(8_192)),
  /** A JSON body. */
  body: z.json().optional(),
  /** An XML body instead (SOAP): its text, sent as is, and one of SOAP's content types (1.2's with its action). */
  xml: z.strictObject({
    text: z.string().max(1_048_576),
    contentType: z.string().regex(/^(text\/xml; charset=utf-8|application\/soap\+xml; charset=utf-8(; action="[^"\r\n\\]{0,500}")?)$/),
  }).optional(),
}).refine((r) => r.body === undefined || r.xml === undefined, 'a request has one body');
export type PreparedRequest = z.infer<typeof preparedRequest>;

export const egressResponse = z.object({
  status: z.number().int().min(100).max(599),
  /** Lower-cased names. Set-Cookie is never returned. */
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});
export type EgressResponse = z.infer<typeof egressResponse>;

export const sendAuthorisedRequest = defineContract({
  service: 'credential', name: 'sendAuthorisedRequest', method: 'POST', path: '/v1/authorised-requests',
  callers: ['connect-runtime'],
  // The runtime decides whether a request may be repeated (reads are; writes go through
  // the write-back engine's own keys).
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    reason: z.enum(['connect', 'query', 'mutation', 'read_back', 'probe', 'change_stream']),
    request: preparedRequest,
    /**
     * Conformance only (spec 17.2, the error class): place a deliberately wrong value
     * instead of each secret, to see the source refuse it. Probe reason only; nothing is
     * opened, so nothing is recorded as an unwrap.
     */
    invalidCredentials: z.literal(true).optional(),
  }),
  response: egressResponse,
  maxBodyBytes: 1024 * 1024,
});

/**
 * The login of a connection through the Silo Agent, for one piece of work on one agent (spec
 * 10.7). A cell-custody login is opened here and sealed to that agent's X25519 key with HPKE
 * (RFC 9180; utils/hpke.util.ts), bound to the organisation, the agent, the connection and the
 * work, valid for two minutes: connect-runtime relays it and never holds it in clear. An
 * agent-custody connection's login stays on the agent's host: nothing is opened, and the use is
 * recorded held_by_agent. Each use is in iam.credential_unwraps either way.
 */
export const AGENT_CREDENTIAL_INFO = 'silo.agent_credential.v1';
export const AGENT_CREDENTIAL_SECONDS = 120;

export const sealAgentCredentials = defineContract({
  service: 'credential', name: 'sealAgentCredentials', method: 'POST', path: '/v1/agent-credentials',
  callers: ['connect-runtime'],
  // Each call opens and seals afresh for one piece of work; nothing to repeat.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    reason: z.enum(['connect', 'query', 'mutation', 'read_back', 'probe', 'change_stream']),
    agentId: z.uuid(),
    workId: z.uuid(),
  }),
  response: z.discriminatedUnion('custody', [
    z.object({ custody: z.literal('agent') }),
    z.object({
      custody: z.literal('cell'),
      /** HPKE enc || ciphertext || tag, base64. */
      sealed: z.base64(),
      expiresAt: z.iso.datetime({ offset: true }),
    }),
  ]),
  maxBodyBytes: 1_024,
});

/**
 * SFTP (spec 14.4): the credential service, which holds the login, runs the session and
 * returns a directory's file names or one file's bytes; the cell parses them. The server is
 * the manifest's sftp host, pinned by the connection's host_key_sha256: a server presenting
 * any other key is refused before the login is sent. Bounded: a file over maxBytes is refused,
 * never truncated.
 */
export const SFTP_MAX_LIST_ENTRIES = 10_000;
export const sendSftpRequest = defineContract({
  service: 'credential', name: 'sendSftpRequest', method: 'POST', path: '/v1/sftp-requests',
  callers: ['connect-runtime'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    reason: z.enum(['connect', 'query', 'probe', 'change_stream']),
    operation: z.discriminatedUnion('kind', [
      /** Under the connection's base path; relative segments, never "..". */
      z.strictObject({ kind: z.literal('list'), directory: z.string().min(1).max(500).regex(/^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._ -]+(\/[A-Za-z0-9._ -]+)*$/) }),
      z.strictObject({
        kind: z.literal('read'),
        directory: z.string().min(1).max(500).regex(/^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._ -]+(\/[A-Za-z0-9._ -]+)*$/),
        name: z.string().min(1).max(255).regex(/^[^/\\\u0000]+$/).refine((n) => n !== '.' && n !== '..'),
        maxBytes: z.int().min(1).max(100 * 1024 * 1024),
      }),
    ]),
  }),
  response: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('list'), entries: z.array(z.object({ name: z.string(), size: z.int().min(0), modifiedAt: z.string() })).max(SFTP_MAX_LIST_ENTRIES) }),
    z.object({ kind: z.literal('read'), size: z.int().min(0), contentBase64: z.string() }),
  ]),
  maxBodyBytes: 4 * 1024,
});
