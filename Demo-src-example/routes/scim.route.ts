import { Router } from 'express';
import * as scim from '../controllers/scim.controller';
import { requireScimToken, scimError } from '../middleware/scim.middleware';
import { generalLimit } from '../middleware/rateLimit.middleware';

/**
 * §1 — the address an identity provider posts to.
 *
 * ── EVERY PATH HERE IS OUTSIDE `requireAuth`, AND THAT IS THE POINT ────────
 *
 * The caller is Entra or Okta. It has no session, no user and no membership;
 * what it has is a bearer token the customer generated here and pasted there,
 * and that token is the entire claim to belong to an organisation. The same
 * shape as the inbound webhook transports, and guarded the same way — the
 * credential is checked before anything else runs.
 *
 * `/scim/v2` BECAUSE THE STANDARD SAYS SO. Providers are configured with a base
 * URL and append the rest themselves; a different prefix is a support ticket
 * for every customer who onboards.
 */
export const scimRouter: Router = Router();

scimRouter.use(generalLimit);
scimRouter.use(requireScimToken);

/*
 * ── WHAT A PROVIDER FETCHES BEFORE IT DOES ANYTHING ──────────────────────
 *
 * Entra and Okta both read these during setup. A 404 here is a directory that
 * cannot be connected AT ALL — the failure lands before provisioning is
 * attempted, in somebody else's interface, as an error with nothing to act on.
 */
scimRouter.get('/ServiceProviderConfig', scim.serviceProviderConfig);
scimRouter.get('/ResourceTypes', scim.resourceTypes);
scimRouter.get('/Schemas', scim.schemas);

/*
 * USERS. `POST` is somebody joining and `PATCH`/`DELETE` are somebody leaving,
 * which is the half an enterprise is actually buying: an offboarding that does
 * not depend on anybody in Silo remembering.
 */
/* READ BEFORE WRITE. A provider looks somebody up by `userName` before creating
   them, so that a second sync does not make a second account. */
scimRouter.get('/Users', scim.listUsers);
scimRouter.get('/Users/:id', scim.getUser);
scimRouter.post('/Users', scim.createUser);
scimRouter.patch('/Users/:id', scim.patchUser);
scimRouter.put('/Users/:id', scim.patchUser);
scimRouter.delete('/Users/:id', scim.deleteUser);

/*
 * GROUPS. The provider says who is in one; what being in one CARRIES was
 * declared by an administrator and checked against the six delegation rules at
 * that moment. Nothing on this router makes an authority decision.
 */
scimRouter.get('/Groups', scim.listGroups);
scimRouter.get('/Groups/:id', scim.getGroup);
scimRouter.post('/Groups', scim.createGroup);
scimRouter.patch('/Groups/:id', scim.patchGroup);
scimRouter.put('/Groups/:id', scim.patchGroup);
scimRouter.delete('/Groups/:id', scim.deleteGroup);

/*
 * ANYTHING ELSE UNDER /scim/v2 ANSWERS IN SCIM'S OWN SHAPE.
 *
 * The application's 404 is a different document, and a provider parsing it sees
 * a transport fault rather than "no such endpoint" — which is how an unsupported
 * call becomes an hour on a support line instead of a line in a log.
 */
scimRouter.use((req, res) => {
  scimError(res, 404, `${req.method} ${req.path} is not a SCIM endpoint this server implements.`);
});
