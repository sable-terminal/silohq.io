// The auth service's WebAuthn and password-change endpoints: contracts to services/auth/webauthn.

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type {
  changePassword, confirmWebauthnRegistration, startWebauthnAssertion, startWebauthnRegistration, verifyWebauthnAssertion,
} from '../../contracts/auth/webauthn.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { AuthDeps } from '../../services/auth/deps.service.ts';
import * as webauthn from '../../services/auth/webauthn.service.ts';

export function webauthnController(deps: AuthDeps): {
  startWebauthnRegistration: RouteHandlers<typeof startWebauthnRegistration>;
  confirmWebauthnRegistration: RouteHandlers<typeof confirmWebauthnRegistration>;
  startWebauthnAssertion: RouteHandlers<typeof startWebauthnAssertion>;
  verifyWebauthnAssertion: RouteHandlers<typeof verifyWebauthnAssertion>;
  changePassword: RouteHandlers<typeof changePassword>;
} {
  return {
    startWebauthnRegistration: { handle: (input) => webauthn.startRegistration(deps, input.body.sessionToken) },
    confirmWebauthnRegistration: {
      handle: (input, ctx) => webauthn.confirmRegistration(deps, input.body.sessionToken, input.body.response as unknown as RegistrationResponseJSON,
        ctx.correlationId),
    },
    startWebauthnAssertion: { handle: (input) => webauthn.startAssertion(deps, input.body.sessionToken) },
    verifyWebauthnAssertion: {
      handle: (input, ctx) => webauthn.verifyAssertion(deps, input.body.sessionToken, input.body.response as unknown as AuthenticationResponseJSON,
        ctx.correlationId),
    },
    changePassword: { handle: (input, ctx) => webauthn.changePassword(deps, ctx, input.body) },
  };
}
