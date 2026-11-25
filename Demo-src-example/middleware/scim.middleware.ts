import type { NextFunction, Request, Response } from 'express';
import * as scim from '../services/scim.service';
import { childLogger } from '../config/logger.config';

const log = childLogger('scim');

/**
 * §1 — turning a provisioning token into a tenant.
 *
 * ── NOT `requireAuth`, AND NOT FOLDED INTO IT ──────────────────────────────
 *
 * A SCIM request has no session, no user and no membership. It is an identity
 * provider posting to an address with a bearer token, exactly like the inbound
 * webhook transports — the credential IS the request's claim to belong to an
 * organisation, and the read that resolves it cannot already be inside one.
 *
 * Folding this into `requireAuth` would mean that middleware growing a branch
 * for a subject with no membership, which is the shape `apiKey.middleware`
 * already exists separately to avoid.
 */
declare module 'express-serve-static-core' {
  interface Request {
    scim?: { organisationId: string; tokenId: string };
  }
}

export async function requireScimToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    scimError(res, 401, 'A bearer token is required.');
    return;
  }

  try {
    req.scim = await scim.authenticate(token);
    next();
  } catch {
    /*
     * ONE ANSWER FOR EVERY WAY IT CAN FAIL. A revoked token, a token for
     * another tenant and a string that was never a token are indistinguishable
     * here on purpose: telling them apart would let somebody with a list of
     * candidates learn which organisations exist.
     */
    log.warn({ component: 'scim' }, 'SCIM token rejected');
    scimError(res, 401, 'That token is not valid.');
  }
}

/**
 * An error a provider can read.
 *
 * SCIM HAS ITS OWN ERROR SHAPE and providers parse it. Returning this
 * product's envelope would make every failure look like a transport problem to
 * Entra and Okta, which is how a misconfiguration becomes an hour on a support
 * call instead of a message on a screen.
 */
export function scimError(res: Response, status: number, detail: string, scimType?: string): void {
  res.status(status).json({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  });
}
