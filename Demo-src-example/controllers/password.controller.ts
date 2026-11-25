import type { Request, Response } from 'express';
import * as passwordService from '../services/password.service';
import { body } from '../middleware/validate.middleware';
import { clientIp, userAgent } from '../middleware/requestContext.middleware';
import { authConfig } from '../config/auth.config';
import { SESSION_TTL_SECONDS } from '../config/constants.config';
import type * as schema from '../schemas/auth.schema';

/**
 * THE RESET ENDPOINTS ALWAYS ANSWER 202, WHATEVER HAPPENED. An address that
 * exists and one that does not produce the same status, the same body and — as
 * far as a caller can measure — the same timing, because the service does the
 * work either way. Any difference here is an account-enumeration oracle, and it
 * is the one people reach for first: the reset form is unauthenticated, and it
 * takes an email address as input by design.
 */

export async function change(req: Request, res: Response): Promise<void> {
  const { currentPassword, newPassword } = body<schema.ChangePasswordBody>(req);
  const auth = req.auth!;

  const { token } = await passwordService.change({
    userId: auth.user.id,
    currentPassword,
    newPassword,
    /*
     * EVERY SESSION DIES AND THE CALLER GETS A REPLACEMENT. Keeping them all
     * would defeat the point — changing a password is what you do when you think
     * somebody else has one — and keeping none would sign the user out of the
     * form they just submitted, which reads as a failure. Naming their own
     * session gets them a token issued *after* the change.
     */
    keepSessionId: auth.session.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
  });

  /*
   * 200 WITH THE NEW TOKEN, NOT 204. A client that got 204 would carry on with
   * the token it holds, which this call has just revoked — so the next request
   * fails with a 401 that looks like the password change failed.
   */
  if (token) {
    res.cookie(authConfig.cookie.name, token, {
      ...authConfig.cookie,
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
  }

  res.status(200).json({ token });
}

export async function requestReset(req: Request, res: Response): Promise<void> {
  const { email } = body<schema.RequestResetBody>(req);
  await passwordService.requestReset({ email, ip: clientIp(req) });

  res.status(202).json({
    message: 'If that address has an account, a reset link is on its way.',
  });
}

export async function consumeReset(req: Request, res: Response): Promise<void> {
  const { token, newPassword } = body<schema.ConsumeResetBody>(req);
  await passwordService.consumeReset({ token, newPassword });

  /*
   * THE COOKIE IS CLEARED BECAUSE EVERY SESSION IS NOW GONE. Leaving it set
   * means the browser keeps sending a token that is guaranteed to fail, and the
   * user sees an authentication error on the page that just told them they
   * succeeded.
   */
  res.clearCookie(authConfig.cookie.name, authConfig.cookie);
  res.status(200).json({ message: 'Your password has been changed. Sign in with the new one.' });
}
