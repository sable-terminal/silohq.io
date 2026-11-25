// SCIM 2.0 provisioning (RFC 7643, 7644; spec 55.5; design: iam.scim_tokens,
// iam.memberships.scim_external_id).
//
// A User is a membership of the token's organisation: its id is the membership id, its
// userName the person's address (one user per address in the cell), its externalId the
// provisioning client's own id. What a client can do:
// - create: the person (a new user, SSO-only, when the cell has none with the address) and
//   an active membership, given the organisation's SSO default role (granted as the
//   member who issued the token, under the delegation trigger) when its provider has one;
// - read, list, and filter by userName, externalId, emails.value or id (eq only);
// - replace or patch: active, externalId and the name; the address does not change here;
// - deprovision (active false, or DELETE): in one transaction the membership is suspended,
//   its seat reclaimed (spec 72.3) and every session of it revoked (spec 55.5); setting
//   active true again reinstates it.
// Groups: see scimGroups.service.ts (decision 2026-11-14). A member created here is marked
// SCIM-managed, so their roles change only through mapped groups.

import { groupResourceType, handleGroups } from './scimGroups.service.ts';
import { z } from 'zod';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import {
  identityProviderRepo, membershipRepo, roleAssignmentRepo, scimTokenRepo, scopeMembershipRepo, sessionRepo, userRepo, type ScimProfile,
} from '../../repos/iam/index.repo.ts';
import { seatRepo } from '../../repos/billing/index.repo.ts';
import { tenantMigrationRepo } from '../../repos/platform/tenantMigration.repo.ts';
import { grantAfterAssignment, recordSeatEvent, seatOnJoin } from './seats.service.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import { normaliseEmail } from '../../utils/email.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7, isUuid } from '../../utils/id.util.ts';
import { issueScimToken, parseScimToken } from '../../utils/token.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import type { AuthDeps } from './deps.service.ts';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const MAX_PAGE = 200;

export interface ScimReply { status: number; body?: string; location?: string }

const scimError = (status: number, scimType: string | undefined, message: string): AppError => {
  const category = status === 400 ? 'validation' : status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden'
    : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'internal';
  return new AppError(category, message, { code: scimType === undefined ? `scim.${category}` : `scim.${scimType}` });
};

const reply = (status: number, value: unknown, location?: string): ScimReply =>
  ({ status, body: JSON.stringify(value), ...(location === undefined ? {} : { location }) });

const loose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);
const scimBool = z.union([z.boolean(), z.enum(['true', 'false', 'True', 'False']).transform((v) => v.toLowerCase() === 'true')]);

const userResource = loose({
  userName: z.string().min(3).max(320),
  externalId: z.string().min(1).max(512).optional(),
  name: loose({ givenName: z.string().max(200).optional(), familyName: z.string().max(200).optional() }).optional(),
  emails: z.array(loose({ value: z.string().max(320), primary: scimBool.optional() })).max(10).optional(),
  active: scimBool.default(true),
});
type UserResource = z.output<typeof userResource>;

const patchRequest = loose({
  Operations: z.array(loose({ op: z.string().regex(/^(add|replace|remove)$/i), path: z.string().max(200).optional(), value: z.unknown().optional() }))
    .min(1).max(50),
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

const addressOf = (resource: UserResource): string => {
  const primary = resource.emails?.find((e) => e.primary === true)?.value ?? resource.emails?.[0]?.value ?? resource.userName;
  const address = primary.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) throw scimError(400, 'invalidValue', 'userName or a primary email must be an address');
  return address;
};

const resourceOf = (profile: ScimProfile, origin: string) => ({
  schemas: [USER],
  id: profile.membershipId,
  ...(profile.externalId === null ? {} : { externalId: profile.externalId }),
  userName: profile.email,
  name: { givenName: profile.firstName, familyName: profile.lastName },
  emails: [{ value: profile.email, primary: true }],
  active: profile.status === 'active',
  meta: {
    resourceType: 'User', created: profile.createdAt, lastModified: profile.updatedAt,
    location: `${origin}/scim/v2/Users/${profile.membershipId}`,
  },
});

/** filter=attr eq "value", for the attributes clients look users up by. */
function filterOf(query: URLSearchParams): { membershipId?: string; email?: string; externalId?: string } {
  const filter = query.get('filter');
  if (filter === null || filter.trim() === '') return {};
  const match = /^\s*(userName|externalId|id|emails(?:\.value|\[type eq "work"\]\.value)?)\s+eq\s+"((?:[^"\\]|\\.){1,512})"\s*$/i.exec(filter);
  if (!match) throw scimError(400, 'invalidFilter', 'only attr eq "value" on userName, externalId, emails.value or id is supported');
  const attribute = match[1]!.toLowerCase();
  const value = match[2]!.replace(/\\(.)/g, '$1');
  if (attribute === 'externalid') return { externalId: value };
  if (attribute === 'id') return isUuid(value) ? { membershipId: value } : { membershipId: '00000000-0000-7000-8000-000000000000' };
  return { email: value };
}

export async function handleScim(deps: AuthDeps, input: { token: string; method: string; path: string; query: string; body?: string | undefined },
  correlationId: string): Promise<ScimReply> {
  const parsed = parseScimToken(input.token);
  if (!parsed) throw scimError(401, undefined, 'the bearer token is not valid');
  const organisationId = parsed.organisationId;
  const control = deps.databases.pool('control');
  const token = await inTransaction(control, { organisationId }, (db) => scimTokenRepo.useLive(db, organisationId, parsed.hash));
  if (!token) throw scimError(401, undefined, 'the bearer token is not valid');
  const origin = deps.config.gateway.publicOrigin ?? '';
  const query = new URLSearchParams(input.query);
  const segments = input.path.split('/').filter(Boolean);
  const ctx = { organisationId, issuer: token.createdBy, correlationId, origin };
  // While the organisation moves cell (spec 6.4) nothing is written that its export would leave
  // behind: a change is refused as unavailable, which a provisioning client retries.
  if (input.method !== 'GET' && await inTransaction(control, { organisationId }, (db) => tenantMigrationRepo.writesPaused(db, organisationId), { readOnly: true })) {
    throw new AppError('unavailable', 'the organisation is moving to another Silo cell: provisioning resumes when the move completes', {
      code: 'tenant_migrations.writes_paused', retryable: true,
    });
  }

  if (segments.length === 1 && input.method === 'GET') {
    if (segments[0] === 'ServiceProviderConfig') return reply(200, serviceProviderConfig(origin));
    if (segments[0] === 'ResourceTypes') return reply(200, resourceTypes(origin));
    if (segments[0] === 'Schemas') return reply(200, { schemas: [LIST], totalResults: 0, Resources: [] });
  }
  if (segments[0] === 'Users') {
    if (segments.length === 1 && input.method === 'GET') return listUsers(deps, ctx, query);
    if (segments.length === 1 && input.method === 'POST') return createUser(deps, ctx, parseBody(userResource, input.body));
    if (segments.length === 2 && isUuid(segments[1]!)) {
      const membershipId = segments[1]!;
      if (input.method === 'GET') return reply(200, resourceOf(await profileOf(deps, organisationId, membershipId), origin));
      if (input.method === 'PUT') return replaceUser(deps, ctx, membershipId, parseBody(userResource, input.body));
      if (input.method === 'PATCH') return patchUser(deps, ctx, membershipId, parseBody(patchRequest, input.body));
      if (input.method === 'DELETE') {
        await setActive(deps, ctx, membershipId, false);
        return { status: 204 };
      }
    }
    if (segments.length === 2) throw scimError(404, undefined, 'no such user');
  }
  if (segments[0] === 'Groups') return handleGroups(deps, ctx, { method: input.method, segments, query, body: input.body });
  throw scimError(404, undefined, 'no such endpoint');
}

interface Ctx { organisationId: string; issuer: string; correlationId: string; origin: string }

async function profileOf(deps: AuthDeps, organisationId: string, membershipId: string): Promise<ScimProfile> {
  const { profiles } = await inTransaction(deps.databases.pool('control'), { organisationId }, (db) =>
    membershipRepo.scimProfiles(db, { membershipId }, 0, 1));
  if (!profiles[0]) throw scimError(404, undefined, 'no such user');
  return profiles[0];
}

async function listUsers(deps: AuthDeps, ctx: Ctx, query: URLSearchParams): Promise<ScimReply> {
  const startIndex = Math.max(1, Number.parseInt(query.get('startIndex') ?? '1', 10) || 1);
  const count = Math.min(MAX_PAGE, Math.max(0, Number.parseInt(query.get('count') ?? String(MAX_PAGE), 10) || 0));
  const { total, profiles } = await inTransaction(deps.databases.pool('control'), { organisationId: ctx.organisationId }, (db) =>
    membershipRepo.scimProfiles(db, filterOf(query), startIndex - 1, count));
  return reply(200, {
    schemas: [LIST], totalResults: total, startIndex, itemsPerPage: profiles.length, Resources: profiles.map((p) => resourceOf(p, ctx.origin)),
  });
}

async function createUser(deps: AuthDeps, ctx: Ctx, resource: UserResource): Promise<ScimReply> {
  const control = deps.databases.pool('control');
  const email = addressOf(resource);
  const existing = await inTransaction(control, {}, (db) => userRepo.findForLogin(db, email));
  const userId = existing?.id ?? uuidv7();
  const membershipId = uuidv7();
  const role = (await inTransaction(control, { organisationId: ctx.organisationId }, (db) =>
    identityProviderRepo.listPublic(db, ctx.organisationId))).find((p) => p.active && p.defaultRoleId !== null);
  try {
    await inTransaction(control, { organisationId: ctx.organisationId, userId }, async (db) => {
      if (existing) {
        if (await membershipRepo.findByUserId(db, { userId, organisationId: ctx.organisationId })) {
          throw scimError(409, 'uniqueness', 'that person is already a member');
        }
      } else {
        await userRepo.insert(db, {
          id: userId, email, firstName: resource.name?.givenName?.trim() || email.slice(0, email.indexOf('@')),
          lastName: resource.name?.familyName?.trim() || '-', passwordHash: null, ssoOnly: true,
        });
      }
      const joinedAt = new Date().toISOString();
      await membershipRepo.insert(db, {
        id: membershipId, userId, organisationId: ctx.organisationId, status: resource.active ? 'active' : 'suspended',
        invitedBy: ctx.issuer, invitedAt: joinedAt, joinedAt, scimExternalId: resource.externalId ?? null, scimManaged: true,
        ...(resource.active ? {} : { suspendedAt: joinedAt }),
      });
      if (role?.defaultRoleId) {
        const actedAt = role.defaultScopeId === null ? null : await roleAssignmentRepo.actingScope(db, ctx.organisationId, ctx.issuer, role.defaultScopeId);
        await roleAssignmentRepo.insert(db, {
          id: uuidv7(), organisationId: ctx.organisationId, membershipId, roleId: role.defaultRoleId, onScopeId: role.defaultScopeId,
          grantedBy: ctx.issuer, grantedAtScopeId: actedAt,
        });
        if (role.defaultScopeId !== null) {
          await scopeMembershipRepo.insert(db, {
            id: uuidv7(), organisationId: ctx.organisationId, membershipId, scopeId: role.defaultScopeId, isPrimary: true, addedBy: ctx.issuer,
          });
        }
      }
      await recordAuthEvent(db, {
        organisationId: ctx.organisationId, correlationId: ctx.correlationId, event: 'member_joined', userId, membershipId,
        detail: { method: 'scim', new_account: !existing },
      });
      if (resource.active) {
        await seatOnJoin(db, { organisationId: ctx.organisationId, membershipId }, ctx.correlationId, membershipId, role?.defaultScopeId ?? null);
      }
    });
    if (resource.active) await grantAfterAssignment(deps, ctx.organisationId, membershipId, ctx.correlationId);
  } catch (error) {
    if (error instanceof AppError && error.category === 'conflict' && !error.code.startsWith('scim.')) {
      throw scimError(409, 'uniqueness', 'a member with that externalId exists');
    }
    if (error instanceof AppError && error.details['sqlstate'] === '42501') {
      throw scimError(403, undefined, 'the member who issued this token can no longer give the default role');
    }
    throw error;
  }
  if (!existing) await deps.directory.registerIdentity({ userId, email }, ctx.correlationId);
  const profile = await profileOf(deps, ctx.organisationId, membershipId);
  return reply(201, resourceOf(profile, ctx.origin), `/Users/${membershipId}`);
}

async function updateNames(db: Queryable, userId: string, name: UserResource['name']): Promise<void> {
  const changes: { firstName?: string; lastName?: string } = {};
  if (name?.givenName?.trim()) changes.firstName = name.givenName.trim();
  if (name?.familyName?.trim()) changes.lastName = name.familyName.trim();
  if (Object.keys(changes).length > 0) await userRepo.update(db, userId, changes);
}

async function replaceUser(deps: AuthDeps, ctx: Ctx, membershipId: string, resource: UserResource): Promise<ScimReply> {
  const profile = await profileOf(deps, ctx.organisationId, membershipId);
  if (normaliseEmail(addressOf(resource)) !== normaliseEmail(profile.email)) {
    throw scimError(400, 'mutability', 'the address of a person is not changed by provisioning');
  }
  await inTransaction(deps.databases.pool('control'), { organisationId: ctx.organisationId, userId: profile.userId }, async (db) => {
    await membershipRepo.update(db, membershipId, { scimExternalId: resource.externalId ?? null });
    await updateNames(db, profile.userId, resource.name);
  });
  if ((profile.status === 'active') !== resource.active) await setActive(deps, ctx, membershipId, resource.active);
  return reply(200, resourceOf(await profileOf(deps, ctx.organisationId, membershipId), ctx.origin));
}

async function patchUser(deps: AuthDeps, ctx: Ctx, membershipId: string, patch: z.output<typeof patchRequest>): Promise<ScimReply> {
  const profile = await profileOf(deps, ctx.organisationId, membershipId);
  let active: boolean | undefined;
  let externalId: string | null | undefined;
  const name: { givenName?: string; familyName?: string } = {};
  const apply = (path: string, value: unknown, op: string): void => {
    const key = path.toLowerCase();
    if (key === 'active') {
      const parsed = scimBool.safeParse(value);
      if (!parsed.success) throw scimError(400, 'invalidValue', 'active is a boolean');
      active = parsed.data;
    } else if (key === 'externalid') {
      externalId = op === 'remove' ? null : z.string().min(1).max(512).parse(value);
    } else if (key === 'name.givenname' && typeof value === 'string') {
      name.givenName = value;
    } else if (key === 'name.familyname' && typeof value === 'string') {
      name.familyName = value;
    } else if (key === 'name' && value !== null && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (typeof v['givenName'] === 'string') name.givenName = v['givenName'];
      if (typeof v['familyName'] === 'string') name.familyName = v['familyName'];
    } else if (key === 'username' || key.startsWith('emails')) {
      throw scimError(400, 'mutability', 'the address of a person is not changed by provisioning');
    } else {
      throw scimError(400, 'invalidPath', `${path} cannot be changed here`);
    }
  };
  for (const operation of patch.Operations) {
    const op = operation.op.toLowerCase();
    if (operation.path !== undefined) {
      apply(operation.path, operation.value, op);
    } else if (op !== 'remove' && operation.value !== null && typeof operation.value === 'object') {
      for (const [path, value] of Object.entries(operation.value as Record<string, unknown>)) apply(path, value, op);
    } else {
      throw scimError(400, 'noTarget', 'an operation needs a path or an object value');
    }
  }
  await inTransaction(deps.databases.pool('control'), { organisationId: ctx.organisationId, userId: profile.userId }, async (db) => {
    if (externalId !== undefined) await membershipRepo.update(db, membershipId, { scimExternalId: externalId });
    await updateNames(db, profile.userId, name);
  });
  if (active !== undefined && (profile.status === 'active') !== active) await setActive(deps, ctx, membershipId, active);
  return reply(200, resourceOf(await profileOf(deps, ctx.organisationId, membershipId), ctx.origin));
}

/**
 * Deprovision (spec 55.5): suspend the membership, reclaim its seat (spec 72.3) and revoke
 * every session of it, in one transaction; then drop the sessions' hot copies. Or
 * reinstate a suspended one.
 */
async function setActive(deps: AuthDeps, ctx: Ctx, membershipId: string, active: boolean): Promise<void> {
  const control = deps.databases.pool('control');
  const revoked = await inTransaction(control, { organisationId: ctx.organisationId }, async (db) => {
    const membership = await membershipRepo.findById(db, membershipId);
    if (!membership || membership.status === 'removed') throw scimError(404, undefined, 'no such user');
    const now = new Date().toISOString();
    if (!active) {
      if (membership.status === 'suspended') return [];
      await membershipRepo.update(db, membershipId, { status: 'suspended', suspendedAt: now });
      const seatReclaimed = await seatRepo.reclaimFrom(db, membershipId);
      const sessions = await sessionRepo.revokeForMembership(db, ctx.organisationId, membershipId);
      await recordAuthEvent(db, {
        organisationId: ctx.organisationId, correlationId: ctx.correlationId, event: 'member_suspended', userId: membership.userId, membershipId,
        detail: { method: 'scim', sessions_revoked: sessions.length, seat_reclaimed: seatReclaimed },
      });
      if (seatReclaimed) {
        await recordSeatEvent(db, { organisationId: ctx.organisationId }, ctx.correlationId, {
          event: 'seat_reclaimed', subjectMembershipId: membershipId, detail: { reason: 'suspended', method: 'scim' },
        });
      }
      return sessions;
    }
    if (membership.status === 'active') return [];
    await membershipRepo.update(db, membershipId, { status: 'active', suspendedAt: null, ...(membership.joinedAt === null ? { joinedAt: now } : {}) });
    await recordAuthEvent(db, {
      organisationId: ctx.organisationId, correlationId: ctx.correlationId, event: 'member_reinstated', userId: membership.userId, membershipId,
      detail: { method: 'scim' },
    });
    return [];
  });
  if (revoked.length > 0) {
    await deps.sessions.forget(revoked.map((id) => ({ id, organisationId: ctx.organisationId })), '');
  }
}

function serviceProviderConfig(origin: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: `${origin}/docs/scim`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A token issued in Silo by a super admin', primary: true }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${origin}/scim/v2/ServiceProviderConfig` },
  };
}

function resourceTypes(origin: string) {
  return {
    schemas: [LIST], totalResults: 2, Resources: [{
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER,
      meta: { resourceType: 'ResourceType', location: `${origin}/scim/v2/ResourceTypes/User` },
    }, groupResourceType(origin)],
  };
}


// ----------------------------------------------------------------------------- tokens (org.sso.manage)

async function demand(deps: AuthDeps, ctx: HandlerContext): Promise<string> {
  const decision = await deps.services.call(authorise, { body: { permission: 'org.sso.manage' } }, { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow' || ctx.request.membershipId === undefined) {
    throw new AppError('forbidden', 'you may not manage provisioning', { code: 'auth.not_permitted' });
  }
  return ctx.request.membershipId;
}

export async function issueToken(deps: AuthDeps, ctx: HandlerContext): Promise<{ tokenId: string; token: string; createdAt: string }> {
  const membershipId = await demand(deps, ctx);
  const organisationId = ctx.request.organisationId!;
  const { token, hash } = issueScimToken(organisationId);
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const inserted = await scimTokenRepo.insert(db, { id: uuidv7(), organisationId, tokenHash: hash, createdBy: membershipId });
    await recordAuthEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'scim_token_issued', membershipId, detail: { token_id: inserted.id },
    });
    return inserted;
  });
  return { tokenId: row.id, token, createdAt: row.createdAt };
}

export async function listTokens(deps: AuthDeps, ctx: HandlerContext) {
  await demand(deps, ctx);
  const rows = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => scimTokenRepo.list(db, ctx.request.organisationId!));
  return { tokens: rows.map((r) => ({ tokenId: r.id, createdBy: r.createdBy, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt })) };
}

export async function revokeToken(deps: AuthDeps, ctx: HandlerContext, tokenId: string): Promise<void> {
  const membershipId = await demand(deps, ctx);
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    if (await scimTokenRepo.revoke(db, tokenId)) {
      await recordAuthEvent(db, {
        organisationId: ctx.request.organisationId!, correlationId: ctx.correlationId, event: 'scim_token_revoked', membershipId,
        detail: { token_id: tokenId },
      });
    }
  });
}
