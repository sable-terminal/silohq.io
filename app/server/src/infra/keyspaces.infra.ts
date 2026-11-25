// Every Redis keyspace of a cell (design: Redis keyspaces; spec 7.7, 7.9, 8.1, 8.3, 8.5,
// 24.6, 30, 60.2). A key that matches none of these is reported by the audit job.
//
// Kinds, and why:
// - hash where fields change on their own, atomically: a session's revoked flag (the
//   deprovisioning script sets it), result meta counters, tunnel heartbeats, capture gap
//   counts, idempotency state, subscription acks.
// - value (MessagePack) where the value is written and read whole: the permission set,
//   result pages, the result cache entry, the match index.
// - set, zset, counter, lock and stream where Redis's own type does the work.
//
// Built here: every operation on value, hash, set, sorted set, counter and lock keys.
// Left to the owning service, which adds its operations to redis.infra.ts: the capture
// queue streams (cq: XADD, consumer groups, per-minute buckets; executor, state-plane,
// siloes-capture), live object state fields (st:...:o: dynamic fields per input and
// source; state-plane), and the deprovisioning script across sess, sessmem and perm (auth).
//
// Hash field names are camelCase, as everywhere else in TypeScript; the design doc's
// tables write them snake_case.

import { z } from 'zod';
import { LIMITS } from '../config/limits.config.ts';
import { AppError } from '../utils/errors.util.ts';
import { recordValue } from '../utils/recordValue.util.ts';
import { defineKeyspace, hashField, type Keyspace, type RedisKey, type RedisStore } from './redis.infra.ts';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const KB = 1024;

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/);
const hex = z.string().regex(/^[0-9a-f]{16,64}$/);

// ----------------------------------------------------------------------------- redis-session
// Never record values, secrets or prompts. Postgres is the record of truth (spec 60.2).

/** The hot copy of a session. TTL: the remaining idle lifetime, never beyond absoluteExpiresAt. */
export const sessionKeys = defineKeyspace({
  pattern: 'sess:{org}:<sessionId>',
  instance: 'session',
  kind: 'hash',
  values: false,
  schema: z.object({
    membershipId: z.uuid().optional(),
    userId: z.uuid().optional(),
    // Service principal sessions (iam.sessions arc, chapter 60.5); not in the design table.
    servicePrincipalId: z.uuid().optional(),
    authStrength: z.string().regex(/^[a-z_]{1,32}$/),
    policyVersionAtIssue: hashField.int(),
    issuedAt: hashField.timestamp(),
    idleExpiresAt: hashField.timestamp(),
    absoluteExpiresAt: hashField.timestamp(),
    /** The idle window this session slides by: the cell's, or the organisation's shorter one. */
    idleMinutes: hashField.int(),
    revoked: hashField.flag(),
    // SHA-256 of the token, as Postgres stores it, so a request can be checked against the
    // hot copy alone. Never the token. (The design table lists no token field; a hash of a
    // 256-bit random token is not one.)
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** When MFA was satisfied (spec 55.4); absent until then. */
    mfaSatisfiedAt: hashField.timestamp().optional(),
    /** How the person signed in (iam.sessions.auth_method); absent for sessions written before SSO, which were password. */
    authMethod: z.enum(['password', 'sso', 'synthetic']).optional(),
  }),
  // The idle timeout is at most 24 hours (security config), so the TTL is too.
  ttlSeconds: { max: DAY },
  maxBytes: 2 * KB,
});

/**
 * A membership's session ids, so deprovisioning finds every copy. Outlives its longest
 * session: adding a session extends it, and auth touches it with the session's new TTL
 * each time a session slides (touch never shortens an extend keyspace).
 */
export const membershipSessionKeys = defineKeyspace({
  pattern: 'sessmem:{org}:<membershipId>',
  instance: 'session',
  kind: 'set',
  values: false,
  schema: z.uuid(),
  ttlSeconds: { max: DAY },
  ttlMode: 'extend',
  maxMembers: 100,
});

/**
 * The resolved permission set of a session under one policy version (spec 7.7: caches are
 * keyed by policy_version, so a change applies on the next request). Names only.
 */
export const permissionKeys = defineKeyspace({
  pattern: 'perm:{org}:<sessionId>:<policyVersion>',
  instance: 'session',
  kind: 'value',
  values: false,
  // The membership's resolved authority (spec 57.6 steps 1 to 3): each live grant's
  // permission names and where it applies, the roles held and scopes sat in, the markings
  // its clearances satisfy and the connections its grants reach. Names and identifiers
  // only. The TTL is capped at the earliest expiry among the grants and clearances that
  // produced it, since expiry bumps no policy version (design doc: iam.policy_versions).
  schema: z.object({
    membershipActive: z.boolean(),
    grants: z.array(z.object({
      permissions: z.array(z.string().max(200)),
      /** The ltree path of the scope it was assigned on; null organisation-wide. */
      scopePath: z.string().max(500).nullable(),
      resourceType: z.enum(['connection', 'silo', 'view', 'object_type', 'app']).nullable(),
      resourceId: z.uuid().nullable(),
    })),
    memberScopePaths: z.array(z.string().max(500)),
    obligations: z.array(z.string().max(200)),
    roleIds: z.array(z.uuid()).optional(),
    /** Classification and compartment markings its live clearances satisfy. */
    clearances: z.array(z.uuid()).optional(),
    /** Connections its live grants reach, with the higher access. Ownership is read live. */
    connections: z.array(z.object({ id: z.uuid(), access: z.enum(['read', 'write']) })).optional(),
  }),
  ttlSeconds: { max: 15 * MINUTE, default: 15 * MINUTE },
  // Above it, not cached and resolved on each request (design doc).
  maxBytes: 64 * KB,
});

/** A purpose session (spec 58.5). TTL until endsAt; never renewed. */
export const purposeSessionKeys = defineKeyspace({
  pattern: 'purp:{org}:<purposeSessionId>',
  instance: 'session',
  kind: 'hash',
  values: false,
  schema: z.object({
    purposeDefinitionId: z.uuid(),
    /** The declarer: a membership or a service principal, exactly one. */
    membershipId: z.uuid().optional(),
    servicePrincipalId: z.uuid().optional(),
    /** The authentication session it is bound to: it never serves another (spec 58.5). */
    sessionId: z.uuid(),
    /** The purpose marking it satisfies. */
    markingId: z.uuid(),
    startedAt: hashField.timestamp(),
    endsAt: hashField.timestamp(),
  }),
  // The definition's max_session_minutes bounds a purpose session; the spec sets no cap, so
  // the hot copy keeps at most a day (decision) and a longer session is read from Postgres.
  ttlSeconds: { max: DAY },
  maxBytes: KB,
});

// ----------------------------------------------------------------------------- redis-data
// Record values only in result pages and the capture queue, for at most 15 and 10 minutes
// (spec 8.5). Never secrets or prompts.

/** A query result's state. Every page read re-arms it and the pages read. */
export const resultMetaKeys = defineKeyspace({
  pattern: 'res:{org}:<queryId>:meta',
  instance: 'data',
  kind: 'hash',
  values: false,
  schema: z.object({
    planHash: hex,
    permissionFingerprint: hex,
    /** The actor whose result it is: a membership, or a service principal. Only that actor reads its pages. */
    membershipId: z.uuid().optional(),
    servicePrincipalId: z.uuid().optional(),
    status: z.enum(['running', 'complete', 'failed']),
    pageCount: hashField.int(),
    rowCount: hashField.int(),
    /** The bound that stopped the query, if one did. */
    boundHit: id.optional(),
    createdAt: hashField.timestamp(),
  }),
  ttlSeconds: { max: LIMITS.redisData.resultPageTtl, default: LIMITS.redisData.resultPageTtl },
  maxBytes: 2 * KB,
});

/** One page of result rows. Values. */
export const resultPageKeys = defineKeyspace({
  pattern: 'res:{org}:<queryId>:p:<page>',
  instance: 'data',
  kind: 'value',
  values: true,
  schema: recordValue(z.array(z.unknown())),
  ttlSeconds: { max: LIMITS.redisData.resultPageTtl, default: LIMITS.redisData.resultPageTtl },
  // Assumption in the design doc; the executor's page size keeps under it.
  maxBytes: 1024 * KB,
});

/**
 * A result's header: columns, coverage, lineage, periods, defaults; everything but the
 * objects, which are in the pages. References, counts and calendar ranges only, no record
 * values. Written by the executor with the pages, and lives as long as they do. Not in the
 * design doc's tables.
 */
export const resultHeadKeys = defineKeyspace({
  pattern: 'res:{org}:<queryId>:head',
  instance: 'data',
  kind: 'value',
  values: false,
  schema: z.record(z.string(), z.unknown()),
  ttlSeconds: { max: LIMITS.redisData.resultPageTtl, default: LIMITS.redisData.resultPageTtl },
  maxBytes: 512 * KB,
});

/**
 * A keyed compile's whole outcome (the plan, its parameters, the answer's first page), so a
 * retry under the same Idempotency-Key gets the same reply without a second model call or
 * charge. Values, so it lives as long as a result page. Written by compile. Not in the
 * design doc's tables.
 */
export const compileOutcomeKeys = defineKeyspace({
  pattern: 'res:{org}:<compileId>:outcome',
  instance: 'data',
  kind: 'value',
  values: true,
  schema: recordValue(z.record(z.string(), z.unknown())),
  ttlSeconds: { max: LIMITS.redisData.resultPageTtl, default: LIMITS.redisData.resultPageTtl },
  maxBytes: 1024 * KB,
});

/**
 * Plans running per organisation, across every executor replica (spec 27, the executor
 * bound "concurrent plans per organisation"). Members are query ids scored by when their
 * lease ends, as modelCallSlotKeys. Not in the design doc's tables.
 */
export const executorSlotKeys = defineKeyspace({
  pattern: 'xslot:{org}',
  instance: 'data',
  kind: 'zset',
  values: false,
  schema: z.uuid(),
  ttlSeconds: { max: HOUR, default: 15 * MINUTE },
  maxMembers: 10_000,
});

/**
 * The result cache: which complete result answers a plan for these permissions. The key
 * holds every version the result depends on (spec 24.6): plan hash, ontology version,
 * period resolution and permission fingerprint. The design doc's key has only the first
 * and last; spec 24.6 is binding. A hit needs the res: keys to exist, else it is a miss.
 * TTL 5 minutes by default, 0 per organisation disables it, never beyond the page TTL.
 */
export const resultCacheKeys = defineKeyspace({
  pattern: 'cache:{org}:<planHash>:<ontologyVersion>:<periodResolution>:<permissionFingerprint>',
  instance: 'data',
  kind: 'value',
  values: false,
  // epochs: the hash of the change epochs of every source object the plan read, taken before
  // the run (changeEpochKeys); a hit whose epochs differ from the current ones is a miss.
  schema: z.object({ queryId: z.uuid(), computedAt: hashField.timestamp(), epochs: z.string().regex(/^[0-9a-f]{64}$/).optional() }),
  ttlSeconds: { max: LIMITS.redisData.resultPageTtl, default: LIMITS.redisData.resultCacheTtl },
  maxBytes: 300,
});

/**
 * Change epochs (spec 24.6: "a change stream event for an object invalidates cached results
 * containing it"): one counter per connection and source object, which change-stream bumps
 * for every batch of changes it accepts. The executor reads the epochs of every source
 * object a plan reads before it runs, keeps them with the cached result, and treats a
 * cached result whose epochs differ from the current ones as a miss. Coarser than per
 * entity (a change to one record invalidates every cached result over that source object)
 * and never stale. The key outlives every cached result (twice the page TTL, extended on
 * each bump), so a counter that expires and restarts at zero can never match a result
 * cached before it expired.
 */
export const changeEpochKeys = defineKeyspace({
  pattern: 'cep:{org}:<connectionId>:<sourceObject>',
  instance: 'data',
  kind: 'counter',
  values: false,
  schema: z.number().int(),
  ttlSeconds: { max: 2 * LIMITS.redisData.resultPageTtl, default: 2 * LIMITS.redisData.resultPageTtl },
  ttlMode: 'extend',
});

export interface SourceObjectRef { connectionId: string; sourceObject: string }

const epochKey = (organisationId: string, ref: SourceObjectRef) =>
  changeEpochKeys.key(organisationId, { connectionId: ref.connectionId, sourceObject: ref.sourceObject });

/** change-stream: one batch of accepted changes per source object. */
export async function bumpChangeEpochs(store: RedisStore, organisationId: string, refs: readonly SourceObjectRef[]): Promise<void> {
  const unique = new Map(refs.map((r) => [`${r.connectionId}:${r.sourceObject}`, r]));
  await Promise.all([...unique.values()].map((ref) => store.increment(changeEpochKeys, epochKey(organisationId, ref))));
}

/** The executor: the epochs to keep with a cached result, and to compare on a hit. Same order as refs. */
export async function readChangeEpochs(store: RedisStore, organisationId: string, refs: readonly SourceObjectRef[]): Promise<number[]> {
  return Promise.all(refs.map((ref) => store.readCounter(changeEpochKeys, epochKey(organisationId, ref))));
}

/**
 * Which connect-runtime replica holds an agent's tunnel, refreshed by each 10-second heartbeat:
 * where the other replicas relay its work (relayUrl), its pool, health and load. A replica
 * that dies stops refreshing, and its agents fall out within the TTL.
 */
export const tunnelKeys = defineKeyspace({
  pattern: 'tun:{org}:<agentId>',
  instance: 'data',
  kind: 'hash',
  values: false,
  schema: z.object({
    connectRuntimePod: id,
    tunnelId: id,
    agentVersion: id,
    connectedAt: hashField.timestamp(),
    lastHeartbeatAt: hashField.timestamp(),
    poolId: z.uuid(),
    relayUrl: z.string().regex(/^https?:\/\/[A-Za-z0-9.:[\]-]{1,253}$/),
    healthy: hashField.flag(),
    /** The calls the agent reported plus those its replica has given it since. */
    activeCalls: hashField.int(),
  }),
  ttlSeconds: { max: 30, default: 30 },
  maxBytes: KB,
});

/** Refresh locks: purpose 'oauth' with a connection id, or another purpose and resource. */
export const lockKeys = defineKeyspace({
  pattern: 'lock:{org}:<purpose>:<resourceId>',
  instance: 'data',
  kind: 'lock',
  values: false,
  schema: z.string(),
  ttlSeconds: { max: 30, default: 30 },
  maxBytes: 64,
});

/**
 * A resolution run over a type's contributing objects (spec 23): its status and counts,
 * read by whoever started it. Counts, codes and ids only. Written by resolution; a run
 * that stops heartbeating for a minute reads as abandoned.
 */
export const resolutionRunKeys = defineKeyspace({
  pattern: 'rrun:{org}:<runId>',
  instance: 'data',
  kind: 'value',
  values: false,
  schema: z.object({
    id: z.uuid(),
    objectTypeId: z.uuid(),
    status: z.enum(['running', 'completed', 'failed', 'abandoned']),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    heartbeatAt: z.string(),
    entries: z.object({ added: z.number().int(), remapped: z.number().int(), merged: z.number().int(), retired: z.number().int() }),
    sources: z.array(z.object({ connectionId: z.uuid(), sourceObject: z.string(), records: z.number().int(), unmatched: z.number().int() })),
    objects: z.number().int(),
    unkeyed: z.number().int(),
    proposals: z.array(z.uuid()),
    modelConsulted: z.boolean(),
    notes: z.array(z.string().max(100)).max(50),
  }),
  ttlSeconds: { max: 7 * DAY, default: DAY },
  maxBytes: 16 * KB,
});

/**
 * The capture queue: one stream per Silo and minute bucket. Values. The TTL is set when
 * the bucket is created and never moved, so no entry outlives 10 minutes (spec 8.5).
 * Operated by executor and change-stream (producers) and siloes-capture (consumer).
 */
export const captureQueueKeys = defineKeyspace({
  pattern: 'cq:{org}:<siloId>:<minute>',
  instance: 'data',
  kind: 'stream',
  values: true,
  schema: z.object({
    objectTypeId: z.uuid(),
    objectRef: id,
    property: id,
    value: recordValue(z.unknown()),
    observedAt: hashField.timestamp(),
    connectionId: z.uuid(),
    origin: z.enum(['query', 'change_stream']),
  }),
  ttlSeconds: { max: LIMITS.redisData.captureQueueTtl, default: LIMITS.redisData.captureQueueTtl },
  ttlMode: 'keep',
  maxMembers: 50_000,
});

/** Observations dropped over the capture queue bound. Counts only. */
export const captureGapKeys = defineKeyspace({
  pattern: 'cqgap:{org}:<siloId>',
  instance: 'data',
  kind: 'hash',
  values: false,
  schema: z.object({
    droppedCount: hashField.int(),
    firstDroppedAt: hashField.timestamp().optional(),
    lastDroppedAt: hashField.timestamp().optional(),
  }),
  ttlSeconds: { max: DAY, default: DAY },
  maxBytes: 200,
});

/** Idempotency keys (spec 7.1: callers retry under idempotency keys). */
export const idempotencyKeys = defineKeyspace({
  pattern: 'idem:{org}:<scope>:<idempotencyKey>',
  instance: 'data',
  kind: 'hash',
  values: false,
  schema: z.object({
    state: z.enum(['in_progress', 'done']),
    /** An identifier of the result, never the result. */
    resultRef: id.optional(),
    /** SHA-256 of the request, so a key reused for a different request is refused. */
    requestHash: hex.optional(),
  }),
  ttlSeconds: { max: LIMITS.redisData.idempotencyKeyTtl, default: LIMITS.redisData.idempotencyKeyTtl },
  maxBytes: 512,
});

/** Bytes in use per organisation for pages, cache or capture (spec 8.1 quota). */
export const quotaKeys = defineKeyspace({
  pattern: 'quota:{org}:<quotaClass>',
  instance: 'data',
  kind: 'counter',
  values: false,
  schema: z.int(),
  ttlSeconds: { max: 2 * DAY, default: 2 * DAY },
});

/**
 * Rate limits looked up before the organisation is known, such as login attempts per
 * client address. Global: the hash tag is the subject, a keyed hash of the address or
 * email, so these keys spread across slots and never hold the address itself. A fixed
 * window: the TTL is set by the first attempt. Not in the design doc's tables.
 */
export const rateLimitKeys = defineKeyspace({
  pattern: 'rl:{<subject>}:<limit>',
  instance: 'data',
  kind: 'counter',
  values: false,
  schema: z.int(),
  ttlSeconds: { max: HOUR },
  ttlMode: 'keep',
});

/**
 * A charged operation, kept for the rephrase window (spec 73.2: a rephrase within a short
 * window of a prior compile charges once). Written by metering when it charges; read when
 * a later charge names it as rephraseOf. References only. Not in the design doc's tables.
 */
export const chargeWindowKeys = defineKeyspace({
  pattern: 'mchg:{org}:<correlationId>',
  instance: 'data',
  kind: 'value',
  values: false,
  schema: z.object({ membershipId: z.uuid(), operation: z.enum(['compile', 'advanced_compile']) }),
  ttlSeconds: { max: HOUR, default: 10 * MINUTE },
  maxBytes: 200,
});

/**
 * A saved view's last result (spec 37.2): the executor's result reference and when and by
 * whom it ran, held as long as result pages are. References only; the result itself is
 * filtered to each opener before render. Not in the design doc's tables.
 */
export const viewLastRunKeys = defineKeyspace({
  pattern: 'wsrun:{org}:<viewId>',
  instance: 'data',
  kind: 'value',
  values: false,
  schema: z.object({ resultRef: z.string().max(200), ranAt: z.string().max(40), ranBy: z.uuid() }),
  ttlSeconds: { max: LIMITS.redisData.resultPageTtl, default: LIMITS.redisData.resultPageTtl },
  maxBytes: 400,
});

/**
 * One notice per membership, kind and day, so a refused charge raises allowance_exhausted
 * or daily_limit_reached once rather than on every retry (spec 73.9). Not in the design
 * doc's tables.
 */
export const meteringNoticeKeys = defineKeyspace({
  pattern: 'mnot:{org}:<membershipId>:<notice>:<day>',
  instance: 'data',
  kind: 'value',
  values: false,
  schema: z.literal(1),
  ttlSeconds: { max: 2 * DAY, default: 2 * DAY },
  maxBytes: 16,
});

/**
 * Model calls in flight per organisation, across every model-gateway replica (spec 7.8:
 * per-organisation concurrency is bounded). Members are call ids, scored by when their
 * lease ends (epoch milliseconds), so a replica that dies mid-call frees its slot when the
 * lease runs out. Not in the design doc's tables.
 */
export const modelCallSlotKeys = defineKeyspace({
  pattern: 'mslot:{org}',
  instance: 'data',
  kind: 'zset',
  values: false,
  schema: z.uuid(),
  ttlSeconds: { max: HOUR, default: 15 * MINUTE },
  maxMembers: 20_000,
});

/** Model calls in flight in the whole cell, as modelCallSlotKeys. Global: the hash tag is the cell id. */
export const modelCellSlotKeys = defineKeyspace({
  pattern: 'mcell:{<cellId>}',
  instance: 'data',
  kind: 'zset',
  values: false,
  schema: z.uuid(),
  ttlSeconds: { max: HOUR, default: 15 * MINUTE },
  maxMembers: 20_000,
});

/**
 * An SSO sign-in in flight (spec 55.5), from its start to the provider's answer, keyed by
 * a hash of the state the provider carries. What binds it to the browser that started it
 * is a hash: the binding itself stays in that browser, and the PKCE verifier is derived
 * from it, so nothing here can finish the flow. Used once. Not in the design doc's tables.
 */
const ssoFlow = z.object({
  providerId: z.uuid(),
  kind: z.enum(['oidc', 'saml']),
  bindingHash: z.string().regex(/^[0-9a-f]{64}$/),
  purpose: z.enum(['sign_in', 'link', 'invitation']),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional(),
  samlRequestId: z.string().regex(/^_[0-9a-f]{32,64}$/).optional(),
  /** link: the signed-in person proving the account (linked_via existing_session). */
  linkUserId: z.uuid().optional(),
  /** invitation: the invitation the token named (linked_via invitation). */
  invitationId: z.uuid().optional(),
});

export const ssoFlowKeys = defineKeyspace({
  pattern: 'ssof:{org}:<stateHash>',
  instance: 'data',
  kind: 'value',
  values: false,
  schema: ssoFlow,
  ttlSeconds: { max: 30 * MINUTE },
  maxBytes: KB,
});

/**
 * A verified SAML answer waiting for the browser that started the flow (spec 55.5). The
 * provider posts to the gateway cross-site, where no browser binding can be read; the
 * gateway sends the browser on with a ticket, which only that browser's binding redeems.
 * Holds the flow and the verified identity for at most a few minutes. Not in the design
 * doc's tables.
 */
export const ssoTicketKeys = defineKeyspace({
  pattern: 'ssot:{org}:<ticketHash>',
  instance: 'data',
  kind: 'value',
  values: false,
  schema: z.object({
    flow: ssoFlow,
    identity: z.object({
      subject: z.string().min(1).max(512),
      email: z.string().max(320).nullable(),
      emailVerified: z.boolean(),
      firstName: z.string().max(200).nullable(),
      lastName: z.string().max(200).nullable(),
      mfa: z.boolean(),
      configuredBy: z.uuid().nullable(),
      /** A SAML sign-in's session at the provider, for single logout (spec 55.5). */
      saml: z.object({ nameId: z.string().max(512), nameIdFormat: z.string().max(200), sessionIndex: z.string().max(512).nullable() }).optional(),
    }),
  }),
  ttlSeconds: { max: 5 * MINUTE },
  maxBytes: 4 * KB,
});

/**
 * A Silo staff session in the admin portal (spec 13.3, 13.4). Staff are not tenant data, so
 * the key is global: the hash tag is a hash of the token the staff browser holds, never the
 * token. TTL: the idle window, slid on each request, never past absoluteExpiresAt. The
 * operator's row is read again on every request, so a suspension or removal applies at
 * once. Losing the key signs the person out. Not in the design doc's tables.
 */
export const staffSessionKeys = defineKeyspace({
  pattern: 'stf:{<tokenHash>}',
  instance: 'session',
  kind: 'value',
  values: false,
  schema: z.object({
    operatorId: z.uuid(),
    /** Resolved from the provider's groups at sign-in (contracts/admin-portal/capability). */
    capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/)).max(64),
    issuedAt: z.iso.datetime({ offset: true }),
    absoluteExpiresAt: z.iso.datetime({ offset: true }),
  }),
  // ADMIN_PORTAL_SESSION_IDLE_MINUTES is at most 120.
  ttlSeconds: { max: 2 * HOUR },
  maxBytes: 2 * KB,
});

/**
 * A staff sign-in in flight, from its start to the staff identity provider's answer, keyed
 * by a hash of the state. As ssoFlowKeys: the binding stays in the browser that started
 * it and the PKCE verifier is derived from it, so nothing here can finish the flow. Used
 * once. Not in the design doc's tables.
 */
export const staffFlowKeys = defineKeyspace({
  pattern: 'stff:{<stateHash>}',
  instance: 'data',
  kind: 'value',
  values: false,
  schema: z.object({
    bindingHash: z.string().regex(/^[0-9a-f]{64}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  }),
  ttlSeconds: { max: 30 * MINUTE },
  maxBytes: KB,
});

/** A WebAuthn ceremony's challenge (spec 55.4), per session and ceremony, used once. Not in the design doc's tables. */
export const webauthnChallengeKeys = defineKeyspace({
  pattern: 'wauth:{org}:<sessionId>:<ceremony>',
  instance: 'data',
  kind: 'value',
  values: false,
  schema: z.object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) }),
  ttlSeconds: { max: 10 * MINUTE },
  maxBytes: 256,
});

// ----------------------------------------------------------------------------- redis-state
// Values in st: object keys only, the latest per input and source, never history (spec 30.6).

/** Live object state. Dynamic fields per input and source; operated by state-plane. */
export const liveObjectKeys = defineKeyspace({
  pattern: 'st:{org}:o:<objectId>',
  instance: 'state',
  kind: 'hash',
  values: true,
  schema: recordValue(z.record(z.string(), z.string())),
  // Idle 15 minutes, re-armed by interest, never beyond the object's absolute expiry.
  ttlSeconds: { max: LIMITS.statePlane.idleTtl, default: LIMITS.statePlane.idleTtl },
  maxBytes: 16 * KB,
});

/** The object an exact match key resolves to. The source key is hashed. */
export const liveMatchKeys = defineKeyspace({
  pattern: 'st:{org}:m:<connectionId>:<sourceKeyHash>',
  instance: 'state',
  kind: 'value',
  values: false,
  schema: z.uuid(),
  ttlSeconds: { max: LIMITS.statePlane.idleTtl, default: LIMITS.statePlane.idleTtl },
  maxBytes: 100,
});

/**
 * Deltas for entities not yet held, scored by when they were observed (epoch milliseconds):
 * a backfill takes those observed after its read began and applies them over the snapshot
 * (spec 18.5), whichever state-plane replica the delta reached. A minute at most.
 */
export const livePendingKeys = defineKeyspace({
  pattern: 'st:{org}:p:<connectionId>:<object>',
  instance: 'state',
  kind: 'zset',
  values: true,
  schema: recordValue(z.string().max(64 * KB)),
  ttlSeconds: { max: 2 * MINUTE, default: MINUTE },
  maxMembers: 10_000,
});

/** Live objects scored by absolute expiry, for the per-organisation bound (spec 7.9). */
export const liveIndexKeys = defineKeyspace({
  pattern: 'live:{org}',
  instance: 'state',
  kind: 'zset',
  values: false,
  schema: z.uuid(),
  ttlSeconds: { max: LIMITS.statePlane.absoluteTtl, default: LIMITS.statePlane.absoluteTtl },
  maxMembers: LIMITS.statePlane.liveObjectsPerOrganisation,
});

/**
 * Precomputed canvas positions for a large set (spec 29.8): held here under TTL, never on
 * disk, because positions derived from a set would store the set. Per node, in the
 * precomputation's order: x, y (null when not placed) and its lowest-zoom cluster.
 * clone.layout_precomputations keeps only the parameters, the set hash and this key.
 * Operated by canvas-layout.
 */
export const layoutPositionKeys = defineKeyspace({
  pattern: 'st:{org}:lay:<precomputationId>',
  instance: 'state',
  kind: 'value',
  values: false,
  schema: z.object({
    layout: z.string(),
    positions: z.array(z.tuple([z.number().nullable(), z.number().nullable(), z.int()])),
    notPlaced: z.int(),
  }),
  ttlSeconds: { max: DAY, default: DAY },
  maxBytes: 4 * 1024 * KB,
});

/** A subscription group: one per object set and permission fingerprint, so values are never shared across permissions. */
export const subscriptionGroupKeys = defineKeyspace({
  pattern: 'sub:{org}:g:<groupId>',
  instance: 'state',
  kind: 'hash',
  values: false,
  schema: z.object({
    objectSetHash: hex,
    permissionFingerprint: hex,
    projectionHash: hex,
    objectCount: hashField.int(),
    subscriberCount: hashField.int(),
    createdAt: hashField.timestamp(),
    /** The group's frame sequence: each delta, snapshot and status frame takes the next. */
    seq: hashField.int().optional(),
    /** What the group serves, as JSON: names and ids only (state-plane's own shape). */
    plan: z.string().max(12 * KB).optional(),
  }),
  ttlSeconds: { max: LIMITS.statePlane.idleTtl, default: LIMITS.statePlane.idleTtl },
  maxBytes: 16 * KB,
});

/** The objects in a group's resolved set. */
export const subscriptionGroupObjectKeys = defineKeyspace({
  pattern: 'sub:{org}:g:<groupId>:objs',
  instance: 'state',
  kind: 'set',
  values: false,
  schema: z.uuid(),
  ttlSeconds: { max: LIMITS.statePlane.idleTtl, default: LIMITS.statePlane.idleTtl },
  maxMembers: LIMITS.bus.objectsPerSubscription,
});

/** One subscriber: a viewer (60 seconds, re-armed by heartbeats) or a Cron watch (120 seconds). */
export const subscriptionKeys = defineKeyspace({
  pattern: 'sub:{org}:s:<subscriptionId>',
  instance: 'state',
  kind: 'hash',
  values: false,
  schema: z.object({
    groupId: id,
    holderKind: z.enum(['session', 'cron']),
    holderId: z.uuid(),
    sessionId: z.uuid().optional(),
    lastAckedSeq: hashField.int(),
    connectedAt: hashField.timestamp(),
    bufferMode: z.enum(['live', 'snapshot']),
  }),
  ttlSeconds: { max: 120, default: 60 },
  maxBytes: 512,
});

/** The groups an object is live in, so a delta reaches every group that holds it. */
export const objectGroupKeys = defineKeyspace({
  pattern: 'sub:{org}:o:<objectId>',
  instance: 'state',
  kind: 'set',
  values: false,
  schema: id,
  ttlSeconds: { max: LIMITS.statePlane.idleTtl, default: LIMITS.statePlane.idleTtl },
  maxMembers: 1_000,
});

/**
 * Live interest in a connection's source objects (spec 18.3): which objects the state plane
 * holds live, scored by when the interest lapses (epoch milliseconds). change-stream polls
 * and publishes only for these; a delivery for anything else is discarded before decode
 * where the source names the object, after it otherwise.
 */
export const changeInterestKeys = defineKeyspace({
  pattern: 'cs:{org}:i:<connectionId>',
  instance: 'state',
  kind: 'zset',
  values: false,
  schema: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  ttlSeconds: { max: LIMITS.statePlane.idleTtl, default: LIMITS.statePlane.idleTtl },
  maxMembers: 500,
});

/** Connections with live interest, scored like the interest itself: what the poller walks. */
export const changeInterestIndexKeys = defineKeyspace({
  pattern: 'cs:{org}:connections',
  instance: 'state',
  kind: 'zset',
  values: false,
  schema: z.uuid(),
  ttlSeconds: { max: LIMITS.statePlane.idleTtl, default: LIMITS.statePlane.idleTtl },
  maxMembers: 10_000,
});

/** Organisations with live interest: what change-stream's workers walk. */
export const changeOrganisationKeys = defineKeyspace({
  pattern: 'cs:{<cellId>}:organisations',
  instance: 'state',
  kind: 'zset',
  values: false,
  schema: z.uuid(),
  ttlSeconds: { max: LIMITS.statePlane.idleTtl, default: LIMITS.statePlane.idleTtl },
  maxMembers: 100_000,
});

/** A polling watermark or event cursor (spec 18.9): a timestamp, sequence or cursor, never a record value. */
export const changeWatermarkKeys = defineKeyspace({
  pattern: 'cs:{org}:w:<connectionId>:<object>',
  instance: 'state',
  kind: 'value',
  values: false,
  schema: z.object({ watermark: z.string().max(512).nullable(), polledAt: hashField.timestamp() }),
  ttlSeconds: { max: LIMITS.statePlane.absoluteTtl, default: LIMITS.statePlane.absoluteTtl },
  maxBytes: 1 * KB,
});

/** A connection's stream health (spec 18.7): live, delayed, stale or stopped, the source in use, and why. */
export const changeStatusKeys = defineKeyspace({
  pattern: 'cs:{org}:s:<connectionId>',
  instance: 'state',
  kind: 'hash',
  values: false,
  schema: z.object({
    status: z.enum(['live', 'delayed', 'stale', 'stopped']),
    source: z.enum(['webhook', 'cdc', 'poll', 'email', 'mqtt', 'opcua', 'none']),
    since: hashField.timestamp(),
    lastDeliveryAt: hashField.timestamp().optional(),
    lastDeltaAt: hashField.timestamp().optional(),
    reason: z.string().max(200).optional(),
    // The last changes lost on the way through the agent's spool (spec 10.6): counts and times only.
    gapReason: z.enum(['spool_bound', 'spool_age', 'spool_damaged', 'resumed_ahead']).optional(),
    gapChanges: hashField.int().optional(),
    gapFrom: hashField.timestamp().optional(),
    gapTo: hashField.timestamp().optional(),
    gapAt: hashField.timestamp().optional(),
  }),
  ttlSeconds: { max: LIMITS.statePlane.absoluteTtl, default: LIMITS.statePlane.absoluteTtl },
  maxBytes: 1 * KB,
});

/**
 * state-plane: holds these source objects live for a while (spec 18.3), so change-stream
 * polls and publishes for them. Renewed while anything subscribes; lapses on its own.
 */
export async function registerChangeInterest(store: RedisStore, cellId: string, organisationId: string,
  connectionId: string, objects: readonly string[], ttlSeconds: number = LIMITS.statePlane.idleTtl): Promise<void> {
  if (objects.length === 0) return;
  const until = Date.now() + ttlSeconds * 1000;
  await store.addScored(changeInterestKeys, changeInterestKeys.key(organisationId, { connectionId }),
    objects.map((member) => ({ member, score: until })), { ttlSeconds });
  await store.addScored(changeInterestIndexKeys, changeInterestIndexKeys.key(organisationId), [{ member: connectionId, score: until }], { ttlSeconds });
  await store.addScored(changeOrganisationKeys, changeOrganisationKeys.key({ cellId }), [{ member: organisationId, score: until }], { ttlSeconds });
}

/** change-stream: the source objects of a connection held live now. */
export async function liveInterest(store: RedisStore, organisationId: string, connectionId: string): Promise<Set<string>> {
  const key = changeInterestKeys.key(organisationId, { connectionId });
  await store.removeScoredUpTo(changeInterestKeys, key, Date.now());
  return new Set(await store.scoredMembers(changeInterestKeys, key));
}

/** change-stream: a connection gone or revoked holds no interest; it lapses at once. */
export async function dropChangeInterest(store: RedisStore, organisationId: string, connectionId: string): Promise<void> {
  const key = changeInterestIndexKeys.key(organisationId);
  await store.addScored(changeInterestIndexKeys, key, [{ member: connectionId, score: 0 }]);
  await store.removeScoredUpTo(changeInterestIndexKeys, key, Date.now());
}

/** change-stream: organisations, then connections, with live interest now. */
export async function interestedOrganisations(store: RedisStore, cellId: string): Promise<string[]> {
  const key = changeOrganisationKeys.key({ cellId });
  await store.removeScoredUpTo(changeOrganisationKeys, key, Date.now());
  return store.scoredMembers(changeOrganisationKeys, key);
}

export async function interestedConnections(store: RedisStore, organisationId: string): Promise<string[]> {
  const key = changeInterestIndexKeys.key(organisationId);
  await store.removeScoredUpTo(changeInterestIndexKeys, key, Date.now());
  return store.scoredMembers(changeInterestIndexKeys, key);
}

/** Source change de-duplication: truncated SHA-256 of each dedup key, trimmed after 10 minutes. */
export const changeDedupKeys = defineKeyspace({
  pattern: 'dedup:{org}:<connectionId>',
  instance: 'state',
  kind: 'zset',
  values: false,
  schema: hex,
  ttlSeconds: { max: 10 * MINUTE, default: 10 * MINUTE },
  maxMembers: 100_000,
});

const manifestName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

/**
 * A stream probe (decision 2026-11-15): the conformance service watching one test record's
 * changes. The record named by the SHA-256 of its identifier; per change its operation,
 * sequence, de-duplication hash and a digest of the probed fields. No record value.
 */
export const changeProbeKeys = defineKeyspace({
  pattern: 'cs:{org}:p:<probeId>',
  instance: 'state',
  kind: 'value',
  values: false,
  schema: z.object({
    connectionId: z.uuid(),
    object: manifestName,
    source: z.enum(['webhook', 'poll', 'cdc', 'none']),
    baseline: z.string().max(512).nullable(),
    watermark: z.string().max(512).nullable(),
    entityHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    fields: z.array(manifestName).max(50),
    observations: z.array(z.object({
      operation: z.enum(['insert', 'update', 'delete']),
      sourceSeq: z.string().max(200).nullable(),
      digest: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
      duplicate: z.boolean(),
      dedupHash: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
    })).max(200),
  }),
  ttlSeconds: { max: LIMITS.statePlane.idleTtl, default: LIMITS.statePlane.idleTtl },
  maxBytes: 64 * KB,
});

/** The probes open on a connection, scored by when each lapses: what publishing checks. */
export const changeProbeIndexKeys = defineKeyspace({
  pattern: 'cs:{org}:pi:<connectionId>',
  instance: 'state',
  kind: 'zset',
  values: false,
  schema: z.uuid(),
  ttlSeconds: { max: LIMITS.statePlane.idleTtl, default: LIMITS.statePlane.idleTtl },
  maxMembers: 20,
});

// ----------------------------------------------------------------------------- idempotency

export type IdempotencyClaim =
  | { state: 'claimed' }
  | { state: 'in_progress' }
  | { state: 'done'; resultRef: string | undefined }
  /** The key was first used for a different request (its requestHash differs). */
  | { state: 'mismatch' };

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.-]{1,200}$/;

function idempotencyKeyOf(organisationId: string, scope: string, idempotencyKey: string): RedisKey<typeof idempotencyKeys.pattern> {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new AppError('validation', 'an idempotency key is 1 to 200 letters, digits, dots, dashes or underscores', {
      code: 'idempotency.invalid_key',
    });
  }
  return idempotencyKeys.key(organisationId, { scope, idempotencyKey });
}

/**
 * Claims an idempotency key for this attempt. claimed: go ahead. in_progress: another
 * attempt is running; refuse with a retry. done: return the earlier result. A fast path
 * only: Redis is not authoritative (spec 12.2), so a write that must happen once is also
 * guarded in Postgres by a unique key.
 */
export async function claimIdempotencyKey(
  store: RedisStore, organisationId: string, scope: string, idempotencyKey: string, requestHash?: string,
): Promise<IdempotencyClaim> {
  const key = idempotencyKeyOf(organisationId, scope, idempotencyKey);
  const result = await store.putHashIfAbsent(idempotencyKeys, key, {
    state: 'in_progress', ...(requestHash === undefined ? {} : { requestHash }),
  });
  if (result.created) return { state: 'claimed' };
  if (requestHash !== undefined && result.current?.requestHash !== undefined && result.current.requestHash !== requestHash) {
    return { state: 'mismatch' };
  }
  if (result.current?.state === 'done') return { state: 'done', resultRef: result.current.resultRef };
  return { state: 'in_progress' };
}

/** Records the result of a claimed key, keeping its 24-hour TTL. */
export async function completeIdempotencyKey(
  store: RedisStore, organisationId: string, scope: string, idempotencyKey: string, resultRef?: string,
): Promise<void> {
  const key = idempotencyKeyOf(organisationId, scope, idempotencyKey);
  await store.setFields(idempotencyKeys, key, { state: 'done', ...(resultRef === undefined ? {} : { resultRef }) });
}

/** Gives a claimed key back after a failed attempt, so a retry may run. */
export async function releaseIdempotencyKey(
  store: RedisStore, organisationId: string, scope: string, idempotencyKey: string,
): Promise<void> {
  await store.remove(idempotencyKeys, idempotencyKeyOf(organisationId, scope, idempotencyKey));
}

// ----------------------------------------------------------------------------- locks

export type LockOutcome<T> = { acquired: false } | { acquired: true; value: T };

/**
 * Runs work while holding a lock (design: lock keys). The holder renews it every third of
 * its TTL. If a renewal fails, the signal aborts: the lock may now be someone else's, and
 * work must stop before writing. Released by compare-and-delete, so a lock that expired
 * and was taken by another holder is never deleted.
 */
export async function withLock<P extends string, T>(
  store: RedisStore, keyspace: Keyspace<P, 'lock'>, key: RedisKey<P>, work: (signal: AbortSignal) => Promise<T>,
  options: { ttlSeconds?: number } = {},
): Promise<LockOutcome<T>> {
  const ttlSeconds = options.ttlSeconds ?? keyspace.ttlSeconds.default ?? keyspace.ttlSeconds.max;
  const token = await store.acquireLock(keyspace, key, ttlSeconds);
  if (token === undefined) return { acquired: false };
  const controller = new AbortController();
  const renewal = setInterval(() => {
    store.renewLock(keyspace, key, token, ttlSeconds).then(
      (held) => { if (!held) controller.abort(new AppError('conflict', 'the lock was lost', { code: 'redis.lock_lost' })); },
      (error: unknown) => controller.abort(error),
    );
  }, Math.max(100, Math.floor((ttlSeconds * 1000) / 3)));
  try {
    return { acquired: true, value: await work(controller.signal) };
  } finally {
    clearInterval(renewal);
    await store.releaseLock(keyspace, key, token).catch(() => undefined);
  }
}
