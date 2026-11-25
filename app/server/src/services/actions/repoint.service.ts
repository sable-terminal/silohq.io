// Re-pointing links on revert (spec 46.6): a dependent's key is written with the identifier
// the source gives a record the same revert recreates, known only once that create has run.
// Planned, the new value is this placeholder naming the recreating target; the diff shows it
// as such, and execution writes the dependents in a second pass with the identifier put in.

export interface NewIdentifierOf {
  $newIdentifierOf: string;
}

export const newIdentifierOf = (targetId: string): NewIdentifierOf => ({ $newIdentifierOf: targetId });

export function isNewIdentifier(value: unknown): value is NewIdentifierOf {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>)['$newIdentifierOf'] === 'string';
}

/** Whether a target's new values wait on another target's identifier. */
export const followsRecreation = (newValues: Record<string, unknown> | undefined): boolean => Object.values(newValues ?? {}).some(isNewIdentifier);

/** A dependent the revert could not re-point, named in the receipt. */
export interface NotRepointed {
  recreatedTargetId: string;
  connectionId: string;
  reference: string;
  via: string;
  reason: 'not_writable' | 'changed_since' | 'no_object_type' | 'not_found';
}
