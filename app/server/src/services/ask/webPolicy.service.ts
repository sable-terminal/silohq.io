// Ask's web context per scope (36.7; decision 2026-11-14; D89). For one member: off where the
// organisation turned it off, or any scope they sit in or under turned it off, or those
// scopes hold marked data an admin satisfying it has not covered; otherwise on, limited to
// the deepest allowlist set and away from every blocklist. A result outside the domains is
// dropped before the answer shows it.

import type { Queryable } from '../../infra/postgres.infra.ts';
import type { WebResult } from '../../infra/webSearch.infra.ts';
import { askWebPolicyRepo } from '../../repos/workspace/index.repo.ts';

export interface EffectiveWebPolicy {
  enabled: boolean;
  /** Why it is off, where it is. */
  reason: 'organisation' | 'scope' | 'marked_data' | null;
  allowedDomains: string[];
  blockedDomains: string[];
  /** The deepest scope with a policy, for the audit record; null where none is set. */
  scopeId: string | null;
}

export async function effectiveWebPolicy(db: Queryable, membershipId: string, organisationEnabled: boolean): Promise<EffectiveWebPolicy> {
  const policies = await askWebPolicyRepo.forMember(db, membershipId);
  const base = {
    allowedDomains: policies.find((p) => p.allowedDomains.length > 0)?.allowedDomains ?? [],
    blockedDomains: [...new Set(policies.flatMap((p) => p.blockedDomains))], scopeId: policies[0]?.scopeId ?? null,
  };
  if (!organisationEnabled) return { enabled: false, reason: 'organisation', ...base };
  if (policies.some((p) => !p.enabled)) return { enabled: false, reason: 'scope', ...base };
  const held = await askWebPolicyRepo.markingsHeldFor(db, membershipId);
  const covered = new Set(policies.flatMap((p) => p.markedOverrideMarkings));
  if (held.some((m) => !covered.has(m))) return { enabled: false, reason: 'marked_data', ...base };
  return { enabled: true, reason: null, ...base };
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};
const within = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** Results inside the policy's domains (pure). */
export function withinDomains(results: readonly WebResult[], policy: Pick<EffectiveWebPolicy, 'allowedDomains' | 'blockedDomains'>): WebResult[] {
  return results.filter((r) => {
    const host = hostOf(r.url);
    if (host === '' || policy.blockedDomains.some((d) => within(host, d))) return false;
    return policy.allowedDomains.length === 0 || policy.allowedDomains.some((d) => within(host, d));
  });
}
