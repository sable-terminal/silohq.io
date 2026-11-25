// Choosing a source and polling with a watermark (spec 18.1, 18.4, 18.7).
//
// For each object the state plane holds live, the first healthy declared source is used, in
// the order webhook, CDC, polling: a webhook is healthy while its endpoint is active and it
// has delivered within the manifest's heartbeat; when it falls silent the stream is marked
// delayed and falls back to polling where declared. CDC runs in the Silo Agent, whose cell
// side is not built: an object with CDC only is not streamed, and says so.
//
// A poll reads, through connect-runtime with reason change_stream, the records whose
// watermark field is after the stored watermark, oldest first, at most POLL_PAGE at a time,
// and publishes each as an update. The watermark is the largest value read: a timestamp,
// sequence or cursor, never otherwise a record value (spec 18.9). The first poll only finds
// where the watermark stands (the state plane's snapshot holds current state). A watermark
// poll cannot see a record removed outright; where the manifest names a deleted marker
// (deletedField), a record whose marker is set is published as a delete. Polls share the
// connection's request budget with queries; a lock keeps two replicas from polling the same
// object at once.
//
// An object that is not subscribable (it has not passed the change-stream class) and that an
// admin lets be polled is polled at the admin's interval, never the manifest's shorter one
// (decision 2026-11-15).

import type { ChangeStreamObject } from '../../contracts/connect/manifest.contract.ts';
import { subscribabilityOf } from './subscribability.service.ts';
import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import type { PlanStepInput } from '../../contracts/connect/step.contract.ts';
import { changeWatermarkKeys, lockKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { cdcSlotRepo, webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { ChangeDeltaDraft } from '../expression-evaluator/evaluator.service.ts';
import type { ChangeStreamDeps } from './deps.service.ts';
import { publishChanges } from './publish.service.ts';
import { entityRefOf, type ConnectionSources, type StreamedObject } from './sources.service.ts';
import { isReading, type StreamHealthStore } from './status.service.ts';

export const POLL_PAGE = 1_000;

export type PollSource = Extract<ChangeStreamObject['sources'][number], { kind: 'poll' }>;

/** The object's declared poll source, if any. */
export const pollSourceOf = (streamed: StreamedObject): PollSource | undefined =>
  streamed.stream.sources.find((s): s is PollSource => s.kind === 'poll');

/** A deleted marker is set: anything but null, false, zero, empty or "false". */
const marked = (value: unknown): boolean => value !== null && value !== undefined && value !== false && value !== 0 && value !== '' && value !== 'false';

/** The changes in a page read past a watermark, and the watermark after it (pure). */
export function draftsFromPage(streamed: StreamedObject, poll: Pick<PollSource, 'watermarkField' | 'deletedField'>, rows: readonly Record<string, unknown>[],
  from: string | null): { drafts: ChangeDeltaDraft[]; watermark: string | null } {
  const field = poll.watermarkField;
  let watermark = from;
  const drafts: ChangeDeltaDraft[] = [];
  for (const row of rows) {
    const entityRef = entityRefOf(streamed.object, row);
    const mark = row[field];
    if (mark !== null && mark !== undefined && (watermark === null || laterThan(String(mark), watermark))) watermark = String(mark);
    if (entityRef === undefined) continue;
    const deleted = poll.deletedField !== undefined && marked(row[poll.deletedField]);
    drafts.push({
      object: streamed.object.name, entityRef, operation: deleted ? 'delete' : 'update', changed: (deleted ? {} : row) as Record<string, never>,
      ...(mark === null || mark === undefined ? {} : { sourceSeq: String(mark) }),
    });
  }
  return { drafts, watermark };
}

export type PollResult = 'polled' | 'not_due' | 'webhook' | 'cdc' | 'not_streamed' | 'busy' | 'failed';

/** Watermarks order as numbers when both are numbers, else as text (ISO timestamps, positions). */
export function laterThan(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  return a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y) ? x > y : a > b;
}

/** Decides the source for each live object of a connection this round, and polls those due. */
export async function serviceConnection(deps: ChangeStreamDeps, health: StreamHealthStore, sources: ConnectionSources,
  objects: ReadonlySet<string>, now: Date = new Date()): Promise<Map<string, PollResult>> {
  const { connection, manifest } = sources;
  const organisationId = connection.organisationId;
  const results = new Map<string, PollResult>();
  if (connection.status !== 'active') {
    await health.report(organisationId, connection.id, { status: 'stopped', source: 'none', reason: `connection ${connection.status}` });
    return results;
  }
  const webhookBlock = manifest.changeStream?.webhook;
  let webhookUsable = false;
  // A silent webhook leaves the stream delayed while polling stands in (spec 18.7), until a
  // delivery arrives and the stream recovers.
  let webhookSilent = false;
  if (webhookBlock !== undefined) {
    const endpoint = await inTransaction(deps.databases.pool('control'), { organisationId },
      (db) => webhookEndpointRepo.liveInbound(db, connection.id), { readOnly: true });
    webhookUsable = endpoint?.status === 'active';
    if (webhookUsable && webhookBlock.heartbeatSeconds !== undefined) {
      const record = await health.read(organisationId, connection.id);
      const heard = record?.lastDeliveryAt ?? endpoint!.lastDeliveryAt ?? endpoint!.createdAt;
      if (now.getTime() - Date.parse(heard) > webhookBlock.heartbeatSeconds * 1000) {
        if (record?.status !== 'delayed') {
          await health.report(organisationId, connection.id, {
            status: 'delayed', source: 'webhook', reason: 'no webhook delivery within the declared heartbeat',
          });
        }
        webhookUsable = false;
        webhookSilent = true;
      }
    }
  }
  const { modes, capture } = await inTransaction(deps.databases.pool('control'), { organisationId }, async (db) => ({
    modes: await subscribabilityOf(db, connection, [...objects]),
    capture: [...sources.streamed.values()].some((s) => s.kinds.includes('cdc')) ? await cdcSlotRepo.currentFor(db, connection.id) : undefined,
  }), { readOnly: true });
  // Change data capture while an agent of the pool reads it (its lease follows the agent's
  // heartbeat); without a reader the stream is stale, and polling stands in where declared.
  const captured = capture !== undefined && isReading(capture, now.getTime());
  let captureLapsed = false;
  for (const name of objects) {
    const streamed = sources.streamed.get(name);
    if (streamed === undefined) continue;
    if (streamed.kinds.includes('webhook') && webhookUsable) {
      results.set(name, 'webhook');
      continue;
    }
    if (streamed.kinds.includes('cdc')) {
      if (captured) {
        results.set(name, 'cdc');
        continue;
      }
      captureLapsed = capture !== undefined;
    }
    const poll = pollSourceOf(streamed);
    if (poll === undefined) {
      results.set(name, 'not_streamed');
      continue;
    }
    const fallback = modes.get(name)?.mode === 'polled' ? modes.get(name)!.fallback : null;
    const interval = Math.max(poll.intervalSeconds, fallback?.intervalSeconds ?? 0);
    results.set(name, await pollObject(deps, health, sources, streamed, { ...poll, intervalSeconds: interval }, now, webhookSilent));
  }
  // With nothing standing in, a capture no agent reads leaves the stream stale (spec 18.7).
  const standIn = [...results.values()].some((r) => r === 'polled' || r === 'not_due' || r === 'busy' || r === 'webhook');
  if (captureLapsed && !standIn && (await health.read(organisationId, connection.id))?.status !== 'stale') {
    await health.report(organisationId, connection.id, {
      status: 'stale', source: 'cdc', reason: capture!.status === 'lost' ? 'the replication slot was lost on the source: set up change capture again'
        : capture!.status === 'dropping' ? 'change data capture is being dropped' : 'no Silo Agent of the connection\'s pool is reading the change capture',
    });
  }
  return results;
}

async function pollObject(deps: ChangeStreamDeps, health: StreamHealthStore, sources: ConnectionSources, streamed: StreamedObject,
  poll: PollSource, now: Date, fallback: boolean): Promise<PollResult> {
  const healthy = fallback
    ? { status: 'delayed' as const, source: 'poll' as const, reason: 'no webhook delivery within the declared heartbeat; polling' }
    : { status: 'live' as const, source: 'poll' as const };
  const { connection } = sources;
  const organisationId = connection.organisationId;
  const objectName = streamed.object.name;
  const lockKey = lockKeys.key(organisationId, { purpose: 'stream_poll', resourceId: `${connection.id}.${objectName}` });
  const token = await deps.data.acquireLock(lockKeys, lockKey, 30);
  if (token === undefined) return 'busy';
  try {
    const watermarkKey = changeWatermarkKeys.key(organisationId, { connectionId: connection.id, object: objectName });
    const stored = await deps.state.read(changeWatermarkKeys, watermarkKey);
    if (stored !== undefined && now.getTime() - Date.parse(stored.polledAt) < poll.intervalSeconds * 1000) return 'not_due';
    const request = { organisationId };
    const field = poll.watermarkField;
    const read = (step: PlanStepInput) =>
      deps.services.call(readObject, { body: { connectionId: connection.id, reason: 'change_stream', step } },
        { request, correlationId: uuidv7(), timeoutMs: 60_000 });
    try {
      if (stored === undefined || stored.watermark === null) {
        // Where the watermark stands now; the snapshot holds current state.
        const latest = await read({ object: objectName, fields: [field], sort: [{ field, direction: 'desc' }], limit: 1 });
        const value = latest.rows[0]?.[field];
        await deps.state.put(changeWatermarkKeys, watermarkKey, {
          watermark: value === undefined || value === null ? null : String(value), polledAt: now.toISOString(),
        });
        await health.report(organisationId, connection.id, healthy);
        return 'polled';
      }
      const page = await read({
        object: objectName, filters: [{ field, op: 'gt', value: stored.watermark }], sort: [{ field, direction: 'asc' }], limit: POLL_PAGE,
      });
      const paged = draftsFromPage(streamed, poll, page.rows, stored.watermark);
      const watermark = paged.watermark ?? stored.watermark;
      const drafts = paged.drafts;
      const outcome = drafts.length === 0 ? { objects: new Set<string>() } : await publishChanges(deps, sources, 'poll', drafts, now);
      // A full page: poll again next round rather than after the interval.
      const polledAt = page.rows.length >= POLL_PAGE ? new Date(now.getTime() - poll.intervalSeconds * 1000).toISOString() : now.toISOString();
      await deps.state.put(changeWatermarkKeys, watermarkKey, { watermark, polledAt });
      await health.report(organisationId, connection.id, { ...healthy, deltas: outcome.objects.size > 0 });
      return 'polled';
    } catch (error) {
      const reason = isAppError(error) ? `poll failed: ${error.code}` : 'poll failed';
      deps.logger.failure('a change poll failed', error, { event: 'stream.poll_failed', connectionId: connection.id });
      await deps.state.put(changeWatermarkKeys, watermarkKey, { watermark: stored?.watermark ?? null, polledAt: now.toISOString() });
      await health.report(organisationId, connection.id, { status: 'stale', source: 'poll', reason });
      return 'failed';
    }
  } finally {
    await deps.data.releaseLock(lockKeys, lockKey, token).catch(() => undefined);
  }
}
