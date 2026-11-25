import { Router } from 'express';
import { z } from 'zod';
import { authRouter } from './auth.route';
import { invitationRouter, memberRouter } from './member.route';
import { scopeRouter } from './scope.route';
import { markingRouter, roleRouter } from './role.route';
import { auditRouter } from './audit.route';
import { compileRouter } from './compile.route';
import { organisationRouter } from './organisation.route';
import { scimRouter } from './scim.route';
import { authorityRouter } from './authority.route';
import { seatRouter } from './seat.route';
import { principalRouter } from './principal.route';
import { ssoAdminRouter, ssoPublicRouter } from './sso.route';
import { connectionPublicRouter, connectionRouter } from './connection.route';
import { connectorRouter } from './connector.route';
import { queryRouter } from './query.route';
import { automationRouter } from './automation.route';
import { fileRouter } from './file.route';
import { savedViewRouter } from './savedView.route';
import { searchRouter } from './search.route';
import { dashboardRouter } from './dashboard.route';
import { conversationRouter } from './conversation.route';
import { notificationRouter } from './notification.route';
import { ticketRouter } from './ticket.route';
import { dependencyGraphRouter } from './dependencyGraph.route';
import { simulationRouter } from './simulation.route';
import { conceptRouter } from './concept.route';
import { terminologyRouter } from './terminology.route';
import { resolutionRouter } from './resolution.route';
import { detectorRouter } from './detector.route';
import { associationRouter } from './association.route';
import { rankingRouter } from './ranking.route';
import { mapRouter } from './map.route';
import { renderRouter } from './render.route';
import { discoveryRouter } from './discovery.route';
import { siloRouter } from './silo.route';
import { approvalRouter } from './approval.route';
import { mutationRouter } from './mutation.route';
import { billingRouter } from './billing.route';
import { fieldPolicyRouter } from './fieldPolicy.route';
import { localUploadRouter, siloImportRouter } from './siloImport.route';
import { agentPublicRouter, agentRouter } from './agent.route';
import * as objectStore from '../infra/objectStore.infra';
import { env } from '../config/env.config';
import * as member from '../controllers/member.controller';
import { validate } from '../middleware/validate.middleware';
import { credentialLimit } from '../middleware/rateLimit.middleware';
import { requireHuman } from '../middleware/turnstile.middleware';
import * as memberSchema from '../schemas/member.schema';

/**
 * The whole HTTP surface, in one file.
 *
 * MOUNTED HERE SO THE SURFACE IS COUNTABLE. A reviewer asking "what can be
 * reached without a session" should be able to answer it by reading one screen
 * rather than by grepping for `requireAuth` and trusting that every file that
 * omits it meant to. The unauthenticated routes are the ones below and the ones
 * at the top of `auth.route`, and there are no others.
 */

export const apiRouter: Router = Router();

/**
 * The invitation endpoints an invitee reaches before they are anybody.
 *
 * THEY CANNOT REQUIRE A SESSION — the person following the link has no account
 * yet, or has one in a different organisation. They cannot set tenant context
 * either, for the same reason, so both go through the `SECURITY DEFINER`
 * functions in `002_auth.sql`: `invitation_by_token` and `claim_invitation`.
 *
 * THOSE TWO FUNCTIONS ARE THE ONLY DELIBERATE HOLE IN ROW LEVEL SECURITY IN THE
 * WHOLE SCHEMA, so they are narrow by construction — each takes a token, returns
 * or touches exactly one row, and pins its `search_path` so a shadowed table
 * cannot be substituted. Rate limited because the token is a secret and this is
 * where it is guessed at.
 */
apiRouter.get(
  '/invitations/preview',
  credentialLimit,
  validate({ query: z.object({ token: z.string().min(20).max(500) }).strict() }),
  member.previewInvitation,
);

apiRouter.post(
  '/invitations/accept',
  credentialLimit,
  requireHuman('accept-invitation'),
  validate({ body: memberSchema.acceptInvitation }),
  member.acceptInvitation,
);

/**
 * SSO's two public endpoints.
 *
 * NEITHER CAN REQUIRE A SESSION — starting a sign-in is what somebody does
 * instead of having one, and the callback is a navigation from the customer's
 * own directory. Both are rate limited, and neither reveals whether a person
 * has an account: the lookup is by DOMAIN, so an address at a configured domain
 * gets the same answer whether or not anybody by that name exists.
 */
apiRouter.use('/sso', ssoPublicRouter);

/**
 * The connector OAuth callback, which cannot require a session either.
 *
 * IT IS A NAVIGATION BACK FROM A PROVIDER'S CONSENT SCREEN, arriving on a fresh
 * cross-origin redirect, so there is no session to read and no organisation in
 * the request. The state token carries both, and it is consumed in one statement
 * before anything else happens, so a replayed callback finds nothing.
 */
apiRouter.use('/connections', connectionPublicRouter);

/** An agent exchanging its one-time enrolment token: it has no session and never will. */
apiRouter.use('/agents', agentPublicRouter);

/**
 * The local object store's upload endpoint, which cannot require a session for
 * the same reason a signed URL does not: the token IS the credential, bound to
 * one key and one content type for fifteen minutes. Present only in a build
 * with storage, outside production with no bucket, where it stands in for Cloud
 * Storage — a build without storage has no import to upload to.
 */
if (env.SILOES_AVAILABLE && objectStore.isLocal()) {
  apiRouter.use('/silo-uploads', localUploadRouter);
}

/* ── Everything below requires a session ────────────────────────────────── */

apiRouter.use('/auth', authRouter);
apiRouter.use('/members', memberRouter);
apiRouter.use('/invitations', invitationRouter);
apiRouter.use('/scopes', scopeRouter);
apiRouter.use('/roles', roleRouter);
apiRouter.use('/markings', markingRouter);
apiRouter.use('/seats', seatRouter);
apiRouter.use('/audit', auditRouter);
apiRouter.use('/principals', principalRouter);
apiRouter.use('/identity-providers', ssoAdminRouter);
apiRouter.use('/connections', connectionRouter);
apiRouter.use('/connectors', connectorRouter);
apiRouter.use('/agents', agentRouter);
apiRouter.use('/query', queryRouter);

/*
 * Finding a thing by its name, from anywhere in the app.
 *
 * NO PERMISSION IN FRONT OF IT, AND THAT IS THE POINT — each kind it returns is
 * scoped by the same rule as the list it links to, in `search.service`.
 */
apiRouter.use('/search', searchRouter);

/* §7 — questions kept, and asked again for nothing. */
apiRouter.use('/views', savedViewRouter);

/* Rendering §8 — named grids of those questions, re-run when opened. */
apiRouter.use('/dashboards', dashboardRouter);

/* §2.2 — the thread itself: the words, kept, and never the answer's data. */
apiRouter.use('/conversations', conversationRouter);

/* The bell: what happened that this person did not do. */
apiRouter.use('/notifications', notificationRouter);

/*
 * Asking for help, which used to be impossible.
 *
 * NO PERMISSION IN FRONT OF IT, DELIBERATELY. A role that could not raise a
 * support ticket would mean somebody watching the product fail with no way to
 * say so — see `ticket.route`.
 */
apiRouter.use('/support', ticketRouter);

/* Automations §2.4 — "crons" to the people who configure them. */
apiRouter.use('/crons', automationRouter);

/* Simulation §2 — what waits on what, proposed and confirmed. */
apiRouter.use('/graph', dependencyGraphRouter);

/* Simulation §3 and §5 — a stated failure, and the records it reaches. */
apiRouter.use('/simulation', simulationRouter);

/* Files §1 — what Silo produced, and later what a customer uploaded. */
apiRouter.use('/files', fileRouter);
apiRouter.use('/ask', compileRouter);
apiRouter.use('/organisation', organisationRouter);
/* The subscription, its seats and what they entitle. Every build has billing. */
apiRouter.use('/billing', billingRouter);
/*
 * §1 — SCIM. MOUNTED OUTSIDE `requireAuth` because its caller is an identity
 * provider with a bearer token and no session — the same shape as the inbound
 * webhook transports. `/scim/v2` is the path the standard names, and providers
 * append the rest themselves.
 */
apiRouter.use('/scim/v2', scimRouter);
apiRouter.use('/concepts', conceptRouter);

/* §12 — what this organisation, and this person, call those concepts. */
apiRouter.use('/terminology', terminologyRouter);
apiRouter.use('/authorities', authorityRouter);
apiRouter.use('/resolutions', resolutionRouter);
apiRouter.use('/findings', detectorRouter);
apiRouter.use('/associations', associationRouter);
apiRouter.use('/rankings', rankingRouter);
apiRouter.use('/maps', mapRouter);
apiRouter.use('/renders', renderRouter);
/*
 * The approval chain. Mounted in every build: whether an action needs a second
 * person is a rule about the organisation, and the service refuses a policy for
 * an action the build does not have.
 */
apiRouter.use('/approvals', approvalRouter);
/*
 * Mutations. Mounted in every build: a write to a connected system is not
 * storage, and what it keeps to make the write revertable is bounded by the
 * schema rather than by the storage switch.
 */
apiRouter.use('/mutations', mutationRouter);
/* Which fields each person may see: enforced wherever a query or a change is planned. */
apiRouter.use('/field-policies', fieldPolicyRouter);

/**
 * §9 — mounted only where the build includes it.
 *
 * "OFF MEANS UNREACHABLE, NOT IDLE." A sovereign build does not have these paths
 * at all, so they 404 like any other unknown URL rather than existing and
 * refusing — which is a different statement to make to somebody probing the API.
 */
if (env.DISCOVERY_AVAILABLE) {
  apiRouter.use('/discovery', discoveryRouter);
}

/**
 * SS10 -- Siloes, mounted only where the build includes them.
 *
 * SAME REASON AS DISCOVERY, AND MORE SHARPLY. A sovereign deployment's promise
 * is that the storage code is not there -- so the paths are not there either.
 * A build that exposed these and refused would be saying "this exists and you
 * may not use it", which is a different sentence, and the wrong one.
 */
if (env.SILOES_AVAILABLE) {
  apiRouter.use('/siloes', siloRouter);
  /* Import shares the prefix, the gate and the disclosure. */
  apiRouter.use('/siloes', siloImportRouter);
}
