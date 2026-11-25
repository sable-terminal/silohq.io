import { Router } from 'express';
import * as compile from '../controllers/compile.controller';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requireCapability } from '../middleware/authorise.middleware';
import { validate } from '../middleware/validate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/compile.schema';

export const compileRouter: Router = Router();

compileRouter.use(requireAuth);

/*
 * §15.3 — a cancelled account cannot ask, and this is the expensive way to ask.
 * Refused before the model call rather than after it, for the same reason
 * `query.run` is checked before the vocabulary is gathered.
 */
compileRouter.use(requireCapability('canQuery'));

/*
 * §7 — A QUESTION, COMPILED AND ANSWERED.
 *
 * RATE LIMITED HARDER THAN A WRITE WOULD BE, because it costs twice: a model
 * call that is billed by the token, and then a fan-out to every system the
 * chosen concept spans. It is the most expensive endpoint in the product and
 * the easiest to hold a key down on.
 *
 * `query.run` IS CHECKED IN THE SERVICE, before the vocabulary is gathered and
 * long before the model runs — a reader who may not query must not be able to
 * spend a model call discovering that.
 */
compileRouter.post(
  '/',
  writeLimit,
  validate({ body: schema.askQuestion }),
  compile.ask,
);

/*
 * 129 — AN ANSWER, WRITTEN UP. Rate limited like the question: it is a model
 * call billed by the token. The organisation's choice and the deployment's
 * retention are checked in the service before anything is sent.
 */
compileRouter.post('/read', writeLimit, validate({ body: schema.readAnswer }), compile.read);
