// The policy decision endpoints: contracts to the decision point.

import type { authorise, declassificationDecision, listHeldPermissions, listMyPermissions, listPermittedScopes, readMarkingBanner, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { permissionRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { actorOf, AUDITED_DENIALS, recordCeilingRefusal, recordDenial, type AdminDeps } from '../../services/policy/deps.service.ts';
import * as governance from '../../services/policy/governance.service.ts';

export function decisionController(deps: AdminDeps): {
  authorise: RouteHandlers<typeof authorise>;
  listHeldPermissions: RouteHandlers<typeof listHeldPermissions>;
  listPermittedScopes: RouteHandlers<typeof listPermittedScopes>;
  listMyPermissions: RouteHandlers<typeof listMyPermissions>;
  resolveAccess: RouteHandlers<typeof resolveAccess>;
  declassificationDecision: RouteHandlers<typeof declassificationDecision>;
  readMarkingBanner: RouteHandlers<typeof readMarkingBanner>;
} {
  return {
    authorise: {
      async handle(input, ctx) {
        const actor = actorOf(ctx);
        const reason = await deps.policy.decide({
          actor, permission: input.body.permission, scopeId: input.body.scopeId, resource: input.body.resource,
          organisationWide: input.body.organisationWide === true, purposeSessionIds: input.body.purposeSessionIds,
        });
        if (reason !== 'allowed') {
          ctx.logger.debug('authorisation denied', { event: 'authorisation.denied', reason });
          // spec 57.11: authorisation_denied, for refusals that are authorisation decisions.
          if (AUDITED_DENIALS.has(reason)) {
            await recordDenial(deps, actor, ctx.correlationId, { permission: input.body.permission, reason }, input.body.resource, input.body.scopeId);
          }
          // spec 52.8: every attempt by an AI FDE principal outside its ceiling, read first.
          if (actor.servicePrincipalId !== undefined && (reason === 'not_granted' || reason === 'principal_never_authorises')) {
            await recordCeilingRefusal(deps, actor, ctx.correlationId, { permission: input.body.permission, reason });
          }
        }
        return { decision: reason === 'allowed' ? 'allow' as const : 'deny' as const, reason };
      },
    },
    listHeldPermissions: {
      async handle(input, ctx) {
        // One resolution of the member for every permission asked about.
        const resolved = await deps.policy.resolve(actorOf(ctx));
        if (resolved.reason !== 'allowed') return { held: [] };
        const held: string[] = [];
        for (const permission of new Set(input.body.permissions)) {
          if (await deps.policy.decideFor(resolved.subject, { permission }) === 'allowed') held.push(permission);
        }
        return { held };
      },
    },
    listMyPermissions: {
      async handle(_input, ctx) {
        const resolved = await deps.policy.resolve(actorOf(ctx));
        const held = resolved.reason === 'allowed' ? await deps.policy.heldAnywhere(resolved.subject) : new Set<string>();
        const described = await inTransaction(deps.databases.pool('control'), {}, (db) => permissionRepo.listDescribed(db), { readOnly: true });
        return { permissions: described.map((p) => ({ id: p.id, description: p.description, held: held.has(p.id) })) };
      },
    },
    listPermittedScopes: {
      async handle(input, ctx) {
        const resolved = await deps.policy.resolve(actorOf(ctx));
        if (resolved.reason !== 'allowed') return { scopes: [] };
        const scopes = await deps.policy.scopesFor(resolved.subject, input.body.permission);
        return { scopes: scopes.map((s) => ({ id: s.id, name: s.name, parentScopeId: s.parentScopeId, depth: s.depth })) };
      },
    },
    resolveAccess: {
      async handle(input, ctx) {
        const { asMembershipId, ...body } = input.body;
        if (asMembershipId !== undefined && ctx.caller !== 'recognition') {
          throw new AppError('forbidden', 'only recognition asks for a member who is not present', { code: 'policy.as_member_refused' });
        }
        const actor = asMembershipId === undefined ? actorOf(ctx) : { organisationId: ctx.request.organisationId!, membershipId: asMembershipId, sessionId: undefined };
        const result = await deps.policy.access({ actor, ...body, sessionless: asMembershipId !== undefined });
        return { decision: result.reason === 'allowed' ? 'allow' as const : 'deny' as const, ...result };
      },
    },
    readMarkingBanner: {
      handle: ({ body }, ctx) => governance.markingBanner(deps, ctx, body),
    },
    declassificationDecision: {
      async handle(input, ctx) {
        const reason = await governance.declassificationDecision(deps, ctx, input.body);
        return { decision: reason === 'allowed' ? 'allow' as const : 'deny' as const, reason };
      },
    },
  };
}
