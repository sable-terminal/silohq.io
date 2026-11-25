// auth's endpoints for a person's own memberships and factors, and for API client access
// sessions: parsed input to the services and back.

import type { issueClientSession, resolveClientSession } from '../../contracts/auth/clientSession.contract.ts';
import type { listIdentities, listMfaFactors, removeMfaFactor, unlinkIdentity } from '../../contracts/auth/mfa.contract.ts';
import type { listMyMemberships, readOwnProfile, switchMembership } from '../../contracts/auth/session.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as account from '../../services/auth/account.service.ts';
import * as clients from '../../services/auth/clientSessions.service.ts';
import * as synthetic from '../../services/auth/synthetic.service.ts';
import type { issueSyntheticSession, provisionSyntheticTenant } from '../../contracts/auth/synthetic.contract.ts';
import type { AuthDeps } from '../../services/auth/deps.service.ts';

export function accountController(deps: AuthDeps): {
  readOwnProfile: RouteHandlers<typeof readOwnProfile>;
  listMyMemberships: RouteHandlers<typeof listMyMemberships>;
  switchMembership: RouteHandlers<typeof switchMembership>;
  listMfaFactors: RouteHandlers<typeof listMfaFactors>;
  removeMfaFactor: RouteHandlers<typeof removeMfaFactor>;
  listIdentities: RouteHandlers<typeof listIdentities>;
  unlinkIdentity: RouteHandlers<typeof unlinkIdentity>;
  issueClientSession: RouteHandlers<typeof issueClientSession>;
  resolveClientSession: RouteHandlers<typeof resolveClientSession>;
  provisionSyntheticTenant: RouteHandlers<typeof provisionSyntheticTenant>;
  issueSyntheticSession: RouteHandlers<typeof issueSyntheticSession>;
} {
  return {
    readOwnProfile: { handle: (input) => account.readOwnProfile(deps, input.body.sessionToken) },
    listMyMemberships: { handle: (input) => account.listMyMemberships(deps, input.body.sessionToken) },
    switchMembership: { handle: (input, ctx) => account.switchMembership(deps, input.body, ctx.correlationId) },
    listMfaFactors: { handle: (input) => account.listMfaFactors(deps, input.body.sessionToken) },
    removeMfaFactor: { handle: (input, ctx) => account.removeMfaFactor(deps, input.body.sessionToken, input.body.factorId, ctx.correlationId) },
    listIdentities: { handle: (input) => account.listIdentities(deps, input.body.sessionToken) },
    unlinkIdentity: { handle: (input, ctx) => account.unlinkIdentity(deps, input.body.sessionToken, input.body.identityId, ctx.correlationId) },
    issueClientSession: { handle: (input, ctx) => clients.issueClientSession(deps, input.body, ctx.correlationId) },
    resolveClientSession: { handle: (input) => clients.resolveClientSession(deps, input.body.accessToken, input.body.writes === true) },
    provisionSyntheticTenant: { handle: (_input, ctx) => synthetic.provisionSyntheticTenant(deps, ctx.correlationId) },
    issueSyntheticSession: { handle: (input, ctx) => synthetic.issueSyntheticSession(deps, input.body.member, ctx.correlationId) },
  };
}
