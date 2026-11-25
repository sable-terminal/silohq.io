import { Router } from 'express';
import * as sso from '../controllers/sso.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { credentialLimit, writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/sso.schema';
import * as scim from '../controllers/scim.controller';
import * as scimSchema from '../schemas/scim.schema';

/**
 * The two halves of SSO sit on different routers because they have different
 * callers: a browser that is not signed in, and an administrator who is.
 */
export const ssoPublicRouter: Router = Router();

/*
 * RATE LIMITED, because it takes an address and tells you whether a directory
 * exists for its domain. That is a much smaller disclosure than an account
 * oracle — it is per-domain, not per-person — but it is still a list somebody
 * could enumerate into "which companies use Silo".
 */
ssoPublicRouter.post(
  '/start',
  credentialLimit,
  validate({ body: schema.begin }),
  sso.begin,
);

ssoPublicRouter.get('/callback', credentialLimit, validate({ query: schema.callback }), sso.callback);

export const ssoAdminRouter: Router = Router();

ssoAdminRouter.use(requireAuth);

ssoAdminRouter.get('/', requirePermission('sso.manage'), sso.listProviders);

ssoAdminRouter.post(
  '/',
  writeLimit,
  requirePermission('sso.manage'),
  validate({ body: schema.configure }),
  sso.configure,
);

/*
 * §1 — SCIM, which is the other half of connecting a directory.
 *
 * ON THE SSO ADMIN ROUTER because it is the same decision and the same person:
 * somebody trusted to configure the identity provider is necessarily trusted to
 * decide what that provider may push. A separate permission would be a second
 * answer to a question `sso.manage` already answers.
 *
 * THE PROVISIONING ENDPOINTS THEMSELVES ARE NOT HERE — they are on `/scim/v2`,
 * outside `requireAuth`, because their caller has no session.
 */
ssoAdminRouter.get('/scim/tokens', requirePermission('sso.manage'), scim.listTokens);

ssoAdminRouter.post(
  '/scim/tokens',
  writeLimit,
  requirePermission('sso.manage'),
  validate({ body: scimSchema.issueToken }),
  scim.issueToken,
);

ssoAdminRouter.delete(
  '/scim/tokens/:id',
  writeLimit,
  requirePermission('sso.manage'),
  validate({ params: scimSchema.tokenParams }),
  scim.revokeToken,
);

/*
 * WHAT A DIRECTORY GROUP CARRIES. The six delegation rules run inside the
 * service, against the person declaring it — `sso.manage` gets them to the
 * door and does not decide whether they may grant this particular role here.
 */
ssoAdminRouter.post(
  '/scim/group-grants',
  writeLimit,
  requirePermission('sso.manage'),
  validate({ body: scimSchema.declareGroupGrant }),
  scim.declareGroupGrant,
);

ssoAdminRouter.delete(
  '/scim/group-grants/:id',
  writeLimit,
  requirePermission('sso.manage'),
  validate({ params: scimSchema.grantParams }),
  scim.withdrawGroupGrant,
);
