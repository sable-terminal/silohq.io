import { Router } from 'express';
import * as ticket from '../controllers/ticket.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/ticket.schema';

/**
 * Support.
 *
 * NO CAPABILITY AND NO PERMISSION, ONLY A SESSION. Being unable to ask for help
 * because of a role would be absurd — and worse than absurd, because the thing
 * somebody is asking about is usually the role refusing them. A cancelled
 * account raises one too: it is the account most likely to need to.
 *
 * `writeLimit` ON RAISING, because it is an unpriced write that ends in an
 * email to us, which is the shape of thing that gets used to send a thousand.
 * Reading your own is not limited beyond the general limit.
 */
export const ticketRouter: Router = Router();

ticketRouter.use(requireAuth);

ticketRouter.post('/tickets', writeLimit, validate({ body: schema.raiseTicket }), ticket.raise);

ticketRouter.get('/tickets', ticket.mine);

ticketRouter.get('/tickets/:id', validate({ params: schema.ticketId }), ticket.open);
