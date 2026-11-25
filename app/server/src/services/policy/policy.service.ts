// The authorisation decision point (spec 7.7, 57.1, 57.6, 58, 60.4).
//
// For an actor (a membership with its session, or a service principal), a permission and
// where it is used, in the order of spec 57.6:
// 1. the actor must be live: the session the membership's, MFA satisfied where due (spec
//    55.4), the membership active; a principal unrevoked, unexpired, its owner active;
// 2. the actor's live grants (organisation-wide; on a scope whose path contains the scope
//    acted on, or, when none is named, a scope the actor sits in; on the resource itself)
//    are unioned (steps 1 and 2). A principal never holds an authorising permission (60.6)
//    and has no more than its owner holds at the same place, now (60.4);
// 3. connections are reached only through live grants (step 3);
// 4. the mandatory gate: every marking on the resource must be satisfied, by a live
//    clearance (classification, compartment) or by an active purpose session the request
//    names (purpose: spec 58.5). One unsatisfied marking denies, whatever the role (step 4);
// 5. field policies narrow what is visible of a field or property (step 5);
// 6. deny wins at every step.
//
// The membership's resolved authority (grants, roles, scopes, clearances, connection
// grants) is cached in redis-session per session and policy version, so a change to any of
// them applies on the next request in every pod (spec 7.7). Expiry bumps no version, so an
// entry lives no longer than the earliest expiry among what produced it.

import type { DENIAL_REASONS, FieldEffect } from '../../contracts/policy/decision.contract.ts';
import { permissionKeys, purposeSessionKeys, sessionKeys } from '../../infra/keyspaces.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import { clearanceRepo, purposeSessionRepo, resourceMarkingRepo, type MarkableResource } from '../../repos/gov/index.repo.ts';
import type { NodeKind } from '../../contracts/lineage/lineage.contract.ts';
import { artefactMarkingsOf } from '../lineage/markings.service.ts';
import {
  connectionGrantRepo, fieldPolicyRepo, membershipRepo, objectTypeMarkingRepo, policyVersionRepo, roleAssignmentRepo,
  scopeMembershipRepo, scopeRepo, servicePrincipalRepo, servicePrincipalRoleRepo,
} from '../../repos/iam/index.repo.ts';
import type { LiveGrant } from '../../repos/iam/roleAssignment.repo.ts';
import type { Scope } from '../../models/iam/scope.model.ts';
import { authorisationConnectionRepo, automationConnectionRepo } from '../../repos/automation/index.repo.ts';
import { CRON_MUTATE_PERMISSIONS, CRON_PRINCIPAL_PERMISSIONS } from '../../contracts/scheduler/cron.contract.ts';
import { PIPELINE_PRINCIPAL_PERMISSIONS } from '../../contracts/workspace/pipeline.contract.ts';
import { pipelineScheduleRepo } from '../../repos/workspace/index.repo.ts';
import { FDE_FORBIDDEN_PERMISSIONS } from '../../contracts/fde-orchestrator/events.contract.ts';
import { fdeEngagementRepo, fdePrincipalRepo } from '../../repos/fde/index.repo.ts';

const FDE_FORBIDDEN: ReadonlySet<string> = new Set(FDE_FORBIDDEN_PERMISSIONS);

export type Reason = 'allowed' | (typeof DENIAL_REASONS)[number];
export type PermissionCategory = 'standard' | 'authorising' | 'silo_staff';
type Access = 'read' | 'write';

export interface Authority {
  membershipActive: boolean;
  grants: LiveGrant[];
  memberScopePaths: string[];
  obligations: string[];
  roleIds?: string[] | undefined;
  /** Markings the actor's live clearances satisfy. */
  clearances?: string[] | undefined;
  /** Connections the actor's live grants reach. */
  connections?: { id: string; access: Access }[] | undefined;
}

export type ResourceRef = { type: NonNullable<LiveGrant['resourceType']>; id: string };

/** Who is asking: a membership acting under its session, or a service principal. */
export type ActorRef =
  | { organisationId: string; membershipId: string; servicePrincipalId?: undefined; sessionId: string | undefined }
  | { organisationId: string; membershipId?: undefined; servicePrincipalId: string; sessionId: string | undefined };

export interface DecisionRequest {
  actor: ActorRef;
  permission: string;
  scopeId?: string | undefined;
  resource?: ResourceRef | undefined;
  organisationWide?: boolean | undefined;
  purposeSessionIds?: readonly string[] | undefined;
}

export interface AccessRequest {
  actor: ActorRef;
  connections: readonly string[];
  objectTypes: readonly string[];
  properties: readonly string[];
  linkTypes: readonly string[];
  actionTypes: readonly string[];
  /** Functions and interfaces (spec 21.15): visible where every marking on them is held. */
  functions?: readonly string[] | undefined;
  interfaces?: readonly string[] | undefined;
  fields: readonly { connectionId: string; path: string }[];
  /** Markings to test directly (an artefact's, from lineage). */
  markings?: readonly string[] | undefined;
  purposeSessionIds?: readonly string[] | undefined;
  /**
   * A decision for a named member who is not present (decision 2026-11-14: a Lens's coverage
   * at share, worked out as each recipient): no session is required, the authority is loaded
   * fresh, and only clearances count, since a purpose session lives in a session.
   */
  sessionless?: boolean | undefined;
}

export interface AccessResult {
  reason: Reason;
  connections: { id: string; access: 'none' | Access; unsatisfiedMarkingIds: string[] }[];
  objectTypes: { id: string; visible: boolean; unsatisfiedMarkingIds: string[] }[];
  linkTypes: { id: string; visible: boolean }[];
  actionTypes: { id: string; visible: boolean }[];
  functions: { id: string; visible: boolean }[];
  interfaces: { id: string; visible: boolean }[];
  properties: { id: string; visible: boolean; effect: FieldEffect }[];
  fields: { connectionId: string; path: string; effect: FieldEffect }[];
  markings: { id: string; satisfied: boolean }[];
}

// ltree containment: a path is within an ancestor when it is the ancestor or extends it.
export const within = (ancestor: string, path: string): boolean => path === ancestor || path.startsWith(`${ancestor}.`);

/**
 * Spec 57.6 steps 1, 2 and 6 over resolved grants. Pure, so it can be tested on its own.
 * organisationWide: only a grant held organisation-wide counts (no scope, no resource).
 */
export function decide(authority: Authority, permission: string, scopePath: string | null, resource: ResourceRef | undefined,
  organisationWide = false): Reason {
  if (!authority.membershipActive) return 'membership_inactive';
  const applies = (grant: LiveGrant): boolean => {
    if (organisationWide) return grant.scopePath === null && grant.resourceType === null;
    if (grant.resourceType !== null) return resource !== undefined && grant.resourceType === resource.type && grant.resourceId === resource.id;
    if (grant.scopePath === null) return true;
    if (scopePath !== null) return within(grant.scopePath, scopePath);
    return authority.memberScopePaths.some((path) => within(grant.scopePath!, path));
  };
  return authority.grants.some((grant) => grant.permissions.includes(permission) && applies(grant)) ? 'allowed' : 'not_granted';
}

/** The mandatory gate (spec 57.5): satisfied only when every marking is. */
export const satisfiesAll = (markingIds: readonly string[], satisfied: ReadonlySet<string>): boolean =>
  markingIds.every((id) => satisfied.has(id));

const EFFECT_ORDER: Record<FieldEffect, number> = { allow: 0, mask: 1, redact: 2, deny: 3 };
/** The stricter of two effects: deny wins. */
export const stricter = (a: FieldEffect, b: FieldEffect): FieldEffect => (EFFECT_ORDER[b] > EFFECT_ORDER[a] ? b : a);

export interface FieldPolicyAudience {
  appliesToRoleId: string | null;
  appliesToMarkingId: string | null;
  appliesToScopePath: string | null;
  includeDescendants: boolean;
}

/**
 * Whether a field policy applies to a reader (spec 57.4). Each condition set narrows the
 * audience (design doc: AND; all unset means everyone): the reader holds the role; the
 * reader does not satisfy the marking; the reader sits in the scope (or beneath it, with
 * descendants).
 */
export function policyApplies(policy: FieldPolicyAudience, reader: { roleIds: ReadonlySet<string>; scopePaths: readonly string[];
  satisfied: ReadonlySet<string> }): boolean {
  if (policy.appliesToRoleId !== null && !reader.roleIds.has(policy.appliesToRoleId)) return false;
  if (policy.appliesToMarkingId !== null && reader.satisfied.has(policy.appliesToMarkingId)) return false;
  if (policy.appliesToScopePath !== null) {
    const scope = policy.appliesToScopePath;
    if (!reader.scopePaths.some((path) => (policy.includeDescendants ? within(scope, path) : path === scope))) return false;
  }
  return true;
}

export interface PolicyDeps {
  databases: Databases;
  /** redis-session: the session hot copies (read), resolved authority and purpose sessions. */
  sessions: RedisStore;
  logger: Logger;
  /** The permission catalogue (spec 76) with each permission's category, loaded at start. */
  catalogue: ReadonlyMap<string, PermissionCategory>;
}

/** A live actor, resolved: what every later step reads. */
export interface Subject {
  actor: ActorRef;
  authority: Authority;
  /** A principal's accountable owner, whose authority bounds its own (spec 60.4). */
  owner?: Authority | undefined;
  ownerMembershipId?: string | undefined;
  scopePaths: string[];
  roleIds: Set<string>;
  /** Markings satisfied: live clearances plus the purposes of the request's active purpose sessions. */
  satisfied: Set<string>;
  connections: Map<string, Access>;
}

export type Resolved = { reason: 'allowed'; subject: Subject } | { reason: Exclude<Reason, 'allowed'> };

export interface Policy {
  /** Steps 1, 2, 4 and 6 for a permission (spec 57.6). */
  decide(request: DecisionRequest): Promise<Reason>;
  /** Resolves a live actor, or why it is not one. */
  resolve(actor: ActorRef, purposeSessionIds?: readonly string[]): Promise<Resolved>;
  /** The permission decision for an already resolved actor. */
  decideFor(subject: Subject, request: Omit<DecisionRequest, 'actor' | 'purposeSessionIds'>): Promise<Reason>;
  /** The live scopes where the resolved actor holds a scoped permission, by the same rule as decideFor (W7). */
  scopesFor(subject: Subject, permission: string): Promise<Scope[]>;
  /** The catalogue permissions the resolved actor holds anywhere: with no scope named, as decideFor decides, or on some live scope. */
  heldAnywhere(subject: Subject): Promise<Set<string>>;
  /** Steps 3 to 5, for a plan about to be built. */
  access(request: AccessRequest): Promise<AccessResult>;
  /** The markings on these resources, by resource id. */
  markingsOf(type: MarkableResource | 'object_type', ids: readonly string[]): Promise<Map<string, string[]>>;
}

const MINUTE_SECONDS = 60;
const AUTHORITY_TTL_SECONDS = 15 * MINUTE_SECONDS;

const earliest = (instants: readonly (string | null | undefined)[]): number | undefined => {
  const times = instants.filter((t): t is string => typeof t === 'string').map((t) => Date.parse(t));
  return times.length === 0 ? undefined : Math.min(...times);
};

export function createPolicy(deps: PolicyDeps): Policy {
  const control = deps.databases.pool('control');

  /** A membership's authority from Postgres, and when the earliest thing in it expires. */
  async function loadMembershipAuthority(db: Queryable, membershipId: string): Promise<{ authority: Authority; expiresAt: number | undefined }> {
    const membership = await membershipRepo.findById(db, membershipId);
    const assignments = await roleAssignmentRepo.liveAssignments(db, membershipId);
    const clearances = await clearanceRepo.liveFor(db, { membershipId });
    const connections = await connectionGrantRepo.reachableByMembership(db, membershipId);
    return {
      authority: {
        membershipActive: membership?.status === 'active',
        grants: assignments.map(({ permissions, scopePath, resourceType, resourceId }) => ({ permissions, scopePath, resourceType, resourceId })),
        memberScopePaths: await scopeMembershipRepo.activeScopePaths(db, membershipId),
        obligations: [],
        roleIds: [...new Set(assignments.map((a) => a.roleId))],
        clearances: clearances.map((c) => c.markingId),
        connections: connections.map((c) => ({ id: c.connectionId, access: c.access })),
      },
      expiresAt: earliest([...assignments.map((a) => a.expiresAt), ...clearances.map((c) => c.expiresAt),
        ...connections.map((c) => c.expiresAt)]),
    };
  }

  /** Cached per session and policy version; never beyond the earliest expiry. Fails open to a fresh load. */
  async function membershipAuthority(organisationId: string, membershipId: string, sessionId: string, version: number): Promise<Authority> {
    const key = permissionKeys.key(organisationId, { sessionId, policyVersion: version });
    const hit = await deps.sessions.read(permissionKeys, key).catch(() => undefined);
    if (hit !== undefined) return hit;
    const { authority, expiresAt } = await inTransaction(control, { organisationId, membershipId }, (db) => loadMembershipAuthority(db, membershipId));
    const ttl = Math.min(AUTHORITY_TTL_SECONDS, expiresAt === undefined ? AUTHORITY_TTL_SECONDS : Math.floor((expiresAt - Date.now()) / 1000));
    if (ttl >= 1) {
      await deps.sessions.put(permissionKeys, key, authority, { ttlSeconds: ttl }).catch((error: unknown) => {
        deps.logger.debug('authority not cached', { event: 'policy.authority_not_cached', reason: error instanceof Error ? error.name : 'unknown' });
      });
    }
    return authority;
  }

  /**
   * The purpose markings the request's purpose sessions satisfy (spec 58.5): each must be
   * open, unexpired, the actor's and bound to this authentication session. Read from the
   * Redis hot copy, with Postgres as the record when the copy is absent. A session that
   * fails any test satisfies nothing; it does not deny the request.
   */
  async function purposeMarkings(actor: ActorRef, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0 || actor.sessionId === undefined) return [];
    const markings: string[] = [];
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const copy = await deps.sessions.readHash(purposeSessionKeys, purposeSessionKeys.key(actor.organisationId, { purposeSessionId: id }))
        .catch(() => undefined);
      if (copy === undefined) {
        missing.push(id);
        continue;
      }
      const mine = actor.membershipId !== undefined ? copy.membershipId === actor.membershipId : copy.servicePrincipalId === actor.servicePrincipalId;
      if (mine && copy.sessionId === actor.sessionId && Date.parse(copy.endsAt) > Date.now()) markings.push(copy.markingId);
    }
    if (missing.length > 0) {
      const rows = await inTransaction(control, { organisationId: actor.organisationId }, (db) => purposeSessionRepo.findLive(db, missing));
      for (const row of rows) {
        const mine = actor.membershipId !== undefined ? row.membershipId === actor.membershipId : row.servicePrincipalId === actor.servicePrincipalId;
        if (mine && row.sessionId === actor.sessionId) markings.push(row.markingId);
      }
    }
    return markings;
  }

  /** A live session for the actor: the membership's, or the principal's when it names one. */
  async function sessionReason(actor: ActorRef): Promise<Exclude<Reason, 'allowed'> | undefined> {
    if (actor.sessionId === undefined) return actor.servicePrincipalId !== undefined ? undefined : 'session_unknown';
    const session = await deps.sessions.readHash(sessionKeys, sessionKeys.key(actor.organisationId, { sessionId: actor.sessionId }));
    const owner = actor.membershipId !== undefined ? session?.membershipId === actor.membershipId : session?.servicePrincipalId === actor.servicePrincipalId;
    if (!session || session.revoked || !owner
      || Date.parse(session.absoluteExpiresAt) <= Date.now() || Date.parse(session.idleExpiresAt) <= Date.now()) {
      return 'session_unknown';
    }
    if (session.authStrength === 'password_mfa_pending' || session.authStrength === 'password_mfa_enrol') return 'mfa_required';
    return undefined;
  }

  async function resolve(actor: ActorRef, purposeSessionIds: readonly string[] = [], sessionless = false): Promise<Resolved> {
    if (sessionless && actor.membershipId !== undefined) {
      const { authority } = await inTransaction(control, { organisationId: actor.organisationId, membershipId: actor.membershipId },
        (db) => loadMembershipAuthority(db, actor.membershipId!));
      if (!authority.membershipActive) return { reason: 'membership_inactive' };
      return {
        reason: 'allowed',
        subject: {
          actor, authority, scopePaths: authority.memberScopePaths, roleIds: new Set(authority.roleIds ?? []),
          satisfied: new Set(authority.clearances ?? []), connections: new Map((authority.connections ?? []).map((c) => [c.id, c.access])),
        },
      };
    }
    const sessionProblem = await sessionReason(actor);
    if (sessionProblem !== undefined) return { reason: sessionProblem };
    const purposes = await purposeMarkings(actor, purposeSessionIds);

    if (actor.membershipId !== undefined) {
      const version = await inTransaction(control, { organisationId: actor.organisationId, membershipId: actor.membershipId }, async (db) =>
        Number((await policyVersionRepo.findByOrganisationId(db, actor.organisationId))?.version ?? 0));
      const authority = await membershipAuthority(actor.organisationId, actor.membershipId, actor.sessionId!, version);
      if (!authority.membershipActive) return { reason: 'membership_inactive' };
      return {
        reason: 'allowed',
        subject: {
          actor, authority, scopePaths: authority.memberScopePaths, roleIds: new Set(authority.roleIds ?? []),
          satisfied: new Set([...(authority.clearances ?? []), ...purposes]),
          connections: new Map((authority.connections ?? []).map((c) => [c.id, c.access])),
        },
      };
    }

    // A service principal (spec 60.4): resolved fresh on each request, not cached.
    const principalId = actor.servicePrincipalId;
    const loaded = await inTransaction(control, { organisationId: actor.organisationId, servicePrincipalId: principalId }, async (db) => {
      const principal = await servicePrincipalRepo.findForDecision(db, principalId);
      if (!principal || principal.revokedAt !== null || (principal.expiresAt !== null && Date.parse(principal.expiresAt) <= Date.now())) {
        return undefined;
      }
      const owner = await loadMembershipAuthority(db, principal.ownerMembershipId);
      if (!owner.authority.membershipActive) return undefined;
      const roles = await servicePrincipalRoleRepo.grantsFor(db, principalId);
      const clearances = await clearanceRepo.liveFor(db, { servicePrincipalId: principalId });
      const reached = await connectionGrantRepo.reachableByPrincipal(db, principalId);
      // A Cron's principal (spec 40.6) is granted what its Cron needs: read access to the
      // connections its question reads, and the permissions its actions use. Its owner bounds
      // both below, as for every principal, and its markings are its owner's, now.
      // A scheduled pipeline's principal (D241) is granted read on the connections its inputs read and silo.import, to write
      // its output; its owner bounds both, and its markings are its owner's, as a Cron's are.
      const pipeline = principal.kind === 'automation' ? await pipelineScheduleRepo.grantedToPrincipal(db, principalId) : undefined;
      const cron = principal.kind === 'automation' && pipeline === undefined ? await automationConnectionRepo.grantedToPrincipal(db, principalId) : undefined;
      // A Cron with an unrevoked mutate authorisation proposes through the connections it names (spec 40.5); once an execute
      // authorisation expires it still proposes, and actions no longer executes it unattended (40.6).
      const cronWrites = principal.kind === 'automation' ? await authorisationConnectionRepo.writableToPrincipal(db, principalId) : [];
      // An AI FDE principal (spec 49.4, 52.1): its role's tool permissions, live only while its
      // engagement is active; what it reaches and sees is its engaging administrator's, now.
      let fde: { toolPermissions: string[]; engagementId: string; role: string; ownerOwns: string[] } | undefined;
      if (principal.kind === 'fde') {
        const row = await fdePrincipalRepo.findByServicePrincipalId(db, { organisationId: actor.organisationId, servicePrincipalId: principalId });
        const engagement = row === undefined ? undefined : await fdeEngagementRepo.findById(db, row.engagementId);
        if (row === undefined || row.revokedAt !== null || engagement?.status !== 'active') return undefined;
        fde = { toolPermissions: row.toolPermissions, engagementId: row.engagementId, role: row.role,
          ownerOwns: await connectionGrantRepo.ownedBy(db, principal.ownerMembershipId) };
      }
      // The owner's own connections count in the bound: owning one reaches it with write.
      const candidates = [...new Set([...reached.map((r) => r.connectionId), ...(cron ?? []), ...(pipeline ?? []), ...cronWrites])];
      const ownerOwns = candidates.length === 0 ? [] : await connectionGrantRepo.ownedAmong(db, principal.ownerMembershipId, candidates);
      return { principal, owner, roles, clearances, reached, cron, pipeline, cronWrites, ownerOwns, fde };
    });
    if (loaded === undefined) return { reason: 'principal_inactive' };
    const { principal, owner, roles, clearances, cron, pipeline, cronWrites, fde } = loaded;
    const reached = fde !== undefined
      // Read only, never write: the AI FDE writes nothing to a live record (spec 52.1).
      ? [...new Set([...(owner.authority.connections ?? []).map((c) => c.id), ...fde.ownerOwns])].map((connectionId) => ({ connectionId, access: 'read' as const }))
      : pipeline !== undefined ? [...loaded.reached, ...pipeline.map((connectionId) => ({ connectionId, access: 'read' as const }))]
      : cron === undefined ? loaded.reached : [
        ...loaded.reached, ...cron.filter((c) => !cronWrites.includes(c)).map((connectionId) => ({ connectionId, access: 'read' as const })),
        ...cronWrites.map((connectionId) => ({ connectionId, access: 'write' as const })),
      ];
    // Its roles apply within the scope that bounds it, or organisation-wide when none does.
    const grants = roles.map((r) => ({ permissions: r.permissions, scopePath: principal.scopePath, resourceType: null, resourceId: null }));
    if (cron !== undefined) {
      grants.push({
        permissions: [...CRON_PRINCIPAL_PERMISSIONS, ...(cronWrites.length > 0 ? CRON_MUTATE_PERMISSIONS : [])], scopePath: principal.scopePath,
        resourceType: null, resourceId: null,
      });
    }
    if (pipeline !== undefined) {
      grants.push({ permissions: [...PIPELINE_PRINCIPAL_PERMISSIONS], scopePath: principal.scopePath, resourceType: null, resourceId: null });
    }
    if (fde !== undefined) {
      // effective = role tool permissions ∩ the engaging administrator's (the owner bound,
      // below) ∖ the forbidden set, which the database already keeps off its tool list.
      grants.push({ permissions: fde.toolPermissions.filter((p) => !FDE_FORBIDDEN.has(p)), scopePath: principal.scopePath, resourceType: null, resourceId: null });
    }
    const authority: Authority = {
      membershipActive: true,
      grants,
      memberScopePaths: principal.scopePath === null ? [] : [principal.scopePath],
      obligations: [],
      roleIds: roles.map((r) => r.roleId),
      // A Cron's and the AI FDE's markings are their owner's: no clearance of their own (spec 52.1).
      clearances: cron === undefined && pipeline === undefined && fde === undefined ? clearances.map((c) => c.markingId) : [...(owner.authority.clearances ?? [])],
    };
    // Connection access is the lesser of the principal's and its owner's.
    const ownerReach = new Map<string, Access>((owner.authority.connections ?? []).map((c) => [c.id, c.access]));
    for (const id of [...loaded.ownerOwns, ...(fde?.ownerOwns ?? [])]) ownerReach.set(id, 'write');
    const connections = new Map<string, Access>();
    for (const r of reached) {
      const ownerAccess = ownerReach.get(r.connectionId);
      if (ownerAccess !== undefined) connections.set(r.connectionId, ownerAccess === 'write' && r.access === 'write' ? 'write' : 'read');
    }
    return {
      reason: 'allowed',
      subject: {
        actor, authority, owner: owner.authority, ownerMembershipId: principal.ownerMembershipId, scopePaths: authority.memberScopePaths,
        roleIds: new Set(authority.roleIds), satisfied: new Set([...authority.clearances!, ...purposes]), connections,
      },
    };
  }

  return {
    resolve,

    async decide(request) {
      if (!deps.catalogue.has(request.permission)) return 'unknown_permission';
      const resolved = await resolve(request.actor, request.purposeSessionIds);
      if (resolved.reason !== 'allowed') return resolved.reason;
      return this.decideFor(resolved.subject, request);
    },

    async scopesFor(subject, permission) {
      if (deps.catalogue.get(permission) === undefined) return [];
      const { organisationId } = subject.actor;
      const context = { organisationId, ...(subject.actor.membershipId ? { membershipId: subject.actor.membershipId } : {}),
        ...(subject.actor.servicePrincipalId ? { servicePrincipalId: subject.actor.servicePrincipalId } : {}) };
      const scopes = await inTransaction(control, context, (db) => scopeRepo.list(db, false), { readOnly: true });
      return scopes.filter((scope) => decide(subject.authority, permission, scope.path, undefined) === 'allowed'
        && (subject.owner === undefined || decide(subject.owner, permission, scope.path, undefined) === 'allowed'));
    },
    async heldAnywhere(subject) {
      const { organisationId } = subject.actor;
      const context = { organisationId, ...(subject.actor.membershipId ? { membershipId: subject.actor.membershipId } : {}),
        ...(subject.actor.servicePrincipalId ? { servicePrincipalId: subject.actor.servicePrincipalId } : {}) };
      const scopes = await inTransaction(control, context, (db) => scopeRepo.list(db, false), { readOnly: true });
      const held = new Set<string>();
      for (const [permission, category] of deps.catalogue) {
        if (subject.actor.servicePrincipalId !== undefined && category === 'authorising') continue;
        // The same rule as decideFor: the actor's grants, and a principal's owner's, at one place.
        const at = (path: string | null): boolean => decide(subject.authority, permission, path, undefined) === 'allowed'
          && (subject.owner === undefined || decide(subject.owner, permission, path, undefined) === 'allowed');
        if (at(null) || scopes.some((scope) => at(scope.path))) held.add(permission);
      }
      return held;
    },
    async decideFor(subject, request) {
      const category = deps.catalogue.get(request.permission);
      if (category === undefined) return 'unknown_permission';
      if (subject.actor.servicePrincipalId !== undefined && category === 'authorising') return 'principal_never_authorises';
      const { organisationId } = subject.actor;
      const context = { organisationId, ...(subject.actor.membershipId ? { membershipId: subject.actor.membershipId } : {}),
        ...(subject.actor.servicePrincipalId ? { servicePrincipalId: subject.actor.servicePrincipalId } : {}) };
      const { scopePath, markings } = await inTransaction(control, context, async (db) => ({
        scopePath: request.scopeId === undefined ? null : (await scopeRepo.findById(db, request.scopeId))?.path ?? undefined,
        markings: request.resource === undefined ? [] : await resourceMarkings(db, organisationId, request.resource),
      }));
      if (scopePath === undefined) return 'not_granted';
      const own = decide(subject.authority, request.permission, scopePath, request.resource, request.organisationWide === true);
      if (own !== 'allowed') return own;
      if (subject.owner !== undefined) {
        // A principal never exceeds its owner's authority at the same place, now (spec 60.4).
        const owner = decide(subject.owner, request.permission, scopePath, request.resource, request.organisationWide === true);
        if (owner !== 'allowed') return 'not_granted';
      }
      if (!satisfiesAll(markings, subject.satisfied)) return 'marking_unsatisfied';
      return 'allowed';
    },

    markingsOf: (type, ids) => inTransaction(control, {}, (db) => markingsByResource(db, type, ids)),

    async access(request) {
      const empty: AccessResult = {
        reason: 'allowed', connections: [], objectTypes: [], linkTypes: [], actionTypes: [], functions: [], interfaces: [], properties: [], fields: [], markings: [],
      };
      const resolved = await resolve(request.actor, request.purposeSessionIds, request.sessionless === true);
      if (resolved.reason !== 'allowed') return { ...empty, reason: resolved.reason };
      const subject = resolved.subject;
      const { organisationId } = subject.actor;
      const context = { organisationId, ...(subject.actor.membershipId ? { membershipId: subject.actor.membershipId } : {}),
        ...(subject.actor.servicePrincipalId ? { servicePrincipalId: subject.actor.servicePrincipalId } : {}) };

      const connectionIds = [...new Set([...request.connections, ...request.fields.map((f) => f.connectionId)])];
      const loaded = await inTransaction(control, context, async (db) => {
        const ownerId = subject.actor.membershipId ?? subject.ownerMembershipId!;
        return {
          owned: new Set(await connectionGrantRepo.ownedAmong(db, ownerId, connectionIds)),
          connectionMarkings: await markingsByResource(db, 'connection', connectionIds),
          objectTypeMarkings: await markingsByResource(db, 'object_type', request.objectTypes),
          propertyMarkings: await markingsByResource(db, 'property', request.properties),
          // A property carries the markings of the source fields it maps; a field, its own (58.4, 21.15).
          mappedFieldMarkings: await resourceMarkingRepo.mappedFieldMarkings(db, request.properties),
          fieldMarkings: await resourceMarkingRepo.fieldMarkings(db, request.fields),
          linkTypeMarkings: await markingsByResource(db, 'link_type', request.linkTypes),
          actionTypeMarkings: await markingsByResource(db, 'action_type', request.actionTypes),
          functionMarkings: await markingsByResource(db, 'function', request.functions ?? []),
          interfaceMarkings: await markingsByResource(db, 'interface', request.interfaces ?? []),
          policies: await fieldPolicyRepo.liveFor(db, { fields: request.fields, propertyIds: request.properties }),
        };
      });

      const visible = (markings: Map<string, string[]>, id: string): boolean => satisfiesAll(markings.get(id) ?? [], subject.satisfied);
      const lacking = (markings: Map<string, string[]>, id: string): string[] => (markings.get(id) ?? []).filter((m) => !subject.satisfied.has(m));
      const fieldCleared = (connectionId: string, path: string): boolean => satisfiesAll(
        loaded.fieldMarkings.filter((m) => m.connectionId === connectionId && m.path === path).map((m) => m.markingId), subject.satisfied);
      const mappedCleared = (propertyId: string): boolean => satisfiesAll(
        loaded.mappedFieldMarkings.filter((m) => m.resourceId === propertyId).map((m) => m.markingId), subject.satisfied);
      const reader = { roleIds: subject.roleIds, scopePaths: subject.scopePaths, satisfied: subject.satisfied };
      // Owning a connection reaches it (a principal's owner's ownership does not); otherwise
      // only a live grant does (default deny, spec 57.3). A marking on it unsatisfied: none.
      const accessTo = (id: string): 'none' | Access => {
        const owned = loaded.owned.has(id) && subject.actor.membershipId !== undefined ? 'write' as const : undefined;
        const access = owned ?? subject.connections.get(id);
        return access !== undefined && visible(loaded.connectionMarkings, id) ? access : 'none';
      };
      const effectOf = (matches: (p: (typeof loaded.policies)[number]) => boolean): FieldEffect =>
        loaded.policies.filter(matches).filter((p) => policyApplies(p, reader)).reduce<FieldEffect>((e, p) => stricter(e, p.effect), 'allow');

      return {
        reason: 'allowed',
        connections: request.connections.map((id) => ({ id, access: accessTo(id), unsatisfiedMarkingIds: lacking(loaded.connectionMarkings, id) })),
        objectTypes: request.objectTypes.map((id) => ({
          id, visible: visible(loaded.objectTypeMarkings, id), unsatisfiedMarkingIds: lacking(loaded.objectTypeMarkings, id),
        })),
        linkTypes: request.linkTypes.map((id) => ({ id, visible: visible(loaded.linkTypeMarkings, id) })),
        actionTypes: request.actionTypes.map((id) => ({ id, visible: visible(loaded.actionTypeMarkings, id) })),
        functions: (request.functions ?? []).map((id) => ({ id, visible: visible(loaded.functionMarkings, id) })),
        interfaces: (request.interfaces ?? []).map((id) => ({ id, visible: visible(loaded.interfaceMarkings, id) })),
        properties: request.properties.map((id) => {
          const shown = visible(loaded.propertyMarkings, id) && mappedCleared(id);
          return { id, visible: shown, effect: shown ? effectOf((p) => p.propertyId === id) : 'deny' as const };
        }),
        // A field of a connection the reader cannot reach is denied with it.
        fields: request.fields.map((f) => ({
          connectionId: f.connectionId, path: f.path,
          effect: accessTo(f.connectionId) === 'none' || !fieldCleared(f.connectionId, f.path) ? 'deny' as const
            : effectOf((p) => p.connectionId === f.connectionId && p.fieldPath === f.path),
        })),
        markings: (request.markings ?? []).map((id) => ({ id, satisfied: subject.satisfied.has(id) })),
      };
    },
  };
}

/** Markings on these resources of one type, by resource id (every id present, possibly with none). */
export async function markingsByResource(db: Queryable, type: MarkableResource | 'object_type', ids: readonly string[])
  : Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return result;
  const rows = type === 'object_type' ? await objectTypeMarkingRepo.markingsFor(db, ids) : await resourceMarkingRepo.markingsFor(db, type, ids);
  for (const row of rows) result.get(row.resourceId)?.push(row.markingId);
  return result;
}

// The artefacts a decision may name, as lineage node kinds: their markings include those
// inherited along lineage (spec 58.1), stored or still being propagated (58.6).
const ARTEFACT_KINDS: Partial<Record<ResourceRef['type'], NodeKind>> = { view: 'view', app: 'app_version', silo: 'silo' };

/** The markings on a decision's resource: its own direct markings (spec 57.5), and for an artefact those it inherits. */
async function resourceMarkings(db: Queryable, organisationId: string, resource: ResourceRef): Promise<string[]> {
  const direct = (await markingsByResource(db, resource.type === 'object_type' ? 'object_type' : resource.type, [resource.id])).get(resource.id) ?? [];
  const kind = ARTEFACT_KINDS[resource.type];
  return kind === undefined ? direct : [...new Set([...direct, ...await artefactMarkingsOf(db, organisationId, kind, resource.id)])];
}
