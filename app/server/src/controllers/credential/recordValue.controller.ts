// The credential service's record-value endpoints: base64 on the wire, buffers inside.

import type { openRecordValues, sealRecordValues } from '../../contracts/credential/recordValue.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { RecordValueCipher } from '../../services/credential/recordValue.service.ts';
import { AppError } from '../../utils/errors.util.ts';

const organisationOf = (organisationId: string | undefined): string => {
  if (organisationId === undefined) {
    throw new AppError('validation', 'a record value belongs to an organisation', { code: 'context.organisation_missing' });
  }
  return organisationId;
};

export function recordValueController(cipher: RecordValueCipher): {
  toSealed: RouteHandlers<typeof sealRecordValues>;
  toOpened: RouteHandlers<typeof openRecordValues>;
} {
  return {
    toSealed: {
      async handle({ body }, ctx) {
        const sealed = await cipher.seal(organisationOf(ctx.request.organisationId),
          body.items.map((i) => ({ binding: i.binding, value: Buffer.from(i.value, 'base64') })));
        return { items: sealed.map((b) => b.toString('base64')) };
      },
    },
    toOpened: {
      async handle({ body }, ctx) {
        const opened = await cipher.open(organisationOf(ctx.request.organisationId),
          body.items.map((i) => ({ binding: i.binding, sealed: Buffer.from(i.sealed, 'base64') })));
        return { items: opened.map((b) => b.toString('base64')) };
      },
    },
  };
}
