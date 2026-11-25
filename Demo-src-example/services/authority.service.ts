import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, notFound } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { childLogger } from '../config/logger.config';
import { assertCan, authorityOf } from './authorisation.service';
import { readableIds } from './connector.service';
import * as authorityRepo from '../repos/authority.repo';
import * as fieldAliasRepo from '../repos/fieldAlias.repo';
import * as conceptTimeRepo from '../repos/conceptTime.repo';
import * as conceptRepo from '../repos/concept.repo';
import type { FieldAuthority } from '../models/authority.model';
import type { Actor } from './scope.service';

const log = childLogger('authority');

/**
 * §2.8 — which system is right about a field.
 *
 * ── Why this is a person's statement and not a rule ────────────────────────
 *
 * Resolution says two rows are one invoice. Then Netsuite says its total is
 * £200 and Sage says £260, and everything above that point has to know what to
 * do. A FINDING may report both and decide nothing — that is what a
 * disagreement detector is for. A TOTAL cannot: it carries one number, and
 * something has to choose.
 *
 * Nothing in this product can make that choice. Most-recently-written is wrong
 * when a nightly sync overwrites a correction; highest-precision is wrong when
 * one system rounds on purpose; more-rows is wrong when it is the stale one. So
 * a person says it, the same way §2.4 makes a person confirm a concept.
 *
 * ── It is not delegable ────────────────────────────────────────────────────
 *
 * `authority.declare` is `scopeable = false`. This decides what every later
 * answer says a number IS, across the whole organisation — a scope admin
 * setting it for their own department would be deciding the organisation's
 * figures from inside one corner of it.
 */

export async function list(actor: Actor, conceptId?: string): Promise<FieldAuthority[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const found = await authorityRepo.live(db, conceptId);

        /*
         * ── BOUNDED BY WHAT THE READER CAN REACH ─────────────────────────────
         *
         * An authority names a CONNECTION, so the list is a statement about
         * which systems hold which concepts. Returning every one in the
         * organisation tells somebody with no grant on a system that it exists
         * and what it decides — the same disclosure `concept.relationships` is
         * filtered for, and the same rule.
         *
         * DROPPED, NOT REFUSED, like every other filter of this kind here: one
         * unreachable connection must not turn the whole list into an error,
         * because that announces the connection just as loudly.
         */
        const readable = await readableIds(
          db,
          actor,
          [...new Set(found.map((one) => one.connectionId))],
        );

        return found.filter((one) => readable.has(one.connectionId));
      }),
  );
}

/**
 * Say which system decides a field.
 *
 * THE DATABASE REFUSES A SYSTEM THE CONCEPT DOES NOT SPAN, through a composite
 * foreign key onto `concept_objects (concept_id, connection_id)`. That is worth
 * more than a check here: a declaration naming a system the concept has no
 * object in would never fire, and nobody would think to look for it.
 */
export async function declare(
  actor: Actor,
  input: { conceptId: string; fieldPath: string; connectionId: string; because?: string },
): Promise<FieldAuthority> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'authority.declare');

        /* A retired concept is the same answer as no concept: declaring an
           authority on one would merge answers against something withdrawn. */
        const concept = await conceptRepo.read(db, input.conceptId);
        if (!concept || concept.retiredAt) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        const fieldPath = input.fieldPath.trim();
        if (fieldPath === '') {
          throw invalid({ message: 'Name the field.', code: 'invalid.field_path' });
        }

        /*
         * SAID HERE AS WELL AS ENFORCED THERE. The composite foreign key gives
         * a constraint violation, which reaches a caller as a 500 and tells
         * them nothing. This is the same refusal in words they can act on.
         */
        if (!concept.objects.some((object) => object.connectionId === input.connectionId)) {
          throw invalid({
            message: `${concept.name} has no object in that system, so it cannot decide anything about it.`,
            code: 'invalid.concept_missing_object',
          });
        }

        const declared = await authorityRepo.declare(db, {
          organisationId: actor.organisationId,
          conceptId: input.conceptId,
          fieldPath,
          connectionId: input.connectionId,
          because: input.because?.trim() || null,
          declaredBy: actor.membershipId,
        });

        /*
         * AUDITED, BECAUSE IT CHANGES WHAT EVERY LATER ANSWER SAYS A NUMBER IS.
         * Somebody asking why this quarter's total differs from last quarter's
         * needs to find the day the authority moved, and who moved it.
         */
        await writeAudit(db, {
          event: 'field_authority_declared',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            conceptId: input.conceptId,
            fieldPath,
            connectionId: input.connectionId,
          },
        });

        log.info(
          { conceptId: input.conceptId, fieldPath, connectionId: input.connectionId },
          'Field authority declared',
        );

        return declared;
      }),
  );
}

/**
 * Withdraw one.
 *
 * AFTERWARDS THE FIELD IS DISPUTED AGAIN wherever the systems differ, and that
 * is the point rather than a regression: withdrawing the statement withdraws
 * the answers it was producing, and a merge that kept working off a decision
 * the organisation has taken back would be worse than one that stops.
 */
export async function retire(actor: Actor, id: string): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'authority.declare');

        if (!(await authorityRepo.retire(db, id))) {
          throw notFound({
            message: 'That authority does not exist, or has already been withdrawn.',
            code: 'missing.authority',
          });
        }

        await writeAudit(db, {
          event: 'field_authority_retired',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { authorityId: id },
        });

        log.info({ authorityId: id }, 'Field authority withdrawn');
      }),
  );
}

/* ── §2.3 Field corrections ──────────────────────────────────────────────── */

/**
 * What this organisation calls a column, where the convention got it wrong.
 *
 * ── Said once per system, not once per concept ─────────────────────────────
 *
 * Canonicalisation is mechanical: `Invoice.TotalAmt` becomes `total` by taking
 * the object's own name out of the field's. A column called `amt_gross`
 * canonicalises to `amt_gross`, which is not wrong so much as not what the
 * business calls it, and somebody has to say so.
 *
 * THAT STATEMENT BELONGS TO THE CONNECTION. It is a fact about a vendor's
 * schema and holds for every concept over that system, so a customer with an
 * invoice concept, a credit note concept and a payments concept over one ERP
 * says it once — and every concept confirmed afterwards inherits it.
 *
 * IT DOES NOT REACH A CONCEPT ALREADY CONFIRMED. A concept's map is what it was
 * confirmed with, and silently rewriting it would change what every stored
 * finding about it was computed from. Correcting one is `concept.correct`,
 * which records a revision and asks for a reason.
 */
export async function listCorrections(actor: Actor, connectionId: string) {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () => withTransaction((db) => fieldAliasRepo.forConnections(db, [connectionId])),
  );
}

export async function correctField(
  actor: Actor,
  input: {
    connectionId: string;
    objectName: string;
    sourceField: string;
    canonicalField: string;
  },
) {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        /*
         * `concept.confirm` RATHER THAN `authority.declare`. Naming a column is
         * part of saying what a system holds, which is what confirming a
         * concept is — and unlike deciding WHICH system is right, it is bounded
         * by the connections a scope admin can already reach.
         */
        assertCan(authority, 'concept.confirm');

        /*
         * ── AND THE CONNECTION, WHICH WAS NOT CHECKED AT ALL ─────────────────
         *
         * The permission was verified and the connection was not, so a
         * correction could be written against any connection id in the cell —
         * another tenant's included. The foreign key does not stop it, because
         * a foreign key is not scoped by row level security.
         *
         * The route comment claimed this was "bounded by the connections a
         * scope admin can already reach". It is now.
         */
        const readable = await readableIds(db, actor, [input.connectionId]);
        if (!readable.has(input.connectionId)) {
          throw notFound({
            message: 'That connection does not exist, or you cannot reach it.',
            code: 'missing.connection',
          });
        }

        const declared = await fieldAliasRepo.declare(db, {
          organisationId: actor.organisationId,
          connectionId: input.connectionId,
          objectName: input.objectName.trim(),
          sourceField: input.sourceField.trim(),
          canonicalField: input.canonicalField.trim(),
          declaredBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'field_alias_declared',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            connectionId: input.connectionId,
            objectName: declared.objectName,
            sourceField: declared.sourceField,
            canonicalField: declared.canonicalField,
          },
        });

        log.info(
          { connectionId: input.connectionId, sourceField: declared.sourceField },
          'Field correction recorded',
        );

        return declared;
      }),
  );
}

export async function removeCorrection(actor: Actor, id: string): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'concept.confirm');

        if (!(await fieldAliasRepo.remove(db, id))) {
          throw notFound({
            message: 'That correction does not exist.',
            code: 'missing.field_alias',
          });
        }

        await writeAudit(db, {
          event: 'field_alias_removed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { aliasId: id },
        });
      }),
  );
}

/* ── §7.3 Time fields ────────────────────────────────────────────────────── */

/**
 * Which fields of a concept are times, and which one a question means.
 *
 * ── Why this is a statement and not a guess ────────────────────────────────
 *
 * "Last quarter's invoices" means something different against created,
 * modified, occurred and effective, and the difference is usually material: an
 * invoice raised in March, amended in April and dated to February appears in
 * three different quarters depending which one was meant.
 *
 * Nothing can work that out from a schema. A column called `date` is not a kind
 * of time, and two systems calling the same kind different things is the normal
 * case — which is why this is named in the CONCEPT's own words and covers every
 * system it spans, including ones connected later.
 *
 * THE DEFAULT IS WHAT MAKES A QUESTION ANSWERABLE WITHOUT ASKING. Where there
 * is one, a question that names no field uses it and the answer says so. Where
 * there are several and no default, the compiler surfaces the choice rather
 * than making it.
 */
export async function timeFields(actor: Actor, conceptId: string) {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () => withTransaction((db) => conceptTimeRepo.forConcepts(db, [conceptId])),
  );
}

export async function declareTimeField(
  actor: Actor,
  input: {
    conceptId: string;
    fieldPath: string;
    kind: 'occurred' | 'created' | 'modified' | 'effective';
    isDefault?: boolean;
  },
) {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        /* Naming what a field MEANS is part of saying what a system holds,
           which is what confirming a concept is. */
        assertCan(authority, 'concept.confirm');

        const concept = await conceptRepo.read(db, input.conceptId);
        if (!concept || concept.retiredAt) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        /*
         * THE CONCEPT HAS TO ACTUALLY MAP THE FIELD. A time field declared
         * against a name no system maps can never be filtered on, and the
         * failure would appear much later as a period that matched nothing.
         */
        const mapped = concept.objects.some((object) => input.fieldPath in object.fieldMap);
        if (!mapped) {
          throw invalid({
            message: `${concept.name} has no field called ${input.fieldPath}.`,
            code: 'invalid.unknown_field',
          });
        }

        const declared = await conceptTimeRepo.declare(db, {
          organisationId: actor.organisationId,
          conceptId: input.conceptId,
          fieldPath: input.fieldPath.trim(),
          kind: input.kind,
          isDefault: input.isDefault ?? false,
          declaredBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'concept_time_field_declared',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            conceptId: input.conceptId,
            fieldPath: declared.fieldPath,
            kind: declared.kind,
          },
        });

        return declared;
      }),
  );
}

export async function removeTimeField(
  actor: Actor,
  input: { conceptId: string; fieldPath: string },
): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'concept.confirm');

        if (!(await conceptTimeRepo.remove(db, input))) {
          throw notFound({
            message: 'That field is not declared a time.',
            code: 'missing.time_field',
          });
        }
      }),
  );
}
