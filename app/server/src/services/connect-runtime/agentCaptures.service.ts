// Change data capture through the agents this connect-runtime holds tunnels for (spec 10.3,
// 10.4, 18.1; contracts/connect-runtime/agentTunnel.contract.ts).
//
// - "A CDC reader holds a lease on its log position, renewed with the heartbeat; another agent
//   resumes from the last acknowledged position on lease loss." On a heartbeat an agent renews
//   the leases it holds (a third of the way through them), and takes at most one more slot of
//   its pool that no agent holds, up to 16 (spec 10.7): it is told cdc.start, with the position
//   the cell acknowledged last. Taking one at a time spreads a pool's slots over its agents.
// - The agent opens a capture stream for the slot (POST /v1/cdc/:slotId). Each transaction it
//   sends is handed to change-stream (reportCapture) and only then acknowledged: recorded on the
//   slot while the agent's lease holds, and sent down as cdc.ack, so the source lets its log go
//   only once the changes are in. A lapsed or moved lease refuses the acknowledgement and ends
//   the stream: the next reader resumes from the last position recorded, and change-stream
//   drops what it has seen already.
// - The stream ending ends the lease, and the slot is offered again: to another agent of the
//   pool at once, to this one after a wait that doubles with each failure, to 5 minutes. A
//   slot whose stream never opens is given up the same way. The agent's tunnel closing gives up
//   all its leases.
// - A slot being dropped (stream.manage) is taken by the agent reading it, or any agent of the
//   pool: it stops the reader (cdc.stop), drops the slot (cdc.drop) and reports it dropped.
// - Store-and-forward (spec 10.6): an agent reads on into its spool while its tunnel is down,
//   and its heartbeat names the slots it reads and the spools holding what only they have. Those
//   slots are given back to it whoever held the lease meanwhile, since the replication slot
//   serves one reader and the spool must go up; a slot no longer live is stopped there. What its
//   spool dropped at the bound arrives as a gap record: audited (agent_spool_gap), kept with the
//   stream's health, and acknowledged (cdc.gap_ack). Positions with no changes are acknowledged
//   without troubling change-stream, and the recorded position never moves back.
// - MQTT telemetry (spec 20.2, 20.6) is leased the same way, as a capture of method mqtt: its
//   start names the connection's broker, the streamed objects' topic filters and, where the
//   manifest declares a login, the login sealed to the agent for this lease (the slot's id is
//   the work it is bound to). The agent subscribes and sends messages up as they arrive, never
//   spooled; they go to change-stream unacknowledged, since a broker keeps no position.
// - OPC UA subscriptions (spec 20.3) likewise, as captures of method opcua: the start names the
//   connection's active server and its security (the application certificate and the pinned
//   server certificate, the key and login sealed to the agent for the lease), and per streamed
//   object its root, type definition, the fields' browse paths and the sampling the manifest
//   declares. The samples go to change-stream unacknowledged, as messages do.

import type { z } from 'zod';
import type { CaptureFrame, DownFrame } from '../../contracts/connect-runtime/agentTunnel.contract.ts';
import { MAX_CDC_READERS } from '../../contracts/connect-runtime/agentTunnel.contract.ts';
import { reportCapture } from '../../contracts/change-stream/capture.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { cdcTables, manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import type { CdcSlot } from '../../models/connect/cdcSlot.model.ts';
import { cdcSlotRepo, connectionRepo, connectorManifestRepo, industrialEndpointRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { pemToDerBase64 } from '../../utils/pem.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';

export interface CaptureDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  /** A reader's lease (30 s, spec 9.1's pool failover): renewed with its agent's heartbeats; lapsed, another agent of the pool takes the slot. */
  leaseMs?: number;
  /** The first wait before a slot that failed on an agent is offered to it again (10 s). */
  retryMs?: number;
  /** An MQTT capture's login, sealed by the credential service to the agent for the lease; undefined where the agent holds it. */
  seal?: (input: { organisationId: string; connectionId: string; agentId: string; workId: string }) => Promise<{ sealed: string; expiresAt: string } | undefined>;
  /** An OPC UA capture's application key, sealed by the credential service to the agent for the lease. */
  sealKey?: (input: { organisationId: string; connectionId: string; endpointId: string; agentId: string; workId: string }) => Promise<{ sealed: string; expiresAt: string }>;
  now?: () => number;
}

/** The agent a capture belongs to, as its tunnel knows it. */
export interface CaptureAgent {
  agentId: string;
  organisationId: string;
  poolId: string;
}

type Send = (frame: DownFrame) => void;
type CaptureTable = { schema: string; table: string };
type Sealed = { sealed: string; expiresAt: string };
type MqttStart = { endpointUrl: string; topics: { filter: string; qos: 0 | 1 | 2 }[]; credential?: Sealed };
type OpcUaObject = {
  object: string; root: string; typeDefinition?: string; paths: string[]; samplingMs: number; queueSize: number;
  deadband?: { type: 'absolute' | 'percent'; value: number };
};
type OpcUaStart = {
  endpointUrl: string; securityPolicy: string; certificate?: string; serverThumbprint?: string; applicationKey?: Sealed; credential?: Sealed;
  objects: OpcUaObject[];
};
type OpcUaPlan = Omit<OpcUaStart, 'applicationKey' | 'credential'> & { endpointId: string; signed: boolean; login: boolean };

interface Held {
  slotId: string;
  since: number;
  dropping: boolean;
  streaming: boolean;
}

interface AgentCaptures {
  held: Map<string, Held>;
  renewedAt: number;
  waits: Map<string, { until: number; failures: number }>;
  beating: boolean;
}

const MAX_WAIT_MS = 5 * 60_000;

/**
 * Whether next follows current in the slot's log. Every method's positions are written as
 * Postgres LSNs are, and compare as numbers: LSNs, binary log positions (the file's number, then
 * the offset) and change tracking versions.
 */
export function laterPosition(_method: CdcSlot['method'], current: string, next: string): boolean {
  const lsn = (text: string): bigint | undefined => {
    const m = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/.exec(text);
    return m === null ? undefined : (BigInt(`0x${m[1]}`) << 32n) + BigInt(`0x${m[2]}`);
  };
  const a = lsn(current);
  const b = lsn(next);
  return a === undefined || b === undefined || b > a;
}

/** What the agent's heartbeat says it reads, and the spools holding what only they have. */
export interface ReportedCaptures {
  reading: readonly string[];
  spooled: readonly string[];
}

/** One capture stream: the frames the agent sends up it, then its end. */
export interface CaptureStream {
  take(frame: CaptureFrame): Promise<void>;
  end(failed: boolean): Promise<void>;
}

export function createAgentCaptures(deps: CaptureDeps) {
  const now = deps.now ?? Date.now;
  const leaseMs = deps.leaseMs ?? 30_000;
  const retryMs = deps.retryMs ?? 10_000;
  const control = deps.databases.pool('control');
  const agents = new Map<string, AgentCaptures>();

  const stateOf = (agentId: string): AgentCaptures => {
    let state = agents.get(agentId);
    if (state === undefined) {
      state = { held: new Map(), renewedAt: now(), waits: new Map(), beating: false };
      agents.set(agentId, state);
    }
    return state;
  };

  const wait = (state: AgentCaptures, slotId: string): void => {
    const failures = (state.waits.get(slotId)?.failures ?? 0) + 1;
    state.waits.set(slotId, { until: now() + Math.min(MAX_WAIT_MS, retryMs * 2 ** (failures - 1)), failures });
  };

  const startFrame = (slot: CdcSlot, tables: Map<string, CaptureTable[]>, mqtt?: MqttStart, opcua?: OpcUaStart): DownFrame => ({
    type: 'cdc.start', slotId: slot.id, connectionId: slot.connectionId, method: slot.method, slotName: slot.slotName,
    ...(slot.publication === null ? {} : { publication: slot.publication }),
    ...(slot.method === 'logical_replication' || slot.method === 'mqtt' || slot.method === 'opcua' ? {} : { tables: tables.get(slot.id) ?? [] }),
    ...(slot.acknowledgedPosition === null ? {} : { position: slot.acknowledgedPosition }),
    ...(mqtt === undefined ? {} : { mqtt: { endpointUrl: mqtt.endpointUrl, topics: mqtt.topics, ...(mqtt.credential === undefined ? {} : { credential: mqtt.credential }) } }),
    ...(opcua === undefined ? {} : { opcua }),
  });

  /** An MQTT capture's broker and topic filters, from the connection's endpoint and manifest as they stand when it starts. */
  const mqttOf = async (db: Queryable, slots: readonly CdcSlot[]): Promise<Map<string, MqttStart & { login: boolean }>> => {
    const out = new Map<string, MqttStart & { login: boolean }>();
    for (const slot of slots) {
      if (slot.method !== 'mqtt') continue;
      const connection = await connectionRepo.findById(db, slot.connectionId);
      const endpoint = connection === undefined ? undefined : await industrialEndpointRepo.activeForConnection(db, connection.id);
      const row = connection === undefined ? undefined : await connectorManifestRepo.findById(db, connection.manifestId);
      const parsed = row === undefined ? undefined : manifestSchema.safeParse(row.document);
      if (endpoint?.plugin !== 'mqtt' || parsed?.success !== true) continue;
      const streamed = new Set((parsed.data.changeStream?.objects ?? []).filter((o) => o.sources.some((s) => s.kind === 'mqtt')).map((o) => o.object));
      const topics = parsed.data.objects.flatMap((o) => (streamed.has(o.name) && o.source.kind === 'mqtt' ? [{ filter: o.source.topic, qos: o.source.qos }] : []));
      if (topics.length === 0) continue;
      out.set(slot.id, { endpointUrl: endpoint.endpointUrl, topics, login: parsed.data.auth.strategy !== 'none' });
    }
    return out;
  };

  /** An OPC UA capture's server and monitored objects, from the connection's endpoint and manifest as they stand when it starts. */
  const opcuaOf = async (db: Queryable, slots: readonly CdcSlot[]): Promise<Map<string, OpcUaPlan>> => {
    const out = new Map<string, OpcUaPlan>();
    for (const slot of slots) {
      if (slot.method !== 'opcua') continue;
      const connection = await connectionRepo.findById(db, slot.connectionId);
      const endpoint = connection === undefined ? undefined : await industrialEndpointRepo.activeForConnection(db, connection.id);
      const row = connection === undefined ? undefined : await connectorManifestRepo.findById(db, connection.manifestId);
      const parsed = row === undefined ? undefined : manifestSchema.safeParse(row.document);
      if (endpoint?.plugin !== 'opcua' || parsed?.success !== true) continue;
      const objects: OpcUaObject[] = [];
      for (const stream of parsed.data.changeStream?.objects ?? []) {
        const source = stream.sources.find((s) => s.kind === 'opcua');
        const object = parsed.data.objects.find((o) => o.name === stream.object);
        if (source?.kind !== 'opcua' || object?.source.kind !== 'opc_ua') continue;
        objects.push({
          object: object.name, root: object.source.root, ...(object.source.typeDefinition === undefined ? {} : { typeDefinition: object.source.typeDefinition }),
          paths: [...new Set(object.fields.map((f) => f.path ?? f.name))], samplingMs: source.samplingMs, queueSize: source.queueSize,
          ...(source.deadband === undefined ? {} : { deadband: source.deadband }),
        });
      }
      if (objects.length === 0) continue;
      const signed = endpoint.securityPolicy !== 'None' && endpoint.appCertificatePem !== null && endpoint.serverCertificateThumbprint !== null;
      out.set(slot.id, {
        endpointId: endpoint.id, endpointUrl: endpoint.endpointUrl, securityPolicy: endpoint.securityPolicy, objects, signed,
        login: parsed.data.auth.strategy !== 'none',
        ...(signed ? { certificate: pemToDerBase64(endpoint.appCertificatePem!), serverThumbprint: endpoint.serverCertificateThumbprint! } : {}),
      });
    }
    return out;
  };

  /**
   * The tables a binlog or change tracking capture reads, from the connection's manifest as it
   * stands when the reader starts: an object added to the stream since is read from the next start.
   */
  const tablesOf = async (db: Queryable, slots: readonly CdcSlot[]): Promise<Map<string, CaptureTable[]>> => {
    const tables = new Map<string, CaptureTable[]>();
    for (const slot of slots) {
      if (slot.method === 'logical_replication') continue;
      const connection = await connectionRepo.findById(db, slot.connectionId);
      const row = connection === undefined ? undefined : await connectorManifestRepo.findById(db, connection.manifestId);
      const parsed = row === undefined ? undefined : manifestSchema.safeParse(row.document);
      tables.set(slot.id, parsed?.success === true
        ? cdcTables(parsed.data).flatMap((t) => (t.schema === undefined ? [] : [{ schema: t.schema, table: t.table }]))
        : []);
    }
    return tables;
  };

  const report = (agent: CaptureAgent, slotId: string, body: z.input<typeof reportCapture.body>) =>
    deps.services.call(reportCapture, { params: { slotId }, body }, { request: { organisationId: agent.organisationId }, correlationId: uuidv7() });

  return {
    /** On the agent's heartbeat: its leases renewed, a slot being dropped or one more to read taken, and stalled ones given up. */
    async beat(agent: CaptureAgent, send: Send, reported: ReportedCaptures = { reading: [], spooled: [] }): Promise<void> {
      const state = stateOf(agent.agentId);
      if (state.beating) return;
      state.beating = true;
      try {
        const leaseSeconds = leaseMs / 1000;
        const stopped: string[] = [];
        const toDrop: CdcSlot[] = [];
        const resumed: CdcSlot[] = [];
        let toStart: CdcSlot | undefined;
        let tables = new Map<string, CaptureTable[]>();
        let subscriptions = new Map<string, MqttStart & { login: boolean }>();
        let monitored = new Map<string, OpcUaPlan>();
        await inTransaction(control, { organisationId: agent.organisationId }, async (db) => {
          // What the agent reads, or spooled, that it does not hold here: back to it, or stopped.
          for (const slotId of new Set([...reported.reading, ...reported.spooled])) {
            if (state.held.has(slotId)) continue;
            const slot = await cdcSlotRepo.findById(db, slotId);
            if (slot === undefined || slot.agentPoolId !== agent.poolId || (slot.status !== 'active' && slot.status !== 'dropping')) {
              stopped.push(slotId);
              continue;
            }
            const taken = await cdcSlotRepo.takeOver(db, slotId, agent.agentId, agent.poolId, leaseSeconds);
            if (taken?.status === 'active') resumed.push(taken);
            else if (taken?.status === 'dropping') toDrop.push(taken);
          }
          // A stream that never opened: the agent cannot read it (an older agent, or a refusal lost on the way).
          for (const held of state.held.values()) {
            if (!held.streaming && now() - held.since > leaseMs) {
              await cdcSlotRepo.release(db, agent.agentId, held.slotId);
              wait(state, held.slotId);
              stopped.push(held.slotId);
            }
          }
          for (const id of stopped) state.held.delete(id);
          if (state.held.size > 0 && now() - state.renewedAt >= leaseMs / 3) {
            const renewed = new Set(await cdcSlotRepo.renew(db, agent.agentId, [...state.held.keys()], leaseSeconds));
            for (const id of state.held.keys()) if (!renewed.has(id)) stopped.push(id);
            for (const id of stopped) state.held.delete(id);
            state.renewedAt = now();
          }
          for (const slot of await cdcSlotRepo.takeable(db, agent.poolId, agent.agentId, 'dropping', 3)) {
            if (state.held.get(slot.id)?.dropping === true || (state.waits.get(slot.id)?.until ?? 0) > now()) continue;
            if (await cdcSlotRepo.claim(db, slot.id, agent.agentId, agent.poolId, leaseSeconds) !== undefined) toDrop.push(slot);
          }
          const reading = [...state.held.values()].filter((h) => !h.dropping).length;
          if (reading < MAX_CDC_READERS) {
            for (const slot of await cdcSlotRepo.takeable(db, agent.poolId, agent.agentId, 'active', 5)) {
              if (state.held.has(slot.id) || resumed.some((r) => r.id === slot.id) || (state.waits.get(slot.id)?.until ?? 0) > now()) continue;
              toStart = await cdcSlotRepo.claim(db, slot.id, agent.agentId, agent.poolId, leaseSeconds);
              if (toStart !== undefined) break;
            }
          }
          tables = await tablesOf(db, toStart === undefined ? resumed : [...resumed, toStart]);
          subscriptions = await mqttOf(db, toStart === undefined ? resumed : [...resumed, toStart]);
          monitored = await opcuaOf(db, toStart === undefined ? resumed : [...resumed, toStart]);
        });
        // An OPC UA capture's start: its server and items, its key and login sealed to this agent for the lease.
        const opcuaStart = async (slot: CdcSlot): Promise<OpcUaStart | undefined> => {
          if (slot.method !== 'opcua') return undefined;
          const plan = monitored.get(slot.id);
          if (plan === undefined) return undefined;
          const { endpointId, signed, login, ...start } = plan;
          const bound = { organisationId: agent.organisationId, connectionId: slot.connectionId, agentId: agent.agentId, workId: slot.id };
          const credential = login && deps.seal !== undefined ? await deps.seal(bound).catch(() => undefined) : undefined;
          const applicationKey = signed && deps.sealKey !== undefined ? await deps.sealKey({ ...bound, endpointId }).catch(() => undefined) : undefined;
          return { ...start, ...(credential === undefined ? {} : { credential }), ...(applicationKey === undefined ? {} : { applicationKey }) };
        };
        // An MQTT capture's start: its broker and filters, and its login sealed to this agent for the lease.
        const mqttStart = async (slot: CdcSlot): Promise<MqttStart | undefined> => {
          if (slot.method !== 'mqtt') return undefined;
          const sub = subscriptions.get(slot.id);
          if (sub === undefined) return undefined;
          const credential = sub.login && deps.seal !== undefined
            ? await deps.seal({ organisationId: agent.organisationId, connectionId: slot.connectionId, agentId: agent.agentId, workId: slot.id }).catch(() => undefined)
            : undefined;
          return { endpointUrl: sub.endpointUrl, topics: sub.topics, ...(credential === undefined ? {} : { credential }) };
        };
        for (const slotId of stopped) send({ type: 'cdc.stop', slotId });
        for (const slot of resumed) {
          state.held.set(slot.id, { slotId: slot.id, since: now(), dropping: false, streaming: false });
          send(startFrame(slot, tables, await mqttStart(slot), await opcuaStart(slot)));
        }
        for (const slot of toDrop) {
          if (state.held.has(slot.id)) send({ type: 'cdc.stop', slotId: slot.id });
          state.held.set(slot.id, { slotId: slot.id, since: now(), dropping: true, streaming: false });
          send({ type: 'cdc.drop', slotId: slot.id, connectionId: slot.connectionId, method: slot.method, slotName: slot.slotName });
        }
        if (toStart !== undefined) {
          state.held.set(toStart.id, { slotId: toStart.id, since: now(), dropping: false, streaming: false });
          send(startFrame(toStart, tables, await mqttStart(toStart), await opcuaStart(toStart)));
          deps.logger.info('change capture leased to an agent', {
            event: 'agent.cdc_leased', organisationId: agent.organisationId, resourceId: toStart.id, connectionId: toStart.connectionId,
          });
        }
      } finally {
        state.beating = false;
      }
    },

    /** The capture stream the agent opened for a slot it was given. */
    open(agent: CaptureAgent, slotId: string, send: Send): CaptureStream {
      const state = stateOf(agent.agentId);
      const held = state.held.get(slotId);
      if (held === undefined) throw new AppError('conflict', 'this agent holds no lease on that capture', { code: 'agent.capture_not_leased' });
      if (held.streaming) throw new AppError('conflict', 'that capture is already being sent', { code: 'agent.capture_streaming' });
      held.streaming = true;
      let failed = false;
      let finished = false;
      return {
        async take(frame) {
          if (state.held.get(slotId) !== held) throw new AppError('conflict', 'the capture\'s lease has ended', { code: 'agent.capture_lease_lost' });
          switch (frame.type) {
            case 'changes': {
              if (held.dropping) throw new AppError('conflict', 'the capture is being dropped', { code: 'agent.capture_dropping' });
              // A position with no changes only moves the acknowledged position on.
              if (frame.changes.length > 0) {
                await report(agent, slotId, { kind: 'changes', agentId: agent.agentId, committedAt: frame.committedAt, changes: frame.changes });
              }
              if (frame.position !== undefined) {
                const recorded = await inTransaction(control, { organisationId: agent.organisationId },
                  (db) => cdcSlotRepo.acknowledge(db, slotId, agent.agentId, frame.position!, laterPosition));
                if (!recorded) throw new AppError('conflict', 'the capture\'s lease has ended', { code: 'agent.capture_lease_lost' });
                state.waits.delete(slotId);
              }
              // The spool lets go of what the cell has, a part of a transaction too; the source, of acknowledged positions.
              if (frame.position !== undefined || frame.spoolId !== undefined) {
                send({ type: 'cdc.ack', slotId, ...(frame.position === undefined ? {} : { position: frame.position }),
                  ...(frame.spoolId === undefined ? {} : { received: frame.spoolId }) });
              }
              return;
            }
            case 'started':
              await report(agent, slotId, { kind: 'started', agentId: agent.agentId });
              return;
            case 'messages':
              // MQTT telemetry (20.6): to change-stream as it arrives; a broker keeps no position to acknowledge.
              if (held.dropping) throw new AppError('conflict', 'the capture is being dropped', { code: 'agent.capture_dropping' });
              if (frame.messages.length > 0) await report(agent, slotId, { kind: 'messages', agentId: agent.agentId, messages: frame.messages });
              return;
            case 'samples':
              // OPC UA subscriptions (20.3): to change-stream as they arrive, unacknowledged as messages are.
              if (held.dropping) throw new AppError('conflict', 'the capture is being dropped', { code: 'agent.capture_dropping' });
              if (frame.samples.length > 0) await report(agent, slotId, { kind: 'samples', agentId: agent.agentId, samples: frame.samples });
              return;
            case 'gap': {
              await report(agent, slotId, {
                kind: 'gap', agentId: agent.agentId, reason: frame.reason, ...(frame.changes === undefined ? {} : { changes: frame.changes }),
                ...(frame.from === undefined ? {} : { from: frame.from }), ...(frame.to === undefined ? {} : { to: frame.to }),
              });
              await inTransaction(control, { organisationId: agent.organisationId }, async (db) => {
                const slot = await cdcSlotRepo.findById(db, slotId);
                await recordConnectEvent(db, {
                  organisationId: agent.organisationId, correlationId: uuidv7(), event: 'agent_spool_gap', service: 'connect-runtime',
                  resourceType: 'agent', resourceId: agent.agentId, detail: Object.fromEntries(Object.entries({
                    slot_id: slotId, connection_id: slot?.connectionId, reason: frame.reason, records: frame.records,
                    changes: frame.changes, from: frame.from, to: frame.to, from_position: frame.fromPosition, to_position: frame.toPosition,
                  }).filter((entry): entry is [string, string | number] => entry[1] !== undefined)),
                });
              });
              deps.logger.warn('the agent reported changes lost on the way', {
                event: 'agent.cdc_gap', organisationId: agent.organisationId, resourceId: slotId, count: frame.changes ?? 0, reason: frame.reason,
              });
              send({ type: 'cdc.gap_ack', slotId, gapId: frame.id });
              return;
            }
            case 'lost':
            case 'dropped':
              finished = true;
              await report(agent, slotId, { kind: frame.type, agentId: agent.agentId });
              return;
            case 'error':
              failed = true;
              await report(agent, slotId, {
                kind: 'failed', agentId: agent.agentId, category: frame.category, ...(frame.sqlstate === undefined ? {} : { sqlstate: frame.sqlstate }),
              });
              return;
          }
        },
        async end(broken) {
          // A newer lease of the same slot (the agent reconnected) is not this stream's to end.
          if (state.held.get(slotId) !== held) return;
          state.held.delete(slotId);
          if (!finished) {
            await inTransaction(control, { organisationId: agent.organisationId }, (db) => cdcSlotRepo.release(db, agent.agentId, slotId));
          }
          if (failed || broken) wait(state, slotId);
          deps.logger.info('a capture stream ended', {
            event: 'agent.cdc_stream_ended', organisationId: agent.organisationId, resourceId: slotId, outcome: finished ? 'finished' : failed || broken ? 'failed' : 'stopped',
          });
        },
      };
    },

    /** The agent's tunnel closed or was replaced: its readers stopped with it, so its leases go. */
    async closed(agent: CaptureAgent): Promise<void> {
      const state = agents.get(agent.agentId);
      agents.delete(agent.agentId);
      if (state === undefined || state.held.size === 0) return;
      // Its streams still open end as not theirs to end: a new tunnel may lease the slots again.
      state.held.clear();
      await inTransaction(control, { organisationId: agent.organisationId }, (db) => cdcSlotRepo.release(db, agent.agentId));
    },

    /** The slots an agent holds here, for tests and diagnostics. */
    heldBy(agentId: string): { slotId: string; dropping: boolean; streaming: boolean }[] {
      return [...(agents.get(agentId)?.held.values() ?? [])].map((h) => ({ slotId: h.slotId, dropping: h.dropping, streaming: h.streaming }));
    },
  };
}

export type AgentCapturesService = ReturnType<typeof createAgentCaptures>;
