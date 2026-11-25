import type { ManifestObject } from '../../schemas/manifest.schema';
import type { ConceptRelationship, ContributingObject } from '../../models/concept.model';

/**
 * §4.1 — reading the relationships between concepts out of the schemas that
 * already declare them.
 *
 * ── Why this is not inference ───────────────────────────────────────────────
 *
 * Association analysis needs to know that an invoice relates to an order before
 * it can say anything about the two together. It was working that out from
 * whether their findings shared an entity reference, which is not a
 * relationship — it is two systems numbering things the same way, and it
 * produced confident associations between concepts that have nothing to do with
 * each other.
 *
 * A foreign key is the customer's own statement that one thing depends on
 * another. It is already in the manifest, it was already collected, and
 * `concept_objects` simply never carried it forward. Nothing here decides
 * anything: it joins two facts that were both already written down.
 *
 * ── Within one connection, always ──────────────────────────────────────────
 *
 * A foreign key is a statement INSIDE one system. Two objects in different
 * systems being the same thing is what the ontology is for, and reading a
 * relationship across that boundary would be inventing a join nobody declared.
 * So the walk is: this object, in this connection, references that object, in
 * the same connection — and both objects contribute to confirmed concepts.
 *
 * ── Direction is the information ───────────────────────────────────────────
 *
 * §4.1 wants to know which way a relationship COULD run. An invoice references
 * an order; an order does not reference an invoice, and a line item cannot
 * precede the order it belongs to whatever the data says. That is a fact about
 * the model rather than about cause, and it is the only directional claim this
 * product is willing to make.
 */

export type ConceptShape = {
  conceptId: string;
  objects: ContributingObject[];
};

export type DerivedRelationship = {
  fromConceptId: string;
  toConceptId: string;
  connectionId: string;
  fromObject: string;
  fromField: string;
  toObject: string;
  toField: string;
};

/**
 * Relationships between concepts, from the foreign keys their objects declare.
 *
 * DETERMINISTIC AND SORTED, like everything else the ontology derives: the same
 * manifests produce the same rows in the same order, so a re-derivation can be
 * told apart from a reordering.
 */
export function relate(input: {
  concepts: readonly ConceptShape[];
  /** Per connection, the objects its manifest describes. */
  objectsByConnection: ReadonlyMap<string, readonly ManifestObject[]>;
}): DerivedRelationship[] {
  /*
   * WHICH CONCEPTS HOLD WHICH OBJECT, PER CONNECTION — AND IT IS OFTEN TWO.
   *
   * This kept one: "first wins, by concept id", from when an object belonged
   * to a single concept. It no longer does. Every confirmed connection's
   * object is a concept of its own (128), and the same object is also part of
   * whatever concept spans it and its counterparts in other systems — a
   * ledger's contacts are "Contacts" and are one third of "Customer".
   *
   * With one owner, an invoice's key to its contact reached whichever of the
   * two had the smaller id: a coin toss, made once per organisation, on which
   * "customers with overdue invoices" either worked or was refused as having
   * no key between them. A foreign key into an object is a link to everything
   * that object is, so it reaches every concept that holds it.
   */
  const holders = new Map<string, string[]>();

  for (const concept of [...input.concepts].sort((a, b) => compare(a.conceptId, b.conceptId))) {
    for (const object of concept.objects) {
      const key = `${object.connectionId}\u0000${object.objectName}`;
      holders.set(key, [...(holders.get(key) ?? []), concept.conceptId]);
    }
  }

  const found: DerivedRelationship[] = [];

  for (const concept of input.concepts) {
    for (const contributing of concept.objects) {
      const objects = input.objectsByConnection.get(contributing.connectionId);
      if (!objects) continue;

      const described = objects.find((one) => one.name === contributing.objectName);
      if (!described) continue;

      for (const link of described.relationships) {
        /*
         * A FOREIGN KEY INTO AN OBJECT NO CONCEPT CONTRIBUTES IS A REAL LINK
         * AND NOT ONE THIS LAYER CAN SAY ANYTHING ABOUT. Invoices reference a
         * currency table nobody made a concept of; there is no second concept
         * for the relationship to reach, so there is nothing to record.
         */
        for (const target of holders.get(`${contributing.connectionId}\u0000${link.targetObject}`) ?? []) {
          if (target === concept.conceptId) continue;

          found.push({
            fromConceptId: concept.conceptId,
            toConceptId: target,
            connectionId: contributing.connectionId,
            fromObject: contributing.objectName,
            fromField: link.field,
            toObject: link.targetObject,
            toField: link.targetField,
          });
        }
      }
    }
  }

  /*
   * DEDUPLICATED ON WHAT THE UNIQUE CONSTRAINT KEYS ON, so a concept spanning
   * several connections that each declare the same foreign key produces one row
   * per connection rather than a constraint violation.
   */
  const unique = new Map<string, DerivedRelationship>();
  for (const relationship of found) {
    unique.set(
      [
        relationship.fromConceptId,
        relationship.toConceptId,
        relationship.connectionId,
        relationship.fromField,
      ].join('\u0000'),
      relationship,
    );
  }

  return [...unique.values()].sort(
    (a, b) =>
      compare(a.fromConceptId, b.fromConceptId) ||
      compare(a.toConceptId, b.toConceptId) ||
      compare(a.connectionId, b.connectionId) ||
      compare(a.fromField, b.fromField),
  );
}

/** Plain comparison, not `localeCompare`, whose result depends on ICU data. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/* ── §4.1 Routes ─────────────────────────────────────────────────────────── */

/**
 * A relationship as a walk crosses it, and which way round it was crossed.
 *
 * `along` FOLLOWS THE KEY: an invoice names an order, so walking from invoice
 * to order goes along it. `against` walks back up the key: from an order to the
 * invoices that name it. Both are legitimate; they are not the same claim, and
 * a path that does not say which is a path nobody can check.
 */
export type RouteStep = {
  relationshipId: string;
  fromConceptId: string;
  toConceptId: string;
  direction: 'along' | 'against';
  /** The system that declared this key. A route may not silently change system. */
  connectionId: string;
  /** The object and field the key is stated on, whichever way it is crossed. */
  keyObject: string;
  keyField: string;
  targetObject: string;
  targetField: string;
  origin: 'derived' | 'confirmed';
};

export type Route = {
  fromConceptId: string;
  toConceptId: string;
  steps: RouteStep[];
  /**
   * Where the start sits relative to the end, and NOTHING MORE THAN THAT.
   *
   * `upstream` means every step followed a key: the end is something the start
   * depends on, and so it existed first. `downstream` is every step against.
   * `mixed` is a route that turns around somewhere — two invoices reached
   * through a shared supplier — which is a real connection and not an ordering.
   *
   * IT IS POSITION, NOT CAUSE. See `describeRoute`.
   */
  position: 'upstream' | 'downstream' | 'mixed';
};

/**
 * Every route from one concept to another, shortest first.
 *
 * ── Types, never data ──────────────────────────────────────────────────────
 *
 * This reads the concept graph, which is a statement about SCHEMAS: these
 * objects declare these keys. No instance is consulted and none could be —
 * nothing here knows whether a single invoice exists. Walking actual rows is
 * `engine/traverse`, and it takes a route from here as its plan.
 *
 * ── Why every route and not the shortest ───────────────────────────────────
 *
 * Two concepts are often connected more than one way, and the ways are
 * different claims. An invoice reaches a supplier directly by `supplier_code`,
 * and also through its order. The first is what the invoice says; the second is
 * what the order said when the invoice was raised against it. A reader deciding
 * whether a finding on one bears on the other needs to see that there are two
 * and that they can disagree.
 *
 * ── A route may not change system ──────────────────────────────────────────
 *
 * Every step is a foreign key, and a foreign key is a statement INSIDE one
 * system. Stitching Netsuite's invoice→order onto Sage's order→supplier would
 * invent a join neither system declared, on the strength of the two orders
 * being "the same" — which is the ontology's claim about identity, not a key.
 * Crossing systems is what `resolve` is for, and it happens at the ends of a
 * walk rather than in the middle of one.
 */
export function routesBetween(input: {
  relationships: readonly ConceptRelationship[];
  from: string;
  to: string;
  /** Steps a route may have. The caller's bound, from `bounds.util`. */
  maxHops: number;
}): Route[] {
  if (input.from === input.to || input.maxHops < 1) return [];

  /* Both crossings of every key, indexed by where a walk would be standing. */
  const outward = new Map<string, RouteStep[]>();

  const add = (step: RouteStep) => {
    outward.set(step.fromConceptId, [...(outward.get(step.fromConceptId) ?? []), step]);
  };

  for (const relationship of [...input.relationships].sort(byRelationship)) {
    add({
      relationshipId: relationship.id,
      fromConceptId: relationship.fromConceptId,
      toConceptId: relationship.toConceptId,
      direction: 'along',
      connectionId: relationship.connectionId,
      keyObject: relationship.fromObject,
      keyField: relationship.fromField,
      targetObject: relationship.toObject,
      targetField: relationship.toField,
      origin: relationship.origin,
    });
    add({
      relationshipId: relationship.id,
      fromConceptId: relationship.toConceptId,
      toConceptId: relationship.fromConceptId,
      direction: 'against',
      connectionId: relationship.connectionId,
      keyObject: relationship.fromObject,
      keyField: relationship.fromField,
      targetObject: relationship.toObject,
      targetField: relationship.toField,
      origin: relationship.origin,
    });
  }

  const found: Route[] = [];

  /*
   * BREADTH FIRST, SO SHORTEST COMES FIRST. A reader offered the three-hop
   * route before the one-hop route will read the long one as the relationship,
   * and the direct key as an aside.
   */
  const walk = (at: string, taken: RouteStep[], visited: ReadonlySet<string>) => {
    if (taken.length >= input.maxHops) return;

    for (const step of outward.get(at) ?? []) {
      /* A CONCEPT IS NOT REVISITED. A cycle produces routes that are longer
         restatements of shorter ones, and there is no end to them. */
      if (visited.has(step.toConceptId)) continue;

      /* The system a route runs in is fixed by its first step. */
      const first = taken[0];
      if (first && step.connectionId !== first.connectionId) continue;

      const path = [...taken, step];

      if (step.toConceptId === input.to) {
        found.push({
          fromConceptId: input.from,
          toConceptId: input.to,
          steps: path,
          position: positionOf(path),
        });
        /* Reaching the target ends this route. Continuing past it and coming
           back would be a longer route to the same place. */
        continue;
      }

      walk(step.toConceptId, path, new Set([...visited, step.toConceptId]));
    }
  };

  walk(input.from, [], new Set([input.from]));

  return found.sort(
    (a, b) =>
      a.steps.length - b.steps.length ||
      compare(routeKey(a), routeKey(b)),
  );
}

const positionOf = (steps: readonly RouteStep[]): Route['position'] => {
  if (steps.every((step) => step.direction === 'along')) return 'upstream';
  if (steps.every((step) => step.direction === 'against')) return 'downstream';
  return 'mixed';
};

const routeKey = (route: Route) =>
  route.steps.map((step) => `${step.connectionId} ${step.keyObject}.${step.keyField} ${step.direction}`).join(' > ');

const byRelationship = (a: ConceptRelationship, b: ConceptRelationship) =>
  compare(a.fromConceptId, b.fromConceptId) ||
  compare(a.toConceptId, b.toConceptId) ||
  compare(a.connectionId, b.connectionId) ||
  compare(a.fromField, b.fromField);

/**
 * What a route is allowed to be reported as.
 *
 * ── The sentence this product will not write ───────────────────────────────
 *
 * SAYS THE BREAK IS UPSTREAM OF THE GAP. NEVER SAYS IT CAUSED IT.
 *
 * A route is derived from foreign keys. A foreign key says an invoice names an
 * order — it says nothing whatever about whether the order going wrong is why
 * the invoice did. The two findings may share a cause that is in neither
 * concept, they may be independent and merely adjacent, or the arrow may run
 * the other way entirely and the schema simply records it this direction.
 *
 * Every one of those reads the same from here, which is exactly why the
 * vocabulary is fixed in code rather than left to whoever writes the next
 * template. `upstream` is a position in a graph the customer drew. `caused`,
 * `because`, `led to`, `explains`, `due to`, `responsible for` are all claims
 * about the world that nothing in this system computed.
 *
 * The model in §5 writes prose, and this is what it is given to write from:
 * positions, not verbs.
 */
export function describeRoute(
  route: Route,
  nameOf: (conceptId: string) => string,
): string {
  const from = nameOf(route.fromConceptId);
  const to = nameOf(route.toConceptId);

  const through = route.steps
    .map((step) => `${step.keyObject}.${step.keyField}`)
    .join(', then ');

  const standing =
    route.position === 'upstream'
      ? `${to} is upstream of ${from}`
      : route.position === 'downstream'
        ? `${to} is downstream of ${from}`
        : `${from} and ${to} are connected, in neither order`;

  return `${standing}, through ${through}.`;
}
