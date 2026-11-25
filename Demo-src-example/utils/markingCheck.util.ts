/**
 * The mandatory gate: does this membership hold every marking on this resource.
 *
 * INTERSECTION, NOT UNION, AND THAT IS THE WHOLE DIFFERENCE FROM ROLES. A role
 * grants a capability, so holding two roles gives you the sum. A marking withholds
 * a resource, so missing one denies it however many you hold. Reversing this is
 * the classic hole in a combined RBAC and MAC system: somebody adds a second
 * clearance and it silently widens what a missing third one was protecting.
 *
 * DENY WINS AND IT IS NOT OVERRIDABLE. There is no role, no admin tier and no
 * super admin bypass. A super admin without the clearance does not see the
 * resource, which is the point of separating clearance from role.
 */

export interface MarkingRequirement {
  /** Every marking on the resource, its connection, and any contributing concept. */
  required: readonly string[];
}

export interface Clearances {
  /** Marking ids the membership currently holds, expiry already applied. */
  held: ReadonlySet<string>;
}

export interface MarkingDecision {
  permitted: boolean;
  /**
   * Which markings were missing.
   *
   * FOR THE AUDIT LOG, NOT FOR THE USER. Telling somebody they lack `PROJECT
   * ORION` confirms that a compartment by that name exists and that something in
   * it is relevant to their question — which is exactly what a compartment is
   * meant to hide.
   */
  missing: string[];
}

export function checkMarkings(
  requirement: MarkingRequirement,
  clearances: Clearances,
): MarkingDecision {
  const missing = requirement.required.filter((marking) => !clearances.held.has(marking));
  return { permitted: missing.length === 0, missing };
}

/**
 * Collect every marking a resource is subject to.
 *
 * A CONCEPT'S MARKINGS COUNT, AND THIS IS THE SUBTLE ONE. An ontology concept
 * resolves an entity across systems. If one contributing system is restricted and
 * another is not, resolving the concept reveals that a restricted record exists —
 * the count changes, the join succeeds, the entity appears. Field-level marking
 * alone leaves that side channel wide open.
 *
 * The compiler drops the concept from the plan entirely rather than resolving it
 * and filtering afterwards. Resolution never runs against a source the user
 * cannot see.
 */
export function requiredMarkings(input: {
  resource: readonly string[];
  connection?: readonly string[];
  concepts?: readonly (readonly string[])[];
}): MarkingRequirement {
  const all = new Set<string>(input.resource);
  for (const marking of input.connection ?? []) all.add(marking);
  for (const concept of input.concepts ?? []) {
    for (const marking of concept) all.add(marking);
  }
  return { required: [...all] };
}
