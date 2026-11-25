// Measuring the AI FDE (spec 54): what the engagement's own records and the organisation's
// audit events show, computed when asked and stored as fde_metrics rows, each ratio with its
// numerator and denominator and every value with the records it came from. "A metric that
// cannot cite its events is not recorded": one whose events are not raised yet is named as
// not measured, with why; one whose events have not happened yet is simply absent.
//
// From the audit events, since the agent was installed (or the engagement started):
// - time to first answer: the first ask_question_compiled (an answer, not a refusal), in
//   working hours;
// - conformance pass rate: connections whose first conformance_run_completed verified them,
//   over connections verified, per transport;
// - heal proposal accuracy: heal_applied over heal_applied and heal_rejected (the reviewed);
//   rename repairs later found to be changes of meaning are not detected;
// - unconfirmed edge crossing rate: simulation_crossed_unconfirmed_edge over simulation_run,
//   in the thirty days after stage 8 passed;
// - time to first live clone: the first live subscription_opened with objects on a connection
//   whose mapping was confirmed (mapping_confirmed) before it, in working hours;
// - time to first app: the first app_opened of the published version of an app the engagement
//   created from an accepted studio_app proposal, by a person other than the one who accepted
//   it, in working days;
// - post-handover reversal rate: of the artefacts the engagement created before handover (its
//   accepted proposals' applied targets), those retired, reverted or revised within ninety days
//   of fde_engagement_handed_over (REVERSALS), over the artefacts created. While the ninety days
//   run it is the rate so far, citing its window.

import { credibleInterval } from '../../utils/bayes.util.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { FdeMetric, FdeProposal, FdeProposalTarget } from '../../models/fde/index.model.ts';
import { fdeMetricRepo, fdeProposalRepo, fdeProposalTargetRepo, fdeStageRepo } from '../../repos/fde/index.repo.ts';
import { auditEventRepo } from '../../repos/audit/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { nowOf, type Context, type FdeDeps } from './deps.service.ts';
import { loadEngagement } from './engagements.service.ts';

const DECIDED = ['accepted', 'accepted_edited', 'rejected'];

/** A metric whose events are not raised yet, named with why (none now: every metric of 54.1 cites its events). */
const NOT_MEASURED: { metric: string; why: string }[] = [];

const ACCEPTED = ['accepted', 'accepted_edited'];

const ELEMENT_CHANGES = ['element_deprecated', 'element_retired'];

/**
 * What retires, reverts or revises each kind of artefact an engagement creates (54.1), by the
 * target column that names it: the resource its events name, and the events that count.
 * - An ontology element also counts when a merge to main changes it (ontology_proposal_merged
 *   names up to a hundred of the elements it changed).
 * - A published version after the first is a revision of an app or an Action type; the first
 *   publication is not.
 * - Only a person pausing a Cron counts; the scheduler pausing it for a halted source or a
 *   removed owner is not a reversal.
 * - write_enablement's connection counts when its writes are disabled.
 * Kinds a person does not revise as such, or whose events do not name them (estate entries,
 * discovery findings, heal reviews, connector manifests and mappings, resolution pairs, aliases,
 * time fields, detector configurations), are counted on neither side.
 */
const REVERSALS: Partial<Record<keyof FdeProposalTarget, { type: string; events: readonly string[] }>> = {
  objectTypeId: { type: 'object_type', events: ELEMENT_CHANGES },
  linkTypeId: { type: 'link_type', events: ELEMENT_CHANGES },
  interfaceId: { type: 'interface', events: ELEMENT_CHANGES },
  actionTypeId: { type: 'action_type', events: ['action_type_retired', 'action_type_version_published'] },
  appId: { type: 'app', events: ['app_archived', 'app_rolled_back', 'app_publication_withdrawn', 'app_version_published'] },
  savedViewId: { type: 'view', events: ['view_archived'] },
  automationId: { type: 'automation', events: ['automation_deleted', 'automation_paused'] },
  dependencyEdgeId: { type: 'dependency_edge', events: ['graph_edge_revised', 'graph_edge_retired'] },
  fieldAuthorityId: { type: 'field_authority', events: ['authority_revoked'] },
};

const ELEMENT_TYPES = new Set(['object_type', 'link_type', 'interface']);

interface Artefact { id: string; type: string; events: readonly string[] }

/** The artefact a target names, where 54.1's reversal rate counts its kind. */
function artefactOf(t: FdeProposalTarget): Artefact | undefined {
  if (t.proposalKind === 'write_enablement' && t.connectionId !== null) return { id: t.connectionId, type: 'connection', events: ['writes_disabled'] };
  for (const [column, reversal] of Object.entries(REVERSALS)) {
    const id = t[column as keyof FdeProposalTarget];
    if (typeof id === 'string') return { id, ...reversal! };
  }
  return undefined;
}

/** Whether an event retires, reverts or revises the artefact (see REVERSALS). */
function reverses(a: Artefact, e: { event: string; membershipId: string | null; detail: Record<string, unknown> }): boolean {
  if (!a.events.includes(e.event)) return false;
  if (e.event === 'app_version_published' || e.event === 'action_type_version_published') return Number(e.detail['version']) > 1;
  if (e.event === 'automation_paused') return e.membershipId !== null;
  return true;
}

const DAY = 86_400_000;

const SLICE = 15 * 60_000;

/**
 * Working days between two instants in the organisation's calendar time zone (54.3): Monday
 * to Friday there, whole and part days, counted in quarter hours so a zone with a half-hour
 * offset still turns its days at local midnight. Which days are working days the spec does
 * not say; Saturday and Sunday are not.
 */
export function workingDays(from: string, to: string, timeZone = 'UTC'): number {
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' });
  const start = Date.parse(from);
  const end = Date.parse(to);
  let ms = 0;
  for (let t = start; t < end;) {
    const next = Math.min(end, (Math.floor(t / SLICE) + 1) * SLICE);
    const day = weekday.format(new Date(t));
    if (day !== 'Sat' && day !== 'Sun') ms += next - t;
    t = next;
  }
  return ms / 86_400_000;
}

export function createMetrics(deps: FdeDeps) {
  const pool = deps.databases.pool('control');

  return {
    async compute(ctx: Context, engagementId: string) {
      return inTransaction(pool, ctx.request, async (db) => {
        const e = await loadEngagement(db, engagementId);
        const at = nowOf(deps).toISOString();
        const timeZone = (await organisationRepo.findById(db, e.organisationId))?.calendarTimeZone ?? 'UTC';
        const proposals = await fdeProposalRepo.listForEngagement(db, e.id);
        const stages = await fdeStageRepo.listForEngagement(db, e.id);
        const from = [{ table: 'fde.fde_proposals', engagement_id: e.id }];
        const rows: Omit<FdeMetric, 'id' | 'organisationId' | 'engagementId'>[] = [];
        const ratio = (metric: FdeMetric['metric'], dimensions: Record<string, string | number>, numerator: number, denominator: number,
          cite: readonly Record<string, unknown>[] = from) => {
          if (denominator === 0) return;
          rows.push({ metric, dimensions: dimensions as never, value: (numerator / denominator).toFixed(4), unit: 'ratio',
            numerator: String(numerator), denominator: String(denominator), computedFrom: cite as never, measuredAt: at });
        };
        const count = (list: FdeProposal[], statuses: string[]) => list.filter((p) => statuses.includes(p.status)).length;

        for (const kind of new Set(proposals.map((p) => p.kind))) {
          const ofKind = proposals.filter((p) => p.kind === kind);
          const decided = count(ofKind, DECIDED);
          ratio('proposals_accepted_unchanged', { proposal_kind: kind }, count(ofKind, ['accepted']), decided);
          ratio('proposals_edited', { proposal_kind: kind }, count(ofKind, ['accepted_edited']), decided);
          ratio('proposals_rejected', { proposal_kind: kind }, count(ofKind, ['rejected']), decided);
        }
        // Calibration: bands are informative only if their accepted-unchanged rates separate.
        for (const band of ['high', 'medium', 'low'] as const) {
          const ofBand = proposals.filter((p) => p.confidenceBand === band);
          ratio('calibration', { confidence_band: band }, count(ofBand, ['accepted']), count(ofBand, DECIDED));
        }
        const stageCite = [{ table: 'fde.fde_stages', engagement_id: e.id }];
        for (const n of new Set(stages.map((s) => s.stageNumber))) {
          const attempts = stages.filter((s) => s.stageNumber === n);
          ratio('stage_failure_rate', { stage_number: n }, attempts.filter((s) => s.status === 'failed').length, attempts.length, stageCite);
          const passed = attempts.find((s) => s.status === 'passed' && s.enteredAt !== null && s.exitedAt !== null);
          if (passed !== undefined) {
            rows.push({ metric: 'time_per_stage', dimensions: { stage_number: n } as never, value: workingDays(passed.enteredAt!, passed.exitedAt!, timeZone).toFixed(4),
              unit: 'working_days', numerator: null, denominator: null, computedFrom: [{ table: 'fde.fde_stages', id: passed.id }] as never, measuredAt: at });
          }
        }
        // Other services' audit events (see the header).
        const since = e.agentInstalledAt ?? e.startedAt;
        const audited = (event: string) => [{ table: 'audit.audit_events', organisation_id: e.organisationId, event, since }];
        const answer = await auditEventRepo.firstOf(db, e.organisationId, ['ask_question_compiled'], since);
        if (answer !== undefined) {
          rows.push({ metric: 'time_to_first_answer', dimensions: {} as never, value: (workingDays(since, answer.occurredAt, timeZone) * 24).toFixed(4), unit: 'working_hours',
            numerator: null, denominator: null, computedFrom: [{ table: 'audit.audit_events', id: answer.id }, { table: 'fde.fde_engagements', id: e.id }] as never,
            measuredAt: at });
        }
        const firstRun = new Map<string, boolean>();
        for (const run of await auditEventRepo.detailsOf(db, e.organisationId, 'conformance_run_completed', since, 10_000)) {
          const connectionId = run.detail['connection_id'];
          if (typeof connectionId === 'string' && !firstRun.has(connectionId)) firstRun.set(connectionId, run.detail['verified'] === true);
        }
        const byTransport = new Map<string, { passed: number; verified: number }>();
        for (const [connectionId, passed] of firstRun) {
          const connection = await connectionRepo.findById(db, connectionId);
          const manifest = connection === undefined ? undefined : await connectorManifestRepo.findById(db, connection.manifestId);
          const transport = (manifest?.document as { protocol?: { kind?: string } } | undefined)?.protocol?.kind ?? 'unknown';
          const tally = byTransport.get(transport) ?? { passed: 0, verified: 0 };
          tally.verified += 1;
          if (passed) tally.passed += 1;
          byTransport.set(transport, tally);
        }
        for (const [transport, tally] of byTransport) ratio('conformance_pass_rate', { transport }, tally.passed, tally.verified, audited('conformance_run_completed'));
        const heals = await auditEventRepo.countsOf(db, e.organisationId, ['heal_applied', 'heal_rejected'], since, at);
        ratio('heal_proposal_accuracy', {}, heals['heal_applied'] ?? 0, (heals['heal_applied'] ?? 0) + (heals['heal_rejected'] ?? 0),
          [...audited('heal_applied'), ...audited('heal_rejected')]);
        const simulated = stages.find((s) => s.stageNumber === 8 && s.status === 'passed' && s.exitedAt !== null);
        if (simulated !== undefined) {
          const until = new Date(Math.min(Date.parse(simulated.exitedAt!) + 30 * DAY, Date.parse(at))).toISOString();
          const counted = await auditEventRepo.countsOf(db, e.organisationId, ['simulation_crossed_unconfirmed_edge', 'simulation_run'], simulated.exitedAt!, until);
          ratio('unconfirmed_edge_crossing_rate', {}, counted['simulation_crossed_unconfirmed_edge'] ?? 0, counted['simulation_run'] ?? 0,
            [...audited('simulation_crossed_unconfirmed_edge'), ...audited('simulation_run'), { table: 'fde.fde_stages', id: simulated.id }]);
        }

        // Time to first live clone: a confirmed mapping's objects first rendered with live state.
        let liveClone: { id: string; occurredAt: string; connectionId: string } | undefined;
        for (const confirmed of await auditEventRepo.firstPerResource(db, e.organisationId, 'mapping_confirmed', since)) {
          const opened = await auditEventRepo.firstLiveSubscription(db, e.organisationId, confirmed.resourceId, confirmed.occurredAt);
          if (opened !== undefined && (liveClone === undefined || Date.parse(opened.occurredAt) < Date.parse(liveClone.occurredAt))) liveClone = { ...opened, connectionId: confirmed.resourceId };
        }
        if (liveClone !== undefined) {
          rows.push({ metric: 'time_to_first_live_clone', dimensions: {} as never, value: (workingDays(since, liveClone.occurredAt, timeZone) * 24).toFixed(4),
            unit: 'working_hours', numerator: null, denominator: null, measuredAt: at,
            computedFrom: [{ table: 'audit.audit_events', id: liveClone.id }, { table: 'audit.audit_events', event: 'mapping_confirmed', connection_id: liveClone.connectionId },
              { table: 'fde.fde_engagements', id: e.id }] as never });
        }

        // Time to first app: an accepted app opened by someone other than the person who accepted it.
        const accepted = proposals.filter((p) => ACCEPTED.includes(p.status));
        const targets = await fdeProposalTargetRepo.appliedFor(db, accepted.map((p) => p.id));
        const deciderOf = new Map(accepted.map((p) => [p.id, p.decidedBy]));
        let firstApp: { id: string; occurredAt: string; appId: string } | undefined;
        for (const t of targets.filter((x) => x.proposalKind === 'studio_app' && x.appId !== null)) {
          const decider = deciderOf.get(t.proposalId);
          if (decider === null || decider === undefined) continue;
          const opened = await auditEventRepo.firstOpenByAnother(db, e.organisationId, t.appId!, since, decider);
          if (opened !== undefined && (firstApp === undefined || Date.parse(opened.occurredAt) < Date.parse(firstApp.occurredAt))) firstApp = { ...opened, appId: t.appId! };
        }
        if (firstApp !== undefined) {
          rows.push({ metric: 'time_to_first_app', dimensions: {} as never, value: workingDays(since, firstApp.occurredAt, timeZone).toFixed(4), unit: 'working_days',
            numerator: null, denominator: null, measuredAt: at,
            computedFrom: [{ table: 'audit.audit_events', id: firstApp.id }, { table: 'fde.fde_proposal_targets', app_id: firstApp.appId },
              { table: 'fde.fde_engagements', id: e.id }] as never });
        }

        // Post-handover reversal rate: the engagement's artefacts retired, reverted or revised within ninety days of handover.
        const [handover] = await auditEventRepo.onResources(db, e.organisationId, ['fde_engagement_handed_over'], [e.id], e.startedAt, at, 1);
        if (handover !== undefined) {
          const until = new Date(Math.min(Date.parse(handover.occurredAt) + 90 * DAY, Date.parse(at))).toISOString();
          const artefacts = new Map<string, Artefact>();
          for (const t of targets) {
            const a = Date.parse(t.createdAt) <= Date.parse(handover.occurredAt) ? artefactOf(t) : undefined;
            if (a !== undefined) artefacts.set(a.id, a);
          }
          const reversed = new Set<string>();
          const events = [...new Set([...artefacts.values()].flatMap((a) => a.events))];
          for (const ev of await auditEventRepo.onResources(db, e.organisationId, events, [...artefacts.keys()], handover.occurredAt, until, 10_000)) {
            const a = artefacts.get(ev.resourceId);
            if (a !== undefined && reverses(a, ev)) reversed.add(a.id);
          }
          if ([...artefacts.values()].some((a) => ELEMENT_TYPES.has(a.type))) {
            for (const merge of await auditEventRepo.detailsOf(db, e.organisationId, 'ontology_proposal_merged', handover.occurredAt, 10_000)) {
              if (Date.parse(merge.occurredAt) >= Date.parse(until)) break;
              for (const id of (merge.detail['element_ids'] as string[] | undefined) ?? []) if (ELEMENT_TYPES.has(artefacts.get(id)?.type ?? '')) reversed.add(id);
            }
          }
          ratio('post_handover_reversal_rate', {}, reversed.size, artefacts.size, [
            { table: 'audit.audit_events', id: handover.id }, { table: 'fde.fde_proposal_targets', engagement_id: e.id },
            { table: 'audit.audit_events', events: [...events, 'ontology_proposal_merged'], from: handover.occurredAt, until },
          ]);
        }

        const engagementCite = [{ table: 'fde.fde_engagements', id: e.id }, { table: 'billing.token_transactions', engagement_id: e.id }];
        rows.push({ metric: 'tokens_per_engagement', dimensions: {} as never, value: e.tokensConsumed, unit: 'tokens', numerator: null, denominator: null,
          computedFrom: engagementCite as never, measuredAt: at });
        rows.push({ metric: 'provider_cost_per_engagement', dimensions: {} as never, value: e.providerCostConsumed, unit: 'gbp', numerator: null, denominator: null,
          computedFrom: [{ table: 'fde.fde_tasks', engagement_id: e.id }] as never, measuredAt: at });

        for (const row of rows) await fdeMetricRepo.insert(db, { id: uuidv7(), organisationId: e.organisationId, engagementId: e.id, ...row });
        const latest = await fdeMetricRepo.latestFor(db, e.id);
        return {
          metrics: latest.map((m) => ({
            metric: m.metric, dimensions: m.dimensions as Record<string, never>, value: m.value, unit: m.unit, numerator: m.numerator,
            denominator: m.denominator, measuredAt: m.measuredAt,
            interval: m.unit === 'ratio' && m.numerator !== null && m.denominator !== null && Number(m.denominator) > 0
              ? credibleInterval(Number(m.numerator), Number(m.denominator)).map((x) => Math.round(x * 10_000) / 10_000) as [number, number] : null,
          })),
          notMeasured: NOT_MEASURED,
        };
      });
    },
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
