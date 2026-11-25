/**
 * §2 — what the customer's data means.
 *
 * NOTHING HERE IS PREDEFINED AND NOTHING CAN BE. These are the shapes a concept
 * takes, not a list of concepts: there is no `Invoice`, no `Customer`, and no
 * enum of known types anywhere in this file. Two customers with a concept called
 * "customer" have unrelated concepts, and the model expresses that by having
 * nothing to say about what a concept is called.
 */

/**
 * One connector's contribution to a concept.
 *
 * IT LIVES IN THE MODEL BECAUSE FOUR PLACES NEED IT. The service confirms them,
 * the derivation engine proposes them, the detectors resolve rows against them
 * and the map layer reads them — and before this file existed there were two
 * structurally identical copies of this type, which is two definitions waiting
 * to disagree about whether `matchKeys` is ordered.
 */
export interface ContributingObject {
  connectionId: string;
  objectName: string;
  /**
   * WHICH FIELD IS THE INSTANCE. Not a value — a field path, so an entity is
   * referred to by identifier and never by its contents.
   */
  identifierField: string;
  /** §2.5 — ordered, because the first that matches decides. */
  matchKeys: string[];
  /**
   * §2.3 — the concept's name for each field, and this system's name for it.
   *
   * `{ total: 'TotalAmt', status: 'Status__c' }`. One question names `total`
   * and every system it reaches translates it separately — which is why this
   * belongs to the concept rather than the connector: a connector describes one
   * system without reference to any other, and a concept is a statement about
   * several.
   *
   * DERIVED RATHER THAN TYPED. `canonicalField` computes it from the manifest,
   * so every customer on the same connector gets the same canonicalisation
   * without entering anything; what they correct is kept per connection and
   * inherited by every later concept over it.
   */
  fieldMap: Record<string, string>;
}

/**
 * How a concept came to exist. §2.4 — confirmation is the creating act; a
 * `system` concept is one object of a confirmed connection, made by Silo so it
 * can be asked about from the first connection (128); a `learned` one spans
 * systems and was made by Silo because their records bore it out (132).
 */
export type ConceptOrigin = 'confirmed' | 'corrected' | 'manual' | 'system' | 'learned';

export interface Concept {
  id: string;
  organisationId: string;
  name: string;
  origin: ConceptOrigin;
  proposalId: string | null;
  confirmedBy: string;
  confirmedAt: Date;
  retiredAt: Date | null;
  objects: ContributingObject[];
}

/**
 * §2.7 — A CONCEPT NEEDS TWO SYSTEMS TO BE WORTH ANYTHING.
 *
 * DERIVED, NOT STORED, for the reason `seat.model` gives about seat state: a
 * `resolvable` column would be a second source of truth beside the contributing
 * objects, wrong the first time one is added without it.
 *
 * IT TAKES THE OBJECTS RATHER THAN THE CONCEPT because the answer is per
 * reader. A concept spanning finance and engineering is resolvable for somebody
 * granted both and inert for somebody granted one, and the caller filters to
 * what that person can reach before asking.
 */
export function resolvable(objects: readonly ContributingObject[]): boolean {
  if (objects.length < 2) return false;

  /* One object per connection: two in the same system is not two systems
     agreeing, it is one system compared with itself. */
  return new Set(objects.map((object) => object.connectionId)).size === objects.length;
}

/** §2.4 — a proposal is a filled-in form. It is not a concept. */
export type ProposalDecision = 'confirmed' | 'corrected' | 'rejected' | 'learned';

export interface ConceptProposal {
  id: string;
  organisationId: string;
  proposedName: string;
  contributing: ContributingObject[];
  /**
   * WHY IT THINKS THESE ARE THE SAME THING — field overlap, value overlap, a
   * foreign key. §2.2 keeps this as structure and counts; there is no value
   * from a customer's record in here and there must never be one.
   */
  evidence: Record<string, unknown>;
  confidence: number | null;
  decision: ProposalDecision | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  conceptId: string | null;
  proposedAt: Date;
}

/* §2.6's shapes live in `resolution.model` — the failure path is kept
   separate because it is the only place inference touches identity. */

/**
 * A stable key for a set of contributing objects.
 *
 * USED TO TELL A NEW PROPOSAL FROM ONE ALREADY IN THE QUEUE. Sorted, so two
 * derivation runs that found the same group in a different order produce the
 * same key — otherwise re-running doubles the review queue and the third run
 * triples it.
 */
export function signatureOf(objects: readonly { connectionId: string; objectName: string }[]): string {
  return objects
    .map((object) => `${object.connectionId}:${object.objectName}`)
    .sort()
    .join('|');
}

/* ── Corrections ─────────────────────────────────────────────────────────── */

/**
 * What changed about a concept.
 *
 * A CLOSED SET, BECAUSE THE READER IS FILTERING. Somebody asking "has anything
 * about identity changed since March" wants `objects_changed` and not the
 * eleven renames in between, and free text cannot be filtered on.
 */
export type ConceptChange = 'renamed' | 'objects_changed' | 'markings_changed' | 'retired';

export interface ConceptRevision {
  id: string;
  conceptId: string;
  change: ConceptChange;
  /** What the concept was. Names, field paths, ids — never a record's contents. */
  previousState: Record<string, unknown>;
  newState: Record<string, unknown>;
  reason: string | null;
  changedBy: string;
  changedAt: Date;
}

/**
 * Whether a correction changes what past answers MEANT.
 *
 * RENAMING IS COSMETIC AND RE-KEYING IS NOT. A concept called "supplier" that
 * becomes "vendor" resolves exactly the same rows; one whose match keys change
 * from `code` to `vat_number` may merge and split entities that every earlier
 * finding was computed against. The first needs a record; the second needs a
 * record AND a reason, which is why the database refuses one without it.
 */
export function altersIdentity(change: ConceptChange): boolean {
  return change === 'objects_changed' || change === 'retired';
}

/* ── §4.1 Relationships between concepts ─────────────────────────────────── */

/**
 * One concept references another, because a foreign key says so.
 *
 * DIRECTED, AND THAT IS THE INFORMATION. An invoice references an order; an
 * order does not reference an invoice, and a line item cannot precede the order
 * it belongs to whatever the data says. That is a fact about the model rather
 * than about cause, and it is the only directional claim this product makes.
 */
export interface ConceptRelationship {
  id: string;
  organisationId: string;
  fromConceptId: string;
  toConceptId: string;
  connectionId: string;
  fromObject: string;
  fromField: string;
  toObject: string;
  toField: string;
  /** `derived` from a manifest's foreign key; `confirmed` stated by a person. */
  origin: 'derived' | 'confirmed';
  confirmedBy: string | null;
  recordedAt: Date;
}
