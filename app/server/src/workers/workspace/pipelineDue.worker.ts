// The pipeline schedules' due sweep (D241): every tick, claims the schedules whose time has come
// (workspace.claim_due_pipeline_schedules: a lease, so two replicas never take the same run) and
// runs each as its own principal (pipelines.service.ts runDue). Missed times are counted, never
// backfilled. A run that fails is recorded with why; the lease lapses on a crash and the next
// sweep retries.

import type { Worker } from '../../infra/service.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { pipelineScheduleRepo } from '../../repos/workspace/index.repo.ts';
import type { WorkspaceDeps } from '../../services/workspace/deps.service.ts';
import { runDue } from '../../services/workspace/pipelines.service.ts';
import { sleep } from '../../utils/time.util.ts';

export interface PipelineSweep { tickMs: number; batch: number; concurrency: number; now: () => number }

export function pipelineDueWorker(deps: WorkspaceDeps, sweep: PipelineSweep): Worker {
  const control = deps.databases.pool('control');
  const inFlight = new Set<Promise<void>>();
  return {
    name: 'workspace-pipeline-due',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const room = Math.max(0, sweep.concurrency - inFlight.size);
          const due = room === 0 ? [] : await inTransaction(control, {}, (db) =>
            pipelineScheduleRepo.claimDue(db, Math.min(room, sweep.batch), new Date(sweep.now()).toISOString()));
          for (const claim of due) {
            const job: Promise<void> = runDue(deps, claim.organisationId, claim.pipelineId, claim.nextRunAt, sweep.now())
              .catch((error: unknown) => {
                deps.logger.failure('a due pipeline could not be run; its lease lapses and the next sweep retries', error, {
                  event: 'workspace.pipeline_due_failed', organisationId: claim.organisationId, resourceId: claim.pipelineId,
                });
              })
              .finally(() => { inFlight.delete(job); });
            inFlight.add(job);
          }
        } catch (error) {
          deps.logger.failure('the pipeline sweep failed; the next tick retries', error, { event: 'workspace.pipeline_sweep_failed' });
        }
        await sleep(sweep.tickMs, signal).catch(() => undefined);
      }
      await Promise.allSettled([...inFlight]);
    },
  };
}
