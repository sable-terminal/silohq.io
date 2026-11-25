import { Router } from 'express';
import * as connection from '../controllers/connection.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { credentialLimit, writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/connection.schema';

/**
 * Two routers, because the OAuth callback has a different caller from
 * everything else here: a browser arriving from a provider's consent screen,
 * with no session and no organisation in the request.
 */
export const connectionPublicRouter: Router = Router();

/*
 * RATE LIMITED, because it takes a state token and acts on it. That token is a
 * secret and this is the only place it can be guessed at — and the endpoint
 * cannot require a session to protect itself, because the person following the
 * redirect has just come back from another origin.
 */
connectionPublicRouter.get(
  '/oauth/callback',
  credentialLimit,
  validate({ query: schema.callback }),
  connection.callback,
);

/*
 * WHERE A CUSTOMER'S SYSTEM POSTS. Neither of these can require a session: one
 * is an ERP sending an event and the other a mail provider relaying a forward.
 * The address is the credential — random, and stored only as a hash.
 *
 * RATE LIMITED, because an unauthenticated endpoint that writes is exactly what
 * gets found and hammered, and because the token is guessed at here or nowhere.
 */
connectionPublicRouter.post(
  '/inbound/:token',
  credentialLimit,
  validate({ params: schema.intakeToken, body: schema.webhookBody }),
  connection.receiveWebhook,
);

connectionPublicRouter.post(
  '/inbound/:token/email',
  credentialLimit,
  validate({ params: schema.intakeToken, body: schema.emailBody }),
  connection.receiveEmail,
);

export const connectionRouter: Router = Router();

connectionRouter.use(requireAuth);

/*
 * `connection.create` GUARDS ALL THREE. Inspecting a provider makes this server
 * fetch a URL somebody typed, which is not something an ordinary member should
 * be able to make it do; and the other two configure and authorise a credential.
 */
connectionRouter.get('/', connection.list);

/*
 * READABLE BY ANY MEMBER WHO MAY QUERY. This is the screen that tells somebody a
 * connector exists and is waiting for their credential, so gating it behind
 * `connection.create` would hide it from exactly the people it is for.
 */
connectionRouter.get('/available', requirePermission('query.run'), connection.available);

/*
 * `connection.grant` — the permission that existed and was enforced nowhere
 * until these three routes.
 */
connectionRouter.get(
  '/:id/grants',
  requirePermission('connection.grant'),
  validate({ params: schema.connectionId }),
  connection.listGrants,
);

connectionRouter.get(
  '/:id/reach',
  requirePermission('connection.grant'),
  validate({ params: schema.connectionId }),
  connection.reach,
);

connectionRouter.post(
  '/:id/grants',
  writeLimit,
  requirePermission('connection.grant'),
  validate({ params: schema.connectionId, body: schema.grantConnection }),
  connection.grantConnection,
);

connectionRouter.delete(
  '/:id/grants/:grantId',
  writeLimit,
  requirePermission('connection.grant'),
  validate({ params: schema.grantId }),
  connection.revokeGrant,
);

/*
 * §8 says a halted connection "stays halted until a person looks". This is the
 * person saying they have — without it, self-heal could stop a connection and
 * nothing in the product could start it again.
 */
connectionRouter.post(
  '/:id/resume',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId }),
  connection.resume,
);

connectionRouter.put(
  '/:id/credential-provenance',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId, body: schema.credentialProvenance }),
  connection.recordProvenance,
);

connectionRouter.post(
  '/',
  writeLimit,
  requirePermission('connection.create'),
  validate({ body: schema.createConnection }),
  connection.create,
);

/*
 * `credentialLimit`, NOT `writeLimit`. This endpoint takes a secret, which makes
 * it a place where one can be tried repeatedly rather than an ordinary write.
 */
connectionRouter.put(
  '/:id/credential',
  credentialLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId, body: schema.setCredential }),
  connection.setCredential,
);

/*
 * §7's steps 2, 4 and 5. All three change what a connection is permitted to do,
 * so all three are administrative rather than something a reader can trigger.
 */
/*
 * THE CONNECT FORM, FOR ANY SIGNED-IN MEMBER. A per-user system asks each
 * person for their own credential, so the questions cannot be behind
 * `connection.create`; they name fields, never values.
 */
connectionRouter.get('/forms/:manifestId', validate({ params: schema.manifestId }), connection.connectForm);

connectionRouter.put(
  '/:id/parameters',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId, body: schema.setParameters }),
  connection.setParameters,
);

connectionRouter.post(
  '/:id/confirm',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId }),
  connection.confirm,
);

connectionRouter.post(
  '/:id/verify-writes',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId, body: schema.verifyWrites }),
  connection.verifyWrites,
);

connectionRouter.post(
  '/:id/promote',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId }),
  connection.promote,
);

/*
 * NO `POST /:id/records`. It wrote a record on request — no prior state, no
 * approval, no audit of the write — and every write made through it was
 * unrevertable. Records change through `/mutations` and nowhere else.
 */

/*
 * §8. The weekly pass is driven from OUTSIDE the process — Cloud Run scales to
 * zero, so an in-process interval fires only if an instance happens to be alive.
 * This is what a scheduler calls, and it is also what an administrator presses
 * when they suspect something has moved.
 */
connectionRouter.post(
  '/:id/intake',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId, body: schema.mintIntake }),
  connection.mintIntake,
);

/*
 * DRIVEN FROM OUTSIDE, like the weekly re-check. It reclaims space rather than
 * enforcing retention — reads already exclude expired rows, so a sweep that does
 * not run is a storage problem and not a broken promise.
 *
 * THIS ROUTER IS SESSION-SCOPED, SO THE SWEEP IS TOO. It once ran the cell-wide
 * `sweep_inbound_events()` and handed the caller its total, which counted every
 * other organisation's expired events. A member presses this for their own
 * organisation and is told about their own rows; sweeping the whole cell is an
 * operator's job and has no member-reachable route.
 *
 * NOT UNDER `/inbound`, DELIBERATELY. The public router is mounted first and
 * owns `/inbound/:token`, so a sweep path beneath it would be matched as a
 * token — and would fail validation rather than reaching this handler, which is
 * a confusing way to discover a routing collision.
 */
connectionRouter.post(
  '/maintenance/sweep-inbound',
  writeLimit,
  requirePermission('connection.create'),
  connection.sweepInbound,
);

connectionRouter.post(
  '/recheck',
  writeLimit,
  requirePermission('connection.create'),
  connection.recheckAll,
);

connectionRouter.post(
  '/:id/recheck',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId }),
  connection.recheck,
);

connectionRouter.post(
  '/:id/heal-proposals/:proposalId/decision',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.proposalId, body: schema.decideProposal }),
  connection.decideProposal,
);

/*
 * A RETIREMENT, NOT A DELETE. Probe runs, heal proposals and the audit trail all
 * point at this connection, and answers already given cite the manifest it used.
 */
connectionRouter.post(
  '/:id/retire',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId, body: schema.retire }),
  connection.retire,
);

/*
 * §7's record and the manifest lineage. Both tables have been written since the
 * first probe and neither could be read back, which made "when was this last
 * checked" and "what did version 3 say" questions answerable only with psql.
 */
connectionRouter.get(
  '/:id/probe-runs',
  requirePermission('connection.create'),
  validate({ params: schema.connectionId }),
  connection.probeRuns,
);

connectionRouter.get(
  '/:id/versions',
  requirePermission('connection.create'),
  validate({ params: schema.connectionId }),
  connection.versions,
);

connectionRouter.post(
  '/:id/derive',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId, body: schema.deriveConnector }),
  connection.derive,
);

/*
 * EVERY FIELD THE SYSTEM HOLDS. Publishes a widened version of the connector
 * and moves the connection onto it, so it is guarded like adopting a version.
 */
connectionRouter.post(
  '/:id/fields',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId }),
  connection.readEveryField,
);

connectionRouter.get(
  '/:id/versions/:manifestId/adoption',
  requirePermission('connection.create'),
  validate({ params: schema.connectionVersion }),
  connection.adoption,
);

connectionRouter.post(
  '/:id/versions/:manifestId/adopt',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionVersion, body: schema.adoptVersion }),
  connection.adopt,
);

connectionRouter.get(
  '/:id/heal-proposals',
  requirePermission('connection.create'),
  validate({ params: schema.connectionId }),
  connection.healProposals,
);

connectionRouter.post(
  '/oauth/inspect',
  writeLimit,
  requirePermission('connection.create'),
  validate({ body: schema.issuer }),
  connection.inspect,
);

connectionRouter.post(
  '/:id/oauth/client',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId, body: schema.provisionClient }),
  connection.configureClient,
);

connectionRouter.post(
  '/:id/oauth/start',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.connectionId }),
  connection.start,
);
