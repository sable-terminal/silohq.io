import { Router } from 'express';
import * as auth from '../controllers/auth.controller';
import * as password from '../controllers/password.controller';
import * as mfa from '../controllers/mfa.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth, requireToken } from '../middleware/authenticate.middleware';
import { credentialLimit, writeLimit } from '../middleware/rateLimit.middleware';
import { requireHuman } from '../middleware/turnstile.middleware';
import * as schema from '../schemas/auth.schema';

/**
 * Getting in, and everything that changes how.
 *
 * THE UNAUTHENTICATED ENDPOINTS ARE THE TOP HALF OF THIS FILE AND THEY ARE ALL
 * RATE LIMITED. Each of them takes a credential — a password, a reset token, a
 * six-digit code — and each is a place where an attacker gets unlimited guesses
 * if nothing counts them. `credentialLimit` fails closed, so if the cache is
 * unavailable these refuse rather than becoming an open guessing window.
 *
 * `requireToken` RATHER THAN `requireAuth` ON THREE OF THEM, and the reason is
 * the same each time: the session exists but is not yet usable. Choosing an
 * organisation is what gives it a membership; satisfying MFA is what makes
 * `requireAuth` accept it; logging out should work on a session too broken to
 * authenticate, or a user cannot get rid of it.
 */

export const authRouter: Router = Router();

/*
 * RATE LIMIT AND BOT CHECK TOGETHER, ON EVERY PUBLIC FORM. They cover different
 * halves and neither is sufficient alone: Turnstile stops the scripted client
 * that never loads the page, and the rate limit bounds the one that solves a
 * challenge and then works through a password list. Turnstile fails open when
 * Cloudflare is unreachable, which is only survivable because the limiter is
 * still counting.
 */
authRouter.post(
  '/login',
  credentialLimit,
  requireHuman('login'),
  validate({ body: schema.login }),
  auth.login,
);
authRouter.post(
  '/register',
  credentialLimit,
  requireHuman('register'),
  validate({ body: schema.register }),
  auth.register,
);

authRouter.post(
  '/password/reset',
  credentialLimit,
  requireHuman('password-reset'),
  validate({ body: schema.requestReset }),
  password.requestReset,
);
authRouter.post(
  '/password/reset/confirm',
  credentialLimit,
  requireHuman('password-reset-confirm'),
  validate({ body: schema.consumeReset }),
  password.consumeReset,
);

// Session exists, membership not yet chosen.
authRouter.get('/organisations', requireToken, auth.organisations);

/*
 * `requireToken`, NOT `requireAuth`. The caller has a real session that names no
 * membership — which is exactly what `requireAuth` refuses — and founding an
 * organisation is how they stop being in that state.
 */
authRouter.post(
  '/organisations',
  requireToken,
  writeLimit,
  validate({ body: schema.createOrganisation }),
  auth.createOrganisation,
);
authRouter.post(
  '/organisation',
  requireToken,
  validate({ body: schema.chooseOrganisation }),
  auth.chooseOrganisation,
);
authRouter.post(
  '/mfa/satisfy',
  credentialLimit,
  requireToken,
  validate({ body: schema.satisfyMfa }),
  auth.satisfyMfa,
);
authRouter.post('/logout', requireToken, auth.logout);

/* ── Signed in ──────────────────────────────────────────────────────────── */

authRouter.get('/me', requireAuth, auth.me);

/*
 * AUTH — where else you are signed in, and ending one of those.
 *
 * `requireToken` RATHER THAN `requireAuth`, as logout uses: a session that has
 * authenticated but not chosen an organisation is still a session somebody may
 * want to end, and it is theirs.
 */
authRouter.get('/sessions', requireToken, auth.sessions);
authRouter.delete('/sessions/:id', requireToken, validate({ params: schema.sessionId }), auth.endSession);

authRouter.post(
  '/password',
  requireAuth,
  credentialLimit,
  validate({ body: schema.changePassword }),
  password.change,
);

authRouter.get('/mfa', requireAuth, mfa.status);
authRouter.post('/mfa', requireAuth, mfa.begin);
authRouter.post(
  '/mfa/confirm',
  requireAuth,
  credentialLimit,
  validate({ body: schema.confirmMfa }),
  mfa.confirm,
);
