// The credential service's TOTP endpoints: wire shapes (base64) to the mediator and back.

import type { enrolTotp, SealedSecretWire, verifyTotp } from '../../contracts/credential/totp.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { CredentialService } from '../../services/credential/credential.service.ts';
import type { SealedSecret } from '../../utils/envelope.util.ts';
import { AppError } from '../../utils/errors.util.ts';

export const toWire = (sealed: SealedSecret): SealedSecretWire => ({
  secretSealed: sealed.ciphertext.toString('base64'), nonce: sealed.nonce.toString('base64'),
  dekWrapped: sealed.dekWrapped.toString('base64'), keyVersionId: sealed.keyVersionId,
});

export const fromWire = (wire: SealedSecretWire): SealedSecret => ({
  ciphertext: Buffer.from(wire.secretSealed, 'base64'), nonce: Buffer.from(wire.nonce, 'base64'),
  dekWrapped: Buffer.from(wire.dekWrapped, 'base64'), keyVersionId: wire.keyVersionId,
});

export function totpController(service: CredentialService): {
  enrol: RouteHandlers<typeof enrolTotp>;
  verify: RouteHandlers<typeof verifyTotp>;
} {
  return {
    enrol: {
      async handle(input, ctx) {
        const enrolment = await service.enrolTotp({ ...input.body, userId: ctx.request.userId! });
        return { sealed: toWire(enrolment.sealed), otpauthUri: enrolment.otpauthUri };
      },
    },
    verify: {
      async handle(input, ctx) {
        const organisationId = ctx.request.organisationId;
        if (organisationId === undefined) {
          throw new AppError('validation', 'an MFA unwrap is recorded in the organisation being logged into', {
            code: 'context.organisation_missing',
          });
        }
        const step = await service.verifyTotp({
          factorId: input.body.factorId, userId: ctx.request.userId!, organisationId, sealed: fromWire(input.body.sealed),
          code: input.body.code, lastUsedStep: input.body.lastUsedStep, callingService: ctx.caller, correlationId: ctx.correlationId,
        });
        return { step };
      },
    },
  };
}
