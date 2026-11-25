// The organisation's write-back settings (spec 45.4): the canary sample size, and whether the
// generic governed edit is allowed (42.9). Read by anyone who proposes; set by mutation.policy
// organisation-wide and audited. Reading them makes silo.edit if the organisation has none yet.

import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { ActionSettingsView } from '../../contracts/actions/settings.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { ActionType } from '../../models/action/actionType.model.ts';
import { actionTypeRepo } from '../../repos/action/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { callOptions, CANARY, type Context, type WriteBackDeps } from './deps.service.ts';
import { recordActionEvent } from './events.service.ts';
import { ensureGenericEdit } from './genericEdit.service.ts';

export function createActionSettings(deps: WriteBackDeps) {
  const control = deps.databases.pool('control');
  const canary = deps.canary ?? CANARY;
  const viewOf = (sampleRows: number | null, generic: ActionType, dryRunRequired: boolean): ActionSettingsView => ({
    canaryThresholdRows: canary.rows, canarySampleRows: sampleRows ?? canary.sample, custom: sampleRows !== null,
    genericEdit: { actionTypeId: generic.id, enabled: generic.disabledAt === null }, physicalDryRunRequired: dryRunRequired,
  });
  const read = (ctx: Context) => inTransaction(control, ctx.request, async (db) => {
    const organisation = await organisationRepo.findById(db, ctx.request.organisationId!);
    return viewOf(organisation?.canarySampleRows ?? null, await ensureGenericEdit(db, ctx.request.organisationId!), organisation?.physicalDryRunRequired ?? false);
  });
  const demandPolicy = async (ctx: Context, what: string): Promise<void> => {
    const decision = await deps.services.call(authorise, { body: { permission: 'mutation.policy', organisationWide: true } }, callOptions(ctx));
    if (decision.decision !== 'allow') {
      throw new AppError('forbidden', `${what} is set with mutation.policy across the organisation`, { code: 'action_settings.not_permitted' });
    }
  };

  return {
    get: read,

    async setCanarySample(ctx: Context, sampleRows: number | null): Promise<ActionSettingsView> {
      await demandPolicy(ctx, 'the canary sample');
      const organisationId = ctx.request.organisationId!;
      await inTransaction(control, ctx.request, async (db) => {
        await organisationRepo.update(db, organisationId, { canarySampleRows: sampleRows });
        await recordActionEvent(db, {
          organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions', event: 'canary_sample_set',
          resource: { type: 'organisation', id: organisationId }, detail: { sample_rows: sampleRows },
        });
      });
      return read(ctx);
    },

    /** A policy requiring a dry run before a physical Action is proposed (47.5): the proposal then names the dry run's receipt. */
    async setPhysicalDryRun(ctx: Context, required: boolean): Promise<ActionSettingsView> {
      await demandPolicy(ctx, 'whether a physical Action needs a dry run');
      const organisationId = ctx.request.organisationId!;
      await inTransaction(control, ctx.request, async (db) => {
        await organisationRepo.update(db, organisationId, { physicalDryRunRequired: required });
        await recordActionEvent(db, {
          organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions', event: 'physical_dry_run_policy_set',
          resource: { type: 'organisation', id: organisationId }, detail: { required },
        });
      });
      return read(ctx);
    },

    /** Disabling refuses new generic edits (here and in the mutation insert guard); one already proposed runs its approval as it stands. */
    async setGenericEdit(ctx: Context, enabled: boolean): Promise<ActionSettingsView> {
      await demandPolicy(ctx, 'the generic governed edit');
      const organisationId = ctx.request.organisationId!;
      await inTransaction(control, ctx.request, async (db) => {
        const generic = await ensureGenericEdit(db, organisationId);
        if ((generic.disabledAt === null) === enabled) return;
        await actionTypeRepo.update(db, generic.id, { disabledAt: enabled ? null : new Date().toISOString(), version: generic.version + 1 });
        await recordActionEvent(db, {
          organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions', event: 'generic_edit_policy_set',
          resource: { type: 'action_type', id: generic.id }, detail: { enabled },
        });
      });
      return read(ctx);
    },
  };
}

export type ActionSettings = ReturnType<typeof createActionSettings>;
