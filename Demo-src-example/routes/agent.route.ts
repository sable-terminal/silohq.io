import { Router } from 'express';
import * as agent from '../controllers/agent.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { credentialLimit, writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/agent.schema';

/**
 * Agents. `agent.manage`, super admin only, checked in the service.
 *
 * The channel an enrolled agent holds open is not here: it is a WebSocket
 * upgrade on `/api/agents/channel`, handled beside the HTTP server because
 * Express never sees an upgrade.
 */
export const agentRouter: Router = Router();

agentRouter.use(requireAuth);

agentRouter.get('/', agent.list);

agentRouter.post('/', writeLimit, validate({ body: schema.createAgent }), agent.create);

agentRouter.delete('/:id', writeLimit, validate({ params: schema.agentId }), agent.revoke);

agentRouter.get('/connections/:connectionId', validate({ params: schema.connectionId }), agent.route);

agentRouter.put('/connections/:connectionId', writeLimit, validate({ params: schema.connectionId, body: schema.assignAgent }), agent.assign);

/**
 * AN AGENT ENROLS BEFORE IT HAS ANY CREDENTIAL BUT THE ONE-TIME TOKEN, so this
 * cannot require a session. It takes a credential, so it is limited like login.
 */
export const agentPublicRouter: Router = Router();

agentPublicRouter.post('/enrol', credentialLimit, validate({ body: schema.enrolAgent }), agent.enrol);
