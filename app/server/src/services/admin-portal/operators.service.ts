// The cell's operator directory (spec 13.4, 65.4): the Silo staff the staff identity provider
// may sign in here, with their clearance, residency and place on the sovereign access list.
// Staff roles themselves are the provider's; this records who may use them in this cell.
//
// - staff.manage adds staff and corrects their facts; staff.review records the quarterly
//   review and suspends or removes ("removed on departure"). Nobody reviews, suspends or
//   removes themselves, and removal is final.
// - A suspended or removed operator's staff sessions end at their next request.
// - Not tenant data, so these are logged, not written to any customer's audit log.

import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Operator } from '../../models/platform/operator.model.ts';
import { operatorRepo } from '../../repos/platform/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { nowOf, type AdminPortalDeps, type StaffContext } from './deps.service.ts';

/** Spec 13.4: "Staff access is reviewed quarterly." */
export const REVIEW_INTERVAL_DAYS = 90;

const notFound = (): AppError => new AppError('not_found', 'no such member of staff', { code: 'staff.operator_not_found' });
const notYourself = (what: string): AppError =>
  new AppError('forbidden', `another member of staff ${what} you`, { code: 'staff.not_yourself' });

type OperatorView = Omit<Operator, 'version'> & { version?: number };
const view = ({ version: _version, ...rest }: Operator): OperatorView => rest;

interface Facts {
  displayName?: string | undefined;
  clearance?: Operator['clearance'] | undefined;
  ukResident?: boolean | undefined;
  sovereignAccessListed?: boolean | undefined;
}

/** Spec 13.3, 65.4: the sovereign access list is UK-resident staff cleared to SC or DV. */
function checkSovereign(f: Required<Pick<Facts, 'clearance' | 'ukResident' | 'sovereignAccessListed'>>): void {
  if (f.sovereignAccessListed && !(f.ukResident && (f.clearance === 'sc' || f.clearance === 'dv'))) {
    throw new AppError('validation', 'the sovereign access list is for UK-resident staff cleared to SC or DV', {
      code: 'staff.sovereign_ineligible',
    });
  }
}

export function createOperators(deps: AdminPortalDeps) {
  const control = deps.databases.pool('control');
  const log = (event: string, ctx: StaffContext, operatorId: string) =>
    deps.logger.info('operator directory changed', { event, resourceType: 'operator', resourceId: operatorId, correlationId: ctx.correlationId });

  const change = async (ctx: StaffContext, operatorId: string, work: (current: Operator) => Partial<Operator>): Promise<OperatorView> =>
    inTransaction(control, {}, async (db) => {
      const current = await operatorRepo.findById(db, operatorId);
      if (current === undefined) throw notFound();
      const updated = await operatorRepo.update(db, operatorId, current.version, work(current));
      if (updated === undefined) throw new AppError('conflict', 'that member of staff changed meanwhile; read them again', { code: 'staff.operator_stale' });
      return view(updated);
    });

  return {
    async list(input: { reviewDue: boolean; limit: number }): Promise<{ operators: OperatorView[] }> {
      const dueBefore = input.reviewDue ? new Date(nowOf(deps).getTime() - REVIEW_INTERVAL_DAYS * 86_400_000).toISOString() : undefined;
      const rows = await inTransaction(control, {}, (db) => operatorRepo.list(db, { reviewDueBefore: dueBefore, limit: input.limit }), { readOnly: true });
      return { operators: rows.map(view) };
    },

    async add(ctx: StaffContext, input: { idpSubject: string; displayName: string; clearance: Operator['clearance']; ukResident: boolean;
      sovereignAccessListed: boolean }): Promise<OperatorView> {
      checkSovereign(input);
      try {
        const row = await inTransaction(control, {}, (db) => operatorRepo.insert(db, { id: uuidv7(), ...input }));
        log('staff.operator_added', ctx, row.id);
        return view(row);
      } catch (error) {
        if (isAppError(error) && error.details['sqlstate'] === '23505') {
          throw new AppError('conflict', 'a member of staff already has that identity', { code: 'staff.subject_taken' });
        }
        throw error;
      }
    },

    async change(ctx: StaffContext, operatorId: string, input: Facts & { version: number }): Promise<OperatorView> {
      const result = await change(ctx, operatorId, (current) => {
        if (current.version !== input.version) throw new AppError('conflict', 'that member of staff changed meanwhile; read them again', { code: 'staff.operator_stale' });
        if (current.status === 'removed') throw new AppError('conflict', 'a removed member of staff is not changed', { code: 'staff.operator_removed' });
        const next = {
          clearance: input.clearance ?? current.clearance, ukResident: input.ukResident ?? current.ukResident,
          sovereignAccessListed: input.sovereignAccessListed ?? current.sovereignAccessListed,
        };
        checkSovereign(next);
        return { ...next, ...(input.displayName === undefined ? {} : { displayName: input.displayName }) };
      });
      log('staff.operator_changed', ctx, operatorId);
      return result;
    },

    async review(ctx: StaffContext, operatorId: string): Promise<OperatorView> {
      if (operatorId === ctx.staff.operator.id) throw notYourself('reviews');
      const result = await change(ctx, operatorId, (current) => {
        if (current.status === 'removed') throw new AppError('conflict', 'a removed member of staff is not reviewed', { code: 'staff.operator_removed' });
        return { lastReviewedAt: nowOf(deps).toISOString(), lastReviewedBy: ctx.staff.operator.id };
      });
      log('staff.operator_reviewed', ctx, operatorId);
      return result;
    },

    async setStatus(ctx: StaffContext, operatorId: string, status: Operator['status']): Promise<OperatorView> {
      if (operatorId === ctx.staff.operator.id) throw notYourself('suspends or removes');
      const result = await change(ctx, operatorId, (current) => {
        if (current.status === 'removed') throw new AppError('conflict', 'removal is final', { code: 'staff.operator_removed' });
        return status === 'removed' ? { status, removedAt: nowOf(deps).toISOString() } : { status };
      });
      log(`staff.operator_${status}`, ctx, operatorId);
      return result;
    },
  };
}

export type Operators = ReturnType<typeof createOperators>;
