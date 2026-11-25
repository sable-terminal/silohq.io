// Change data capture's side in change-stream (spec 18.1, 18.2, 18.7): what the reading agent
// reports, through connect-runtime, which holds its lease.
//
// - Changes: "Every source decodes into one delta shape, through ... the built-in decoder for
//   CDC." A captured row belongs to the streamed object whose SQL source is its table and
//   whose stream declares cdc; its columns become the object's fields (a field's column, else
//   its name), read as reads read them (coerce), its identifier fields give the entity, and its
//   place in the log is the delta's source sequence, so the slot's changes order as text.
//   A row of a table no streamed object reads is discarded and counted. The stream is live.
// - Started: the reader streams from the log; the stream is live (a capture taken over by
//   another agent recovers here, before any change arrives).
// - Lost: the slot is gone or invalidated on the source. What it held is lost, so the capture
//   is lost (cdc_slot_lost) and the stream stale until a new capture is set up; polling stands
//   in where the manifest declares it.
// - Dropped: an agent dropped the slot a person asked to drop (cdc_slot_dropped, naming them).
// - Gap: the agent's spool dropped changes at its bound, or a resumed reader found the source
//   past the acknowledged position (spec 10.6); counts and times stay with the stream's health
//   and show in its status, so the clones over it say what they may be missing.
// - Failed: the reader stopped or never started; the stream is stale with the reason, and
//   connect-runtime offers the slot again, to this agent later or to another of the pool.
//
// Values exist here only in memory, as in publish.service.

import type { CaptureFailure, CapturedChange, CapturedSample, SpoolGapReason } from '../../contracts/connect-runtime/agentTunnel.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { cdcSlotRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import type { MqttSource } from '../../contracts/connect/manifest.contract.ts';
import { parametersOf } from '../../contracts/connect/parameters.contract.ts';
import { coerce, getPath, type ReadStats } from '../connect-runtime/engine.service.ts';
import { decodeMqttPayload } from '../connect-runtime/protocols/mqtt/payload.protocol.ts';
import { compileExpression, type ChangeDeltaDraft } from '../expression-evaluator/evaluator.service.ts';
import { recordStreamEvent, type ChangeStreamDeps } from './deps.service.ts';
import { publishChanges } from './publish.service.ts';
import { entityRefOf, type ConnectionSources, type SourceCatalogue, type StreamedObject } from './sources.service.ts';
import type { StreamHealthStore } from './status.service.ts';

/** Postgres resolves an unqualified table in the schema it searches first. */
const DEFAULT_SCHEMA = 'public';

/** The captured rows as deltas of the objects that stream them from change data capture; the rows no object reads. */
export function draftsFromCapture(sources: ConnectionSources, changes: readonly CapturedChange[], committedAt: string)
  : { drafts: ChangeDeltaDraft[]; unmatched: number; typeMismatches: number } {
  const tables = new Map<string, StreamedObject>();
  for (const streamed of sources.streamed.values()) {
    const source = streamed.object.source;
    if (!streamed.kinds.includes('cdc') || source.kind !== 'sql') continue;
    tables.set(JSON.stringify([source.schema ?? DEFAULT_SCHEMA, source.table]), streamed);
  }
  const stats: ReadStats = { pages: 0, sourceRows: 0, typeMismatches: 0, retries: 0 };
  const drafts: ChangeDeltaDraft[] = [];
  let unmatched = 0;
  for (const change of changes) {
    const streamed = tables.get(JSON.stringify([change.schema, change.table]));
    if (streamed === undefined) {
      unmatched += 1;
      continue;
    }
    const row: Record<string, unknown> = {};
    for (const field of streamed.object.fields) {
      const column = field.column ?? field.name;
      if (Object.hasOwn(change.values, column)) row[field.name] = coerce(change.values[column], field.type, stats);
    }
    const entityRef = entityRefOf(streamed.object, row);
    if (entityRef === undefined) {
      unmatched += 1;
      continue;
    }
    drafts.push({
      object: streamed.object.name, entityRef, operation: change.op, sourceAt: committedAt, sourceSeq: change.position,
      // A delete names the entity; the rest carry the columns the log sent (an unchanged large value is not sent).
      changed: change.op === 'delete' ? {} : row as ChangeDeltaDraft['changed'],
    });
  }
  return { drafts, unmatched, typeMismatches: stats.typeMismatches };
}

/** An MQTT topic filter as a test on a topic: + one whole level, # the rest. */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i += 1) {
    if (f[i] === '#') return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

/**
 * MQTT messages (20.2) as deltas of the objects that stream them by MQTT: a message belongs to
 * each such object whose topic filter it matches, decoded by the object's decode over { topic
 * levels, payload, receivedAt }; its identifier fields give the entity, and the time the agent
 * received it is the delta's source time. A message no object takes, or one whose payload does
 * not parse as declared (JSON, text or Sparkplug B), is discarded and counted.
 */
export async function draftsFromMessages(sources: ConnectionSources, messages: readonly CapturedMessage[])
  : Promise<{ drafts: ChangeDeltaDraft[]; unmatched: number }> {
  const streamed = [...sources.streamed.values()].filter((s) => s.kinds.includes('mqtt') && s.object.source.kind === 'mqtt');
  const stats: ReadStats = { pages: 0, sourceRows: 0, typeMismatches: 0, retries: 0 };
  const params = parametersOf(sources.connection.parameters);
  const drafts: ChangeDeltaDraft[] = [];
  let unmatched = 0;
  for (const message of messages) {
    let taken = false;
    for (const s of streamed) {
      const source = s.object.source as MqttSource;
      if (!topicMatches(source.topic, message.topic)) continue;
      const decoded = decodeMqttPayload(source, sources.connection.id, message.topic, message.payload);
      if (!decoded.ok) continue;
      const payload = decoded.payload;
      const record = await compileExpression('source.decode', 'jsonata', source.decode.jsonata)
        .evaluate({ input: { topic: message.topic.split('/'), payload, receivedAt: message.receivedAt }, params }, new Date(message.receivedAt));
      if (record === null || record === undefined || typeof record !== 'object') continue;
      const row: Record<string, unknown> = {};
      for (const field of s.object.fields) {
        const value = getPath(record, field.path ?? field.name);
        if (value !== undefined) row[field.name] = coerce(value, field.type, stats);
      }
      const entityRef = entityRefOf(s.object, row);
      if (entityRef === undefined) continue;
      drafts.push({ object: s.object.name, entityRef, operation: 'update', sourceAt: message.receivedAt, changed: row as ChangeDeltaDraft['changed'] });
      taken = true;
    }
    if (!taken) unmatched += 1;
  }
  return { drafts, unmatched };
}

/**
 * OPC UA samples (spec 20.3) as deltas: one partial update a sample, naming the record by its
 * instance ($browseName or $nodeId, as the object's identifier fields say), the field at the
 * sample's browse path, and the server's timestamp as source_at (else the source's, else now).
 * A bad value is not a change of the record: counted as unmatched.
 */
export function draftsFromSamples(sources: ConnectionSources, samples: readonly CapturedSample[], now = new Date())
  : { drafts: ChangeDeltaDraft[]; unmatched: number } {
  const stats: ReadStats = { pages: 0, sourceRows: 0, typeMismatches: 0, retries: 0 };
  const drafts: ChangeDeltaDraft[] = [];
  let unmatched = 0;
  for (const sample of samples) {
    const s = sources.streamed.get(sample.object);
    if (s === undefined || !s.kinds.includes('opcua') || s.object.source.kind !== 'opc_ua' || sample.status === 'bad') {
      unmatched += 1;
      continue;
    }
    const row: Record<string, unknown> = {};
    for (const field of s.object.fields) {
      const path = field.path ?? field.name;
      if (path === '$browseName') row[field.name] = sample.browseName;
      else if (path === '$nodeId') row[field.name] = sample.nodeId;
      else if (path === sample.path) row[field.name] = coerce(sample.value, field.type, stats);
    }
    const entityRef = entityRefOf(s.object, row);
    if (entityRef === undefined || Object.keys(row).length === s.object.identifier.length) {
      unmatched += 1;
      continue;
    }
    drafts.push({
      object: s.object.name, entityRef, operation: 'update', sourceAt: sample.serverAt ?? sample.sourceAt ?? now.toISOString(),
      changed: row as ChangeDeltaDraft['changed'],
    });
  }
  return { drafts, unmatched };
}

/** The source a capture's health is told as. */
const sourceOf = (method: string): 'cdc' | 'mqtt' | 'opcua' => (method === 'mqtt' || method === 'opcua' ? method : 'cdc');

const FAILURE_REASONS: Record<CaptureFailure, string> = {
  not_configured: 'the reading agent holds no replication login for this connection',
  source_not_configured: 'the source does not log what change capture needs: the reading agent\'s log names the setting',
  capacity: 'the reading agent runs as many change capture readers as it may',
  source_refused: 'the source refused replication',
  source_unreachable: 'the reading agent cannot reach the source for replication',
  internal: 'the reading agent\'s change capture failed',
  target_refused: 'the reading agent\'s host does not let it reach the broker or server: its owner adds it to targets in the agent\'s configuration',
  login_refused: 'the reading agent did not take the connection\'s login',
};

/** An MQTT message as the agent delivered it: the payload base64. */
export interface CapturedMessage { topic: string; payload: string; retained: boolean; receivedAt: string }

export type CaptureReport =
  | { kind: 'changes'; agentId: string; committedAt: string; changes: CapturedChange[] }
  | { kind: 'messages'; agentId: string; messages: CapturedMessage[] }
  | { kind: 'samples'; agentId: string; samples: CapturedSample[] }
  | { kind: 'started'; agentId: string }
  | { kind: 'lost'; agentId: string }
  | { kind: 'dropped'; agentId: string }
  | { kind: 'failed'; agentId: string; category: CaptureFailure; sqlstate?: string | undefined }
  | { kind: 'gap'; agentId: string; reason: SpoolGapReason; changes?: number | undefined; from?: string | undefined; to?: string | undefined };

export function createCaptureReports(deps: ChangeStreamDeps, catalogue: SourceCatalogue, health: StreamHealthStore) {
  const control = deps.databases.pool('control');

  return {
    async report(request: { organisationId: string }, correlationId: string, slotId: string, report: CaptureReport)
      : Promise<{ accepted: number; discarded: number }> {
      const organisationId = request.organisationId;
      const slot = await inTransaction(control, request, (db) => cdcSlotRepo.findById(db, slotId), { readOnly: true });
      if (slot === undefined) throw new AppError('not_found', 'no such change capture', { code: 'stream.capture_not_found' });
      const connectionId = slot.connectionId;

      switch (report.kind) {
        case 'changes': {
          if (slot.status !== 'active') return { accepted: 0, discarded: report.changes.length };
          const sources = await catalogue.load(request, connectionId);
          if (sources.connection.status !== 'active') return { accepted: 0, discarded: report.changes.length };
          const decoded = draftsFromCapture(sources, report.changes, report.committedAt);
          const outcome = decoded.drafts.length === 0 ? { accepted: 0, discarded: 0, objects: new Set<string>() }
            : await publishChanges(deps, sources, 'cdc', decoded.drafts);
          await health.report(organisationId, connectionId, { status: 'live', source: 'cdc', delivered: true, deltas: outcome.objects.size > 0 });
          if (decoded.unmatched > 0 || decoded.typeMismatches > 0) {
            deps.logger.info('captured rows no streamed object reads', {
              event: 'stream.cdc_unmatched', connectionId, count: decoded.unmatched, rowCount: decoded.typeMismatches,
            });
          }
          return { accepted: outcome.accepted, discarded: outcome.discarded + decoded.unmatched };
        }
        case 'messages': {
          // MQTT telemetry (20.2, 20.6): decoded here with each object's decode, live only, values in memory.
          if (slot.status !== 'active') return { accepted: 0, discarded: report.messages.length };
          const sources = await catalogue.load(request, connectionId);
          if (sources.connection.status !== 'active') return { accepted: 0, discarded: report.messages.length };
          const decoded = await draftsFromMessages(sources, report.messages);
          const outcome = decoded.drafts.length === 0 ? { accepted: 0, discarded: 0, objects: new Set<string>() }
            : await publishChanges(deps, sources, 'mqtt', decoded.drafts);
          await health.report(organisationId, connectionId, { status: 'live', source: 'mqtt', delivered: true, deltas: outcome.objects.size > 0 });
          return { accepted: outcome.accepted, discarded: outcome.discarded + decoded.unmatched };
        }
        case 'samples': {
          // OPC UA subscriptions (20.3): live only, values in memory.
          if (slot.status !== 'active') return { accepted: 0, discarded: report.samples.length };
          const sources = await catalogue.load(request, connectionId);
          if (sources.connection.status !== 'active') return { accepted: 0, discarded: report.samples.length };
          const decoded = draftsFromSamples(sources, report.samples);
          const outcome = decoded.drafts.length === 0 ? { accepted: 0, discarded: 0, objects: new Set<string>() }
            : await publishChanges(deps, sources, 'opcua', decoded.drafts);
          await health.report(organisationId, connectionId, { status: 'live', source: 'opcua', delivered: true, deltas: outcome.objects.size > 0 });
          return { accepted: outcome.accepted, discarded: outcome.discarded + decoded.unmatched };
        }
        case 'started': {
          if (slot.status === 'active' && slot.leasedByAgentId === report.agentId) {
            await health.report(organisationId, connectionId, { status: 'live', source: sourceOf(slot.method) });
          }
          return { accepted: 0, discarded: 0 };
        }
        case 'lost': {
          const lost = await inTransaction(control, request, async (db) => {
            const row = await cdcSlotRepo.markLost(db, slotId, report.agentId);
            if (row !== undefined) {
              await recordStreamEvent(db, {
                organisationId, correlationId, event: 'cdc_slot_lost', connectionId, detail: { slot_id: slotId, slot_name: row.slotName },
              });
            }
            return row;
          });
          if (lost !== undefined) {
            await health.report(organisationId, connectionId, {
              status: 'stale', source: 'cdc', reason: 'the replication slot was lost on the source: set up change capture again',
            });
            deps.logger.warn('a change capture slot was lost', { event: 'stream.cdc_slot_lost', connectionId, resourceId: slotId });
          }
          return { accepted: 0, discarded: 0 };
        }
        case 'dropped': {
          await inTransaction(control, request, async (db) => {
            const row = await cdcSlotRepo.markDropped(db, slotId, report.agentId);
            if (row !== undefined) {
              await recordStreamEvent(db, {
                organisationId, correlationId, event: 'cdc_slot_dropped', membershipId: row.droppedBy ?? undefined, connectionId,
                detail: { slot_id: slotId, slot_name: row.slotName, agent_id: report.agentId },
              });
            }
          });
          return { accepted: 0, discarded: 0 };
        }
        case 'gap': {
          // Changes lost on the way: kept with the stream's health, so the clones over it say so.
          await health.noteGap(organisationId, connectionId, {
            gapReason: report.reason, gapChanges: report.changes, gapFrom: report.from, gapTo: report.to,
          });
          deps.logger.warn('changes were lost on the way from the agent', {
            event: 'stream.cdc_gap', connectionId, resourceId: slotId, count: report.changes ?? 0, reason: report.reason,
          });
          return { accepted: 0, discarded: 0 };
        }
        case 'failed': {
          if (slot.status === 'active') {
            const reason = FAILURE_REASONS[report.category] + (report.sqlstate === undefined ? '' : ` (SQLSTATE ${report.sqlstate})`);
            await health.report(organisationId, connectionId, { status: 'stale', source: sourceOf(slot.method), reason });
          }
          return { accepted: 0, discarded: 0 };
        }
      }
    },
  };
}

export type CaptureReports = ReturnType<typeof createCaptureReports>;
