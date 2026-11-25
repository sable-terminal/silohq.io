// What a service checks before it serves admin-portal on a tenant (spec 13.3): the request
// carries a break-glass session that is running now, on this organisation, at a level that
// covers what is asked. admin-portal has already checked that the person is the session's
// requester and counted the request; this is the serving side's own check, so a request
// without a running session is refused whoever sends it.

import { levelCovers, type AccessLevel } from '../../contracts/admin-portal/capability.contract.ts';
import type { RequestContext, Queryable } from '../../infra/postgres.infra.ts';
import type { OperatorAccessSession } from '../../models/platform/operatorAccessSession.model.ts';
import { operatorAccessSessionRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';

export async function requireOperatorSession(db: Queryable, request: RequestContext, level: AccessLevel): Promise<OperatorAccessSession> {
  const id = request.operatorSessionId;
  const session = id === undefined || request.organisationId === undefined ? undefined
    : await operatorAccessSessionRepo.findLive(db, id, request.organisationId);
  if (session === undefined || !levelCovers(session.accessLevel, level)) {
    throw new AppError('forbidden', `Silo staff reach this only under a running break-glass session at ${level} or above`, {
      code: 'operator_access.session_required', details: { level },
    });
  }
  return session;
}
