// The organisation's inference switches (decision 2026-11-11; D71): read by any member, set by
// org.inference.manage across the organisation, audited with what changed. The services that
// infer read the switch from the organisation row when they run.

import type { InferenceSettings } from '../../contracts/policy/inference.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Organisation } from '../../models/iam/organisation.model.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { auditActorOf, contextOf, demand, recordPolicyEvent, requireActor, type AdminDeps } from './deps.service.ts';

export const inferenceOf = (o: Pick<Organisation, 'inferenceSimulation' | 'inferenceResolution' | 'inferenceLinks' | 'inferenceFindings'>): InferenceSettings =>
  ({ simulation: o.inferenceSimulation, resolution: o.inferenceResolution, links: o.inferenceLinks, findings: o.inferenceFindings });

export async function getInferenceSettings(deps: AdminDeps, ctx: HandlerContext): Promise<InferenceSettings> {
  const subject = await requireActor(deps, ctx);
  const row = await inTransaction(deps.databases.pool('control'), contextOf(subject.actor), (db) => organisationRepo.findById(db, subject.actor.organisationId),
    { readOnly: true });
  if (row === undefined) throw new AppError('not_found', 'no such organisation', { code: 'organisation.not_found' });
  return inferenceOf(row);
}

export async function setInferenceSettings(deps: AdminDeps, ctx: HandlerContext, input: { [K in keyof InferenceSettings]?: boolean | undefined }): Promise<InferenceSettings> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'org.inference.manage', { organisationWide: true });
  const organisationId = subject.actor.organisationId;
  return inTransaction(deps.databases.pool('control'), contextOf(subject.actor), async (db) => {
    const before = await organisationRepo.findById(db, organisationId);
    if (before === undefined) throw new AppError('not_found', 'no such organisation', { code: 'organisation.not_found' });
    const after = (await organisationRepo.update(db, organisationId, {
      ...(input.simulation === undefined ? {} : { inferenceSimulation: input.simulation }),
      ...(input.resolution === undefined ? {} : { inferenceResolution: input.resolution }),
      ...(input.links === undefined ? {} : { inferenceLinks: input.links }),
      ...(input.findings === undefined ? {} : { inferenceFindings: input.findings }),
    }))!;
    const was = inferenceOf(before);
    const now = inferenceOf(after);
    const changed = (Object.keys(now) as (keyof InferenceSettings)[]).filter((k) => was[k] !== now[k]);
    if (changed.length > 0) {
      await recordPolicyEvent(db, {
        organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor), event: 'inference_settings_changed',
        resource: { type: 'organisation', id: organisationId },
        detail: { ...Object.fromEntries(changed.map((k) => [k, now[k]])), changed: changed.join(',') },
      });
    }
    return now;
  });
}
