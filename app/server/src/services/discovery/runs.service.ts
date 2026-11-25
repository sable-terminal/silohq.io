// Scan runs (spec 19.2, 19.3, 19.6). A run starts only under an approved, unexpired,
// unrevoked authorisation, with discovery on and the agent able: discovery signs a scan for
// that run on that agent, carrying the authorisation document's exact text (the one the
// approvers' hash names), and connect-runtime gives it to the agent over its tunnel.
//
// Nothing about a run lives in one process. What the agent does comes back as numbered
// reports (reportScanEvents), taken one at a time with the run locked, by whichever replica
// receives them, and each is held to the authorisation: a probe or finding for a host outside
// the explicit targets, or by a method not authorised, stops the run as failed, and so does
// crossing the host bound (distinct hosts across all its reports); revoked, expired or
// switched off stops it as revoked. Every probe is one row and one host_probed event (19.3:
// what, when, by which agent, under which authorisation). A finding is checked for structure
// only (no name may look like a value) and stored with its proposals. The answer to every
// report says whether to go on, and reports come at least every few seconds while a scan
// runs, so a stop reaches the agent within seconds; a run whose reports stop (its agent or
// replica gone) is ended by the sweep.

import { getManifest, type OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import type { FoundStructure, RunView } from '../../contracts/discovery/discovery.contract.ts';
import { MAX_SCAN_SECONDS, type ScanEvent } from '../../contracts/discovery/scan.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { DiscoveryRun } from '../../models/connect/discoveryRun.model.ts';
import type { NewDiscoveryProbe } from '../../models/connect/discoveryProbe.model.ts';
import {
  agentRepo, discoveryAuthorisationRepo, discoveryFindingRepo, discoveryProbeRepo, discoveryRunHostRepo, discoveryRunRepo, discoverySettingRepo,
} from '../../repos/connect/index.repo.ts';
import { approvalChainRepo } from '../../repos/action/index.repo.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { findValuePatterns } from '../../utils/redaction.util.ts';
import { authorisationView } from './authorisations.service.ts';
import { demand, enabledOrRefuse, memberOf, recordDiscoveryEvent, type Context, type DiscoveryDeps } from './deps.service.ts';
import { inTargets, proposedConnectorType, proposeStructure } from './proposals.service.ts';

/** Every name a finding carries: none may look like a value (spec 19.3: never row contents). */
function names(found: FoundStructure): string[] {
  return [
    found.product ?? '', found.version ?? '',
    ...found.schemas.flatMap((s) => [s.name, ...s.tables.flatMap((t) => [t.name, ...t.columns.flatMap((c) => [c.name, c.type])])]),
    ...found.nodeClasses, ...found.topics,
    ...(found.opcua?.types ?? []).flatMap((t) => [t.name, ...t.variables.flatMap((v) => [v.path, v.dataType]), ...t.references.flatMap((r) => [r.path, r.type])]),
    ...(found.mqtt?.families ?? []).flatMap((f) => [f.filter, ...f.fields.map((x) => x.name)]),
  ];
}

const MAX_REASONS = 20;
const withReasons = (run: DiscoveryRun, more: readonly string[]): string[] =>
  [...new Set([...run.reasons, ...more.map((r) => r.slice(0, 200))])].slice(0, MAX_REASONS);

type Ending = { status: 'completed' | 'failed' | 'revoked'; reason: string | null };

const probeRow = (run: DiscoveryRun, agentId: string, event: Extract<ScanEvent, { type: 'probe' }>): Omit<NewDiscoveryProbe, 'id'> => ({
  organisationId: run.organisationId, runId: run.id, agentId, host: event.host, port: event.port, method: event.method, outcome: event.outcome, probedAt: event.probedAt,
});

/** Each probe: one row and one host_probed event (spec 19.3: what, when, by which agent, under which authorisation). */
async function logProbes(db: Queryable, ctx: Context, run: DiscoveryRun, agentId: string, probes: readonly Omit<NewDiscoveryProbe, 'id'>[]): Promise<void> {
  await discoveryProbeRepo.insertMany(db, probes);
  for (const p of probes) {
    await recordDiscoveryEvent(db, {
      organisationId: run.organisationId, correlationId: ctx.correlationId, request: ctx.request, event: 'host_probed',
      resource: { type: 'discovery_run', id: run.id },
      detail: { host: p.host, port: p.port ?? null, method: p.method, outcome: p.outcome, agent_id: agentId, authorisation_id: run.authorisationId },
    });
  }
}

export interface ScanReport {
  agentId: string;
  sequence: number;
  events: ScanEvent[];
}

export function createRuns(deps: DiscoveryDeps) {
  const control = deps.databases.pool('control');

  async function view(ctx: Context, run: DiscoveryRun): Promise<RunView> {
    const counts = await inTransaction(control, ctx.request, (db) => discoveryRunRepo.counts(db, run.id), { readOnly: true });
    return {
      id: run.id, authorisationId: run.authorisationId, status: run.status, hostsContacted: run.hostsContactedCount, probes: counts.probes,
      findings: counts.findings, reasons: run.reasons, startedAt: run.startedAt, completedAt: run.completedAt,
    };
  }

  /** Ends a run, once: its status, why, and scan_completed with what it did. */
  async function finish(db: Queryable, ctx: Context, run: DiscoveryRun, ending: Ending, changes: Partial<DiscoveryRun> = {}): Promise<DiscoveryRun> {
    const reasons = withReasons(run, [...(changes.reasons ?? []), ...(ending.reason === null ? [] : [ending.reason])]);
    const ended = (await discoveryRunRepo.update(db, run.id, {
      ...changes, status: ending.status, completedAt: new Date().toISOString(), reasons,
    }))!;
    const counts = await discoveryRunRepo.counts(db, run.id);
    await recordDiscoveryEvent(db, {
      organisationId: run.organisationId, correlationId: ctx.correlationId, request: ctx.request, event: 'scan_completed',
      resource: { type: 'discovery_run', id: run.id },
      detail: { status: ending.status, hosts: ended.hostsContactedCount, probes: counts.probes, findings: counts.findings, reason: ending.reason },
    });
    return ended;
  }

  /** Ends runs still running, where they stand (revoked, switched off, silent). */
  async function stop(db: Queryable, ctx: Context, runs: readonly DiscoveryRun[], ending: Ending): Promise<void> {
    for (const run of runs) {
      const locked = await discoveryRunRepo.lock(db, run.id);
      if (locked?.status === 'running') await finish(db, ctx, locked, ending);
    }
  }

  return {
    async start(ctx: Context, authorisationId: string): Promise<RunView> {
      await enabledOrRefuse(deps, ctx);
      memberOf(ctx);
      await demand(deps, ctx, ['discovery.authorise']);
      const loaded = await inTransaction(control, ctx.request, async (db) => {
        const authorisation = await discoveryAuthorisationRepo.findById(db, authorisationId);
        if (!authorisation) throw new AppError('not_found', 'no such scan authorisation', { code: 'discovery.authorisation_not_found' });
        const chain = await approvalChainRepo.findById(db, authorisation.approvalChainId);
        const agent = await agentRepo.findById(db, authorisation.agentId);
        return { authorisation, chain, agent, running: await discoveryRunRepo.listRunning(db, authorisationId) };
      }, { readOnly: true });
      const status = authorisationView(loaded.authorisation, loaded.chain).status;
      if (status !== 'approved') {
        throw new AppError('conflict', `the authorisation is ${status}; a scan runs only under an approved one`, {
          code: 'discovery.authorisation_not_usable', details: { status },
        });
      }
      if (loaded.agent === undefined || loaded.agent.status === 'revoked' || loaded.agent.discoveryDisabledLocally) {
        throw new AppError('conflict', 'the agent cannot scan: revoked, or discovery disabled on it', { code: 'discovery.agent_refuses' });
      }
      if (loaded.running.length > 0) throw new AppError('conflict', 'a scan under this authorisation is already running', { code: 'discovery.run_in_progress' });
      if (!deps.scans.available) {
        throw new AppError('configuration', 'this cell has no discovery scan key: scans through the Silo Agent cannot be signed', { code: 'discovery.signing_unavailable' });
      }
      // The document the approvers' hash names, exactly: the agent takes everything from it.
      const a = loaded.authorisation;
      const document = (loaded.chain?.policySnapshot as { document?: Record<string, unknown> } | null)?.document;
      const text = document === undefined ? undefined : canonicalJson(document);
      if (text === undefined || a.signedHash === null || !sha256(Buffer.from(text, 'utf8')).equals(a.signedHash)) {
        throw new AppError('integrity', 'the authorisation document is not the one approved', { code: 'discovery.authorisation_mismatch' });
      }
      let run = await inTransaction(control, ctx.request, async (db) => {
        const row = await discoveryRunRepo.insert(db, { id: uuidv7(), organisationId: a.organisationId, authorisationId, lastReportAt: new Date().toISOString() });
        await recordDiscoveryEvent(db, {
          organisationId: a.organisationId, correlationId: ctx.correlationId, request: ctx.request, event: 'scan_started',
          resource: { type: 'discovery_run', id: row.id }, detail: { authorisation_id: authorisationId, agent_id: a.agentId },
        });
        return row;
      });
      const scan = deps.scans.sign({ scanId: run.id, organisationId: a.organisationId, agentId: a.agentId, authorisationId, authorisation: text });
      const deadline = new Date(Math.min(Date.parse(a.expiresAt), Date.now() + MAX_SCAN_SECONDS * 1000)).toISOString();
      try {
        await deps.agent.start(ctx, { agentId: a.agentId, runId: run.id, scan, deadline });
      } catch (error) {
        // Not connected, or it refused: the run is over before it began, and says why.
        const reason = isAppError(error) ? error.code : 'agent.error';
        deps.logger.warn('a discovery scan could not start', { event: 'discovery.scan_not_started', resourceId: run.id, reason });
        run = await inTransaction(control, ctx.request, async (db) => {
          const locked = (await discoveryRunRepo.lock(db, run.id))!;
          return locked.status === 'running' ? finish(db, ctx, locked, { status: 'failed', reason }) : locked;
        });
      }
      return view(ctx, run);
    },

    /** An authorisation's runs, newest first; an authorisation the organisation does not hold is not found. */
    async list(ctx: Context, authorisationId: string, limit: number): Promise<RunView[]> {
      await enabledOrRefuse(deps, ctx);
      await demand(deps, ctx, ['discovery.authorise', 'discovery.review']);
      const rows = await inTransaction(control, ctx.request, async (db) => {
        if (!await discoveryAuthorisationRepo.findById(db, authorisationId)) {
          throw new AppError('not_found', 'no such scan authorisation', { code: 'discovery.authorisation_not_found' });
        }
        return discoveryRunRepo.listForAuthorisation(db, authorisationId, limit);
      }, { readOnly: true });
      const views: RunView[] = [];
      for (const run of rows) views.push(await view(ctx, run));
      return views;
    },

    async get(ctx: Context, runId: string): Promise<RunView> {
      await enabledOrRefuse(deps, ctx);
      await demand(deps, ctx, ['discovery.authorise', 'discovery.review']);
      const run = await inTransaction(control, ctx.request, (db) => discoveryRunRepo.findById(db, runId), { readOnly: true });
      if (!run) throw new AppError('not_found', 'no such scan run', { code: 'discovery.run_not_found' });
      return view(ctx, run);
    },

    /**
     * A report of what the agent did, from connect-runtime. Taken in order, once: one already
     * taken is answered again, not taken twice. The answer says whether the scan goes on.
     */
    async report(ctx: Context, runId: string, report: ScanReport): Promise<{ stop: boolean; reason: string | null }> {
      // Proposals compare tables with the ontology's object types: read before the run is locked.
      const ontology: OntologyManifest | undefined = report.events.some((e) => e.type === 'finding')
        ? await deps.services.call(getManifest, { query: {} }, ctx).catch(() => undefined) : undefined;
      return inTransaction(control, ctx.request, async (db) => {
        const run = await discoveryRunRepo.lock(db, runId);
        if (!run) throw new AppError('not_found', 'no such scan run', { code: 'discovery.run_not_found' });
        const a = (await discoveryAuthorisationRepo.findById(db, run.authorisationId))!;
        if (a.agentId !== report.agentId) throw new AppError('forbidden', 'that run is another agent\'s', { code: 'discovery.agent_mismatch' });
        const over = (r: DiscoveryRun) => ({ stop: true, reason: r.reasons.at(-1) ?? r.status });
        if (report.sequence <= run.reportSequence) return run.status === 'running' ? { stop: false, reason: null } : over(run);
        if (report.sequence !== run.reportSequence + 1) {
          throw new AppError('conflict', `report ${report.sequence} came before ${run.reportSequence + 1}`, { code: 'discovery.report_out_of_order' });
        }
        const taken = { reportSequence: report.sequence, lastReportAt: new Date().toISOString() };
        if (run.status !== 'running') {
          // Stopped here before the agent heard: what it probed meanwhile still happened, and is logged.
          await logProbes(db, ctx, run, a.agentId, report.events.flatMap((e) => (e.type === 'probe' ? [probeRow(run, a.agentId, e)] : [])));
          await discoveryRunRepo.update(db, run.id, taken);
          return over(run);
        }

        const settings = await discoverySettingRepo.findByOrganisationId(db, run.organisationId);
        let ending: Ending | undefined = settings?.enabled !== true ? { status: 'revoked', reason: 'discovery_disabled' }
          : a.revokedAt !== null ? { status: 'revoked', reason: 'authorisation_revoked' }
          : Date.parse(a.expiresAt) <= Date.now() ? { status: 'revoked', reason: 'authorisation_expired' }
          : undefined;
        const notes: string[] = [];
        const probes: Omit<NewDiscoveryProbe, 'id'>[] = [];
        const findings: Extract<ScanEvent, { type: 'finding' }>[] = [];
        const hosts: string[] = [];
        if (ending === undefined) {
          for (const event of report.events) {
            if (event.type === 'end') {
              for (const method of event.unavailable ?? []) notes.push(`method_unavailable:${method}`);
              ending = event.status === 'completed' ? { status: 'completed', reason: event.reason ?? null } : { status: 'failed', reason: `agent:${event.reason ?? 'failed'}` };
              break;
            }
            if (!inTargets(event.host, a.ranges)) {
              ending = { status: 'failed', reason: 'target_outside_authorisation' };
              break;
            }
            if (!a.methods.includes(event.method)) {
              ending = { status: 'failed', reason: 'method_not_authorised' };
              break;
            }
            hosts.push(event.host);
            if (event.type === 'probe') {
              probes.push(probeRow(run, a.agentId, event));
            } else if (findValuePatterns(names(event.found).join('\n')).length > 0) {
              notes.push('finding_refused:value_pattern');
            } else {
              findings.push(event);
            }
          }
        }
        // The host bound counts distinct hosts across every report (spec 19.3).
        const contacted = run.hostsContactedCount + await discoveryRunHostRepo.add(db, run.organisationId, run.id, hosts);
        if (contacted > a.maxHosts && (ending === undefined || ending.status === 'completed')) ending = { status: 'failed', reason: 'max_hosts' };

        await logProbes(db, ctx, run, a.agentId, probes);
        for (const event of findings) {
          const proposed = proposeStructure(event.found, ontology);
          await discoveryFindingRepo.insert(db, {
            id: uuidv7(), organisationId: run.organisationId, runId: run.id, host: event.host, found: event.found as never,
            proposedConnectorType: proposedConnectorType(event.found), proposedObjectTypes: proposed.objectTypes as never,
            proposedLinks: proposed.links as never, confidence: String(proposed.confidence),
          });
        }
        const changes = { ...taken, hostsContactedCount: contacted, reasons: withReasons(run, notes) };
        if (ending === undefined) {
          await discoveryRunRepo.update(db, run.id, changes);
          return { stop: false, reason: null };
        }
        const ended = await finish(db, ctx, run, ending, changes);
        // A scan that ended itself needs no stop; one stopped here is told to.
        return ending.status === 'completed' || ending.reason?.startsWith('agent:') === true ? { stop: true, reason: null } : over(ended);
      });
    },

    /** The organisation switched discovery off: its runs stop, in the same transaction. */
    async stopAll(db: Queryable, ctx: Context): Promise<void> {
      await stop(db, ctx, await discoveryRunRepo.listRunningIn(db), { status: 'revoked', reason: 'discovery_disabled' });
    },

    /** An authorisation was revoked: its runs stop, in the same transaction. */
    async stopFor(db: Queryable, ctx: Context, authorisationId: string): Promise<void> {
      await stop(db, ctx, await discoveryRunRepo.listRunning(db, authorisationId), { status: 'revoked', reason: 'authorisation_revoked' });
    },

    /** Runs silent too long (their agent, its tunnel or its replica went), across organisations: failed. */
    async sweep(correlationId: string, now = Date.now()): Promise<number> {
      const silent = await inTransaction(control, {}, (db) => discoveryRunRepo.silent(db, new Date(now - deps.silentMs).toISOString(), 100), { readOnly: true });
      for (const { organisationId, runId } of silent) {
        const ctx: Context = { request: { organisationId }, correlationId };
        await inTransaction(control, ctx.request, async (db) => {
          const run = await discoveryRunRepo.lock(db, runId);
          if (run?.status === 'running') await finish(db, ctx, run, { status: 'failed', reason: 'agent_silent' });
        });
      }
      return silent.length;
    },
  };
}

export type Runs = ReturnType<typeof createRuns>;
