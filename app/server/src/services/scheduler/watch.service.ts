// Change triggers (spec 40.2): a Cron that watches an object set evaluates when the set's
// changes arrive, through the change streams that feed the state plane, never once per
// change.
//
// - The watch keeps change interest registered for each source object behind the set's type
//   (redis-state, refreshed), so its streams deliver while the Cron watches, and takes the
//   deltas from bus-live as one queue across the scheduler's replicas.
// - A delta that changes a watched property's field, or brings an object in or takes one out
//   (an insert or a delete), makes the Cron due at the end of its window, unless it is due
//   sooner: changes coalesce over the window, and the run evaluates current state.
// - Changes arriving during a run become at most one pending follow-up (follow_up_pending),
//   run a window after the run ends.
// - A stream gone stale is a gap: reported once (automation_change_gap), never backfilled,
//   and current state is evaluated once when it resumes.
// Deltas carry values only on bus-live and in memory here: nothing is stored but run state.

import { sourceChange, type SourceChange } from '../../contracts/change-stream/delta.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import { getObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import { liveSubjects, type LiveBus } from '../../infra/bus.infra.ts';
import { changeStatusKeys, registerChangeInterest } from '../../infra/keyspaces.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import { automationRepo, automationRunRepo, automationRunStateRepo } from '../../repos/automation/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { cronActor, recordEvent, type SchedulerDeps } from './deps.service.ts';

/** How long registered interest lives without a refresh. */
const INTEREST_TTL_SECONDS = 120;

export interface Watch {
  /** Property identity ids watched. */
  properties: string[];
  windowSeconds: number;
}

interface Watcher {
  organisationId: string;
  automationId: string;
  windowSeconds: number;
  /** The watched properties' fields on this source object. */
  fields: Set<string>;
}

export interface WatchDeps extends SchedulerDeps {
  state: RedisStore;
  liveBus: LiveBus;
  cellId: string;
}

/** Whether a delta concerns a watcher: an object entering or leaving, or a watched field changing. */
export function concerns(delta: Pick<SourceChange, 'operation' | 'changed'>, fields: ReadonlySet<string>): boolean {
  if (delta.operation === 'insert' || delta.operation === 'delete') return true;
  return Object.keys(delta.changed).some((f) => fields.has(f));
}

export function createWatcher(deps: WatchDeps) {
  const control = deps.databases.pool('control');
  /** By organisation, connection and source object. */
  let watchers = new Map<string, Watcher[]>();
  const subscriptions = new Map<string, () => void>();
  const gaps = new Set<string>();
  const keyOf = (organisationId: string, connectionId: string, sourceObject: string) => `${organisationId}\u0000${connectionId}\u0000${sourceObject}`;

  /** Due a window from now, unless due sooner; a run in progress takes one pending follow-up instead. */
  async function markDue(organisationId: string, automationId: string, windowSeconds: number, now = deps.now()): Promise<void> {
    await inTransaction(control, { organisationId }, async (db) => {
      const row = await automationRepo.findForUpdate(db, automationId);
      if (!row || row.status !== 'active' || row.deletedAt !== null || row.watch === null) return;
      if ((await automationRunRepo.history(db, automationId, 1))[0]?.status === 'running') {
        await automationRunStateRepo.update(db, { organisationId, automationId }, { followUpPending: true });
        return;
      }
      const due = now + windowSeconds * 1000;
      if (row.nextRunAt === null || Date.parse(row.nextRunAt) > due) await automationRepo.update(db, automationId, { nextRunAt: new Date(due).toISOString() });
    });
  }

  function handle(delta: SourceChange): void {
    for (const w of watchers.get(keyOf(delta.organisationId, delta.connectionId, delta.object)) ?? []) {
      if (!concerns(delta, w.fields)) continue;
      void markDue(w.organisationId, w.automationId, w.windowSeconds).catch((error: unknown) => {
        deps.logger.failure('a change could not make its Cron due', error, { event: 'scheduler.watch_failed', organisationId: w.organisationId, resourceId: w.automationId });
      });
    }
  }

  return {
    markDue,
    handle,

    /** Loads the watching Crons, keeps their interest and subscriptions, and reports gaps. */
    async refresh(): Promise<number> {
      const next = new Map<string, Watcher[]>();
      const watching = await inTransaction(control, {}, (db) => automationRepo.watching(db, 1_000), { readOnly: true });
      for (const { organisationId, id } of watching) {
        try {
          const row = await inTransaction(control, { organisationId }, (db) => automationRepo.findById(db, id), { readOnly: true });
          if (!row || row.watch === null || row.objectSetId === null) continue;
          const watch = row.watch as unknown as Watch;
          const options = { request: { organisationId, servicePrincipalId: row.servicePrincipalId }, correlationId: uuidv7() };
          const set = await deps.services.call(getObjectSet, { params: { objectSetId: row.objectSetId } }, options);
          const manifest = await deps.services.call(getManifest, { query: {} }, options);
          const type = manifest.objectTypes.find((t) => t.id === set.baseTypeId);
          for (const c of type?.contributingObjects ?? []) {
            const fields = new Set(type!.properties.filter((p) => watch.properties.includes(p.identityId))
              .flatMap((p) => p.mappings.filter((m) => m.connectionId === c.connectionId && m.sourceObject === c.sourceObject).map((m) => m.fieldPath)));
            const key = keyOf(organisationId, c.connectionId, c.sourceObject);
            next.set(key, [...(next.get(key) ?? []), { organisationId, automationId: id, windowSeconds: watch.windowSeconds, fields }]);
            await registerChangeInterest(deps.state, deps.cellId, organisationId, c.connectionId, [c.sourceObject], INTEREST_TTL_SECONDS);
            if (!subscriptions.has(key)) {
              subscriptions.set(key, deps.liveBus.subscribe(sourceChange, liveSubjects.change(organisationId, c.connectionId, c.sourceObject),
                (delta) => handle(delta), { queue: 'scheduler-watch' }));
            }
            // A stream gone stale is a gap, told once; on resumption the Cron evaluates once.
            const status = (await deps.state.readHash(changeStatusKeys, changeStatusKeys.key(organisationId, { connectionId: c.connectionId })))?.['status'];
            const gapKey = `${id}\u0000${c.connectionId}`;
            if ((status === 'stale' || status === 'stopped') && !gaps.has(gapKey)) {
              gaps.add(gapKey);
              await inTransaction(control, { organisationId }, (db) => recordEvent(db, organisationId, uuidv7(), {
                event: 'automation_change_gap', actor: cronActor(row.servicePrincipalId), resource: { type: 'automation', id },
                detail: { connection_id: c.connectionId, status },
              }));
            } else if ((status === 'live' || status === 'delayed') && gaps.delete(gapKey)) {
              await markDue(organisationId, id, 0);
            }
          }
        } catch (error) {
          deps.logger.failure('a watching Cron could not be loaded; the next refresh retries', error, { event: 'scheduler.watch_refresh_failed', organisationId, resourceId: id });
        }
      }
      for (const [key, unsubscribe] of subscriptions) {
        if (!next.has(key)) {
          unsubscribe();
          subscriptions.delete(key);
        }
      }
      watchers = next;
      return watching.length;
    },

    close(): void {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    },
  };
}

export type Watcher_ = ReturnType<typeof createWatcher>;
