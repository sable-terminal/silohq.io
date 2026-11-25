import { Router } from 'express';
import * as approval from '../controllers/approval.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/approval.schema';

export const approvalRouter: Router = Router();

approvalRouter.use(requireAuth);

/*
 * WHAT IS WAITING, for the people who could decide it and the people who asked.
 * Filtered in the service, because who may decide depends on the action.
 */
approvalRouter.get('/', validate({ query: schema.listRequests }), approval.requests);

/*
 * WHICH ACTIONS NEED A SECOND PERSON is `approval.configure`, super admin only:
 * a rule a scope admin could switch off for the data they want gone would not be
 * a rule.
 */
approvalRouter.get('/policies', approval.policies);

approvalRouter.put(
  '/policies/:action',
  writeLimit,
  validate({ params: schema.action, body: schema.setPolicy }),
  approval.setPolicy,
);

approvalRouter.delete(
  '/policies/:action',
  writeLimit,
  validate({ params: schema.action }),
  approval.removePolicy,
);

/*
 * DECIDING RUNS THE ACTION when it is the last approval needed, so it is rate
 * limited like the action itself.
 */
approvalRouter.post(
  '/:id/approve',
  writeLimit,
  validate({ params: schema.requestId, body: schema.approve }),
  approval.approve,
);

approvalRouter.post(
  '/:id/reject',
  writeLimit,
  validate({ params: schema.requestId, body: schema.reject }),
  approval.reject,
);
