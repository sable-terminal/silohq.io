// Auto top-up (spec 73.4): opt-in, never default. A membership's tokens are topped up when a
// charge would otherwise be refused (its grant, period allowance and purchased balance all
// spent, or the daily limit reached with nothing purchased): billing buys the smallest number
// of hundreds that covers the charge on the organisation's payment method, and the charge
// goes ahead from the purchased balance. With it off, exhaustion refuses with a message saying
// what was exhausted and how to continue. Switching it on or off is tokens.purchase, because
// it spends the organisation's money, and is audited (auto_topup_toggled).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const setAutoTopup = defineContract({
  service: 'metering', name: 'setAutoTopup', method: 'PUT', path: '/v1/balances/:membershipId/auto-topup', callers: ['gateway'],
  // Setting it twice to the same value changes nothing more.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ membershipId: z.uuid() }),
  body: z.strictObject({ enabled: z.boolean() }),
  response: z.object({ membershipId: z.uuid(), autoTopup: z.boolean() }),
  maxBodyBytes: 256,
});
