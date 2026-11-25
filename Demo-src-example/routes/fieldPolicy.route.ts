import { Router } from 'express';
import * as fieldPolicy from '../controllers/fieldPolicy.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/fieldPolicy.schema';

/**
 * Field policies. `field_policy.manage`, super admin only, checked in the service.
 *
 * A REVOKED POLICY IS KEPT, not deleted, so which fields were hidden from whom
 * and when can still be read in the trail.
 */
export const fieldPolicyRouter: Router = Router();

fieldPolicyRouter.use(requireAuth);

fieldPolicyRouter.get('/', fieldPolicy.list);

fieldPolicyRouter.post('/', writeLimit, validate({ body: schema.createFieldPolicy }), fieldPolicy.create);

fieldPolicyRouter.delete('/:id', writeLimit, validate({ params: schema.fieldPolicyId }), fieldPolicy.revoke);
