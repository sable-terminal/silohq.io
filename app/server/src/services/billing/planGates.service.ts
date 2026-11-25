// Plan gates (decision 2026-11-14, amending spec 71.2; D76): what the organisation's open
// entitlement allows, beside permissions. Entitlements are the only billing data the product
// reads (71.4), so every gate reads them here.
//
// - A self-serve plan (an entitlement from a subscription) lists and connects certified
//   prebuilt connectors only.
// - The AI connector builder and the no-code builder need their capabilities, which only
//   Enterprise contracts carry.
// - Connections are limited per plan (null is unlimited). Only adding one is refused; a
//   limit never disconnects an existing connection, so a plan moved down keeps them all.
//
// Each refusal names the plan that would allow it, for the client's upgrade prompt. An
// organisation with no entitlement row (provisioned by hand before billing applies) is not
// gated; every organisation that signs up or signs a contract has one.

import type { Queryable } from '../../infra/postgres.infra.ts';
import type { Entitlement } from '../../models/billing/entitlement.model.ts';
import type { Connector } from '../../models/connect/connector.model.ts';
import { entitlementRepo, subscriptionRepo } from '../../repos/billing/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { PLAN_ENTITLEMENTS } from './plans.service.ts';

export type Plan = 'standard' | 'business' | 'enterprise';

export interface PlanGates {
  /** False where the organisation has no entitlement: nothing is gated. */
  gated: boolean;
  plan: Plan | null;
  /** Certified prebuilt connectors only (a self-serve plan). */
  prebuiltOnly: boolean;
  capabilities: ReadonlySet<string>;
  /** Null: unlimited. */
  connectionsLimit: number | null;
}

const BUILDER_CAPABILITY = { ai: 'ai_connector_builder', visual: 'nocode_connector_builder' } as const;
const BUILDER_NAME = { ai: 'The AI connector builder', visual: 'The no-code connector builder' } as const;

export const UNGATED: PlanGates = { gated: false, plan: null, prebuiltOnly: false, capabilities: new Set(), connectionsLimit: null };

/** The gates from an entitlement and its plan (pure). */
export function gatesOf(entitlement: Entitlement | undefined, plan: Plan | null): PlanGates {
  if (entitlement === undefined) return UNGATED;
  return {
    gated: true, plan, prebuiltOnly: entitlement.source === 'subscription', capabilities: new Set(entitlement.capabilities),
    connectionsLimit: entitlement.connectionsLimit ?? null,
  };
}

/** The organisation's gates now, in the caller's transaction (RLS: the request's organisation). */
export async function planGates(db: Queryable, organisationId: string): Promise<PlanGates> {
  const entitlement = await entitlementRepo.findOpen(db, organisationId);
  if (entitlement === undefined) return UNGATED;
  const plan: Plan = entitlement.source === 'contract' || entitlement.source === 'sovereign_terms' ? 'enterprise'
    : (entitlement.subscriptionId === null ? undefined : await subscriptionRepo.findById(db, entitlement.subscriptionId))?.plan ?? 'standard';
  return gatesOf(entitlement, plan);
}

/** The next plan up that would hold more connections than this one (pure). */
export function upgradeForConnections(plan: Plan | null, limit: number): Plan {
  if (plan === 'standard') {
    const business = PLAN_ENTITLEMENTS.business.connectionsLimit ?? null;
    if (business === null || business > limit) return 'business';
  }
  return 'enterprise';
}

/** Refuses a build route the plan does not include. */
export function requireBuilder(gates: PlanGates, route: 'ai' | 'visual'): void {
  if (!gates.gated || gates.capabilities.has(BUILDER_CAPABILITY[route])) return;
  throw new AppError('forbidden', `${BUILDER_NAME[route]} is included in Enterprise. Upgrade to Enterprise to build your own connectors; `
    + 'certified prebuilt connectors are available on your plan.', {
    code: 'plan.builder_not_included', details: { capability: BUILDER_CAPABILITY[route], upgrade: 'enterprise' },
  });
}

/** Refuses a connector a self-serve plan does not list. */
export function requireListed(gates: PlanGates, connector: Pick<Connector, 'organisationId' | 'trustTier'>): void {
  if (!gates.prebuiltOnly || (connector.organisationId === null && connector.trustTier === 'certified')) return;
  throw new AppError('forbidden', 'Your plan connects certified prebuilt connectors only. Upgrade to Enterprise to connect other connectors.', {
    code: 'plan.prebuilt_only', details: { trustTier: connector.trustTier, upgrade: 'enterprise' },
  });
}

/** Refuses a connection beyond the limit; existing ones are untouched. */
export function requireConnectionRoom(gates: PlanGates, used: number): void {
  const limit = gates.connectionsLimit;
  if (limit === null || used < limit) return;
  const upgrade = upgradeForConnections(gates.plan, limit);
  throw new AppError('forbidden', `Your plan includes ${limit} connection${limit === 1 ? '' : 's'} and ${used} ${used === 1 ? 'is' : 'are'} in use. `
    + `Upgrade to ${upgrade === 'business' ? 'Business' : 'Enterprise'} to add more; your existing connections keep working.`, {
    code: 'plan.connections_limit', details: { limit, used, upgrade },
  });
}
