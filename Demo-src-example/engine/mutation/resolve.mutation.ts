import type { ContributingObject } from '../../models/concept.model';
import type { ManifestObject } from '../../schemas/manifest.schema';
import { matches, type Comparison, type Filter } from '../execution/query.execution';
import type { ResolvedEntity } from '../ontology/resolve.ontology';
import { at, keyOf, type Row } from '../detectors/shared.detector';

/**
 * Mutations §3–§4 — from what somebody asked for to the records it lands on.
 *
 * ── Separate from the read path, deliberately ──────────────────────────────
 *
 * §1: "The mutation path is deliberately separate from the read path in the
 * engine. It shares the ontology, the connectors and the permission model, and
 * nothing else." So the entity set is resolved by the same planner, the same
 * completion pass and the same union-find as an answer — and then judged by a
 * stricter rule than an answer ever needs.
 *
 * ── Why stricter ───────────────────────────────────────────────────────────
 *
 * AN ANSWER CAN SAY HOW SURE IT IS. A write cannot. A total over an entity whose
 * other half could not be checked carries that doubt in its coverage and the
 * reader weighs it; a write to that entity either lands on the right record or
 * lands on the wrong one, and nothing afterwards says which. §4: "Resolution is
 * exact. An entity that cannot be resolved is not written to."
 */

export type MutationOperation = 'update' | 'delete';
export type ResolutionPolicy = 'strict' | 'partial';

/** A value a mutation may set. Scalars only: a field is written, not a document. */
export type SetValue = string | number | boolean | null;

/**
 * §3 — the mutation manifest.
 *
 * CONCEPT TERMS ONLY. No table, no column, no connection: the user says what
 * should change and the ontology says where. The intent in the user's own words
 * is kept beside this rather than in it, because the receipt carries the two
 * separately — what was said, and what it was compiled to.
 */
export type MutationManifest = {
  conceptId: string;
  operation: MutationOperation;
  /** The entity set, as filters in the concept's own field names. */
  where: Array<{ field: string; op: Comparison; value?: unknown }>;
  /**
   * Rendering §5 — "Act on it, ENTERING THE MUTATION PATH WITH THE SELECTION AS
   * THE TARGET."
   *
   * ── A SELECTION IS RECORDS, NOT A FILTER ──────────────────────────────────
   *
   * Somebody reads a distribution, sees three outliers and acts on those three.
   * There is usually no filter that means "these three": the thing that makes
   * them interesting is a deviation the source systems know nothing about. So
   * a caller either cannot express it, or reconstructs a filter that
   * approximates it — and an approximate filter re-evaluated at write time
   * reaches a fourth record that moved since, which nobody selected and nobody
   * will expect.
   *
   * ── THE PRECEDENT IS `reverts` ────────────────────────────────────────────
   *
   * §13 already addresses a change by the records in a receipt "not by filters"
   * for the same reason: the set was decided when somebody looked at it. This
   * is that, for the set somebody looked at on a screen.
   *
   * ── AND IT NARROWS, NEVER WIDENS ──────────────────────────────────────────
   *
   * Filters still apply where both are given. A target list is not a way past
   * a `where` — every gate the mutation path runs is over the entity set this
   * produces, and that set is the intersection.
   */
  targets?: string[];
  /** Concept field -> new value. Empty for a delete. */
  set: Record<string, SetValue>;
  resolution: ResolutionPolicy;
  /**
   * §13 — set when this change reverts another. A revert is addressed by the
   * records in that change's receipt, not by filters, so `where` and `set` are
   * empty and the values are per record, in the preview.
   */
  reverts?: { mutationId: string; receiptId: string };
};

/** Why a record the entity set reached is not written to. */
export type ExclusionReason =
  /** Two or more records in one system belong to the same entity. */
  | 'ambiguous'
  /** The record has no match key, so its counterparts elsewhere cannot be found. */
  | 'unkeyed'
  /** A system being written could not be asked whether it holds a counterpart. */
  | 'unverified'
  /** The systems disagree about whether the entity meets the filter. */
  | 'disputed'
  /** The record matched and has no identifier, so no write can address it. */
  | 'unidentified'
  /** A revert: somebody changed the field since, and nobody has decided what to do about it. */
  | 'conflicted'
  /** A revert: the record is no longer there to put back. */
  | 'record_missing';

export type Exclusion = {
  connectionId: string;
  /** Null only for `unidentified`, which by definition has nothing to name. */
  ref: string | null;
  reason: ExclusionReason;
  /** For `unverified`: the system that could not be asked. */
  missingIn?: string;
};

export type TargetMember = { connectionId: string; ref: string; row: Row };

export type TargetEntity = {
  /** An ordinal within this mutation. Never the match key, which is a value. */
  index: number;
  /** Only the members in systems being written to. */
  members: TargetMember[];
};

export type Targets = {
  entities: TargetEntity[];
  excluded: Exclusion[];
  /** Per written system, how many entities have no record there to change. */
  absent: Record<string, number>;
};

/**
 * Which connections a mutation writes to.
 *
 * AN UPDATE LANDS WHERE ITS FIELDS ARE, and nowhere else: a system that holds
 * the entity and none of the fields being set has nothing to change. A DELETE
 * LANDS EVERYWHERE THE ENTITY IS, because removing a customer from one of three
 * systems is not deleting the customer — it is creating a disagreement.
 */
export function writtenConnections(
  objects: readonly ContributingObject[],
  manifest: Pick<MutationManifest, 'operation' | 'set'>,
): string[] {
  if (manifest.operation === 'delete') return objects.map((object) => object.connectionId);

  const fields = Object.keys(manifest.set);
  return objects
    .filter((object) => fields.some((field) => field in object.fieldMap))
    .map((object) => object.connectionId);
}

/**
 * Whether a value fits what the system says the field holds.
 *
 * REFUSED, NOT COERCED, for the reason a filter refuses: a string written into a
 * number column either fails at the source — after approval, in front of the
 * approver — or succeeds as something nobody meant.
 *
 * `unknown` IS REFUSED TOO. A field whose type the connector does not know
 * cannot be checked, and "cannot be checked" is not the same as "anything goes".
 */
export function valueProblem(
  value: SetValue,
  field: ManifestObject['fields'][number],
): string | null {
  if (value === null) {
    return field.nullable ? null : `${field.name} cannot be left empty in its system.`;
  }

  switch (field.type) {
    case 'string':
      return typeof value === 'string' ? null : `${field.name} holds text.`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${field.name} holds a number.`;
    case 'money':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${field.name} holds an amount, as a number in major units.`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${field.name} holds true or false.`;
    case 'date':
      return typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        ? null
        : `${field.name} holds a date, written as YYYY-MM-DD.`;
    case 'datetime':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))
        ? null
        : `${field.name} holds a date and time, written in ISO 8601.`;
    case 'json':
      return null;
    case 'unknown':
      return `The type of ${field.name} is not known, so a value cannot be checked against it.`;
  }
}

/**
 * The records a mutation lands on, and the ones it will not touch and why.
 *
 * ── Membership is decided by every system, not by whichever answered first ─
 *
 * A filter is pushed to every system, and the completion pass then fetches the
 * counterparts of what matched WITHOUT the filter. An entity whose Netsuite
 * total is 250 and whose Sage total is 90 matched `total > 100` in one system
 * and not the other. An answer reports that as a disputed value; a write to
 * "invoices over 100" that updated both would change a record its own system
 * says is not over 100. So it is `disputed`, and not written.
 *
 * FIRST-PASS ROWS ARE TAKEN AS MATCHING. The source applied the filter itself,
 * with its own collation and its own date arithmetic; re-checking here could
 * only introduce disagreements the source does not have. Only rows fetched by
 * the completion pass, which never saw the filter, are checked locally.
 *
 * ── An entity is written whole or not at all ───────────────────────────────
 *
 * An exclusion removes the ENTITY, in every system. Writing the half that could
 * be resolved would make the systems disagree about a record they agreed on
 * before — a change that manufactures exactly the finding Silo exists to raise.
 */
export function selectTargets(input: {
  entities: readonly ResolvedEntity[];
  /** Rows the filter itself returned, per connection, before completion. */
  matched: ReadonlyMap<string, readonly Row[]>;
  objects: readonly ContributingObject[];
  /** Per connection, the filter in that system's column terms. */
  filters: ReadonlyMap<string, readonly Filter[]>;
  written: readonly string[];
  /** Systems the completion pass could not ask about a counterpart. */
  unverified: readonly string[];
}): Targets {
  const objectOf = new Map(input.objects.map((object) => [object.connectionId, object]));
  const written = new Set(input.written);
  const multiple = new Set(input.objects.map((object) => object.connectionId)).size > 1;

  const firstPass = new Map<string, Set<string>>();
  for (const [connectionId, rows] of input.matched) {
    const object = objectOf.get(connectionId);
    if (!object) continue;
    firstPass.set(connectionId, new Set(rows.map((row) => refFrom(row, object.identifierField))));
  }

  const excluded: Exclusion[] = [];
  const absent: Record<string, number> = Object.fromEntries(input.written.map((id) => [id, 0]));
  const entities: TargetEntity[] = [];

  /* A matching row with no identifier is in no entity, and cannot be addressed. */
  for (const [connectionId, rows] of input.matched) {
    const object = objectOf.get(connectionId);
    if (!object || !written.has(connectionId)) continue;
    for (const row of rows) {
      if (refFrom(row, object.identifierField) === '') {
        excluded.push({ connectionId, ref: null, reason: 'unidentified' });
      }
    }
  }

  for (const entity of input.entities) {
    const satisfies = (member: ResolvedEntity['members'][number]): boolean =>
      Boolean(firstPass.get(member.connectionId)?.has(member.ref)) ||
      (input.filters.get(member.connectionId) ?? []).every((filter) => matches(member.row, filter));

    /*
     * THE COMPLETION COMPLETES ENTITIES; IT NEVER FINDS NEW ONES. An entity
     * assembled only from counterpart rows was not in the set the filter
     * described, however those rows happen to look locally.
     */
    if (!entity.members.some((member) => firstPass.get(member.connectionId)?.has(member.ref))) continue;

    const meeting = entity.members.filter(satisfies);

    const inWritten = entity.members.filter((member) => written.has(member.connectionId));
    const exclude = (reason: ExclusionReason, missingIn?: string) => {
      for (const member of inWritten.length > 0 ? inWritten : meeting) {
        excluded.push({
          connectionId: member.connectionId,
          ref: member.ref,
          reason,
          ...(missingIn ? { missingIn } : {}),
        });
      }
    };

    if (meeting.length < entity.members.length) {
      exclude('disputed');
      continue;
    }

    const perConnection = new Map<string, number>();
    for (const member of inWritten) {
      perConnection.set(member.connectionId, (perConnection.get(member.connectionId) ?? 0) + 1);
    }
    if ([...perConnection.values()].some((count) => count > 1)) {
      exclude('ambiguous');
      continue;
    }

    /*
     * NO MATCH KEY, SO NO WAY TO KNOW WHAT ELSE IT IS. Only matters when the
     * concept spans more than one system and this change reaches beyond the
     * record's own: a write confined to the one system that holds it is exact.
     */
    const unkeyed =
      multiple &&
      entity.members.length === 1 &&
      keyOf(entity.members[0]!.row, objectOf.get(entity.members[0]!.connectionId)?.matchKeys ?? []) === null &&
      input.written.some((connectionId) => connectionId !== entity.members[0]!.connectionId);

    if (unkeyed) {
      exclude('unkeyed');
      continue;
    }

    const holders = new Set(entity.members.map((member) => member.connectionId));
    const unasked = input.written.find(
      (connectionId) => !holders.has(connectionId) && input.unverified.includes(connectionId),
    );
    if (unasked) {
      exclude('unverified', unasked);
      continue;
    }

    for (const connectionId of input.written) {
      if (!holders.has(connectionId)) absent[connectionId] = (absent[connectionId] ?? 0) + 1;
    }

    if (inWritten.length === 0) continue;

    entities.push({
      index: entities.length,
      members: inWritten.map((member) => ({
        connectionId: member.connectionId,
        ref: member.ref,
        row: member.row,
      })),
    });
  }

  return { entities, excluded, absent };
}

function refFrom(row: Row, field: string): string {
  return String(at(row, field) ?? '').trim();
}
