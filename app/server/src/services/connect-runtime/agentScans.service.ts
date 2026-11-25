// Discovery scans on Silo Agents (spec 10.5, 19.3; contracts/connect-runtime/discoveryScan.contract.ts).
//
// discovery asks for a scan with the scan it signed. This replica checks the signature first
// (the agent checks it again), and that the agent is the organisation's, not revoked and not
// switched off locally. The replica holding the agent's tunnel gives it the scan as
// discovery.scan work; one that does not passes the request to the one that does, once. Never
// queued: an agent not connected now is refused at once.
//
// While the scan runs, what the agent reports is passed to discovery in numbered reports: a
// report as soon as a batch fills or a finding arrives, and one at least every few seconds even
// with nothing in it, whose answer says whether to go on. Told to stop, this replica abandons
// the work, which closes the agent's stream, and the agent stops. A report that cannot be
// delivered is tried again; a scan whose reports cannot get through is stopped, since every
// probe must be logged. A tunnel that drops ends the scan as failed.
//
// Industrial methods (spec 19.2, 20.2, 20.3) reach only the organisation's active industrial
// endpoints of the agent's pool whose host is one of the authorisation's targets ("where
// credentials already exist"), one per address: each goes with the scan, its login and (a
// signed OPC UA policy) its application key sealed to the agent for the scan, bound to the
// scan's id as their work.

import type { KeyObject } from 'node:crypto';
import { reportScanEvents, type ScanEvent, type SignedDiscoveryScan } from '../../contracts/discovery/scan.contract.ts';
import { startDiscoveryScan } from '../../contracts/connect-runtime/discoveryScan.contract.ts';
import type { ResultFrame } from '../../contracts/connect-runtime/agentTunnel.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { agentRepo, connectionRepo, connectorManifestRepo, industrialEndpointRepo } from '../../repos/connect/index.repo.ts';
import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import { pemToDerBase64 } from '../../utils/pem.util.ts';
import { inTargets } from '../discovery/proposals.service.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { sleep } from '../../utils/time.util.ts';
import { verifyDiscoveryScan } from '../discovery/scans.service.ts';
import type { AgentTunnels } from './agentTunnels.service.ts';

export interface ScanDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  tunnels: AgentTunnels;
  /** The key scans are checked against; without it, none is given to an agent. */
  scanKey: KeyObject | undefined;
  /** Events per report, and the longest between reports. */
  batch?: number;
  reportMs?: number;
  /** An industrial endpoint's login and application key, sealed by the credential service to the agent for the scan. */
  seal?: (input: { organisationId: string; connectionId: string; agentId: string; workId: string }) => Promise<Sealed | undefined>;
  sealKey?: (input: { organisationId: string; connectionId: string; endpointId: string; agentId: string; workId: string }) => Promise<Sealed>;
}

type Sealed = { sealed: string; expiresAt: string };

/** At most this many industrial endpoints go with one scan. */
const MAX_SCAN_ENDPOINTS = 50;

export interface StartScanInput {
  organisationId: string;
  correlationId: string;
  agentId: string;
  runId: string;
  scan: SignedDiscoveryScan;
  deadline: string;
  relayed: boolean;
}

const REPORT_TRIES = 4;

export function createAgentScans(deps: ScanDeps) {
  const control = deps.databases.pool('control');
  const batch = deps.batch ?? 200;
  const reportMs = deps.reportMs ?? 5_000;
  const running = new Map<string, AbortController>();
  let closing = false;

  /** Runs one scan on an agent held here, passing what it reports to discovery, to its end. */
  async function run(input: StartScanInput & { poolId: string }, stop: AbortController): Promise<void> {
    const ctx = { request: { organisationId: input.organisationId }, correlationId: input.correlationId };
    let sequence = 0;
    let events: ScanEvent[] = [];
    let ended = false;
    let lastReport = Date.now();

    /** Passes on what has come, or asks whether to go on; false when the scan must stop. */
    const report = async (): Promise<boolean> => {
      const sent = events;
      events = [];
      sequence += 1;
      lastReport = Date.now();
      for (let attempt = 1; ; attempt++) {
        try {
          const answer = await deps.services.call(reportScanEvents, {
            params: { runId: input.runId }, body: { agentId: input.agentId, sequence, events: sent },
          }, { ...ctx, timeoutMs: 30_000 });
          return !answer.stop;
        } catch (error) {
          // Taken already, or another agent's: nothing more to say.
          if (isAppError(error) && ['not_found', 'forbidden', 'validation', 'conflict'].includes(error.category)) return false;
          if (attempt >= REPORT_TRIES) {
            deps.logger.failure('a discovery scan\'s report could not be delivered; the scan stops', error, {
              event: 'agent.scan_report_failed', organisationId: input.organisationId, resourceId: input.runId,
            });
            return false;
          }
          await sleep(250 * 2 ** attempt);
        }
      }
    };

    const industrial = await endpointsFor(input).catch((error: unknown) => {
      deps.logger.failure('a scan\'s industrial endpoints were not sealed; the scan goes without them', error, {
        event: 'agent.scan_endpoints_failed', organisationId: input.organisationId, resourceId: input.runId,
      });
      return [];
    });
    const frames = deps.tunnels.dispatch({
      organisationId: input.organisationId, poolId: input.poolId, agentId: input.agentId, kind: 'discovery.scan',
      payload: { scan: input.scan, ...(industrial.length === 0 ? {} : { industrial }) },
      timeoutMs: Math.max(1_000, Date.parse(input.deadline) - Date.now()), signal: stop.signal,
    });
    let next = frames.next();
    const arm = (ms: number) => sleep(ms).then(() => 'tick' as const);
    let tick = arm(reportMs);
    try {
      while (!ended && !stop.signal.aborted) {
        const result = await Promise.race([next, tick]);
        if (result === 'tick') {
          // Nothing reported for a while: ask whether to go on.
          const since = Date.now() - lastReport;
          if (since >= reportMs && !await report()) break;
          tick = arm(since >= reportMs ? reportMs : reportMs - since);
          continue;
        }
        if (result.done) {
          // The stream ended without an end: the agent stopped answering.
          events.push({ type: 'end', status: 'failed', reason: 'tunnel_ended' });
          ended = true;
          break;
        }
        next = frames.next();
        const frame: ResultFrame = result.value;
        switch (frame.type) {
          case 'probe':
          case 'finding':
            events.push(frame);
            if ((events.length >= batch || frame.type === 'finding') && !await report()) stop.abort();
            break;
          case 'end':
            events.push(frame);
            ended = true;
            break;
          case 'error':
            events.push({ type: 'end', status: 'failed', reason: frame.category });
            ended = true;
            break;
          default:
            events.push({ type: 'end', status: 'failed', reason: 'protocol' });
            ended = true;
        }
      }
    } catch (error) {
      // The tunnel dropped, the deadline passed, or this replica is stopping.
      if (!stop.signal.aborted) {
        const reason = isAppError(error) && error.code === 'agent.timeout' ? 'deadline' : 'tunnel_lost';
        events.push({ type: 'end', status: 'failed', reason });
        ended = true;
      }
    } finally {
      // Stopped from here: abandoning the work closes the agent's stream. The frames are let go
      // of too, so the work's own ending runs whether it waits for a frame or holds one unread.
      stop.abort();
      next.catch(() => undefined);
      void frames.return(undefined).catch(() => undefined);
      running.delete(input.runId);
    }
    if (closing && !ended) {
      events.push({ type: 'end', status: 'failed', reason: 'replica_stopping' });
      ended = true;
    }
    if (ended || events.length > 0) await report();
  }

  /** The industrial endpoints a scan's methods and targets reach, sealed for it. */
  async function endpointsFor(input: StartScanInput & { poolId: string }): Promise<Record<string, unknown>[]> {
    let authorisation: { ranges?: unknown; methods?: unknown };
    try {
      authorisation = JSON.parse((JSON.parse(input.scan.scan) as { authorisation: string }).authorisation) as typeof authorisation;
    } catch {
      return [];
    }
    const methods = Array.isArray(authorisation.methods) ? authorisation.methods : [];
    const ranges = Array.isArray(authorisation.ranges) ? authorisation.ranges.filter((r): r is string => typeof r === 'string') : [];
    const plugins = new Set([...(methods.includes('opcua_browse') ? ['opcua'] : []), ...(methods.includes('mqtt_observe') ? ['mqtt'] : [])]);
    if (plugins.size === 0) return [];
    const chosen = await inTransaction(control, { organisationId: input.organisationId }, async (db) => {
      const out: { endpoint: Awaited<ReturnType<typeof industrialEndpointRepo.activeForPool>>[number]; login: boolean }[] = [];
      const seen = new Set<string>();
      for (const endpoint of await industrialEndpointRepo.activeForPool(db, input.poolId)) {
        if (!plugins.has(endpoint.plugin) || seen.has(endpoint.endpointUrl) || out.length >= MAX_SCAN_ENDPOINTS) continue;
        const host = new URL(endpoint.endpointUrl.replace(/^[a-z.]+:\/\//, 'tcp://')).hostname.replace(/^\[|\]$/g, '');
        if (!inTargets(host, ranges)) continue;
        const connection = await connectionRepo.findById(db, endpoint.connectionId);
        const row = connection === undefined ? undefined : await connectorManifestRepo.findById(db, connection.manifestId);
        const manifest = row === undefined ? undefined : manifestSchema.safeParse(row.document);
        if (connection === undefined || connection.status === 'revoked' || manifest?.success !== true) continue;
        seen.add(endpoint.endpointUrl);
        out.push({ endpoint, login: manifest.data.auth.strategy !== 'none' });
      }
      return out;
    }, { readOnly: true });
    const sealed: Record<string, unknown>[] = [];
    for (const { endpoint, login } of chosen) {
      const bound = { organisationId: input.organisationId, connectionId: endpoint.connectionId, agentId: input.agentId, workId: input.runId };
      const signed = endpoint.plugin === 'opcua' && endpoint.securityPolicy !== 'None' && endpoint.appCertificatePem !== null && endpoint.serverCertificateThumbprint !== null;
      const credential = login && deps.seal !== undefined ? await deps.seal(bound) : undefined;
      const applicationKey = signed && deps.sealKey !== undefined ? await deps.sealKey({ ...bound, endpointId: endpoint.id }) : undefined;
      sealed.push({
        plugin: endpoint.plugin, connectionId: endpoint.connectionId, endpointUrl: endpoint.endpointUrl, securityPolicy: endpoint.securityPolicy,
        ...(signed ? { certificate: pemToDerBase64(endpoint.appCertificatePem!), serverThumbprint: endpoint.serverCertificateThumbprint } : {}),
        ...(credential === undefined ? {} : { credential }), ...(applicationKey === undefined ? {} : { applicationKey }),
      });
    }
    return sealed;
  }

  return {
    /** Starts a scan on the agent: here if this replica holds it, else where it is held. */
    async start(input: StartScanInput): Promise<{ started: true }> {
      if (deps.scanKey === undefined) {
        throw new AppError('configuration', 'this cell has no discovery scan key: no scan is given to an agent', { code: 'discovery.signing_unavailable' });
      }
      verifyDiscoveryScan(deps.scanKey, input.scan, { organisationId: input.organisationId, agentId: input.agentId, runId: input.runId });
      const agent = await inTransaction(control, { organisationId: input.organisationId }, (db) => agentRepo.findById(db, input.agentId), { readOnly: true });
      if (agent === undefined || agent.status === 'revoked') throw new AppError('not_found', 'no such agent', { code: 'agent.unknown' });
      if (agent.discoveryDisabledLocally) {
        throw new AppError('conflict', 'discovery is switched off on that agent by its host', { code: 'discovery.agent_refuses' });
      }
      if (!deps.tunnels.holds(input.organisationId, input.agentId)) {
        const elsewhere = input.relayed ? undefined : await deps.tunnels.heldElsewhere(input.organisationId, agent.poolId, input.agentId);
        if (elsewhere === undefined) {
          throw new AppError('source_unreachable', 'the agent is not connected', { code: 'agent.unavailable', retryable: true });
        }
        return deps.services.call(startDiscoveryScan, {
          params: { agentId: input.agentId }, body: { runId: input.runId, scan: input.scan, deadline: input.deadline, relayed: true },
        }, { request: { organisationId: input.organisationId }, correlationId: input.correlationId, replicaUrl: elsewhere.relayUrl });
      }
      if (running.has(input.runId)) throw new AppError('conflict', 'that scan is already running', { code: 'discovery.run_in_progress' });
      const stop = new AbortController();
      running.set(input.runId, stop);
      void run({ ...input, poolId: agent.poolId }, stop).catch((error: unknown) =>
        deps.logger.failure('a discovery scan ended badly', error, { event: 'agent.scan_failed', organisationId: input.organisationId, resourceId: input.runId }));
      return { started: true };
    },

    /** This replica is stopping: its scans stop, and discovery hears so. */
    close(): void {
      closing = true;
      for (const stop of running.values()) stop.abort();
    },

    /** Scans running here (tests). */
    running: (): number => running.size,
  };
}

export type AgentScans = ReturnType<typeof createAgentScans>;

