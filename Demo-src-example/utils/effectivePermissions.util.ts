import { contains } from './path.util';
import { checkMarkings, type Clearances, type MarkingRequirement } from './markingCheck.util';

/**
 * What a membership may actually do to a resource.
 *
 * TWO INDEPENDENT GATES, AND THE COMBINING RULE IS WHERE THIS GOES WRONG:
 *
 *   Discretionary (roles)   UNION across every scope the membership belongs to.
 *   Mandatory (markings)    INTERSECT. One missing marking denies.
 *
 * A person in two scopes gets the sum of what both permit and is still blocked by
 * any marking either lacks. Reversing either half is the classic hole in a
 * combined RBAC and MAC system.
 *
 * CACHED PER REQUEST, NEVER ACROSS. A grant revoked mid-session must bite on the
 * next request, and a cache with any lifetime beyond one request is a window in
 * which it does not.
 *
 * IT TAKES DATA, IT DOES NOT FETCH IT. That is what makes the resolution order
 * testable without a database, and it is the order that carries the security
 * property rather than any individual lookup.
 */

export interface RoleAssignment {
  permissions: readonly string[];
  /** Null for an organisation-wide assignment. */
  scopePath: string | null;
  /** Set when the assignment is scoped directly to one resource. */
  resourceId?: string | null;
  resourceType?: 'connection' | 'silo' | 'view' | null;
}

export interface ConnectionGrant {
  connectionId: string;
  access: 'read' | 'write';
  /** Null for an organisation-wide grant. */
  scopePath: string | null;
  includeDescendants: boolean;
}

export interface FieldPolicy {
  connectionId: string;
  fieldPath: string;
  effect: 'deny' | 'mask' | 'redact';
  appliesToRole?: string | null;
  appliesToMarking?: string | null;
  appliesToScopePath?: string | null;
  includeDescendants: boolean;
}

export interface Subject {
  /** Paths of every scope this membership belongs to. */
  scopePaths: readonly string[];
  roleAssignments: readonly RoleAssignment[];
  connectionGrants: readonly ConnectionGrant[];
  clearances: Clearances;
  roleIds: ReadonlySet<string>;
}

export interface Resource {
  type: 'connection' | 'silo' | 'view' | 'organisation';
  id: string;
  connectionId?: string;
  markings: MarkingRequirement;
}

export interface Decision {
  permissions: ReadonlySet<string>;
  connectionAccess: 'none' | 'read' | 'write';
  deniedFields: ReadonlySet<string>;
  maskedFields: ReadonlySet<string>;
  permitted: boolean;
  missingMarkings: readonly string[];
}

/** Whether an assignment or grant made at `scopePath` reaches this subject. */
function reaches(subject: Subject, scopePath: string | null, includeDescendants = true): boolean {
  // Organisation-wide reaches everybody in the tenant.
  if (scopePath === null) return true;
  return subject.scopePaths.some((held) =>
    includeDescendants ? contains(scopePath, held) : held === scopePath,
  );
}

export function resolve(subject: Subject, resource: Resource): Decision {
  /*
   * 1 and 2. Collect and union the discretionary permissions: organisation-wide,
   * plus any whose scope contains a scope the membership belongs to, plus any
   * scoped directly to this resource.
   */
  const permissions = new Set<string>();
  for (const assignment of subject.roleAssignments) {
    const direct =
      assignment.resourceId != null &&
      assignment.resourceId === resource.id &&
      assignment.resourceType === resource.type;

    if (direct || reaches(subject, assignment.scopePath)) {
      for (const permission of assignment.permissions) permissions.add(permission);
    }
  }

  /* 3. Connection grants reaching the resource, directly or through a scope. */
  let connectionAccess: 'none' | 'read' | 'write' = 'none';
  const connectionId = resource.connectionId ?? (resource.type === 'connection' ? resource.id : null);
  if (connectionId) {
    for (const grant of subject.connectionGrants) {
      if (grant.connectionId !== connectionId) continue;
      if (!reaches(subject, grant.scopePath, grant.includeDescendants)) continue;
      // Write implies read, and the strongest grant wins among grants.
      if (grant.access === 'write') connectionAccess = 'write';
      else if (connectionAccess === 'none') connectionAccess = 'read';
    }
  }

  /*
   * 4. INTERSECT WITH THE MANDATORY GATE. Last, and unconditional: no permission
   * collected above can override a missing marking.
   */
  const marking = checkMarkings(resource.markings, subject.clearances);

  return {
    permissions,
    connectionAccess: marking.permitted ? connectionAccess : 'none',
    deniedFields: new Set(),
    maskedFields: new Set(),
    permitted: marking.permitted && permissions.size > 0,
    missingMarkings: marking.missing,
  };
}

/**
 * Field policies that apply to this subject on this connection.
 *
 * RESOLVED BEFORE THE MANIFEST IS BUILT. A denied field never enters the plan and
 * never reaches the source system. This is the strongest security claim in the
 * product and it depends entirely on this running pre-compile — filtering a
 * result afterwards means the value was already fetched, already crossed the
 * network, and already sat in memory.
 */
export function applyFieldPolicies(
  subject: Subject,
  policies: readonly FieldPolicy[],
  connectionId: string,
): { denied: Set<string>; masked: Set<string> } {
  const denied = new Set<string>();
  const masked = new Set<string>();

  for (const policy of policies) {
    if (policy.connectionId !== connectionId) continue;

    // A policy targets a role, a marking or a scope. An untargeted one applies
    // to everybody.
    if (policy.appliesToRole && !subject.roleIds.has(policy.appliesToRole)) continue;
    if (policy.appliesToMarking && !subject.clearances.held.has(policy.appliesToMarking)) continue;
    if (
      policy.appliesToScopePath &&
      !reaches(subject, policy.appliesToScopePath, policy.includeDescendants)
    ) {
      continue;
    }

    // Deny beats mask beats redact. A field caught by two policies takes the
    // strictest, never the last one read.
    if (policy.effect === 'deny') {
      denied.add(policy.fieldPath);
      masked.delete(policy.fieldPath);
    } else if (!denied.has(policy.fieldPath)) {
      masked.add(policy.fieldPath);
    }
  }

  return { denied, masked };
}
