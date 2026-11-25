// Nothing in a scenario branch reaches a source (spec 39.8, binding rule). A branch's state
// is computed by simulation from current state and never stored; a staged Action has no
// execution path. As a second line behind the call graph (which the architecture test
// checks), the executor and connect-runtime refuse any request that names a branch: the
// branch header, or a body naming a branch or a staged Action.

import type { RequestHandler } from 'express';
import type { ServiceName } from '../config/service.config.ts';
import { SCENARIO_BRANCH_HEADER, type AnyContract } from '../contracts/endpoint.contract.ts';
import { AppError } from '../utils/errors.util.ts';

/** The services that read and write sources. */
export const BRANCH_REFUSING_SERVICES: readonly ServiceName[] = ['executor', 'connect-runtime'];

/** Body fields that name a branch or what is staged in one. */
const BRANCH_FIELDS = ['scenarioBranchId', 'stagedActionId', 'promotion'] as const;

export function refuseBranchReference(contract: AnyContract): RequestHandler {
  const applies = BRANCH_REFUSING_SERVICES.includes(contract.service);
  return (req, _res, next) => {
    if (applies) {
      const body: unknown = req.body;
      const named = req.headers[SCENARIO_BRANCH_HEADER] !== undefined
        || (body !== null && typeof body === 'object' && !Array.isArray(body) && BRANCH_FIELDS.some((f) => f in (body as Record<string, unknown>)));
      if (named) {
        throw new AppError('forbidden', 'a scenario branch never reaches a source: its state is computed, and a staged Action has no execution path',
          { code: 'branch.not_executable' });
      }
    }
    next();
  };
}
