import { Router } from 'express';
import * as principal from '../controllers/principal.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requireApiKey } from '../middleware/apiKey.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/principal.schema';

export const principalRouter: Router = Router();

/**
 * THE ONLY ENDPOINT A KEY MAY CALL, and it is mounted before `requireAuth`
 * because a key is not a session. Everything else on this router is
 * administrative — creating identities, issuing and revoking keys — and is
 * deliberately closed to keys: an automation that can mint its own credentials
 * is one leaked secret away from being permanent.
 */
principalRouter.get('/me', requireApiKey, principal.me);

principalRouter.use(requireAuth);

/*
 * `connection.create` GOVERNS ALL OF THESE rather than a permission of their
 * own. A service principal exists to drive an integration, and the person
 * trusted to connect a system is the person trusted to give that connection an
 * identity. A permission per feature produces a catalogue nobody can hold in
 * their head.
 */
principalRouter.get('/', requirePermission('connection.create'), principal.list);

principalRouter.post(
  '/',
  writeLimit,
  requirePermission('connection.create'),
  validate({ body: schema.createPrincipal }),
  principal.create,
);

principalRouter.post(
  '/:principalId/disabled',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.principalParams, body: schema.setDisabled }),
  principal.setDisabled,
);

principalRouter.post(
  '/:principalId/keys',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.principalParams, body: schema.issueKey }),
  principal.issueKey,
);

principalRouter.delete(
  '/keys/:keyId',
  writeLimit,
  requirePermission('connection.create'),
  validate({ params: schema.keyParams }),
  principal.revokeKey,
);
