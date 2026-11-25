// SCIM Groups and their mapping to Silo roles (decision 2026-11-14; RFC 7643 section 4.2;
// D77).
//
// The identity provider pushes groups and who is in them. A group grants nothing by itself:
// an admin maps it to a Silo role at a scope (or organisation-wide), and while a member is in
// a mapped group they hold that role. Roles are never created from group names; a mapping is
// by the group's id, so a group renamed in the customer's directory grants nothing new.
//
// Grants follow the mapping: whenever a member's groups or a group's mappings change, the
// member's grants are reconciled in the same transaction. A mapped grant is given as the
// admin who made the mapping, under the delegation rules (where that admin can no longer give
// it, it is not given, and the event counts it refused), and carries its mapping; it is
// revoked when nothing maps it any more. A grant the member already holds by hand is left
// alone. Members provisioned by SCIM have their roles edited only this way (policy refuses a
// hand edit), as the identity provider is the source of truth.

import { z } from 'zod';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { ScimGroup } from '../../models/iam/scimGroup.model.ts';
import type { ScimGroupMapping } from '../../models/iam/scimGroupMapping.model.ts';
import {
  membershipRepo, roleAssignmentRepo, roleRepo, scimGroupMappingRepo, scimGroupMemberRepo, scimGroupRepo, scopeRepo,
} from '../../repos/iam/index.repo.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { isUuid, uuidv7 } from '../../utils/id.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import type { AuthDeps } from './deps.service.ts';

export const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const MAX_PAGE = 200;
/** Members named in one request: a client sends larger groups in batches. */
export const MAX_MEMBERS = 10_000;

export interface ScimReply { status: number; body?: string; location?: string }
interface Ctx { organisationId: string; issuer: string; correlationId: string; origin: string }

const scimError = (status: number, scimType: string | undefined, message: string): AppError => {
  const category = status === 400 ? 'validation' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'internal';
  return new AppError(category, message, { code: scimType === undefined ? `scim.${category}` : `scim.${scimType}` });
};
const reply = (status: number, value: unknown, location?: string): ScimReply =>
  ({ status, body: JSON.stringify(value), ...(location === undefined ? {} : { location }) });

const memberRef = z.looseObject({ value: z.string().max(64) });
const groupResource = z.looseObject({
  displayName: z.string().trim().min(1).max(256),
  externalId: z.string().min(1).max(512).optional(),
  members: z.array(memberRef).max(MAX_MEMBERS).optional(),
});
const patchRequest = z.looseObject({
  Operations: z.array(z.looseObject({ op: z.string().regex(/^(add|replace|remove)$/i), path: z.string().max(300).optional(), value: z.unknown().optional() }))
    .min(1).max(100),
});

function parseBody<S extends z.ZodType>(schema: S, body: string | undefined): z.output<S> {
  if (body === undefined) throw scimError(400, 'invalidSyntax', 'a body is required');
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw scimError(400, 'invalidSyntax', 'the body is not JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw scimError(400, 'invalidValue', `the resource is not valid at ${parsed.error.issues[0]?.path.join('.') || 'its root'}`);
  return parsed.data;
}

const idsOf = (members: readonly { value: string }[] | undefined): string[] => {
  const ids = [...new Set((members ?? []).map((m) => m.value.trim()))];
  if (ids.some((id) => !isUuid(id))) throw scimError(400, 'invalidValue', 'a member is named by its user id');
  return ids;
};

const groupView = (group: ScimGroup, members: readonly string[] | undefined, origin: string) => ({
  schemas: [GROUP],
  id: group.id,
  ...(group.externalId === null ? {} : { externalId: group.externalId }),
  displayName: group.displayName,
  ...(members === undefined ? {} : { members: members.map((value) => ({ value, $ref: `${origin}/scim/v2/Users/${value}` })) }),
  meta: { resourceType: 'Group', created: group.createdAt, lastModified: group.updatedAt, location: `${origin}/scim/v2/Groups/${group.id}` },
});

function filterOf(query: URLSearchParams): { id?: string; displayName?: string; externalId?: string } {
  const filter = query.get('filter');
  if (filter === null || filter.trim() === '') return {};
  const match = /^\s*(displayName|externalId|id)\s+eq\s+"((?:[^"\\]|\\.){1,512})"\s*$/i.exec(filter);
  if (!match) throw scimError(400, 'invalidFilter', 'only attr eq "value" on displayName, externalId or id is supported for groups');
  const value = match[2]!.replace(/\\(.)/g, '$1');
  const attribute = match[1]!.toLowerCase();
  if (attribute === 'id') return { id: isUuid(value) ? value : '00000000-0000-7000-8000-000000000000' };
  return attribute === 'externalid' ? { externalId: value } : { displayName: value };
}

const withoutMembers = (query: URLSearchParams): boolean =>
  (query.get('excludedAttributes') ?? '').split(',').some((a) => a.trim().toLowerCase() === 'members');

// ----------------------------------------------------------------------------- reconciling grants

export interface Reconciled { granted: number; revoked: number; refused: number }

/**
 * Brings one member's mapped grants to what their live groups' live mappings say (in the
 * caller's transaction, in the organisation's context). Only an active member is granted.
 */
export async function reconcileGrants(db: Queryable, organisationId: string, membershipId: string): Promise<Reconciled> {
  const membership = await membershipRepo.findById(db, membershipId);
  const desired = membership?.status === 'active' ? await scimGroupMappingRepo.desiredForMembership(db, membershipId) : [];
  const keyOf = (roleId: string, scopeId: string | null) => `${roleId}|${scopeId ?? ''}`;
  const want = new Map<string, (typeof desired)[number]>();
  for (const d of desired) if (!want.has(keyOf(d.roleId, d.scopeId))) want.set(keyOf(d.roleId, d.scopeId), d);
  const live = await roleAssignmentRepo.listForMembership(db, membershipId);
  const out: Reconciled = { granted: 0, revoked: 0, refused: 0 };
  const revoked = new Set<string>();
  for (const a of live.filter((x) => x.scimGroupMappingId !== null)) {
    if (want.has(keyOf(a.roleId, a.onScopeId))) continue;
    // Revoked as its granter, which the revocation rules allow (spec 56.8).
    await roleAssignmentRepo.update(db, a.id, { revokedAt: new Date().toISOString(), revokedBy: a.grantedBy });
    revoked.add(a.id);
    out.revoked += 1;
  }
  const held = new Set(live.filter((a) => !revoked.has(a.id) && a.onConnectionId === null && a.onSiloId === null && a.onViewId === null
    && a.onObjectTypeId === null && a.onAppId === null).map((a) => keyOf(a.roleId, a.onScopeId)));
  for (const [key, d] of want) {
    if (held.has(key)) continue;
    if (await roleAssignmentRepo.grantRefusal(db, organisationId, d.createdBy, d.roleId, d.scopeId) !== null) {
      out.refused += 1;
      continue;
    }
    const actedAt = d.scopeId === null ? null : await roleAssignmentRepo.actingScope(db, organisationId, d.createdBy, d.scopeId);
    await roleAssignmentRepo.insert(db, {
      id: uuidv7(), organisationId, membershipId, roleId: d.roleId, onScopeId: d.scopeId, grantedBy: d.createdBy, grantedAtScopeId: actedAt,
      scimGroupMappingId: d.mappingId,
    });
    out.granted += 1;
  }
  return out;
}

async function reconcileAll(db: Queryable, organisationId: string, membershipIds: Iterable<string>): Promise<Reconciled> {
  const total: Reconciled = { granted: 0, revoked: 0, refused: 0 };
  for (const id of new Set(membershipIds)) {
    const r = await reconcileGrants(db, organisationId, id);
    total.granted += r.granted;
    total.revoked += r.revoked;
    total.refused += r.refused;
  }
  return total;
}

async function changed(db: Queryable, ctx: Ctx, groupId: string, change: string, added: number, removed: number, r: Reconciled): Promise<void> {
  await recordAuthEvent(db, {
    organisationId: ctx.organisationId, correlationId: ctx.correlationId, event: 'scim_group_changed', membershipId: ctx.issuer,
    detail: { group_id: groupId, change, added, removed, granted: r.granted, revoked: r.revoked, refused: r.refused },
  });
}

/** Membership ids must be the organisation's: a foreign key refusal is a bad member reference. */
async function members<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const mapped = isAppError(error) ? error : fromDatabaseError(error);
    if (mapped.details['sqlstate'] === '23503') throw scimError(400, 'invalidValue', 'a member is not a user of this organisation');
    throw error;
  }
}

// ----------------------------------------------------------------------------- the SCIM endpoint

export async function handleGroups(deps: AuthDeps, ctx: Ctx, input: { method: string; segments: string[]; query: URLSearchParams; body?: string | undefined })
  : Promise<ScimReply> {
  const { method, segments } = input;
  if (segments.length === 1 && method === 'GET') return listGroups(deps, ctx, input.query);
  if (segments.length === 1 && method === 'POST') return createGroup(deps, ctx, parseBody(groupResource, input.body));
  if (segments.length === 2 && isUuid(segments[1]!)) {
    const groupId = segments[1]!;
    if (method === 'GET') return getGroup(deps, ctx, groupId, withoutMembers(input.query));
    if (method === 'PUT') return replaceGroup(deps, ctx, groupId, parseBody(groupResource, input.body));
    if (method === 'PATCH') return patchGroup(deps, ctx, groupId, parseBody(patchRequest, input.body));
    if (method === 'DELETE') return deleteGroup(deps, ctx, groupId);
  }
  throw scimError(404, undefined, 'no such group');
}

async function listGroups(deps: AuthDeps, ctx: Ctx, query: URLSearchParams): Promise<ScimReply> {
  const startIndex = Math.max(1, Number.parseInt(query.get('startIndex') ?? '1', 10) || 1);
  const count = Math.min(MAX_PAGE, Math.max(0, Number.parseInt(query.get('count') ?? String(MAX_PAGE), 10) || 0));
  const lean = withoutMembers(query);
  return inTransaction(deps.databases.pool('control'), { organisationId: ctx.organisationId }, async (db) => {
    const { total, groups } = await scimGroupRepo.listLive(db, filterOf(query), startIndex - 1, count);
    const resources = [];
    for (const g of groups) resources.push(groupView(g, lean ? undefined : await scimGroupMemberRepo.membersOf(db, g.id), ctx.origin));
    return reply(200, { schemas: [LIST], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources });
  }, { readOnly: true });
}

async function getGroup(deps: AuthDeps, ctx: Ctx, groupId: string, lean: boolean): Promise<ScimReply> {
  return inTransaction(deps.databases.pool('control'), { organisationId: ctx.organisationId }, async (db) => {
    const group = await scimGroupRepo.findById(db, groupId);
    if (!group || group.deletedAt !== null) throw scimError(404, undefined, 'no such group');
    return reply(200, groupView(group, lean ? undefined : await scimGroupMemberRepo.membersOf(db, groupId), ctx.origin));
  }, { readOnly: true });
}

async function createGroup(deps: AuthDeps, ctx: Ctx, resource: z.output<typeof groupResource>): Promise<ScimReply> {
  const ids = idsOf(resource.members);
  const id = uuidv7();
  return members(() => inTransaction(deps.databases.pool('control'), { organisationId: ctx.organisationId }, async (db) => {
    let group: ScimGroup;
    try {
      group = await scimGroupRepo.insert(db, { id, organisationId: ctx.organisationId, displayName: resource.displayName, externalId: resource.externalId ?? null });
    } catch (error) {
      if (fromDatabaseError(error).category === 'conflict') throw scimError(409, 'uniqueness', 'a group with that externalId exists');
      throw error;
    }
    const added = await scimGroupMemberRepo.add(db, ctx.organisationId, id, ids, ids.map(() => uuidv7()));
    // A new group has no mapping yet: its members gain nothing until an admin maps it.
    await changed(db, ctx, id, 'created', added.length, 0, { granted: 0, revoked: 0, refused: 0 });
    return reply(201, groupView(group, await scimGroupMemberRepo.membersOf(db, id), ctx.origin), `/Groups/${id}`);
  }));
}

async function replaceGroup(deps: AuthDeps, ctx: Ctx, groupId: string, resource: z.output<typeof groupResource>): Promise<ScimReply> {
  const ids = idsOf(resource.members);
  return members(() => inTransaction(deps.databases.pool('control'), { organisationId: ctx.organisationId }, async (db) => {
    const group = await scimGroupRepo.findLiveForUpdate(db, groupId);
    if (!group) throw scimError(404, undefined, 'no such group');
    await scimGroupRepo.update(db, groupId, { displayName: resource.displayName, externalId: resource.externalId ?? null });
    const before = new Set(await scimGroupMemberRepo.membersOf(db, groupId));
    const removed = await scimGroupMemberRepo.removeMembers(db, groupId, [...before].filter((m) => !ids.includes(m)));
    const joining = ids.filter((m) => !before.has(m));
    const added = await scimGroupMemberRepo.add(db, ctx.organisationId, groupId, joining, joining.map(() => uuidv7()));
    const r = await reconcileAll(db, ctx.organisationId, [...added, ...removed]);
    await changed(db, ctx, groupId, 'replaced', added.length, removed.length, r);
    return reply(200, groupView((await scimGroupRepo.findById(db, groupId))!, await scimGroupMemberRepo.membersOf(db, groupId), ctx.origin));
  }));
}

async function patchGroup(deps: AuthDeps, ctx: Ctx, groupId: string, request: z.output<typeof patchRequest>): Promise<ScimReply> {
  return members(() => inTransaction(deps.databases.pool('control'), { organisationId: ctx.organisationId }, async (db) => {
    const group = await scimGroupRepo.findLiveForUpdate(db, groupId);
    if (!group) throw scimError(404, undefined, 'no such group');
    const touched = new Set<string>();
    let added = 0;
    let removed = 0;
    const add = async (ids: string[]) => {
      const done = await scimGroupMemberRepo.add(db, ctx.organisationId, groupId, ids, ids.map(() => uuidv7()));
      done.forEach((m) => touched.add(m));
      added += done.length;
    };
    const remove = async (ids?: string[]) => {
      const done = await scimGroupMemberRepo.removeMembers(db, groupId, ids);
      done.forEach((m) => touched.add(m));
      removed += done.length;
    };
    const attributes = async (value: unknown) => {
      const parsed = z.looseObject({
        displayName: z.string().trim().min(1).max(256).optional(), externalId: z.string().min(1).max(512).nullable().optional(),
        members: z.array(memberRef).max(MAX_MEMBERS).optional(),
      }).safeParse(value);
      if (!parsed.success) throw scimError(400, 'invalidValue', 'the value is not a group\'s attributes');
      const changes: { displayName?: string; externalId?: string | null } = {};
      if (parsed.data.displayName !== undefined) changes.displayName = parsed.data.displayName;
      if (parsed.data.externalId !== undefined) changes.externalId = parsed.data.externalId;
      if (Object.keys(changes).length > 0) await scimGroupRepo.update(db, groupId, changes);
      return parsed.data.members;
    };
    for (const operation of request.Operations) {
      const op = operation.op.toLowerCase();
      const path = operation.path?.trim();
      const filtered = path === undefined ? null : /^members\[\s*value\s+eq\s+"([^"]{1,64})"\s*\]$/i.exec(path);
      if (filtered) {
        if (op !== 'remove') throw scimError(400, 'invalidPath', 'a filtered member path is only removed');
        await remove(idsOf([{ value: filtered[1]! }]));
      } else if (path?.toLowerCase() === 'members') {
        const ids = operation.value === undefined ? undefined : idsOf(z.array(memberRef).max(MAX_MEMBERS).parse(operation.value));
        if (op === 'add') await add(ids ?? []);
        else if (op === 'remove') await remove(ids);
        else {
          const current = new Set(await scimGroupMemberRepo.membersOf(db, groupId));
          const next = ids ?? [];
          await remove([...current].filter((m) => !next.includes(m)));
          await add(next.filter((m) => !current.has(m)));
        }
      } else if (path?.toLowerCase() === 'displayname' || path?.toLowerCase() === 'externalid') {
        if (op === 'remove' && path.toLowerCase() === 'displayname') throw scimError(400, 'mutability', 'a group keeps its displayName');
        const key = path.toLowerCase() === 'displayname' ? 'displayName' : 'externalId';
        await attributes({ [key]: op === 'remove' ? null : operation.value });
      } else if (path === undefined && op !== 'remove') {
        const listed = await attributes(operation.value);
        if (listed !== undefined) {
          const ids = idsOf(listed);
          if (op === 'add') await add(ids);
          else {
            const current = new Set(await scimGroupMemberRepo.membersOf(db, groupId));
            await remove([...current].filter((m) => !ids.includes(m)));
            await add(ids.filter((m) => !current.has(m)));
          }
        }
      } else {
        throw scimError(400, 'invalidPath', 'members, displayName and externalId are the attributes a group changes by');
      }
    }
    const r = await reconcileAll(db, ctx.organisationId, touched);
    await changed(db, ctx, groupId, 'patched', added, removed, r);
    return { status: 204 };
  }));
}

async function deleteGroup(deps: AuthDeps, ctx: Ctx, groupId: string): Promise<ScimReply> {
  return inTransaction(deps.databases.pool('control'), { organisationId: ctx.organisationId }, async (db) => {
    const group = await scimGroupRepo.findLiveForUpdate(db, groupId);
    if (!group) throw scimError(404, undefined, 'no such group');
    const removed = await scimGroupMemberRepo.removeMembers(db, groupId);
    await scimGroupRepo.markDeleted(db, groupId);
    const r = await reconcileAll(db, ctx.organisationId, removed);
    await changed(db, ctx, groupId, 'deleted', 0, removed.length, r);
    return { status: 204 };
  });
}

export const groupResourceType = (origin: string) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP,
  meta: { resourceType: 'ResourceType', location: `${origin}/scim/v2/ResourceTypes/Group` },
});

// ----------------------------------------------------------------------------- mappings (org.sso.manage)

async function demand(deps: AuthDeps, ctx: HandlerContext): Promise<string> {
  const decision = await deps.services.call(authorise, { body: { permission: 'org.sso.manage' } }, { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow' || ctx.request.membershipId === undefined) {
    throw new AppError('forbidden', 'you may not manage provisioning', { code: 'auth.not_permitted' });
  }
  return ctx.request.membershipId;
}

const mappingView = (m: ScimGroupMapping) => ({ id: m.id, groupId: m.groupId, roleId: m.roleId, scopeId: m.scopeId, createdBy: m.createdBy, createdAt: m.createdAt });

/** The groups the identity provider pushed, each with its member count and live mappings. */
export async function listScimGroups(deps: AuthDeps, ctx: HandlerContext) {
  await demand(deps, ctx);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const [groups, mappings] = await Promise.all([scimGroupRepo.listWithCounts(db, 1000), scimGroupMappingRepo.listLive(db)]);
    return {
      groups: groups.map((g) => ({
        id: g.id, displayName: g.displayName, externalId: g.externalId, memberCount: g.memberCount,
        mappings: mappings.filter((m) => m.groupId === g.id).map(mappingView),
      })),
    };
  }, { readOnly: true });
}

/**
 * Maps a group to a role at a scope (null: organisation-wide). Only a role the admin could
 * give there themselves (the delegation rules); its members are granted at once.
 */
export async function createScimGroupMapping(deps: AuthDeps, ctx: HandlerContext, input: { groupId: string; roleId: string; scopeId: string | null }) {
  const membershipId = await demand(deps, ctx);
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const group = await scimGroupRepo.findLiveForUpdate(db, input.groupId);
    if (!group) throw new AppError('not_found', 'no such group', { code: 'scim.group_not_found' });
    const role = await roleRepo.findById(db, input.roleId);
    if (!role || role.retiredAt !== null) throw new AppError('not_found', 'no such role', { code: 'role.not_found' });
    if (input.scopeId !== null && !await scopeRepo.findById(db, input.scopeId)) throw new AppError('not_found', 'no such scope', { code: 'scope.not_found' });
    const existing = await scimGroupMappingRepo.findLiveFor(db, input.groupId, input.roleId, input.scopeId);
    if (existing) return { mapping: mappingView(existing), granted: 0, refused: 0 };
    const refusal = await roleAssignmentRepo.grantRefusal(db, organisationId, membershipId, input.roleId, input.scopeId);
    if (refusal !== null) {
      throw new AppError('forbidden', `you could not give that role there yourself, so you cannot map a group to it: ${refusal}`, { code: 'scim.mapping_refused' });
    }
    const mapping = await scimGroupMappingRepo.insert(db, {
      id: uuidv7(), organisationId, groupId: input.groupId, roleId: input.roleId, scopeId: input.scopeId, createdBy: membershipId,
    });
    const r = await reconcileAll(db, organisationId, await scimGroupMemberRepo.membersOf(db, input.groupId));
    await recordAuthEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'scim_group_mapping_created', membershipId,
      detail: { mapping_id: mapping.id, group_id: input.groupId, role_id: input.roleId, scope_id: input.scopeId ?? 'organisation', granted: r.granted, refused: r.refused },
    });
    return { mapping: mappingView(mapping), granted: r.granted, refused: r.refused };
  });
}

/** Removes a mapping; what only it granted is revoked at once. */
export async function removeScimGroupMapping(deps: AuthDeps, ctx: HandlerContext, mappingId: string): Promise<void> {
  const membershipId = await demand(deps, ctx);
  const organisationId = ctx.request.organisationId!;
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const mapping = await scimGroupMappingRepo.findById(db, mappingId);
    if (!mapping) throw new AppError('not_found', 'no such mapping', { code: 'scim.mapping_not_found' });
    if (!await scimGroupMappingRepo.remove(db, mappingId, membershipId)) return;
    const r = await reconcileAll(db, organisationId, await scimGroupMemberRepo.membersOf(db, mapping.groupId));
    await recordAuthEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'scim_group_mapping_removed', membershipId,
      detail: { mapping_id: mappingId, group_id: mapping.groupId, revoked: r.revoked },
    });
  });
}
