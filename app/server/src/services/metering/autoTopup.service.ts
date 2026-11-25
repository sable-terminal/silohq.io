// Switching a membership's auto top-up on or off (contracts/metering/autoTopup.contract.ts;
// spec 73.4): tokens.purchase, audited as auto_topup_toggled. The balance row is opened if the
// membership has none yet (no onboarding grant comes with it: that is the seat's).

import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { tokenBalanceRepo } from '../../repos/billing/index.repo.ts';
import { membershipRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordEvent, requirePermission, type MeteringDeps } from './deps.service.ts';

export async function setAutoTopup(deps: MeteringDeps, ctx: HandlerContext, membershipId: string, enabled: boolean)
  : Promise<{ membershipId: string; autoTopup: boolean }> {
  await requirePermission(deps, ctx, 'tokens.purchase');
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const member = await membershipRepo.findById(db, membershipId);
    if (member === undefined || member.status !== 'active') {
      throw new AppError('not_found', 'no active member of this organisation by that id', { code: 'metering.member_unknown' });
    }
    await tokenBalanceRepo.open(db, { id: uuidv7(), organisationId, membershipId, onboardingGrantRemaining: 0 });
    const before = await tokenBalanceRepo.lockByMembership(db, membershipId);
    if (before!.autoTopup !== enabled) {
      await tokenBalanceRepo.setAutoTopup(db, before!.id, enabled);
      await recordEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: 'auto_topup_toggled', actor: { kind: 'membership', membershipId: ctx.request.membershipId! },
        subjectMembershipId: membershipId, detail: { enabled },
      });
    }
    return { membershipId, autoTopup: enabled };
  });
}
