/**
 * §2.8 — which system is right about a field of a concept.
 *
 * A STATEMENT SOMEBODY MADE, NEVER SOMETHING DERIVED. Nothing in this product
 * can work out which of two systems holds the correct total, and every
 * heuristic that looks like it could is wrong somewhere expensive. This is the
 * record of a person deciding, which is the only thing that settles it.
 */
export interface FieldAuthority {
  id: string;
  organisationId: string;
  conceptId: string;
  /** The CONCEPT's name for the field, so one statement covers every system. */
  fieldPath: string;
  /** The system whose reading wins. */
  connectionId: string;
  /** Why this system, in the words of whoever decided. */
  because: string | null;
  declaredBy: string;
  declaredAt: Date;
  /**
   * RETIRED, NEVER DELETED. Every answer anybody was given while it stood was
   * merged by it, and a row that vanishes makes those answers unexplainable.
   */
  retiredAt: Date | null;
}
