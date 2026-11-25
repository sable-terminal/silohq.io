import { Router } from 'express';
import * as organisation from '../controllers/organisation.controller';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission, requireSuperAdmin } from '../middleware/authorise.middleware';
import { validate } from '../middleware/validate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/organisation.schema';
import { setAnswerReading } from '../schemas/compile.schema';

export const organisationRouter: Router = Router();

organisationRouter.use(requireAuth);

/*
 * §7.3 — READING NEEDS NO PERMISSION BEYOND MEMBERSHIP. The calendar discloses
 * nothing about the estate, and a figure labelled "last quarter" is not
 * checkable without it.
 */
organisationRouter.get('/calendar', organisation.calendar);

/*
 * §7.3 — `authority.declare`, FOR THE REASON THAT PERMISSION EXISTS.
 *
 * Moving the year start changes what every period in the organisation resolves
 * to, retrospectively. It is the same class of act as deciding which system is
 * right about a number: it says what every later answer MEANS, organisation
 * wide, and a scope admin must not make it from inside one corner.
 */
organisationRouter.put(
  '/calendar',
  writeLimit,
  requirePermission('authority.declare'),
  validate({ body: schema.setCalendar }),
  organisation.setCalendar,
);

/*
 * §6.1 — READING NEEDS NO PERMISSION BEYOND MEMBERSHIP. Somebody whose share
 * was refused is owed the reason, and the policy discloses nothing about the
 * estate.
 */
organisationRouter.get('/sharing-policy', organisation.sharingPolicy);

/*
 * §6.1 — `clearance.grant`, WHICH IS "super admin only, never delegable".
 *
 * Sharing a view is an act INSIDE the policy and `view.share` governs it. This
 * decides what the policy IS: it can only loosen or tighten what everybody else
 * may do, organisation-wide. A scope admin loosening it would be deciding the
 * whole organisation's exposure from inside one corner of it.
 */
organisationRouter.put(
  '/sharing-policy',
  writeLimit,
  requirePermission('clearance.grant'),
  validate({ body: schema.setSharingPolicy }),
  organisation.setSharingPolicy,
);

/*
 * The logo. THE COLUMNS AND THE STORE HAVE EXISTED SINCE THE FIRST MIGRATION
 * and nothing ever put a file in them.
 *
 * `requireSuperAdmin` RATHER THAN A PERMISSION, because there is none for
 * branding and inventing one would mean deciding which roles hold it with
 * nobody to ask. A logo appears on every page and in every email the product
 * sends; changing it is not a thing to delegate by accident.
 */
organisationRouter.put(
  '/logo',
  writeLimit,
  requireSuperAdmin,
  validate({ body: schema.setLogo }),
  organisation.setLogo,
);

/*
 * MANIFEST-V2 §3.7 — whether Silo's own connectors move to a new version by
 * themselves. `requireSuperAdmin`: it decides, for every connection at once,
 * that a new document may be run without anybody looking at it first.
 */
organisationRouter.get('/connector-updates', organisation.connectorUpdates);

organisationRouter.put(
  '/connector-updates',
  writeLimit,
  requireSuperAdmin,
  validate({ body: schema.setConnectorUpdates }),
  organisation.setConnectorUpdates,
);

/*
 * 129 — answers written up by a model. `silo.enable` is checked in the
 * service, as for reading documents: super admin only, never delegable,
 * because it changes what leaves the deployment.
 */
organisationRouter.get('/answer-reading', organisation.answerReadingSetting);

organisationRouter.put(
  '/answer-reading',
  writeLimit,
  requireSuperAdmin,
  validate({ body: setAnswerReading }),
  organisation.setAnswerReading,
);

/*
 * 130 — context from the web, for the whole organisation. `silo.enable` is
 * checked in the service: it decides what leaves the deployment.
 */
organisationRouter.get('/web-context', organisation.webContext);

organisationRouter.put(
  '/web-context',
  writeLimit,
  requireSuperAdmin,
  validate({ body: setAnswerReading }),
  organisation.setWebContext,
);
