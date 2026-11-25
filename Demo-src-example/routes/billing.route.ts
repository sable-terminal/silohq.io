import { Router } from 'express';
import * as billing from '../controllers/billing.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/billing.schema';

/**
 * Billing: the subscription and the seats it licenses.
 *
 * PERMISSIONS ARE THE SERVICE'S, and they are not one permission. Seeing what
 * you are entitled to is `billing.view`; buying is `billing.manage`; reducing
 * the licence count is `seat.release`, which an admin who can offboard somebody
 * deliberately does not have.
 */
export const billingRouter: Router = Router();

billingRouter.use(requireAuth);

billingRouter.get('/', billing.summary);

billingRouter.put('/subscription', writeLimit, validate({ body: schema.subscribe }), billing.subscribe);

billingRouter.post('/seats', writeLimit, validate({ body: schema.seatCount }), billing.addSeats);

/*
 * RELEASING IS A POST, NOT A DELETE. It removes nothing today: the licence count
 * falls at the period boundary, and the seats leave the pool so nobody is
 * assigned one that is about to stop being paid for.
 */
billingRouter.post('/seats/release', writeLimit, validate({ body: schema.seatCount }), billing.releaseSeats);

/* ── Tokens ───────────────────────────────────────────────────────────────── */

/*
 * SOMEBODY'S OWN ALLOWANCE IS NOT A BILLING SECRET. `usage` answers what the
 * caller has left without a permission, and adds the organisation's spend only
 * for somebody holding `billing.view` — being refused for want of tokens and not
 * being allowed to see why is the worst version of this screen.
 */
billingRouter.get('/usage', billing.usage);

billingRouter.post('/tokens', writeLimit, validate({ body: schema.buyTokens }), billing.buyTokens);

billingRouter.put('/tokens/auto-top-up', writeLimit, validate({ body: schema.autoTopUp }), billing.autoTopUp);

/* §2 — how much one person may spend in a day here, which may only be stricter than the plan. */
billingRouter.put('/tokens/daily-limit', writeLimit, validate({ body: schema.dailyLimit }), billing.setDailyLimit);

/* ── Simulations ──────────────────────────────────────────────────────────── */

/*
 * THEIR OWN POOL, AND SAID SO EVEN BEFORE THERE IS A SIMULATION TO RUN. The
 * standing answers what a plan includes; buying is by agreement, and the refusal
 * says that rather than quoting a rate nobody set.
 */
billingRouter.get('/simulations', billing.simulationsStanding);

billingRouter.post('/simulations', writeLimit, billing.buySimulations);

/* ── Siloes ───────────────────────────────────────────────────────────────── */

/*
 * §6 — "The underlying cost is recorded per line." The statement is per Silo per
 * month with the provider's own cost beside the charge, because a margin stated
 * as a percentage over cost is worth nothing if the cost cannot be seen.
 */
billingRouter.get('/storage', billing.storage);
