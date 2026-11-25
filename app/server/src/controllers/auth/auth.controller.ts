// The auth endpoints: contracts to the auth services. Nothing here decides anything.

import type { acceptInvitation, createInvitation } from '../../contracts/auth/invitation.contract.ts';
import type { confirmTotpEnrolment, startTotpEnrolment, verifyMfa } from '../../contracts/auth/mfa.contract.ts';
import type { requestPasswordReset, resetPassword } from '../../contracts/auth/password.contract.ts';
import type { login, resolveSession, revokeSession } from '../../contracts/auth/session.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { AuthDeps } from '../../services/auth/deps.service.ts';
import * as invitations from '../../services/auth/invitations.service.ts';
import { login as loginService } from '../../services/auth/login.service.ts';
import * as mfa from '../../services/auth/mfa.service.ts';
import * as resets from '../../services/auth/passwordReset.service.ts';

export function authController(deps: AuthDeps): {
  login: RouteHandlers<typeof login>;
  resolveSession: RouteHandlers<typeof resolveSession>;
  revokeSession: RouteHandlers<typeof revokeSession>;
  verifyMfa: RouteHandlers<typeof verifyMfa>;
  startTotpEnrolment: RouteHandlers<typeof startTotpEnrolment>;
  confirmTotpEnrolment: RouteHandlers<typeof confirmTotpEnrolment>;
  requestPasswordReset: RouteHandlers<typeof requestPasswordReset>;
  resetPassword: RouteHandlers<typeof resetPassword>;
  createInvitation: RouteHandlers<typeof createInvitation>;
  acceptInvitation: RouteHandlers<typeof acceptInvitation>;
} {
  return {
    login: { handle: (input, ctx) => loginService(deps, input.body, ctx.correlationId) },
    resolveSession: { handle: (input) => deps.sessions.resolve(input.body.sessionToken, input.body.activity, input.body.writes === true) },
    revokeSession: {
      async handle(input) {
        await deps.sessions.revoke(input.body.sessionToken);
        return undefined;
      },
    },
    verifyMfa: { handle: (input, ctx) => mfa.verifyMfa(deps, input.body.sessionToken, input.body.code, ctx.correlationId) },
    startTotpEnrolment: { handle: (input, ctx) => mfa.startTotpEnrolment(deps, input.body.sessionToken, ctx.correlationId) },
    confirmTotpEnrolment: {
      handle: (input, ctx) => mfa.confirmTotpEnrolment(deps, input.body.sessionToken, input.body.factorId, input.body.code, ctx.correlationId),
    },
    requestPasswordReset: {
      async handle(input, ctx) {
        await resets.requestPasswordReset(deps, input.body, ctx.correlationId);
        return { accepted: true as const };
      },
    },
    resetPassword: {
      async handle(input, ctx) {
        await resets.resetPassword(deps, input.body, ctx.correlationId);
        return undefined;
      },
    },
    createInvitation: {
      handle: (input, ctx) => invitations.createInvitation(deps, ctx, input.body),
      resultRef: (output) => output.invitationId,
      replay: (invitationId, ctx) => invitations.readInvitation(deps, ctx, invitationId!),
    },
    acceptInvitation: { handle: (input, ctx) => invitations.acceptInvitation(deps, input.body, ctx.correlationId) },
  };
}
