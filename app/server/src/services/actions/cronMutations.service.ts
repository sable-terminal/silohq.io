// A Cron's mutate action (spec 40.5, 43.11), as the actions service takes it: the Cron's
// principal names its Cron and the action; the authorisation recorded with the action says
// who authorised it and, in execute mode, its bounds (rows, properties, connections, expiry).
// A revoked authorisation proposes nothing; an execute authorisation past its expiry returns
// the action to propose mode (40.6): the mutation waits for a person, as any proposal does.

import { inTransaction } from '../../infra/postgres.infra.ts';
import { authorisationConnectionRepo, automationActionRepo, automationAuthorisationRepo, automationRepo } from '../../repos/automation/index.repo.ts';
import { actionTypeRepo, actionTypeVersionRepo, mutationRepo } from '../../repos/action/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import type { ObjectReference } from '../../contracts/actions/mutation.contract.ts';
import { openValues, type Context, type WriteBackDeps } from './deps.service.ts';
import type { createProposals } from './propose.service.ts';

export function createCronMutations(deps: WriteBackDeps, proposals: ReturnType<typeof createProposals>) {
  const control = deps.databases.pool('control');

  return {
    async propose(ctx: Context, input: { automationId: string; actionId: string; objects: ObjectReference[] }) {
      const principalId = ctx.request.servicePrincipalId;
      const loaded = await inTransaction(control, ctx.request, async (db) => {
        const automation = await automationRepo.findById(db, input.automationId);
        const action = await automationActionRepo.findById(db, input.actionId);
        const authorisation = action?.authorisationId == null ? undefined : await automationAuthorisationRepo.findById(db, action.authorisationId);
        return { automation, action, authorisation, connections: authorisation === undefined ? [] : await authorisationConnectionRepo.listFor(db, authorisation.id) };
      }, { readOnly: true });
      const { automation, action, authorisation, connections } = loaded;
      if (automation === undefined || principalId === undefined || automation.servicePrincipalId !== principalId || automation.deletedAt !== null
        || action === undefined || action.automationId !== automation.id || action.kind !== 'mutate' || authorisation === undefined) {
        throw new AppError('forbidden', 'a Cron proposes only through its own mutate action', { code: 'mutation.cron_not_permitted' });
      }
      if (authorisation.revokedAt !== null) throw new AppError('conflict', 'the Cron\'s authorisation was revoked', { code: 'mutation.cron_revoked' });
      const expired = authorisation.mode === 'execute' && authorisation.expiresAt !== null && Date.parse(authorisation.expiresAt) <= Date.now();
      const execute = authorisation.mode === 'execute' && !expired;
      // The values the attaching person set, sealed with the action (40.5).
      const parameters = action.parameterValues === null ? {}
        : (await openValues(deps, ctx, [{ binding: { table: 'automation.automation_actions', id: action.id, column: 'parameter_values' }, sealed: action.parameterValues }]))[0] as Record<string, never>;
      // A resolvable object's records in every system: only those the Action type may write through are written.
      const permitted = await inTransaction(control, ctx.request, async (db) => {
        const type = await actionTypeRepo.findById(db, action.actionTypeId!);
        const version = type?.currentVersionId == null ? undefined : await actionTypeVersionRepo.findById(db, type.currentVersionId);
        return new Set(version?.permittedConnections ?? []);
      }, { readOnly: true });
      const objects = input.objects.filter((o) => permitted.has(o.connectionId));
      if (objects.length === 0) throw new AppError('validation', 'no record of these objects is in a system the Action type may write through', { code: 'mutation.cron_no_writable_record' });
      const view = await proposals.propose(ctx, {
        actionTypeId: action.actionTypeId!, parameters, objects, resolutionPolicy: 'strict',
        cron: {
          authorisingMembershipId: authorisation.authorisedBy,
          execute: execute ? { maxRows: authorisation.maxRows!, properties: authorisation.permittedFields ?? [], connectionIds: connections } : null,
        },
      });
      const row = (await inTransaction(control, ctx.request, (db) => mutationRepo.findById(db, view.id), { readOnly: true }))!;
      return { mutationId: row.id, status: row.status, cronMode: row.cronMode, refusalReason: row.refusalReason };
    },
  };
}
