import { Router } from 'express';
import * as connector from '../controllers/connector.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { credentialLimit, writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/connection.schema';

/**
 * Route 3 — building a connector.
 *
 * ALL OF IT BEHIND `connection.create`, INCLUDING THE READS. A draft holds
 * hostnames, header names and object paths from a customer's internal systems,
 * which is a map of their estate — not a secret, but not something every member
 * needs either.
 */
export const connectorRouter: Router = Router();

connectorRouter.use(requireAuth, requirePermission('connection.create'));

connectorRouter.get('/vocabulary', validate({ query: schema.route }), connector.vocabulary);

/*
 * VALIDATION IS A POST BECAUSE THE DOCUMENT IS THE ARGUMENT. It changes nothing
 * and could be a GET in spirit, but a manifest does not fit in a query string.
 */
connectorRouter.post('/validate', validate({ body: schema.validateDocument }), connector.validate);

/* A preset is a way to write expressions; this writes them, and changes nothing stored. */
connectorRouter.post('/presets/expand', validate({ body: schema.expandPreset }), connector.expandPreset);

connectorRouter.get('/drafts', connector.list);

connectorRouter.post(
  '/drafts',
  writeLimit,
  validate({ body: schema.createDraft }),
  connector.create,
);

connectorRouter.get('/drafts/:id', validate({ params: schema.draftId }), connector.open);

/*
 * NOT RATE LIMITED THE WAY A WRITE USUALLY IS. The builder saves as somebody
 * types, so the ordinary case is many small saves in a row — a limit tuned for
 * deliberate writes would throttle normal use and silently lose work.
 */
connectorRouter.patch(
  '/drafts/:id',
  validate({ params: schema.draftId, body: schema.saveDraft }),
  connector.save,
);

connectorRouter.delete('/drafts/:id', validate({ params: schema.draftId }), connector.remove);

/* A version 1 draft rewritten in the form the builder edits. The same compile the engine runs at load. */
connectorRouter.post('/drafts/:id/upgrade', writeLimit, validate({ params: schema.draftId }), connector.upgrade);

/*
 * RATE LIMITED LIKE A WRITE even though it writes nothing here: it makes a real
 * request to a customer's system with a real credential, and an unbounded test
 * button is a way to have Silo hammer somebody's ERP.
 */
connectorRouter.post(
  '/drafts/:id/probe',
  writeLimit,
  validate({ params: schema.draftId, body: schema.probe }),
  connector.probe,
);

connectorRouter.post(
  '/drafts/:id/publish',
  writeLimit,
  validate({ params: schema.draftId }),
  connector.publish,
);

/*
 * A BUILD — the AI finishes the connector and tests it against the real system
 * before the person sees it. It replaced `POST /drafts/ai`, which handed the
 * person an untested draft to finish. Starting one fetches a document from an
 * address somebody typed and spends model tokens, and each round may spend
 * more, so both are limited like writes; the credential is limited like every
 * other place a secret is typed.
 */
connectorRouter.post('/builds', writeLimit, validate({ body: schema.aiDraft }), connector.startBuild);
connectorRouter.get('/builds/:id', validate({ params: schema.buildId }), connector.getBuild);
connectorRouter.put('/builds/:id/credential', credentialLimit, validate({ params: schema.buildId, body: schema.buildCredential }), connector.buildCredential);
connectorRouter.post('/builds/:id/signed-in', writeLimit, validate({ params: schema.buildId }), connector.buildSignedIn);
connectorRouter.post('/builds/:id/advance', writeLimit, validate({ params: schema.buildId }), connector.advanceBuild);
connectorRouter.post('/builds/:id/retry', writeLimit, validate({ params: schema.buildId }), connector.retryBuild);
connectorRouter.post('/builds/:id/feedback', writeLimit, validate({ params: schema.buildId, body: schema.buildFeedback }), connector.buildFeedback);
connectorRouter.get('/builds/:id/preview', validate({ params: schema.buildId }), connector.previewBuild);
connectorRouter.post('/builds/:id/connect', writeLimit, validate({ params: schema.buildId, body: schema.buildConnect }), connector.connectBuild);
