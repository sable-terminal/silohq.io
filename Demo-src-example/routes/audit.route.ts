import { Router } from 'express';
import * as audit from '../controllers/audit.controller';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { validate } from '../middleware/validate.middleware';
import * as schema from '../schemas/audit.schema';

export const auditRouter: Router = Router();

auditRouter.use(requireAuth);

/*
 * §12 — READING THE TRAIL.
 *
 * `audit.read` IS CHECKED IN THE MIDDLEWARE AND AGAIN IN THE SERVICE.
 *
 * IT IS CATALOGUED `scopeable = true` AND THE TRAIL CANNOT BE SCOPED. 004 marks
 * it delegable; `auth_events` has no scope column and could not acquire one,
 * because an event is an act of administration rather than a thing in the tree.
 * So a scope admin holding it reads the WHOLE organisation's trail — every
 * other department's grants, lockouts and invitations — which is more than
 * being a scope admin is supposed to carry.
 *
 * That is a product decision rather than a bug in this file, and it is flagged
 * rather than quietly fixed: making it `scopeable = false` and dropping it from
 * the Admin role would take the trail away from every department admin who has
 * it today. The alternative is to accept that reviewing an organisation is an
 * organisation-wide act and say so in the catalogue.
 *
 * IT IS A READ AND IT IS RATE LIMITED NOWHERE, deliberately: an auditor paging
 * through a year of events is the intended use, and keyset pagination makes the
 * thousandth page cost what the first one did.
 */
auditRouter.get(
  '/',
  requirePermission('audit.read'),
  validate({ query: schema.listAuthEvents }),
  audit.list,
);
