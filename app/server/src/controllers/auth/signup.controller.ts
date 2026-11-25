// auth's self-serve sign-up endpoints (decision 2026-11-14): parsed input to the service.

import type { completeSignup, startSignup } from '../../contracts/auth/signup.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { AuthDeps } from '../../services/auth/deps.service.ts';
import * as signup from '../../services/auth/signup.service.ts';

export function signupController(deps: AuthDeps): {
  startSignup: RouteHandlers<typeof startSignup>;
  completeSignup: RouteHandlers<typeof completeSignup>;
} {
  return {
    startSignup: { handle: (input, ctx) => signup.startSignup(deps, input.body, ctx.correlationId) },
    completeSignup: { handle: (input, ctx) => signup.completeSignup(deps, input.body, ctx.correlationId) },
  };
}
