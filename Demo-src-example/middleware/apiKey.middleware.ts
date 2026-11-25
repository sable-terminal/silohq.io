import type { NextFunction, Request, Response } from 'express';
import * as principalService from '../services/principal.service';
import { tokenFrom } from './authenticate.middleware';
import { unauthenticated } from '../utils/error.util';
import { runWithTenant } from '../utils/tenantContext.util';

/**
 * Authenticating a machine.
 *
 * SEPARATE FROM `requireAuth`, NOT FOLDED INTO IT. A principal has no user, no
 * session and no membership, so a shared middleware would have to leave three
 * fields empty on a shape everything downstream assumes is populated — and the
 * first handler to read `req.auth.membership.id` would attribute an
 * automation's action to whichever person happened to create the key.
 *
 * THE TENANT COMES FROM THE KEY. There is no organisation picker for a script:
 * the credential itself says which organisation it acts in, which is why it is
 * scoped to exactly one and cannot be switched.
 */
export async function requireApiKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = tokenFrom(req);

  if (!token || !principalService.looksLikeApiKey(token)) {
    next(
      unauthenticated({
        message: 'This endpoint needs an API key.',
        code: 'unauthenticated.api_key_required',
      }),
    );
    return;
  }

  const principal = await principalService.authenticateKey(token);
  if (!principal) {
    /*
     * ONE ANSWER FOR UNKNOWN, EXPIRED, REVOKED AND DISABLED. Telling them apart
     * tells whoever holds a stolen key whether it was ever real, and which
     * thing to try next.
     */
    next(
      unauthenticated({
        message: 'That API key is not usable.',
        code: 'unauthenticated.api_key',
      }),
    );
    return;
  }

  req.principal = principal;
  req.authority = principal.authority;

  runWithTenant({ organisationId: principal.organisationId }, async () => {
    next();
  }).catch((error: unknown) => {
    req.log.error({ err: error }, 'Tenant scope failed for an API key');
  });
}
