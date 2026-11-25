// A connection's stream health (spec 18.7), held in redis-state: live, delayed, stale or
// stopped, the source in use, when it last delivered, and why it is not live. A move between
// them is audited (stream_delayed, stream_stale, stream_recovered); every clone the stream
// serves shows it, because a clone that looks live and is not is the failure invariant 10
// designs against.

import { changeStatusKeys } from '../../infra/keyspaces.infra.ts';
import type { CdcSlot } from '../../models/connect/cdcSlot.model.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordStreamEvent, type ChangeStreamDeps } from './deps.service.ts';

export type StreamHealth = 'live' | 'delayed' | 'stale' | 'stopped';
export type SourceInUse = 'webhook' | 'cdc' | 'poll' | 'email' | 'mqtt' | 'opcua' | 'none';

export interface HealthRecord {
  status: StreamHealth;
  source: SourceInUse;
  since: string;
  lastDeliveryAt?: string | undefined;
  lastDeltaAt?: string | undefined;
  reason?: string | undefined;
  gapReason?: 'spool_bound' | 'spool_age' | 'spool_damaged' | 'resumed_ahead' | undefined;
  gapChanges?: number | undefined;
  gapFrom?: string | undefined;
  gapTo?: string | undefined;
  gapAt?: string | undefined;
}

const EVENT_OF: Partial<Record<StreamHealth, 'stream_delayed' | 'stream_stale' | 'stream_recovered'>> = {
  delayed: 'stream_delayed', stale: 'stream_stale', live: 'stream_recovered',
};

export function createStreamHealth(deps: Pick<ChangeStreamDeps, 'state' | 'databases' | 'logger'>) {
  const key = (organisationId: string, connectionId: string) => changeStatusKeys.key(organisationId, { connectionId });

  async function read(organisationId: string, connectionId: string): Promise<HealthRecord | undefined> {
    return deps.state.readHash(changeStatusKeys, key(organisationId, connectionId));
  }

  /** Moves the stream to a state, auditing the move when it changes; records delivery times either way. */
  async function report(organisationId: string, connectionId: string, next: {
    status: StreamHealth; source: SourceInUse; reason?: string | undefined; delivered?: boolean; deltas?: boolean;
  }): Promise<HealthRecord> {
    const now = new Date().toISOString();
    const current = await read(organisationId, connectionId);
    const changed = current === undefined || current.status !== next.status || current.source !== next.source;
    const record: HealthRecord = {
      status: next.status, source: next.source, since: changed ? now : current.since,
      ...(next.delivered ? { lastDeliveryAt: now } : current?.lastDeliveryAt === undefined ? {} : { lastDeliveryAt: current.lastDeliveryAt }),
      ...(next.deltas ? { lastDeltaAt: now } : current?.lastDeltaAt === undefined ? {} : { lastDeltaAt: current.lastDeltaAt }),
      ...(next.status === 'live' || next.reason === undefined ? {} : { reason: next.reason.slice(0, 200) }),
      ...gapOf(current),
    };
    await deps.state.putHash(changeStatusKeys, key(organisationId, connectionId), record);
    // The first report is where a stream starts, not a recovery; a stopped stream is the
    // connection's own status, audited where it moved.
    const previous = current?.status;
    const event = changed && previous !== undefined && previous !== next.status ? EVENT_OF[next.status] : undefined;
    if (event !== undefined && previous !== undefined && !(event === 'stream_recovered' && previous === 'stopped')) {
      try {
        await inTransaction(deps.databases.pool('control'), { organisationId }, (db) => recordStreamEvent(db, {
          organisationId, correlationId: uuidv7(), event, connectionId,
          detail: { from: previous, to: next.status, source: next.source, ...(next.reason ? { reason: next.reason.slice(0, 200) } : {}) },
        }));
      } catch (error) {
        deps.logger.failure('a stream health change could not be audited', error, { event: 'stream.audit_failed', connectionId });
      }
    }
    return record;
  }

  /** Records changes lost on the way, kept with the stream's health whatever it moves to next. */
  async function noteGap(organisationId: string, connectionId: string, gap: Required<Pick<HealthRecord, 'gapReason'>> & Pick<HealthRecord, 'gapChanges' | 'gapFrom' | 'gapTo'>)
    : Promise<void> {
    const current = await read(organisationId, connectionId);
    const now = new Date().toISOString();
    const record: HealthRecord = {
      ...(current ?? { status: 'live', source: 'cdc', since: now }),
      gapReason: gap.gapReason, gapAt: now,
      ...(gap.gapChanges === undefined ? {} : { gapChanges: gap.gapChanges }),
      ...(gap.gapFrom === undefined ? {} : { gapFrom: gap.gapFrom }),
      ...(gap.gapTo === undefined ? {} : { gapTo: gap.gapTo }),
    };
    if (gap.gapChanges === undefined) delete record.gapChanges;
    if (gap.gapFrom === undefined) delete record.gapFrom;
    if (gap.gapTo === undefined) delete record.gapTo;
    await deps.state.putHash(changeStatusKeys, key(organisationId, connectionId), record);
  }

  return { read, report, noteGap };
}

const gapOf = (current: HealthRecord | undefined): Partial<HealthRecord> => (current?.gapReason === undefined ? {} : {
  gapReason: current.gapReason, ...(current.gapAt ? { gapAt: current.gapAt } : {}),
  ...(current.gapChanges === undefined ? {} : { gapChanges: current.gapChanges }),
  ...(current.gapFrom ? { gapFrom: current.gapFrom } : {}), ...(current.gapTo ? { gapTo: current.gapTo } : {}),
});

export type StreamHealthStore = ReturnType<typeof createStreamHealth>;

/** An agent of the connection's pool holds the capture's lease, so it is being read. */
export const isReading = (capture: Pick<CdcSlot, 'status' | 'leasedByAgentId' | 'leaseExpiresAt'>, now = Date.now()): boolean =>
  capture.status === 'active' && capture.leasedByAgentId !== null && capture.leaseExpiresAt !== null && Date.parse(capture.leaseExpiresAt) > now;
