// Keeping the subscriptions this replica opened honest (spec 30.1, 30.3, 18.7).
//
// Projection: every few seconds the organisations' policy versions are read; when one has
// moved, each of its subscribers is resolved again under its own permissions. A subscriber
// whose fingerprint changed is sent projection_changed with what it may now see of its
// group (a widened grant shows on its next subscribe; a narrowed one takes effect at once,
// and the gateway removes withheld values from deltas still waiting); one that may no
// longer see the set at all is told everything is withheld, and its subscription ends.
// The target is 5 seconds from the change to delivery stopping (spec 30.1).
//
// Source status: each group is told when the health of its source changes (healthy,
// lagging, stale or down, with the age or reason; not live where an admin's fallback polls
// it), so a clone never looks live when its stream is not delivering (spec 18.7 binding rule).
//
// Backfill on recovery (spec 18.5, 18.7): a group whose source comes back healthy after being
// stale or down, or that lost changes in a gap noted since the group was read, is read again
// under a subscriber's own permissions, within the live bounds. A value changed since the read
// began is kept; the changes observed meanwhile are applied over it; each subscriber is sent
// the group's state anew, told first that it is rebuilding where its stream had looked live.
// stream_backfill_completed records it. A set grown past its bounds is left stale, saying so.
//
// Mode: every minute, each subscription's source is asked again whether it is live, polled or
// unavailable (decision 2026-11-15). One whose mode moved is ended, so its viewer subscribes
// again and is told the new mode: Silo never moves a clone from live to polled unannounced.

import { getStreamStatus } from '../../contracts/change-stream/stream.contract.ts';
import { changeStatusKeys } from '../../infra/keyspaces.infra.ts';
import type { DeltaApplier } from '../../services/state-plane/deltas.service.ts';
import { recordBackfilled, recordSourceStatus, recordSubscription } from '../../services/state-plane/deps.service.ts';
import { rowIdOf } from '../../services/state-plane/subscriptions.service.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import { policyVersionRepo } from '../../repos/iam/index.repo.ts';
import type { StatePlaneDeps } from '../../services/state-plane/deps.service.ts';
import type { GroupStore } from '../../services/state-plane/groups.service.ts';
import { resolveSet } from '../../services/state-plane/resolver.service.ts';
import { sourceStatusOf } from '../../services/state-plane/sourceStatus.service.ts';
import { requestOf, type HeldSubscription, type Subscriptions } from '../../services/state-plane/subscriptions.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

/** How often each source's mode is asked again. */
const MODE_CHECK_MS = 60_000;

export function watchWorker(deps: StatePlaneDeps, groups: GroupStore, subscriptions: Subscriptions, tickMs: number, applier: DeltaApplier): Worker {
  const versions = new Map<string, number>();
  const statusSent = new Map<string, string>();
  const modesChecked = new Map<string, number>();
  /** Per group: the source health last seen, and the gap (its time) it was last read after. */
  const healthSeen = new Map<string, string>();
  const gapRead = new Map<string, string>();
  const retryAt = new Map<string, number>();

  /** Reads the group's set again and sends each subscriber its state (18.5); false where it cannot be. */
  async function backfill(groupId: string, subs: HeldSubscription[], reason: 'recovered' | 'gap'): Promise<boolean> {
    const first = subs[0]!;
    const organisationId = first.holder.organisationId;
    const correlationId = uuidv7();
    const resolution = await resolveSet(deps.services, requestOf(first.holder), first.set, first.requested, correlationId).catch(() => undefined);
    // A changed permission is the policy watch's to tell; a set it cannot resolve stays stale.
    if (resolution === undefined || resolution.outcome === 'refused' || resolution.fingerprint !== first.fingerprint) return false;
    let snapshot;
    try {
      snapshot = await resolution.read();
    } catch (error) {
      deps.logger.failure('a live group could not be read again after its stream recovered; its clones stay stale', error, {
        event: 'live.backfill_failed', organisationId, resourceType: 'subscription_group', resourceId: groupId,
      });
      return false;
    }
    const readStartedAt = new Date(snapshot.readStartedAt).toISOString();
    await groups.refresh(organisationId, groupId, resolution.plan, snapshot.objects, readStartedAt);
    await applier.drainPending(organisationId, resolution.plan.connectionId, resolution.plan.sourceObject, snapshot.readStartedAt);
    for (const sub of subs) await groups.snapshot(organisationId, groupId, resolution.plan, sub.subscriptionId);
    await inTransaction(deps.databases.pool('control'), { organisationId }, (db) => recordBackfilled(db, {
      organisationId, correlationId, connectionId: first.connectionId, objects: snapshot.objects.length, subscriptions: subs.length, reason,
    })).catch((error: unknown) => deps.logger.failure('a backfill could not be audited', error, { event: 'live.audit_failed' }));
    return true;
  }

  /** subscription_projection_changed (32.7): what a policy change left the subscriber, by count; ended when nothing. */
  async function projectionChanged(sub: HeldSubscription, granted: number, withheld: number, ended: boolean): Promise<void> {
    await inTransaction(deps.databases.pool('control'), { organisationId: sub.holder.organisationId }, (db) => recordSubscription(db, {
      organisationId: sub.holder.organisationId, membershipId: sub.holder.membershipId, correlationId: rowIdOf(sub.subscriptionId),
      event: 'subscription_projection_changed', set: sub.set, byStatePlane: true,
      detail: { subscription_id: rowIdOf(sub.subscriptionId), connection_id: sub.connectionId, granted, withheld, ended },
    })).catch((error: unknown) => deps.logger.failure('a projection change was not audited', error, { event: 'live.audit_failed' }));
  }

  /** Per organisation and connection: since when its clones have not been current (source_declared_stale until source_recovered). */
  const staleSince = new Map<string, number>();

  async function watchPolicy(): Promise<void> {
    const byOrganisation = new Map<string, string[]>();
    for (const sub of subscriptions.held.values()) {
      byOrganisation.set(sub.holder.organisationId, [...(byOrganisation.get(sub.holder.organisationId) ?? []), sub.subscriptionId]);
    }
    for (const [organisationId, ids] of byOrganisation) {
      const row = await inTransaction(deps.databases.pool('control'), { organisationId },
        (db) => policyVersionRepo.findByOrganisationId(db, organisationId), { readOnly: true });
      const version = Number(row?.version ?? 0);
      const seen = versions.get(organisationId);
      versions.set(organisationId, version);
      if (seen === undefined || seen === version) continue;
      for (const id of ids) {
        const sub = subscriptions.held.get(id);
        if (sub === undefined) continue;
        const again = await resolveSet(deps.services, requestOf(sub.holder), sub.set, sub.requested, uuidv7()).catch(() => undefined);
        if (again === undefined) continue;
        if (again.outcome === 'refused') {
          if (again.reason !== 'permission') continue;
          groups.publish(organisationId, sub.groupId, { type: 'projection_changed', granted: [], withheld: [...sub.requested].sort() }, id);
          await projectionChanged(sub, 0, sub.requested.length, true);
          await subscriptions.close(sub.holder, id, 'revoked');
          deps.logger.info('a live subscription ended on a policy change', { event: 'live.revoked', subscriptionId: id, organisationId });
          continue;
        }
        if (again.fingerprint === sub.fingerprint) continue;
        const now = new Set(again.plan.properties.map((p) => p.apiName));
        const granted = sub.granted.filter((name) => now.has(name));
        const withheld = sub.requested.filter((name) => !granted.includes(name)).sort();
        sub.fingerprint = again.fingerprint;
        sub.granted = granted;
        groups.publish(organisationId, sub.groupId, { type: 'projection_changed', granted, withheld }, id);
        await projectionChanged(sub, granted.length, withheld.length, false);
      }
    }
  }

  async function watchModes(): Promise<void> {
    const now = Date.now();
    const byConnection = new Map<string, HeldSubscription[]>();
    for (const sub of subscriptions.held.values()) {
      const key = `${sub.holder.organisationId}\u0000${sub.connectionId}`;
      byConnection.set(key, [...(byConnection.get(key) ?? []), sub]);
    }
    for (const key of modesChecked.keys()) if (!byConnection.has(key)) modesChecked.delete(key);
    for (const [key, subs] of byConnection) {
      if (now - (modesChecked.get(key) ?? 0) < MODE_CHECK_MS) continue;
      modesChecked.set(key, now);
      const first = subs[0]!;
      const stream = await deps.services.call(getStreamStatus, { params: { connectionId: first.connectionId } },
        { request: requestOf(first.holder), correlationId: uuidv7() });
      for (const sub of subs) {
        const streamed = stream.objects.find((o) => o.object === sub.sourceObject);
        const refresh = streamed?.mode === 'polled' ? streamed.refreshEverySeconds : null;
        const same = streamed !== undefined && streamed.mode !== 'unavailable' && refresh === sub.refreshEverySeconds;
        if (same) continue;
        await subscriptions.close(sub.holder, sub.subscriptionId, 'revoked');
        deps.logger.info('a live subscription ended: its source is no longer streamed as it was', {
          event: 'live.mode_changed', subscriptionId: sub.subscriptionId, organisationId: sub.holder.organisationId,
        });
      }
    }
  }

  async function watchSources(): Promise<void> {
    const groupsSeen = new Map<string, {
      organisationId: string; connectionId: string; polled?: { sourceObject: string; refreshEverySeconds: number }; subs: HeldSubscription[];
    }>();
    for (const sub of subscriptions.held.values()) {
      const seen = groupsSeen.get(sub.groupId);
      if (seen !== undefined) { seen.subs.push(sub); continue; }
      groupsSeen.set(sub.groupId, {
        organisationId: sub.holder.organisationId, connectionId: sub.connectionId, subs: [sub],
        ...(sub.refreshEverySeconds === null ? {} : { polled: { sourceObject: sub.sourceObject, refreshEverySeconds: sub.refreshEverySeconds } }),
      });
    }
    for (const groupId of [...healthSeen.keys()]) if (!groupsSeen.has(groupId)) { healthSeen.delete(groupId); gapRead.delete(groupId); retryAt.delete(groupId); }
    const now = Date.now();
    // Each source's clones that stopped being current this round, or became current again: by connection, summed over its groups.
    const turned = new Map<string, { organisationId: string; connectionId: string; event: 'source_declared_stale' | 'source_recovered'; status: string;
      ageMs: number | undefined; objects: number; subscriptions: number }>();
    const turn = async (organisationId: string, connectionId: string, groupId: string, subs: HeldSubscription[],
      event: 'source_declared_stale' | 'source_recovered', status: { status: string; ageMs?: number | undefined }) => {
      const key = `${organisationId}\u0000${connectionId}`;
      if ((event === 'source_declared_stale') === staleSince.has(key)) return;
      const objects = (await groups.read(organisationId, groupId))?.objectCount ?? 0;
      const seen = turned.get(key) ?? { organisationId, connectionId, event, status: status.status, ageMs: status.ageMs, objects: 0, subscriptions: 0 };
      seen.objects += objects;
      seen.subscriptions += subs.length;
      turned.set(key, seen);
    };
    for (const [groupId, { organisationId, connectionId, polled, subs }] of groupsSeen) {
      const status = await sourceStatusOf(deps.state, organisationId, connectionId, now, polled);
      // Backfill on recovery (18.5, 18.7): back to healthy after stale or down, or a gap noted since the group was read.
      const gapAt = (await deps.state.readHash(changeStatusKeys, changeStatusKeys.key(organisationId, { connectionId })))?.gapAt ?? '';
      const was = healthSeen.get(groupId);
      healthSeen.set(groupId, status.status);
      if (status.status === 'stale' || status.status === 'down') await turn(organisationId, connectionId, groupId, subs, 'source_declared_stale', status);
      else if (status.status === 'healthy') await turn(organisationId, connectionId, groupId, subs, 'source_recovered', status);
      // A gap noted before this replica first watched the group is already in the state it read.
      if (!gapRead.has(groupId)) gapRead.set(groupId, gapAt);
      const recovered = status.status === 'healthy' && (was === 'stale' || was === 'down');
      const gapped = status.status === 'healthy' && gapAt !== gapRead.get(groupId);
      if ((recovered || gapped) && now >= (retryAt.get(groupId) ?? 0)) {
        const readGap = gapRead.get(groupId) ?? '';
        gapRead.set(groupId, gapAt);
        if (!recovered) {
          // It looked live: say it is rebuilding while its objects are read again.
          statusSent.set(groupId, 'rebuilding');
          groups.publish(organisationId, groupId, { type: 'source_status', sources: [{
            source: connectionId, status: 'stale', reason: 'Rebuilding: changes were missed, so the objects are being read again',
          }] });
        }
        if (!await backfill(groupId, subs, recovered ? 'recovered' : 'gap')) {
          // Tried again in a minute; until then the clone goes on saying it is not live.
          if (was !== undefined) healthSeen.set(groupId, was);
          gapRead.set(groupId, readGap);
          retryAt.set(groupId, now + 60_000);
          continue;
        }
        retryAt.delete(groupId);
      } else if (recovered || gapped) {
        if (was !== undefined) healthSeen.set(groupId, was);
        continue;
      }
      const signature = `${status.status}:${status.reason ?? ''}`;
      if (statusSent.get(groupId) === signature) continue;
      statusSent.set(groupId, signature);
      groups.publish(organisationId, groupId, { type: 'source_status', sources: [status] });
    }
    for (const [key, t] of turned) {
      const since = staleSince.get(key);
      if (t.event === 'source_declared_stale') staleSince.set(key, now);
      else staleSince.delete(key);
      await inTransaction(deps.databases.pool('control'), { organisationId: t.organisationId }, (db) => recordSourceStatus(db, {
        organisationId: t.organisationId, event: t.event, connectionId: t.connectionId,
        detail: t.event === 'source_declared_stale'
          ? { status: t.status, objects: t.objects, subscriptions: t.subscriptions, node: deps.node, ...(t.ageMs === undefined ? {} : { age_ms: t.ageMs }) }
          : { objects: t.objects, subscriptions: t.subscriptions, node: deps.node, ...(since === undefined ? {} : { stale_ms: now - since }) },
      })).catch((error: unknown) => deps.logger.failure('a source\'s status change was not audited', error, { event: 'live.audit_failed' }));
    }
  }

  return {
    name: 'state-plane-watch',
    async run(signal) {
      while (!signal.aborted) {
        try {
          await watchPolicy();
        } catch (error) {
          deps.logger.failure('the policy watch failed; the next round retries', error, { event: 'live.policy_watch_failed' });
        }
        try {
          await watchSources();
        } catch (error) {
          deps.logger.failure('the source watch failed; the next round retries', error, { event: 'live.source_watch_failed' });
        }
        try {
          await watchModes();
        } catch (error) {
          deps.logger.failure('the mode watch failed; the next round retries', error, { event: 'live.mode_watch_failed' });
        }
        await sleep(tickMs, signal).catch(() => undefined);
      }
    },
  };
}
