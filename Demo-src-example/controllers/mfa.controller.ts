import type { Request, Response } from 'express';
import * as mfaService from '../services/mfa.service';
import { body } from '../middleware/validate.middleware';
import { invalid } from '../utils/error.util';
import type * as schema from '../schemas/auth.schema';

/**
 * Enrolling a second factor.
 *
 * TWO STEPS, AND THE FACTOR IS NOT ACTIVE UNTIL THE SECOND. `begin` stores an
 * unconfirmed secret and returns the URI for the QR code; `confirm` requires a
 * code generated from it. A one-step enrolment that trusted the client to have
 * saved the secret locks out every user whose authenticator app failed to scan —
 * and the account is then protected by a factor nobody holds.
 *
 * THE SECRET IS SHOWN EXACTLY ONCE, HERE, and never returned again by any
 * endpoint. It is the shared key; a "show me my MFA secret" call would let anyone
 * with a live session mint codes forever.
 */

export async function begin(req: Request, res: Response): Promise<void> {
  const auth = req.auth!;
  const result = await mfaService.beginEnrolment({ userId: auth.user.id, email: auth.user.email });

  res.status(201).json(result);
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const { factorId, code } = body<schema.ConfirmMfaBody>(req);
  const confirmed = await mfaService.confirmEnrolment({
    userId: req.auth!.user.id,
    factorId,
    code,
  });

  if (!confirmed) {
    throw invalid({
      message: 'That code is not right. Check your authenticator app and try again.',
      code: 'invalid.mfa_code',
    });
  }

  res.status(200).json({ confirmed: true });
}

export async function status(req: Request, res: Response): Promise<void> {
  res.status(200).json({
    enrolled: await mfaService.hasConfirmedFactor(req.auth!.user.id),
    required: req.auth!.organisation.mfaRequired,
    satisfied: req.auth!.session.mfaSatisfiedAt !== null,
  });
}
