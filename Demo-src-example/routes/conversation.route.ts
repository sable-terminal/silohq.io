import { Router } from 'express';
import * as conversation from '../controllers/conversation.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requireCapability } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/conversation.schema';

/**
 * PRODUCT §2.2 — conversations.
 *
 * `canQuery` ON THE WHOLE ROUTER, as on saved views: a conversation is a list
 * of questions, and a cancelled account cannot ask them — so listing what it
 * asked before would be a menu of refusals.
 *
 * NO `writeLimit` ON APPENDING A TURN. One turn follows one question, and the
 * question was already limited where every question is.
 */
export const conversationRouter: Router = Router();

conversationRouter.use(requireAuth);
conversationRouter.use(requireCapability('canQuery'));

conversationRouter.get('/', conversation.mine);

conversationRouter.post('/', writeLimit, validate({ body: schema.createConversation }), conversation.create);

conversationRouter.get('/:id', validate({ params: schema.conversationId }), conversation.open);

conversationRouter.patch(
  '/:id',
  writeLimit,
  validate({ params: schema.conversationId, body: schema.renameConversation }),
  conversation.rename,
);

conversationRouter.delete('/:id', writeLimit, validate({ params: schema.conversationId }), conversation.remove);

conversationRouter.post(
  '/:id/turns',
  validate({ params: schema.conversationId, body: schema.addTurn }),
  conversation.addTurn,
);
