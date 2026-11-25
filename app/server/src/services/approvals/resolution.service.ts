// Policy resolution (spec 44.3), pure so it can be tested on its own.
//
// Per connection: the most specific level with an applicable policy (connection and its
// owning scope, then connection, then the organisation default) is stacked, taking the
// strictest of its policies whose row threshold the mutation reaches, whose risk class
// condition it meets, and whose marking condition names a marking it touches (44.3 rule 3);
// with none, the bulk guardrails are the default (one approver under 100 rows, two at 100 or
// more). Floors then raise anything weaker, and the override is recorded. A floor with
// unwaivable markings applies only to a mutation touching one of them (44.4).
//
// The markings a mutation touches are those its receipt inherits (58.6): on the Action type,
// the object type, the properties it writes and the connections it writes through. A
// marking_holder condition names the touched markings its approver must be cleared for: those
// its policy's (or floor's) condition names, or every touched marking where it names none.
// The Action type's policy is a condition of its own; a physical Action adds the physical
// floor (two approvers, never self-approval). The union keeps every condition.
//
// Slots: a chain holds one slot per required approver. Conditions are taken strictest first;
// each adds only the approvers its count needs beyond the slots already reserved, so one
// approver may satisfy several conditions and the number of distinct approvers is never
// below the largest single count. (Qualifications are treated as a chain, admin above any
// holder; a role and a scope admin are not comparable, so a mutation needing both reserves
// a slot for each.)

import type { ChainCondition, Qualification } from '../../contracts/approvals/approval.contract.ts';

export interface PolicyRow {
  id: string;
  connectionId: string | null;
  scopeId: string | null;
  approvalsRequired: number;
  approverQualification: Qualification;
  qualifyingRoleId: string | null;
  requiresAdmin: boolean;
  selfApprovalPermitted: boolean;
  sequential: boolean;
  rowThreshold: number | null;
  riskClassCondition: string[] | null;
  markingCondition: string[] | null;
  expiryHours: number;
}

export interface FloorRow {
  id: string;
  connectionId: string | null;
  minimumApprovals: number;
  minimumQualification: Qualification;
  riskClass: string | null;
  unwaivableMarkings: string[];
}

export interface ConnectionScope {
  id: string;
  owningScopeId: string;
}

export interface Resolution {
  conditions: ChainCondition[];
  sequential: boolean;
  expiryHours: number;
  policyIds: string[];
  floorIds: string[];
  overrides: { floorId: string; connectionId: string; from: number; to: number }[];
}

export const DEFAULT_EXPIRY_HOURS = 24;
const BULK_ROWS = 100;

const RANK: Readonly<Record<Qualification, number>> = { any_permitted: 0, scope_admin: 1, role: 2, named_role: 2, marking_holder: 2 };

interface Stacked {
  count: number;
  qualification: Qualification;
  qualifyingRoleId: string | null;
  requiresAdmin: boolean;
  selfApprovalPermitted: boolean;
  sequential: boolean;
  expiryHours: number;
  sources: string[];
  /** marking_holder: the touched markings named. */
  markingIds: string[];
}

/** The touched markings a condition names, or every touched marking where it names none. */
const named = (condition: readonly string[] | null, touched: ReadonlySet<string>): string[] =>
  condition === null || condition.length === 0 ? [...touched].sort() : condition.filter((m) => touched.has(m)).sort();

function stack(policies: readonly PolicyRow[], touched: ReadonlySet<string>): Stacked {
  const strictest = policies.reduce((a, b) => (RANK[b.approverQualification] > RANK[a.approverQualification] ? b : a));
  const holders = policies.filter((p) => p.approverQualification === 'marking_holder');
  return {
    count: Math.max(...policies.map((p) => p.approvalsRequired)),
    qualification: strictest.approverQualification,
    qualifyingRoleId: strictest.qualifyingRoleId,
    requiresAdmin: policies.some((p) => p.requiresAdmin),
    selfApprovalPermitted: policies.every((p) => p.selfApprovalPermitted),
    sequential: policies.some((p) => p.sequential),
    expiryHours: Math.min(...policies.map((p) => p.expiryHours)),
    sources: policies.map((p) => p.id),
    markingIds: [...new Set(holders.flatMap((p) => named(p.markingCondition, touched)))].sort(),
  };
}

export function resolvePolicies(input: {
  connections: readonly ConnectionScope[];
  policies: readonly PolicyRow[];
  floors: readonly FloorRow[];
  rowCount: number;
  riskClass: 'data' | 'bulk' | 'external' | 'physical';
  /** The Action type's own policy, in force (superseded rows followed). */
  actionTypePolicy?: PolicyRow | undefined;
  /** The markings the mutation touches (see the header). */
  markings?: ReadonlySet<string> | undefined;
}): Resolution {
  const touched = input.markings ?? new Set<string>();
  const touches = (markings: readonly string[] | null) => markings === null || markings.length === 0 || markings.some((m) => touched.has(m));
  const applicable = (p: PolicyRow) => (p.rowThreshold === null || input.rowCount >= p.rowThreshold)
    && (p.riskClassCondition === null || p.riskClassCondition.includes(input.riskClass))
    && touches(p.markingCondition);
  const conditions: ChainCondition[] = [];
  const policyIds = new Set<string>();
  const floorIds = new Set<string>();
  const overrides: Resolution['overrides'] = [];
  let sequential = false;
  let expiryHours = Number.POSITIVE_INFINITY;

  for (const c of input.connections) {
    const levels = [
      input.policies.filter((p) => p.connectionId === c.id && p.scopeId === c.owningScopeId),
      input.policies.filter((p) => p.connectionId === c.id && p.scopeId === null),
      input.policies.filter((p) => p.connectionId === null && (p.scopeId === null || p.scopeId === c.owningScopeId)),
    ].map((level) => level.filter(applicable));
    const chosen = levels.find((level) => level.length > 0);
    let resolved: Stacked = chosen !== undefined ? stack(chosen, touched)
      : {
        count: input.rowCount >= BULK_ROWS ? 2 : 1, qualification: 'any_permitted', qualifyingRoleId: null, requiresAdmin: false,
        selfApprovalPermitted: false, sequential: false, expiryHours: DEFAULT_EXPIRY_HOURS, sources: ['default'], markingIds: [],
      };
    for (const id of chosen?.map((p) => p.id) ?? []) policyIds.add(id);
    for (const floor of input.floors) {
      if (floor.connectionId !== null && floor.connectionId !== c.id) continue;
      if (floor.riskClass !== null && floor.riskClass !== input.riskClass) continue;
      if (!touches(floor.unwaivableMarkings)) continue;
      floorIds.add(floor.id);
      const weakerCount = resolved.count < floor.minimumApprovals;
      const weakerQualification = floor.minimumQualification !== 'any_permitted' && resolved.qualification === 'any_permitted';
      if (weakerCount || weakerQualification) {
        overrides.push({ floorId: floor.id, connectionId: c.id, from: resolved.count, to: Math.max(resolved.count, floor.minimumApprovals) });
        resolved = {
          ...resolved, count: Math.max(resolved.count, floor.minimumApprovals),
          qualification: weakerQualification ? floor.minimumQualification : resolved.qualification, sources: [...resolved.sources, `floor:${floor.id}`],
          ...(weakerQualification && floor.minimumQualification === 'marking_holder' ? { markingIds: named(floor.unwaivableMarkings, touched) } : {}),
        };
      }
    }
    sequential ||= resolved.sequential;
    expiryHours = Math.min(expiryHours, resolved.expiryHours);
    if (resolved.count > 0) {
      conditions.push({
        id: `connection:${c.id}`, count: resolved.count, qualification: resolved.qualification, qualifyingRoleId: resolved.qualifyingRoleId,
        requiresAdmin: resolved.requiresAdmin, selfApprovalPermitted: resolved.selfApprovalPermitted, connectionIds: [c.id], sources: resolved.sources,
        ...(resolved.qualification === 'marking_holder' ? { markingIds: resolved.markingIds } : {}),
      });
    }
  }

  const all = input.connections.map((c) => c.id);
  if (input.actionTypePolicy !== undefined && input.actionTypePolicy.approvalsRequired > 0 && applicable(input.actionTypePolicy)) {
    const p = input.actionTypePolicy;
    policyIds.add(p.id);
    sequential ||= p.sequential;
    expiryHours = Math.min(expiryHours, p.expiryHours);
    conditions.push({
      id: `action_type:${p.id}`, count: p.approvalsRequired, qualification: p.approverQualification, qualifyingRoleId: p.qualifyingRoleId,
      requiresAdmin: p.requiresAdmin, selfApprovalPermitted: p.selfApprovalPermitted, connectionIds: all, sources: [p.id],
      ...(p.approverQualification === 'marking_holder' ? { markingIds: named(p.markingCondition, touched) } : {}),
    });
  }
  if (input.riskClass === 'physical') {
    // Spec 47: two approvers, neither the requester nor a self-approval, one holding actuation.approve.
    conditions.push({
      id: 'physical_floor', count: 2, qualification: 'any_permitted', qualifyingRoleId: null, requiresAdmin: false, selfApprovalPermitted: false,
      connectionIds: all, sources: ['physical_floor'],
    });
  }
  return {
    conditions, sequential, expiryHours: Number.isFinite(expiryHours) ? expiryHours : DEFAULT_EXPIRY_HOURS,
    policyIds: [...policyIds], floorIds: [...floorIds], overrides,
  };
}

export const strictness = (c: ChainCondition): number => RANK[c.qualification] * 10 + (c.requiresAdmin ? 5 : 0) + (c.selfApprovalPermitted ? 0 : 1);

/** Whether an approver who meets other also meets c. */
const covers = (other: ChainCondition, c: ChainCondition): boolean =>
  (c.qualification === 'any_permitted' || (other.qualification === c.qualification && other.qualifyingRoleId === c.qualifyingRoleId))
  && (c.qualification !== 'marking_holder' || (c.markingIds ?? []).every((m) => (other.markingIds ?? []).includes(m)))
  && (other.requiresAdmin || !c.requiresAdmin)
  && (!other.selfApprovalPermitted || c.selfApprovalPermitted);

/** One slot per required approver, strictest conditions first (see the header). */
export function allocateSlots(conditions: readonly ChainCondition[]): string[] {
  const ordered = [...conditions].sort((a, b) => strictness(b) - strictness(a) || b.count - a.count);
  const slots: string[] = [];
  for (const c of ordered) {
    const covering = slots.filter((id) => covers(conditions.find((x) => x.id === id)!, c)).length;
    for (let n = covering; n < c.count; n++) slots.push(c.id);
  }
  return slots;
}
