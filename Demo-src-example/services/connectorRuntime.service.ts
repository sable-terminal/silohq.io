import { wrapper } from '../infra/kms.infra';
import { sendHttp } from '../infra/network.infra';
import { withTransaction } from '../infra/db.infra';
import { withSecret } from '../utils/mediator.util';
import { notFound, refusal } from '../utils/error.util';
import { credentialAccessLog } from '../utils/credentialAudit.util';
import { childLogger } from '../config/logger.config';
import { CONNECTOR_TIMEOUT_MS } from '../config/constants.config';
import { credentialFieldsOf, type AuthStrategyV2 } from '../schemas/connectorAuth.schema';
import type { ManifestV2 } from '../schemas/manifest.schema';
import { defaultDeps, type Obtained } from '../engine/auth/apply.auth';
import { accessTokenCredential, chooseAlternative, credentialFrom, type Credential } from '../engine/auth/credential.auth';
import { V1_STRATEGY } from '../engine/compat/compile.compat';
import { BlobStore } from '../engine/read/blob.read';
import { ReadBudget } from '../engine/read/budget.read';
import { credentialOrigins, directDispatch, type ReadContext } from '../engine/read/context.read';
import type { LocalWire } from '../engine/transports/local.transport';
import { dispatchThrough, httpThrough, routeFor } from './agentRoute.service';
import { derivedTokens } from './derivedTokens.service';
import { createHash } from 'node:crypto';
import { statementHash } from '../engine/read/pins.read';
import { paramsFor } from '../engine/read/params.read';

export { paramsFor };
import type { LoadedConnection, StoredCredential } from '../repos/connector.repo';
import { accessTokenFor } from './connectorOAuth.service';
import * as rowStore from './rowStore.service';
import * as inboundRepo from '../repos/inbound.repo';
import type { Actor } from './scope.service';

const log = childLogger('connector-runtime');

/**
 * A stored connection, made ready to read or write through the v2 engine.
 *
 * ── THE CREDENTIAL IS OPENED ONCE, INSIDE THE CALLBACK ────────────────────
 *
 * `withConnection` hands `use` a context whose credential lives only for the
 * length of that call: opened through the mediator (audited, bound to the
 * row), or, for OAuth, through `accessTokenFor`, which refreshes before
 * expiry under a lock. Nothing here holds a plaintext beyond the callback.
 *
 * ── A TOKEN SILO OBTAINS ITSELF IS OBTAINED ONCE ──────────────────────────
 *
 * Client-credentials grants, JWT exchanges and login sessions are cached per
 * connection, manifest version and credential until they expire (an hour at
 * most), sealed and shared across instances (`derivedTokens.service`), and
 * refreshed once on a 401.
 */

/** A credential with the manifest's fixed halves filled in — Freshdesk's password is the letter X. */
function withFixed(manifest: ManifestV2, credential: Credential): Credential {
  const fields = { ...credential.fields };
  for (const [name, field] of Object.entries(manifest.credentials)) {
    if (field.fixed !== undefined && fields[name] === undefined) fields[name] = field.fixed;
  }
  return { ...credential, fields };
}

/* ── Local stores ───────────────────────────────────────────────────────── */

const readInbound = (connectionId: string, objectName: string, limit: number): Promise<unknown[]> =>
  withTransaction((db) => inboundRepo.readPayloads(db, { connectionId, objectName, limit }));

function localReader(actor: Actor, connection: LoadedConnection, objectName: string): ReadContext['local'] {
  const kind = connection.manifest.transport.kind;
  if (kind === 'inbound_webhook' || kind === 'email_fallback' || kind === 'queue_tap') {
    return (wire) => readInbound(connection.connectionId, objectName, (wire as LocalWire).limit);
  }
  if (kind === 'silo_import') {
    const reader = rowStore.readerFor({ organisationId: actor.organisationId, membershipId: actor.membershipId, connection });
    const object = connection.manifest.objects.find((o) => o.name === objectName)!;
    return async (wire) => {
      const w = wire as LocalWire;
      const filters = w.where.map((one) => ({ field: one.column, op: one.operator as never, value: one.value }));
      return reader.read({
        object: object as never,
        query: { object: objectName, filters, sort: w.order, fields: w.fields, limit: w.limit },
        pushed: { filters, sort: w.order.length > 0, limit: true, fields: w.fields.length > 0 },
      });
    };
  }
  return undefined;
}

/* ── The context ────────────────────────────────────────────────────────── */

const OAUTH_HELD = new Set(['oauth2_authorization_code', 'oauth2_pkce']);

function accessLogFor(actor: Actor) {
  const audit = credentialAccessLog(actor);
  return {
    async record(entry: Parameters<typeof audit.record>[0]) {
      log.info({ reason: entry.reason, connectionId: entry.subject, outcome: entry.outcome }, 'Connector credential unwrapped');
      await audit.record(entry);
    },
  };
}

export interface ConnectionUse<T> {
  actor: Actor;
  /** Why the credential is opened, for the audit trail. A question, unless said otherwise. */
  reason?: 'connector-request' | 'connection-verify';
  connection: LoadedConnection;
  credential: StoredCredential | undefined;
  /**
   * A queue tap's credential is for the agent's subscription, not for reading
   * what it already delivered — so it is opened only when a tap is being
   * configured, never for a question.
   */
  forTap?: boolean;
  /** `open(object)` is a context for one object; call it as often as the work needs, inside `use`. */
  use: (open: (object: string) => Promise<ReadContext>) => Promise<T>;
}

/**
 * Open a connection for one read or write and hand the context to `use`.
 *
 * THE SOURCES THAT PUSH AT SILO HAVE NO CREDENTIAL, AND THAT IS CORRECT. A
 * webhook's sender authenticates by the unguessable address it posts to; a Silo
 * import is Silo's own copy. Every other connection without one is refused by
 * name rather than tried anonymously.
 */
export async function withConnection<T>(input: ConnectionUse<T>): Promise<T> {
  const { connection } = input;
  const manifest = connection.manifest;
  const kind = manifest.transport.kind;
  const isLocal = kind === 'inbound_webhook' || kind === 'email_fallback' || kind === 'queue_tap' || kind === 'silo_import';

  /* A tap's messages are already in Silo's store; reading them needs no agent. */
  const viaAgent = !isLocal && 'via' in manifest.transport && manifest.transport.via?.agent === true;
  const agent = viaAgent ? await routeFor(input.actor.organisationId, connection.connectionId) : null;
  if (viaAgent && !agent) {
    throw refusal({
      message: `${connection.name} is reached through the Silo agent, and no agent is assigned to it. An admin assigns one and confirms the hosts it may reach.`,
      code: 'refusal.agent_not_assigned',
    });
  }

  const credentialKey = input.credential ? createHash('sha256').update(input.credential.sealed.ciphertext).digest('hex').slice(0, 16) : 'none';

  const run = (credential: Credential | null, oauthToken: string | null) => input.use(async (objectName) => {
    const object = manifest.objects.find((o) => o.name === objectName);
    if (!object) {
      throw notFound({ message: `This connector does not describe an object called ${objectName}.`, code: 'missing.object' });
    }
    const local = localReader(input.actor, connection, objectName);
    const params = paramsFor(manifest, connection.parameters, credential);
    /* A local source has no credential to present — except a tap being configured for its agent. */
    const strategy = local && !credential ? null : chooseAlternative(manifest.auth, credential, credentialFieldsOf as (s: AuthStrategyV2) => string[]);
    if (credential && !strategy) {
      throw refusal({
        message: `${connection.name} was connected with ${credential.strategy}, which this version of its connector no longer offers. Reconnect it.`,
        code: 'refusal.strategy_not_declared',
      });
    }
    /*
     * WHERE THE CREDENTIAL MAY GO IS WHAT THE ADMIN CONFIRMED (§9.2). A
     * connection made before pinning runs on what its document computes until
     * somebody confirms; after that, only on what they confirmed.
     */
    const pinned = connection.pins ? new Set(connection.pins.origins) : await credentialOrigins(manifest, params);
    const statements = connection.pins ? new Set(connection.pins.statements) : null;
    const ctx: ReadContext = {
      manifest,
      object,
      params,
      credential,
      strategy,
      route: { via: 'silo' },
      connectionId: connection.connectionId,
      /* A replaced credential misses every token derived from the old one. */
      cacheKey: `${connection.connectionId}:${connection.manifestId}:${credentialKey}`,
      budget: new ReadBudget(),
      blobs: new BlobStore(),
      dispatch: directDispatch,
      ...(local ? { local } : {}),
      ...(statements ? { statementConfirmed: (text: string) => statements.has(statementHash(text)) } : {}),
      auth: {
        ...defaultDeps(),
        oauthAccessToken: async () => {
          if (oauthToken === null) {
            throw refusal({ message: `${connection.name} has no OAuth token. Reconnect it.`, code: 'refusal.no_credential' });
          }
          return oauthToken;
        },
        cached: (key, obtain, options) => derivedTokens().cached(key, obtain, options),
        invalidate: (prefix) => derivedTokens().invalidate(prefix),
        sendHttp: (wire, socket) => sendHttp(wire, { tls: socket.tls, timeoutMs: CONNECTOR_TIMEOUT_MS, maxBytes: 1_000_000, retry: false }),
        mayReceiveCredential: (url) => pinned.has(url.origin),
      },
    };
    if (agent) {
      /*
       * THROUGH THE CUSTOMER'S AGENT. The connector says so; which agent, and
       * which hosts it may reach, the organisation's admin confirmed. Token
       * endpoints go the same way, because on a system inside somebody's
       * network the login server is inside it too.
       */
      ctx.route = { via: 'agent', agentId: agent.agentId, connectionId: connection.connectionId };
      ctx.dispatch = dispatchThrough(input.actor.organisationId, agent);
      ctx.auth.sendHttp = httpThrough(input.actor.organisationId, connection.connectionId, agent);
    }
    return ctx;
  });

  if (isLocal && !(input.forTap && kind === 'queue_tap')) return run(null, null);

  const stored = input.credential;
  if (!stored) {
    if (manifest.auth.some((a) => a.strategy === 'none')) return run(null, null);
    throw refusal({ message: `${connection.name} has no credential. Reconnect it.`, code: 'refusal.no_credential' });
  }

  const strategyName = V1_STRATEGY[stored.authStrategy] ?? stored.authStrategy;

  /*
   * OAUTH GOES THROUGH THE REFRESH, NOT ROUND IT. A token read directly works
   * until it expires, and then every read fails as a 401 on a connection nobody
   * touched. `accessTokenFor` refreshes before expiry, under a lock, once.
   */
  if (OAUTH_HELD.has(strategyName) || (strategyName === 'oauth2_client_credentials' && stored.expiresAt !== null)) {
    return accessTokenFor(connection.connectionId, (token) => run(accessTokenCredential(strategyName, token), token));
  }

  return withSecret(
    stored.sealed,
    { wrapper: wrapper(), log: accessLogFor(input.actor) },
    { reason: input.reason ?? 'connector-request', subject: connection.connectionId, additionalData: `connection:${connection.connectionId}` },
    (plaintext) => run(withFixed(manifest, credentialFrom(plaintext, strategyName)), null),
  );
}
