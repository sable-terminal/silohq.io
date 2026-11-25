// What the cell's Fleet agent tells the global tier about its cell, and brings back (spec 6.3,
// 11.5, 11.6, 13.4; D199):
//
// - Registration (6.3: "directory registration"): the cell's kind, residency, hostname and status
//   (FLEET_CELL_STATUS, active unless operations close it to placement, drain or retire it) and
//   its live connections, at start and every hour after. A sovereign cell registers nothing in the
//   shared directory. A new cell registers as provisioning, and "placement opens only after a
//   synthetic tenant passes the question, subscription, Action and revert lifecycles": the first
//   round all four pass opens it (active), remembered so a restart keeps it open (D203).
// - Status (13.4): a shared commercial cell reports its eight components every
//   FLEET_REPORT_SECONDS, each judged on the requests its services answered since the last report
//   (contracts/status/status.contract.ts): failing more than a quarter is a major outage, more
//   than one in twenty a partial outage, more than one in a hundred degraded; fewer than twenty
//   answered is operational if a process of it reports at all; none reporting is a major outage.
//   Dedicated, self-managed and sovereign cells never appear on the status page.
// - The change policy (11.5): a dedicated cell's customer sets windows and freezes in their cell;
//   the agent reads them there and carries them to fleet-control, which holds the cell's
//   rollouts to them.
// - Fleet's events about a single-tenant cell (dedicated or self-managed; 11.6): read from
//   fleet-control from the last sequence copied and handed to audit, which writes each into the
//   customer's log once.

import { recordFleetEvents, recordIncidentEvents, recordRedactionViolations } from '../../contracts/audit/fleetEvents.contract.ts';
import { registerCell } from '../../contracts/directory/registration.contract.ts';
import { cellConnectionCount } from '../../contracts/connect-registry/connection.contract.ts';
import { listCellEvents } from '../../contracts/fleet-control/events.contract.ts';
import { getConceptTemplateSet } from '../../contracts/fleet-control/conceptTemplates.contract.ts';
import { installConceptTemplates } from '../../contracts/catalogue/catalogue.contract.ts';
import { putCellChangePolicy } from '../../contracts/fleet-control/rollout.contract.ts';
import { listChangePoliciesForFleet } from '../../contracts/policy/changePolicy.contract.ts';
import { readStatus, reportCellStatus, STATUS_COMPONENTS, type COMPONENT_STATES } from '../../contracts/status/status.contract.ts';
import type { CellConfig } from '../../config/cell.config.ts';
import type { ServiceName } from '../../config/service.config.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { SignalStore } from './cellSignals.service.ts';

type Component = (typeof STATUS_COMPONENTS)[number];
type ComponentState = (typeof COMPONENT_STATES)[number];
export type CellStatus = 'provisioning' | 'active' | 'closed_to_placement' | 'draining' | 'retired';

/** The services behind each component of the status page. */
export const COMPONENT_SERVICES: Readonly<Record<Component, readonly ServiceName[]>> = {
  app: ['gateway'],
  login: ['auth'],
  questions: ['compile', 'planner', 'executor'],
  live_clones: ['state-plane', 'change-stream'],
  actions: ['actions', 'approvals', 'revert'],
  connections: ['connect-runtime', 'connect-registry'],
  files: ['files'],
  notifications: ['notify'],
};

const FRESH_MS = 120_000;

/** A component's state from what its services answered since the last report. */
export function componentState(reporting: number, total: number, errors: number): ComponentState {
  if (reporting === 0) return 'major_outage';
  if (total < 20) return 'operational';
  const rate = errors / total;
  return rate > 0.25 ? 'major_outage' : rate > 0.05 ? 'partial_outage' : rate > 0.01 ? 'degraded' : 'operational';
}

export function createCellReports(deps: {
  services: ServiceClient; logger: Logger; signals: SignalStore; cell: Pick<CellConfig, 'id' | 'kind' | 'residency' | 'hosts'>; status: CellStatus;
  /** Where a provisioning cell remembers that its placement opened. */
  placement?: { read(): Promise<{ openedAt: string } | undefined>; write(value: { openedAt: string }): Promise<void> } | undefined;
}) {
  const { cell } = deps;
  let status: CellStatus = deps.status;
  let remembered = deps.status !== 'provisioning';
  /** A provisioning cell whose placement opened before stays open. */
  const current = async (): Promise<CellStatus> => {
    if (!remembered) {
      if ((await deps.placement?.read()) !== undefined) status = 'active';
      remembered = true;
    }
    return status;
  };
  /** The concept template set last installed in this cell, by digest. */
  let templatesDigest: string | undefined;
  /** Redactions each process had counted per organisation when last carried to audit. */
  const redactionsSeen = new Map<string, number>();
  /** What each process had answered at the last status report, so each report judges what came since. */
  const seen = new Map<string, { total: number; errors: number }>();
  let after = 0;

  return {
    async register(correlationId: string): Promise<boolean> {
      if (cell.kind === 'sovereign') return false;
      const counted = await deps.services.call(cellConnectionCount, {}, { correlationId }).catch((error: unknown) => {
        deps.logger.failure('the cell\'s connections could not be counted; registering without them', error, { event: 'fleet.cell_count_failed' });
        return undefined;
      });
      await deps.services.call(registerCell, {
        params: { cellId: cell.id },
        body: {
          kind: cell.kind, residency: cell.residency, hostname: cell.hosts.app, status: await current(),
          ...(counted === undefined ? {} : { connectionCount: counted.connections }),
        },
      }, { correlationId });
      return true;
    },

    /** A provisioning cell whose synthetic tenant passed every lifecycle: placement opens (spec 6.3). */
    async openPlacement(correlationId: string): Promise<boolean> {
      if (await current() !== 'provisioning') return false;
      status = 'active';
      await deps.placement?.write({ openedAt: new Date().toISOString() });
      deps.logger.info('the synthetic tenant passed every lifecycle: placement opens', { event: 'fleet.placement_opened', resourceType: 'cell', resourceId: cell.id });
      await this.register(correlationId);
      return true;
    },

    async reportStatus(correlationId: string): Promise<Record<Component, ComponentState> | undefined> {
      if (cell.kind !== 'commercial') return undefined;
      const fresh = deps.signals.fresh(FRESH_MS);
      const components = {} as Record<Component, ComponentState>;
      const next = new Map<string, { total: number; errors: number }>();
      for (const component of STATUS_COMPONENTS) {
        const processes = fresh.filter((p) => p.signals.services.some((s) => COMPONENT_SERVICES[component].includes(s)));
        let total = 0;
        let errors = 0;
        for (const p of processes) {
          const now = p.signals.requests;
          const before = seen.get(p.processId);
          // A process that restarted counts from zero again.
          const base = before === undefined || before.total > now.total ? { total: 0, errors: 0 } : before;
          total += now.total - base.total;
          errors += now.errors - base.errors;
          next.set(p.processId, { total: now.total, errors: now.errors });
        }
        components[component] = componentState(processes.length, total, errors);
      }
      for (const [id, counts] of next) seen.set(id, counts);
      await deps.services.call(reportCellStatus, {
        params: { cellId: cell.id },
        body: { reportedAt: new Date().toISOString(), components: STATUS_COMPONENTS.map((component) => ({ component, state: components[component] })) },
      }, { correlationId });
      return components;
    },

    async carryPolicy(correlationId: string): Promise<number> {
      if (cell.kind !== 'dedicated') return 0;
      const { policies } = await deps.services.call(listChangePoliciesForFleet, {}, { correlationId });
      if (policies.length > 1) {
        deps.logger.warn('a dedicated cell holds more than one customer\'s change policy; the first is carried', { event: 'fleet.change_policy_ambiguous', count: policies.length });
      }
      const policy = policies[0];
      if (policy === undefined) return 0;
      await deps.services.call(putCellChangePolicy, { params: { cellId: cell.id }, body: policy }, { correlationId });
      return 1;
    },

    /**
     * Status page incidents naming this shared cell (13.2, 13.5; D209): each declaration and
     * resolution into its customers' audit logs, once (audit keeps which went). Only a shared
     * commercial cell appears on the status page.
     */
    async copyIncidents(correlationId: string): Promise<number> {
      if (cell.kind !== 'commercial') return 0;
      const status = await deps.services.call(readStatus, {}, { correlationId });
      const events = status.notices.filter((n) => n.kind === 'incident' && n.cellIds.includes(cell.id)).flatMap((n) => [
        { noticeId: n.id, event: 'incident_declared' as const, occurredAt: n.startedAt, severity: n.severity, components: n.components },
        ...(n.resolvedAt === null ? [] : [{ noticeId: n.id, event: 'incident_resolved' as const, occurredAt: n.resolvedAt, severity: n.severity, components: n.components }]),
      ]);
      let copied = 0;
      for (let i = 0; i < events.length; i += 100) {
        copied += (await deps.services.call(recordIncidentEvents, { body: { events: events.slice(i, i + 100) } }, { correlationId })).copied;
      }
      return copied;
    },

    /**
     * Log lines each process redacted a value pattern from, by the organisation named (13.1, 13.5;
     * D209): what came since the last look, into each organisation's audit log. Every cell kind.
     */
    async copyRedactions(correlationId: string): Promise<number> {
      const byOrganisation = new Map<string, { services: Set<string>; lines: number; kinds: Set<string> }>();
      const next = new Map<string, number>();
      for (const p of deps.signals.fresh(FRESH_MS)) {
        for (const r of p.signals.redactions ?? []) {
          const key = `${p.processId}/${r.organisationId}`;
          const before = redactionsSeen.get(key);
          // A process that restarted counts from zero again.
          const since = before === undefined || before > r.count ? r.count : r.count - before;
          next.set(key, r.count);
          if (since === 0) continue;
          const into = byOrganisation.get(r.organisationId) ?? { services: new Set<string>(), lines: 0, kinds: new Set<string>() };
          into.lines += since;
          for (const s of p.signals.services) into.services.add(s);
          for (const k of r.kinds) into.kinds.add(k);
          byOrganisation.set(r.organisationId, into);
        }
      }
      const violations = [...byOrganisation].map(([organisationId, v]) => ({
        organisationId, services: [...v.services].sort(), lines: v.lines, kinds: [...v.kinds].sort().slice(0, 10),
      }));
      let recorded = 0;
      for (let i = 0; i < violations.length; i += 100) {
        recorded += (await deps.services.call(recordRedactionViolations, { body: { violations: violations.slice(i, i + 100) } }, { correlationId })).recorded;
      }
      for (const [key, count] of next) redactionsSeen.set(key, count);
      return recorded;
    },

    /**
     * Fleet's reviewed concept template set (22.7; D210), into the cell's catalogue when it has
     * changed; the catalogue verifies Silo's signature before writing. Every cell, sovereign too.
     */
    async carryTemplates(correlationId: string): Promise<{ installed: number; withdrawn: number } | undefined> {
      const signed = await deps.services.call(getConceptTemplateSet, {}, { correlationId });
      if (signed.digest === templatesDigest) return undefined;
      const out = await deps.services.call(installConceptTemplates, { body: { set: signed.set, signatures: signed.signatures } }, { correlationId });
      templatesDigest = signed.digest;
      return { installed: out.installed, withdrawn: out.withdrawn };
    },

    async copyEvents(correlationId: string): Promise<number> {
      if (cell.kind !== 'dedicated' && cell.kind !== 'self_managed') return 0;
      let copied = 0;
      for (;;) {
        const page = await deps.services.call(listCellEvents, { params: { cellId: cell.id }, query: after > 0 ? { after: String(after) } : {} }, { correlationId });
        if (page.events.length === 0) return copied;
        const out = await deps.services.call(recordFleetEvents, { body: { events: page.events.slice(0, 100) } }, { correlationId });
        copied += out.copied;
        after = Math.max(after, ...page.events.slice(0, 100).map((e) => e.seq));
        if (page.next === null && page.events.length <= 100) return copied;
      }
    },
  };
}

export type CellReports = ReturnType<typeof createCellReports>;
