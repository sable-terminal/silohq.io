import { withTransaction, type Executor } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { notFound, policy } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { childLogger } from '../config/logger.config';
import { assertCan, authorityOf } from './authorisation.service';
import * as associationRepo from '../repos/association.repo';
import * as conceptRepo from '../repos/concept.repo';
import * as findingRepo from '../repos/finding.repo';
import { linkedFindings } from '../engine/ontology/links.ontology';
import {
  associateWithCoverage,
  type Association,
  type ConceptEdge,
} from '../engine/analysis/associations.analysis';
import type { Actor } from './scope.service';

const log = childLogger('association');

/**
 * §4 — what moves with what, and what the customer has said matters.
 *
 * IT READS FINDINGS AND WRITES ASSOCIATIONS. Nothing else. It does not run a
 * detector, it cannot create a finding, and the arithmetic lives in
 * `engine/associations` where it can be checked without a database — the same
 * split §3 keeps between the detectors and this layer.
 *
 * CAUSATION IS NOT EXPRESSIBLE HERE OR ANYWHERE BELOW. §4.2. There is no column
 * for it, no field in the engine's output, and no sentence this service can
 * produce that contains the word. That is three places agreeing rather than one
 * policy written down once and forgotten.
 */

/**
 * How far back a computation looks.
 *
 * ALL OF IT, AND THAT IS DELIBERATE FOR NOW. A finding is upserted rather than
 * appended — the same fact found twice is one row — so "every finding" is
 * already "the current state of every entity" rather than a growing log. When
 * Siloes land and findings gain history, this becomes a window and the argument
 * changes; until then a cutoff would only hide rows nobody re-detected.
 */

export type ComputedAssociation = Association & { id: string };

/**
 * Directed edges between concepts, read out of the manifests' foreign keys.
 *
 * §4.1 — STRUCTURAL DIRECTION COMES FROM THE SCHEMA, NOT THE DATA. If a
 * concept's contributing object declares a relationship into an object that
 * contributes to another concept, then the first could depend on the second,
 * and no amount of co-occurrence can reverse that. It is the weakest possible
 * directional claim and the only one that survives the question "what did you
 * control for?".
 *
 * WITHIN ONE CONNECTION ONLY. A foreign key is a statement inside one system; a
 * relationship between two systems is what the ontology is for, and reading one
 * across a connection boundary would be inventing a join nobody declared.
 */
async function conceptEdges(db: Executor): Promise<ConceptEdge[]> {
  /*
   * READ, NOT RE-DERIVED. This used to load every manifest on every compute and
   * work the relationships out again — a second implementation of a rule
   * `engine/ontology/relate` now owns, on the hot path, waiting to disagree
   * with the first.
   *
   * They are recorded when a concept is confirmed, corrected or retired, which
   * is the only time they can change. `origin` is not filtered on: a
   * relationship somebody stated by hand, for a source whose schema declares no
   * constraint, constrains direction exactly as much as one Postgres enforces.
   */
  const relationships = await conceptRepo.relationships(db);

  return relationships.map((link) => ({ from: link.fromConceptId, to: link.toConceptId }));
}

/**
 * Compute the associations across everything detected so far.
 *
 * THE POPULATION COMES FROM THE FINDINGS, NOT FROM A COUNT OF THEM. §4.1
 * requires every finding to state what it was compared against and how many,
 * and this is the second job that requirement does: lift measured against the
 * entities that produced a finding is lift measured against a population where
 * everything is true, and would never clear its own bar.
 *
 * REPLACED, NOT APPENDED. An association is a statement about the current set
 * of findings. Keeping yesterday's beside today's would put two different
 * answers to the same question on one screen, and nothing in the row says which
 * is current — `computed_at` would, and nobody reads it before believing the
 * number next to it.
 */
export async function compute(
  actor: Actor,
  options: { conceptIds?: string[] } = {},
): Promise<{
  associations: ComputedAssociation[];
  findingsRead: number;
  population: number;
  /**
   * §4.1 — PAIRS THIS LAYER COULD NOT EVALUATE, stated rather than omitted.
   * Relating two concepts needs the foreign key walked between their entities,
   * which reading stored findings cannot do. Reporting three associations
   * without saying forty pairs were skipped claims "these are the
   * relationships" while meaning "these are the ones we can see".
   */
  crossConceptSkipped: number;
}> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        /*
         * READING FINDINGS IS WHAT THIS DOES, so it needs what reading findings
         * needs. It computes no new fact about any source and reaches no system.
         */
        assertCan(authority, 'query.run');

        const findings = await findingRepo.facts(db, {
          conceptIds: options.conceptIds?.length ? options.conceptIds : null,
        });

        if (findings.length === 0) {
          return { associations: [], findingsRead: 0, population: 0, crossConceptSkipped: 0 };
        }

        const population = Math.max(...findings.map((row) => row.populationN));

        /*
         * ── §4 — which instances are related to which ─────────────────────
         *
         * Two conditions on different concepts co-occur when the SAME PAIR of
         * related instances shows both. The links were captured at detection
         * time, raw; resolving them to entities happens HERE, at read time,
         * which is what lets a resolution corrected later reinterpret findings
         * already written.
         *
         * An object per connection comes from the concept: `concept_objects`
         * holds one per connection, so a finding's entity is an instance of
         * whichever object its lineage names.
         */
        const contributions = await conceptRepo.liveContributions(db);
        const objectFor = new Map(
          contributions.map((row) => [`${row.conceptId} ${row.connectionId}`, row.objectName]),
        );

        const links = await findingRepo.linksFor(db, findings.map((finding) => finding.id));

        const targets = findings
          .filter((finding) => finding.connectionId)
          .map((finding) => ({
            findingId: finding.id,
            connectionId: finding.connectionId!,
            objectName: objectFor.get(`${finding.conceptId} ${finding.connectionId}`) ?? '',
            entityRef: finding.entityRef,
          }))
          .filter((target) => target.objectName !== '');

        const entityOfFinding = new Map(
          findings.map((finding) => [
            finding.id,
            `${finding.conceptId}\u0000${finding.entityRef}`,
          ]),
        );

        const related = linkedFindings({ links, targets })
          .map((edge) => ({
            from: entityOfFinding.get(edge.fromFindingId),
            to: entityOfFinding.get(edge.toFindingId),
          }))
          .filter((edge): edge is { from: string; to: string } =>
            Boolean(edge.from && edge.to),
          );

        const { associations: computed, crossConceptSkipped } = associateWithCoverage(
          findings.map((row) => ({
            id: row.id,
            detector: row.detector,
            conceptId: row.conceptId,
            measure: row.measure,
            entityRef: row.entityRef,
            /* §4.1 — the denominator, per concept. `populationN` means rows for
               absence and distinct nodes for concentration, so one maximum
               across all of them divided invoices by suppliers. */
            populationN: row.populationN,
            occurredAt: row.occurredAt?.toISOString() ?? null,
          })),
          { population, edges: await conceptEdges(db), related },
        );

        const concepts = [...new Set(findings.map((row) => row.conceptId))];

        /*
         * REPLACED, AND ONLY WHAT THIS RUN COULD HAVE PRODUCED. The concepts
         * whose findings were read are the only pairs recomputable here, which
         * is why `deleteWithin` requires both sides — the argument for that
         * predicate is in the repo, beside the statement it constrains.
         */
        await associationRepo.deleteWithin(db, concepts);

        const written: ComputedAssociation[] = [];

        for (const association of computed) {
          const id = await associationRepo.insert(db, {
            organisationId: actor.organisationId,
            ...association,
          });

          written.push({ ...association, id });
        }

        await writeAudit(db, {
          event: 'associations_computed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            findingsRead: findings.length,
            population,
            raised: written.length,
            crossConceptSkipped,
            concepts,
          },
        });

        log.info(
          { findingsRead: findings.length, population, raised: written.length },
          'Associations computed',
        );

        return {
          associations: written,
          findingsRead: findings.length,
          population,
          crossConceptSkipped,
        };
      }),
  );
}

export async function list(actor: Actor): Promise<ComputedAssociation[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () => withTransaction((db) => associationRepo.list(db)),
  );
}

/* ── §4.3 Outcome designation ────────────────────────────────────────────── */

export type Designation = {
  id: string;
  conceptId: string;
  fieldPath: string;
  direction: 'higher_is_worse' | 'lower_is_worse';
  label: string | null;
  designatedAt: string;
};

/**
 * §4.3 — the customer says which fields represent an outcome that matters.
 *
 * A ONE-TIME INPUT, NOT A MODELLING ENGAGEMENT. Three things: which field,
 * which direction is bad, and what they call it. No target variable, no feature
 * selection, no training. Once designated, every finding ranks against it
 * automatically and the ranking is data-derived rather than assumed — which is
 * the difference between this and the consultancy project §1 refuses to be.
 *
 * WHICH FIELD, NEVER WHAT LATE MEANS. A threshold typed in here would be a
 * domain assumption, and §1 says none ship. Days late is higher-is-worse; how
 * many days counts as late is what the detectors compute against the
 * population, not something anybody declares.
 */
export async function designate(
  actor: Actor,
  input: {
    conceptId: string;
    fieldPath: string;
    direction: 'higher_is_worse' | 'lower_is_worse';
    label?: string;
  },
): Promise<Designation> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'outcome.designate');

        /* A retired concept is the same answer as no concept here: designating
           an outcome on one would rank findings against something withdrawn. */
        const concept = await conceptRepo.read(db, input.conceptId);
        if (!concept || concept.retiredAt) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        const fieldPath = input.fieldPath.trim();

        /*
         * ONE ROW PER FIELD, EVER. `outcome_designations_unique` covers retired
         * rows too, so there is no "retire the old one and insert a new one" —
         * the row is the field's designation and changing direction changes it.
         * Re-declaring what already stands is refused rather than treated as a
         * no-op, because it is nearly always somebody who did not realise it was
         * already there.
         */
        const existing = await associationRepo.readDesignation(db, {
          conceptId: input.conceptId,
          fieldPath,
        });

        if (existing && !existing.retiredAt && existing.direction === input.direction) {
          throw policy({
            message: `${fieldPath} is already designated an outcome.`,
            code: 'policy.outcome_designated',
          });
        }

        await associationRepo.upsertDesignation(db, {
          organisationId: actor.organisationId,
          conceptId: input.conceptId,
          fieldPath,
          direction: input.direction,
          label: input.label?.trim() ?? null,
          designatedBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'outcome_designated',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            conceptId: input.conceptId,
            fieldPath,
            direction: input.direction,
          },
        });

        log.info({ conceptId: input.conceptId, fieldPath }, 'Outcome designated');

        /* Read back rather than assembled from the input, because the upsert
           may have landed on a row that was already there. */
        const written = (await associationRepo.liveDesignation(db, {
          conceptId: input.conceptId,
          fieldPath,
        }))!;

        return {
          id: written.id,
          conceptId: written.conceptId,
          fieldPath: written.fieldPath,
          direction: written.direction,
          label: written.label,
          designatedAt: written.designatedAt.toISOString(),
        };
      }),
  );
}

export async function designations(actor: Actor): Promise<Designation[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const live = await associationRepo.liveDesignations(db);

        return live.map((designation) => ({
          id: designation.id,
          conceptId: designation.conceptId,
          fieldPath: designation.fieldPath,
          direction: designation.direction,
          label: designation.label,
          designatedAt: designation.designatedAt.toISOString(),
        }));
      }),
  );
}

/**
 * Taking a designation back.
 *
 * RETIRED, NEVER DELETED. Every ranking anybody saw while it stood was ordered
 * by it, and a row that vanishes makes those rankings unexplainable — "why was
 * this at the top in March" has an answer only while the reason is still there.
 */
export async function retire(actor: Actor, designationId: string): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'outcome.designate');

        const retired = await associationRepo.retireDesignation(db, designationId);

        if (!retired) {
          throw notFound({
            message: 'That designation does not exist, or was already retired.',
            code: 'missing.outcome_designation',
          });
        }

        await writeAudit(db, {
          event: 'outcome_retired',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { designationId },
        });
      }),
  );
}
