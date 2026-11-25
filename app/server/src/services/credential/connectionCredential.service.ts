// Connection credentials in the mediator (spec 15.2, 61.3).
//
// store: every auth field a connection is given is sealed with its own DEK and nonce, bound
//   to its row (id, organisation, connection, field, purpose); the live row for the field is
//   revoked and crypto-shredded in the same transaction. The manifest decides what is
//   secret: only a secret gets a last four, computed here. Connection parameters are not
//   credentials: they are public data on the connection row, set by connect-registry.
// open: each opened row is recorded in iam.credential_unwraps with its reason, in the same
//   transaction that sets last_used_at, whether the open succeeded or not. Plaintext lives
//   only inside the callback and is zeroed when it settles.
// send: the secret is placed by the manifest's strategy and the request sent to the host
//   the manifest names (its parameters from the connection row), by this service; the
//   response returns, the secret never does. A caller supplies a path, never a host, so it
//   cannot send a secret elsewhere. For the conformance error class, a probe may ask for
//   deliberately wrong values in place of every field: nothing is opened.
// sealForAgent (spec 10.7): a connection through the Silo Agent keeps its login in the cell by
//   default (custody cell). For one piece of work on one agent of the connection's pool, the
//   login is opened here and sealed to that agent's own X25519 key with HPKE, bound to the
//   organisation, agent, connection and work, valid for two minutes: connect-runtime relays it
//   and never sees it, and the agent zeroes it after the call. The password never becomes a
//   JavaScript string: the sealed document is assembled from the opened bytes. Custody agent:
//   the login stays on the agent's host, nothing is opened, and each use is recorded
//   held_by_agent against the row standing for each secret field.

import { noteUnwrap } from './unwrapRate.service.ts';
import { withHeader } from './wsSecurity.service.ts';
import type { EgressResponse, PreparedRequest } from '../../contracts/credential/connectionCredential.contract.ts';
import { manifestSchema, OAUTH_STRATEGIES, type Manifest } from '../../contracts/connect/manifest.contract.ts';
import { parametersOf } from '../../contracts/connect/parameters.contract.ts';
import type { ServiceName } from '../../config/service.config.ts';
import type { Egress } from '../../infra/egress.infra.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import type { ConnectionCredential } from '../../models/connect/connectionCredential.model.ts';
import { agentRepo, connectionCredentialRepo, connectionRepo, connectorManifestRepo, privateLinkRepo } from '../../repos/connect/index.repo.ts';
import { AGENT_CREDENTIAL_INFO, AGENT_CREDENTIAL_SECONDS } from '../../contracts/credential/connectionCredential.contract.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { hpkeSeal, x25519PublicKey } from '../../utils/hpke.util.ts';
import { credentialUnwrapRepo } from '../../repos/iam/index.repo.ts';
import { randomBytes, zeroise } from '../../utils/crypto.util.ts';
import { lastFour, seal, sealBindings, withOpened, type DekCache, type KeyRing, type SealedSecret } from '../../utils/envelope.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import { place, type OpenedValues } from './placement.service.ts';

export type ConnectionUnwrapReason = 'connect' | 'query' | 'mutation' | 'read_back' | 'refresh' | 'probe' | 'rotation' | 'change_stream' | 'action_event'
  | 'webhook';

export interface ConnectionCredentialDeps {
  keys: KeyRing;
  cache: DekCache;
  databases: Databases;
  egress: Egress;
}

/** Who asked: for the ledger and row-level security. */
export interface Caller {
  request: RequestContext;
  caller: ServiceName;
  correlationId: string;
}

export interface Loaded {
  connection: Connection;
  manifest: Manifest;
  rows: ConnectionCredential[];
  /** The ranges of the organisation's live private links, read with the connection, so a removed link stops at once. */
  privateLinks: string[];
}

// Reasons that serve a person's question or write need a live connection; building,
// probing and connecting happen before it is active.
const NEEDS_ACTIVE: ReadonlySet<ConnectionUnwrapReason> = new Set(['query', 'mutation', 'read_back', 'change_stream']);

const binding = (row: Pick<ConnectionCredential, 'id' | 'organisationId' | 'connectionId' | 'fieldName' | 'purpose'>) =>
  sealBindings.connectionCredential(row);

const sealedOf = (row: ConnectionCredential): SealedSecret => {
  if (row.ciphertext === null || row.nonce === null || row.dekWrapped === null || row.keyVersionId === null) {
    throw new AppError('integrity', 'a live cell-custody credential has no sealed value', { code: 'credential.unsealed' });
  }
  return { ciphertext: row.ciphertext, nonce: row.nonce, dekWrapped: row.dekWrapped, keyVersionId: row.keyVersionId };
};

/** The kinds the manifest gives each auth field. Tokens the OAuth engine stores are secret. */
export function declaredKinds(manifest: Manifest): Map<string, 'secret' | 'public'> {
  return new Map(manifest.auth.fields.map((f) => [f.name, f.kind]));
}

/** A wrong value for every field the strategy may place, for the conformance error class. */
function invalidValues(manifest: Manifest): Map<string, Buffer> {
  const wrong = () => Buffer.from(`silo-conformance-${randomBytes(12).toString('hex')}`, 'utf8');
  const values = new Map(manifest.auth.fields.map((f) => [f.name, wrong()]));
  values.set('access_token', wrong());
  return values;
}

export function createConnectionCredentials(deps: ConnectionCredentialDeps) {
  const control = deps.databases.pool('control');

  async function load(caller: Caller, connectionId: string): Promise<Loaded> {
    return inTransaction(control, caller.request, async (db) => {
      const connection = await connectionRepo.findById(db, connectionId);
      if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
      const row = await connectorManifestRepo.findById(db, connection.manifestId);
      if (!row) throw new AppError('integrity', 'the connection names a missing manifest', { code: 'connection.manifest_missing' });
      return {
        connection, manifest: manifestSchema.parse(row.document), rows: await connectionCredentialRepo.liveForConnection(db, connectionId),
        privateLinks: await privateLinkRepo.liveNetworks(db),
      };
    }, { readOnly: true });
  }

  /**
   * Opens the given rows, hands their values to use, and zeroes them when it settles. One
   * ledger row per opened credential, with last_used_at, in one transaction, after use,
   * whatever the outcome.
   */
  async function open<T>(caller: Caller, rows: readonly ConnectionCredential[], reason: ConnectionUnwrapReason,
    use: (values: OpenedValues) => Promise<T>): Promise<T> {
    const values = new Map<string, Buffer>();
    const outcomes: { row: ConnectionCredential; dekCacheHit: boolean; outcome: 'ok' | 'failed' }[] = [];
    const step = async (i: number): Promise<T> => {
      if (i === rows.length) return use(values);
      const row = rows[i]!;
      const record = { row, dekCacheHit: false, outcome: 'failed' as 'ok' | 'failed' };
      outcomes.push(record);
      const opened = await withOpened(deps.keys, sealedOf(row), binding(row), async (plaintext) => {
        record.outcome = 'ok';
        values.set(row.fieldName, plaintext);
        try {
          return await step(i + 1);
        } finally {
          values.delete(row.fieldName);
        }
      }, deps.cache);
      record.dekCacheHit = opened.dekCacheHit;
      return opened.value;
    };
    try {
      return await step(0);
    } finally {
      if (outcomes.length > 0) {
        await inTransaction(control, caller.request, async (db) => {
          for (const { row, dekCacheHit, outcome } of outcomes) {
            noteUnwrap();
            await credentialUnwrapRepo.insert(db, {
              organisationId: row.organisationId, connectionCredentialId: row.id, reason, callingService: caller.caller,
              correlationId: caller.correlationId, membershipId: caller.request.membershipId ?? null,
              servicePrincipalId: caller.request.membershipId === undefined ? caller.request.servicePrincipalId ?? null : null,
              keyVersionId: row.keyVersionId!, dekCacheHit, outcome,
            });
          }
          await connectionCredentialRepo.markUsed(db, outcomes.filter((o) => o.outcome === 'ok').map((o) => o.row.id));
        });
      }
    }
  }

  function usable(loaded: Loaded, reason: ConnectionUnwrapReason): void {
    const { status } = loaded.connection;
    if (status === 'revoked') throw new AppError('forbidden', 'the connection is revoked', { code: 'connection.revoked' });
    if (status === 'halted') throw new AppError('forbidden', 'the connection is halted and serves nothing', { code: 'connection.halted' });
    if (NEEDS_ACTIVE.has(reason) && status !== 'active') {
      throw new AppError('conflict', `a ${status} connection does not serve ${reason} yet`, { code: 'connection.not_active', details: { status } });
    }
  }

  return {
    load,
    open,
    usable,

    async store(caller: Caller, connectionId: string, values: Record<string, string>) {
      const loaded = await load(caller, connectionId);
      if (loaded.connection.status === 'revoked') throw new AppError('conflict', 'a revoked connection takes no new secrets', { code: 'connection.revoked' });
      const kinds = declaredKinds(loaded.manifest);
      for (const name of Object.keys(values)) {
        if (loaded.manifest.params.some((p) => p.name === name)) {
          throw new AppError('validation', 'that is a connection parameter, which is public: set it on the connection', {
            code: 'credential.is_parameter', details: { field: name },
          });
        }
        if (!kinds.has(name)) {
          throw new AppError('validation', 'the manifest declares no auth field of that name', { code: 'credential.field_unknown', details: { field: name } });
        }
        if (loaded.manifest.transport.viaAgent && loaded.connection.credentialCustody === 'agent' && kinds.get(name) === 'secret') {
          throw new AppError('validation', 'the Silo Agent holds this connection\'s secrets; the cell keeps none (spec 10.7)', {
            code: 'credential.agent_custody', details: { field: name },
          });
        }
      }
      const organisationId = caller.request.organisationId!;
      const prepared: { row: ConnectionCredential['id']; name: string; kind: 'secret' | 'public'; sealed: SealedSecret; four: string | null }[] = [];
      for (const [name, text] of Object.entries(values)) {
        const id = uuidv7();
        const plaintext = Buffer.from(text, 'utf8');
        try {
          const kind = kinds.get(name)!;
          const sealed = await seal(deps.keys, plaintext, binding({ id, organisationId, connectionId, fieldName: name, purpose: 'connection_auth' }));
          prepared.push({ row: id, name, kind, sealed, four: kind === 'secret' ? lastFour(text) : null });
        } finally {
          zeroise(plaintext);
        }
      }
      await inTransaction(control, caller.request, async (db) => {
        for (const p of prepared) {
          const replaced = await connectionCredentialRepo.revokeLive(db, connectionId, p.name);
          await connectionCredentialRepo.insert(db, {
            id: p.row, organisationId, connectionId, purpose: 'connection_auth', fieldName: p.name, custody: 'cell',
            ciphertext: p.sealed.ciphertext, nonce: p.sealed.nonce, dekWrapped: p.sealed.dekWrapped, keyVersionId: p.sealed.keyVersionId,
            lastFour: p.four, authStrategy: loaded.manifest.auth.strategy,
          });
          await recordConnectEvent(db, { service: 'credential',
            organisationId, correlationId: caller.correlationId, event: 'credential_sealed', membershipId: caller.request.membershipId,
            resourceType: 'credential', resourceId: p.row, detail: { connection_id: connectionId, field: p.name, kind: p.kind },
          });
          // A secret replacing a live one is a rotation of it (spec 61.9).
          if (replaced > 0) {
            await recordConnectEvent(db, { service: 'credential',
              organisationId, correlationId: caller.correlationId, event: 'credential_rotated', membershipId: caller.request.membershipId,
              resourceType: 'credential', resourceId: p.row, detail: { connection_id: connectionId, field: p.name, kind: p.kind },
            });
          }
        }
      });
      return { fields: prepared.map((p) => ({ name: p.name, kind: p.kind, lastFour: p.four })) };
    },

    async revoke(caller: Caller, connectionId: string): Promise<number> {
      return inTransaction(control, caller.request, async (db) => {
        const revoked = await connectionCredentialRepo.revokeLive(db, connectionId);
        if (revoked > 0) {
          await recordConnectEvent(db, { service: 'credential',
            organisationId: caller.request.organisationId!, correlationId: caller.correlationId, event: 'credential_revoked',
            membershipId: caller.request.membershipId, resourceType: 'connection', resourceId: connectionId, detail: { credentials: revoked },
          });
        }
        return revoked;
      });
    },

    /**
     * A connection's login for one piece of work on one Silo Agent (spec 10.7): sealed to that
     * agent for custody cell, recorded held_by_agent for custody agent.
     */
    async sealForAgent(caller: Caller, input: { connectionId: string; reason: 'connect' | 'query' | 'mutation' | 'read_back' | 'probe' | 'change_stream'; agentId: string; workId: string })
      : Promise<{ custody: 'agent' } | { custody: 'cell'; sealed: string; expiresAt: string }> {
      const loaded = await load(caller, input.connectionId);
      usable(loaded, input.reason);
      const { connection, manifest } = loaded;
      if (!manifest.transport.viaAgent || connection.agentPoolId === null) {
        throw new AppError('validation', 'this connection is not reached through the Silo Agent', { code: 'connection.not_agent_reached' });
      }
      const organisationId = connection.organisationId;
      if (connection.credentialCustody === 'agent') {
        // The agent holds the login: nothing opens here, and each use is still in the ledger.
        await inTransaction(control, caller.request, async (db) => {
          for (const field of manifest.auth.fields.filter((f) => f.kind === 'secret')) {
            await connectionCredentialRepo.ensureAgentHeld(db, {
              id: uuidv7(), organisationId, connectionId: connection.id, fieldName: field.name, authStrategy: manifest.auth.strategy,
            });
          }
          const held = (await connectionCredentialRepo.liveForConnection(db, connection.id)).filter((r) => r.custody === 'agent');
          for (const row of held) {
            noteUnwrap();
            await credentialUnwrapRepo.insert(db, {
              organisationId, connectionCredentialId: row.id, reason: input.reason, callingService: caller.caller, correlationId: caller.correlationId,
              membershipId: caller.request.membershipId ?? null,
              servicePrincipalId: caller.request.membershipId === undefined ? caller.request.servicePrincipalId ?? null : null,
              keyVersionId: null, dekCacheHit: false, outcome: 'held_by_agent',
            });
          }
          await connectionCredentialRepo.markUsed(db, held.map((r) => r.id));
        });
        return { custody: 'agent' };
      }
      // A user and a password; or, for SFTP (14.4), a user and a private key with its optional passphrase.
      const sshKey = manifest.auth.strategy === 'ssh_key';
      if (manifest.auth.strategy !== 'username_password' && manifest.auth.strategy !== 'basic' && !sshKey) {
        throw new AppError('validation', 'a login the cell passes to the Silo Agent is a user name with a password or a private key', {
          code: 'credential.agent_strategy', details: { strategy: manifest.auth.strategy },
        });
      }
      const agent = await inTransaction(control, caller.request, (db) => agentRepo.findById(db, input.agentId), { readOnly: true });
      if (agent === undefined || agent.poolId !== connection.agentPoolId || agent.status === 'revoked') {
        throw new AppError('forbidden', 'that agent does not serve this connection', { code: 'credential.agent_not_in_pool' });
      }
      if (agent.sealingKey === null) {
        throw new AppError('conflict', 'the agent has no key to take a login sealed to it; it gets one at its next renewal or update', {
          code: 'agent.no_sealing_key',
        });
      }
      const role = (r: string) => manifest.auth.fields.find((f) => f.role === r)?.name;
      const userField = role('username');
      const passwordField = sshKey ? undefined : role('password');
      const keyField = sshKey ? role('private_key') : undefined;
      const phraseField = sshKey ? role('passphrase') : undefined;
      const secretField = sshKey ? keyField : passwordField;
      if (secretField === undefined) {
        throw new AppError('integrity', `the manifest names no ${sshKey ? 'private key' : 'password'} field for its login`, { code: 'manifest.password_field_missing' });
      }
      const wanted = new Set([userField, secretField, phraseField].filter((f): f is string => f !== undefined));
      const rows = loaded.rows.filter((r) => r.custody === 'cell' && wanted.has(r.fieldName));
      if (!rows.some((r) => r.fieldName === secretField)) {
        throw new AppError('unauthenticated', `the connection has no ${sshKey ? 'private key' : 'password'} yet`, { code: 'credential.missing', details: { field: secretField } });
      }
      const expiresAt = new Date(Date.now() + AGENT_CREDENTIAL_SECONDS * 1000).toISOString();
      const info = Buffer.concat([Buffer.from(`${AGENT_CREDENTIAL_INFO}\u0000`, 'utf8'),
        canonicalJsonBytes({ agentId: agent.id, connectionId: connection.id, organisationId, workId: input.workId })]);
      const recipient = x25519PublicKey(agent.sealingKey);
      return open(caller, rows, input.reason, async (values) => {
        const parts: Buffer[] = [];
        try {
          parts.push(Buffer.from(`{"expiresAt":${JSON.stringify(expiresAt)},"params":${JSON.stringify(parametersOf(connection.parameters))},"username":`, 'utf8'));
          const user = userField === undefined ? undefined : values.get(userField);
          parts.push(user === undefined ? Buffer.from('null') : jsonString(user));
          if (sshKey) {
            const phrase = phraseField === undefined ? undefined : values.get(phraseField);
            parts.push(Buffer.from(',"password":null,"privateKey":'), jsonString(values.get(keyField!)!), Buffer.from(',"passphrase":'),
              phrase === undefined ? Buffer.from('null') : jsonString(phrase), Buffer.from('}'));
          } else {
            parts.push(Buffer.from(',"password":'), jsonString(values.get(passwordField!)!), Buffer.from('}'));
          }
          const plaintext = Buffer.concat(parts);
          try {
            return { custody: 'cell' as const, sealed: hpkeSeal(recipient, info, plaintext).toString('base64'), expiresAt };
          } finally {
            zeroise(plaintext);
          }
        } finally {
          zeroise(...parts);
        }
      });
    },

    async send(caller: Caller, connectionId: string, reason: ConnectionUnwrapReason, request: PreparedRequest,
      options: { invalidCredentials?: boolean } = {}): Promise<EgressResponse> {
      const loaded = await load(caller, connectionId);
      usable(loaded, reason);
      const { manifest } = loaded;
      if (manifest.transport.viaAgent || manifest.transport.baseUrl === undefined) {
        throw new AppError('validation', 'this connection is not reached from the cell', { code: 'connection.not_cell_reachable' });
      }
      const params = parametersOf(loaded.connection.parameters);
      const deliver = async (values: OpenedValues): Promise<EgressResponse> => {
        const url = resolveUrl(manifest.transport.baseUrl!, params, request);
        const placed = await place(manifest.auth, values, request, new Date());
        for (const [k, v] of Object.entries(placed.query)) url.searchParams.set(k, v);
        const envelope = request.xml === undefined ? undefined
          : placed.soapHeader === undefined ? request.xml.text : withHeader(request.xml.text, placed.soapHeader);
        const body = envelope ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
        const contentType = request.xml !== undefined ? request.xml.contentType : body === undefined ? undefined : 'application/json';
        const result = await deps.egress.send({
          url, method: request.method, body, timeoutMs: manifest.transport.timeoutMs, minTlsVersion: manifest.transport.tls?.minVersion,
          privateLinks: loaded.privateLinks,
          headers: {
            accept: request.xml !== undefined ? 'text/xml, application/soap+xml' : 'application/json', ...callerHeaders(request.headers),
            ...(contentType === undefined ? {} : { 'content-type': contentType }),
            ...placed.headers,
          },
        });
        return { status: result.status, headers: result.headers, body: result.body.toString('utf8') };
      };
      if (options.invalidCredentials === true) {
        if (reason !== 'probe') throw new AppError('validation', 'wrong credentials are sent only to probe', { code: 'credential.invalid_needs_probe' });
        const values = invalidValues(manifest);
        try {
          return await deliver(values);
        } finally {
          for (const v of values.values()) zeroise(v);
        }
      }
      if ((OAUTH_STRATEGIES as readonly string[]).includes(manifest.auth.strategy)) {
        const token = loaded.rows.find((r) => r.fieldName === 'access_token');
        const lead = (manifest.auth.refresh?.leadSeconds ?? 0) * 1000;
        if (token === undefined && manifest.auth.strategy === 'oauth2_client_credentials') {
          // A client credentials connection obtains its first token the way it refreshes.
          throw new AppError('unauthenticated', 'the connection has no access token yet; obtain one', { code: 'credential.token_expired' });
        }
        if (token === undefined) {
          throw new AppError('unauthenticated', 'the connection has no access token; connect it', { code: 'credential.missing', details: { field: 'access_token' } });
        }
        if (token.expiresAt !== null && Date.parse(token.expiresAt) - lead <= Date.now()) {
          // The runtime asks the OAuth engine to refresh under its lock, then retries.
          throw new AppError('unauthenticated', 'the access token has expired; refresh it', { code: 'credential.token_expired' });
        }
      }
      const kinds = declaredKinds(manifest);
      const needed = loaded.rows.filter((r) => r.custody === 'cell' && (kinds.has(r.fieldName) || r.fieldName === 'access_token'));
      return open(caller, needed, reason, deliver);
    },
  };
}


/** A JSON string literal of bytes taken as UTF-8, escaped byte by byte: a secret never becomes a JavaScript string. */
function jsonString(bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length * 6 + 2);
  let at = 0;
  out[at++] = 0x22;
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c) {
      out[at++] = 0x5c;
      out[at++] = byte;
    } else if (byte < 0x20) {
      at += out.write(`\\u00${byte.toString(16).padStart(2, '0')}`, at, 'ascii');
    } else {
      out[at++] = byte;
    }
  }
  out[at++] = 0x22;
  const literal = Buffer.from(out.subarray(0, at));
  zeroise(out);
  return literal;
}

export type ConnectionCredentials = ReturnType<typeof createConnectionCredentials>;

// Headers a caller may not set: routing and framing (a Host header could pick another
// virtual host on the same address), and credentials, which only the strategy places.
const RESERVED_HEADERS = /^(host|connection|content-length|transfer-encoding|te|trailer|upgrade|keep-alive|expect|authorization|proxy-.*|cookie|forwarded|x-forwarded-.*)$/i;

function callerHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !RESERVED_HEADERS.test(name)));
}

// A host part from a parameter is one DNS label; anything else is refused, so a value can
// never change which host a request goes to beyond the label the manifest allows.
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** The manifest's base URL with its parameters, plus the caller's path and query. */
export function resolveUrl(baseUrl: string, params: Record<string, string | undefined>, request: Pick<PreparedRequest, 'path' | 'query'>): URL {
  const parts = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?$/.exec(baseUrl);
  if (!parts) throw new AppError('integrity', 'the manifest base URL is not an origin and path', { code: 'manifest.base_url_invalid' });
  const [, origin, path] = parts;
  const fill = (text: string, host: boolean) => text.replace(/\{params\.([a-z][a-z0-9_]*)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined) throw new AppError('validation', 'the connection is missing a parameter its base URL needs', { code: 'connection.parameter_missing', details: { parameter: name } });
    if (host && !LABEL.test(v)) throw new AppError('validation', 'a host parameter must be one DNS label', { code: 'connection.parameter_invalid', details: { parameter: name } });
    return host ? v : encodeURIComponent(v);
  });
  const base = new URL(fill(origin!, true));
  const basePath = fill(path ?? '', false).replace(/\/$/, '');
  // Encoded dots and backslashes are refused too: URL parsing would turn them into dot
  // segments or separators and walk out of the manifest's base path.
  if (!request.path.startsWith('/') || request.path.startsWith('//') || /(^|\/)\.\.?(\/|$)/.test(request.path) || /%2e|\\/i.test(request.path)) {
    throw new AppError('validation', 'a request path is relative to the connection and has no dot segments', { code: 'request.path_invalid' });
  }
  const url = new URL(`${base.origin}${basePath}${request.path}`);
  if (url.origin !== base.origin) throw new AppError('validation', 'a request cannot leave the connection\'s host', { code: 'request.host_changed' });
  for (const [k, v] of Object.entries(request.query)) url.searchParams.set(k, v);
  return url;
}
