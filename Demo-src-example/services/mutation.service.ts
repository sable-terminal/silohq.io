import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { bounds, denial, invalid, isAppError, notFound, refusal } from '../utils/error.util';
import { DEFAULT_LIMITS } from '../utils/bounds.util';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { log as writeAudit } from './audit.service';
import { assertCan, assertCleared, authorityOf, can, canAtScope, type Authority } from './authorisation.service';
import { askComplete, catalogueKeys, readableIds } from './connector.service';
import * as conceptRepo from '../repos/concept.repo';
import * as connectorRepo from '../repos/connector.repo';
import * as mutationRepo from '../repos/mutation.repo';
import * as mutationApprovalRepo from '../repos/mutationApproval.repo';
import * as mutationPolicyRepo from '../repos/mutationPolicy.repo';
import * as mutationRevertRepo from '../repos/mutationRevert.repo';
import * as organisationRepo from '../repos/organisation.repo';
import * as resolutionRepo from '../repos/resolution.repo';
import { completionQueries, planConceptQuery } from '../engine/ontology/plan.ontology';
import { resolveEntities, type SourceRows } from '../engine/ontology/resolve.ontology';
import { connectionCapabilities, writesOf } from '../engine/read/capabilities.read';
import { transportFor } from '../engine/transports/index.transport';
import type { Filter, Query } from '../engine/execution/query.execution';
import {
  selectTargets,
  valueProblem,
  writtenConnections,
  type Exclusion,
  type MutationManifest,
} from '../engine/mutation/resolve.mutation';
import {
  bulkTier,
  diffOf,
  digestOf,
  type MutationPreview,
  type RecordChange,
} from '../engine/mutation/preview.mutation';
import {
  consequenceOf,
  foreignKeysOf,
  planBlastRadius,
  unaskable,
  type ForeignKey,
  type Consequence,
} from '../engine/mutation/blast.mutation';
import { at, keyOf, refOf, type Row } from '../engine/detectors/shared.detector';
import { capabilitiesFor } from '../models/organisation.model';
import { hiddenFields, visibleObjects } from './fieldPolicy.service';
import * as fieldAliasRepo from '../repos/fieldAlias.repo';
import { withLearned } from '../engine/ontology/derive.ontology';
import type { Manifest, ManifestObject } from '../schemas/manifest.schema';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

const log = childLogger('mutation');

/**
 * Mutations §2 — intent, resolve, policy gate, plan, read prior state, blast
 * radius, preview diff.
 *
 * ── Nothing here writes to a source ────────────────────────────────────────
 *
 * This is the half of the path that has to exist before any write may: what
 * was asked, the records it resolves to, what each held, what else it reaches,
 * and the diff an approver will be shown. Approval, execution, the receipt and
 * revert are built on the rows this produces, and until they exist a mutation
 * stops at `previewed` and lapses.
 *
 * ── A failure at any stage leaves nothing stored ───────────────────────────
 *
 * The preview is written in ONE transaction at the end, with the audit rows for
 * every stage that produced it. A refusal part-way through stores no values at
 * all; it records only that the proposal was made and why it stopped.
 */

/** §9 — how long a preview stands before the world it was computed against has moved. */
const PREVIEW_HOURS = 24;

/** How many records' changes one page of a preview carries. */
const CHANGES_PAGE = 100;

export type MutationView = Omit<mutationRepo.Mutation, 'preview'> & {
  preview: Omit<MutationPreview, 'changes'>;
  /** §9 — who has agreed so far, and what they are held to. Null until approval is asked for. */
  chain: mutationApprovalRepo.Chain | null;
  /** §13 — changes asked for to revert this one, newest first. */
  revertedBy: Array<{ mutationId: string; status: mutationRepo.MutationStatus; requestedAt: Date }>;
};

/* ── Propose ──────────────────────────────────────────────────────────────── */

export async function propose(
  actor: Actor,
  input: { intent: string; manifest: MutationManifest },
): Promise<MutationView & { changes: RecordChange[] }> {
  const tenant = { organisationId: actor.organisationId, membershipId: actor.membershipId };
  const { manifest } = input;
  const mutationId = generateId();

  /* ── §3 intent and §5 the policy gate, before any source is asked ──────── */

  const gate = await runWithTenant(tenant, () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'mutation.propose');

      /*
       * SUSPENSION STOPS CHANGES, AND IS CHECKED HERE RATHER THAN AT THE DOOR.
       * The request carries no billing state to check there, and a proposal made
       * while suspended is a change queued against a billing state the customer
       * may be disputing. (Reverting what already ran is the exception, §13.)
       */
      const organisation = await assertMayChange(db, actor);

      const stored = await conceptRepo.read(db, manifest.conceptId);
      if (!stored || stored.retiredAt) {
        throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
      }

      /* §3 — "Writing to a concept you lack clearance for is refused before a
         plan exists." */
      await assertCleared(db, authority, { type: 'concept', id: stored.id, conceptIds: [stored.id] });

      /*
       * §3 — "FIELD POLICY APPLIES AT COMPILE TIME. A field the user cannot see
       * cannot be written, because it never enters the manifest." Removed from
       * the concept before anything is planned: setting, filtering on or reading
       * a hidden field is refused as a field the concept does not have, and a
       * delete never reads or stores one as prior state.
       */
      const hidden = await hiddenFields(db, actor, stored.objects.map((object) => object.connectionId));

      /*
       * §2.3 (131) — READ AS A QUESTION READS IT, with what answers have taught
       * about these systems' field names. An answer shows one `city` across a
       * CRM and a ledger; a change to it that reached only the system whose
       * column happens to be called that would leave the other saying
       * something else, in a field the reader was shown as one.
       *
       * ONE NAME PER COLUMN, unlike a question — see `keepOldNames`. And what
       * is written by a learned name is listed in the preview for whoever
       * approves it.
       */
      const learnedRows = await fieldAliasRepo.learnedFor(db, stored.objects.map((object) => object.connectionId));
      const read = withLearned({ objects: stored.objects, learned: learnedRows, keepOldNames: false });
      const concept = { ...stored, objects: visibleObjects(read.objects, hidden) };

      const ids = concept.objects.map((object) => object.connectionId);
      const readable = await readableIds(db, actor, ids);

      /*
       * EVERY SYSTEM THE CONCEPT SPANS MUST BE REACHABLE, not only those being
       * written. Resolution asks all of them whether they hold a counterpart;
       * a change resolved without one of them cannot know the entity it is
       * changing is the entity it thinks.
       */
      const unreachable = ids.filter((id) => !readable.has(id));
      if (unreachable.length > 0) {
        throw refusal({
          message:
            `${concept.name} spans a system you cannot reach, so the records a change would ` +
            'land on cannot be resolved.',
          code: 'refusal.unreachable_source',
          detail: { connectionIds: unreachable },
        });
      }

      const loaded = await connectorRepo.load(db, ids);
      const byId = new Map(loaded.map((connection) => [connection.connectionId, connection]));

      const fieldTypes = new Map(
        loaded.map((connection) => [
          connection.connectionId,
          new Map(
            connection.manifest.objects.flatMap((object) =>
              object.fields.map((field) => [field.name, field.type] as const),
            ),
          ),
        ]),
      );

      /* The planner refuses a field the concept does not have, by name. */
      const planned = planConceptQuery({
        objects: concept.objects,
        request: {
          select: manifest.operation === 'update' ? Object.keys(manifest.set) : [],
          where: manifest.where,
          sort: [],
          limit: DEFAULT_LIMITS.maxRows,
        },
        maxRows: DEFAULT_LIMITS.maxRows,
        fieldTypes,
        calendar: organisation?.calendar ?? { timeZone: 'UTC' },
        /*
         * Rendering §5 — the selection as the target. The planner already
         * narrows a read to named records for the second half of a join;
         * this is the same narrowing, asked for by somebody who selected
         * them on a screen rather than by a walk.
         */
        refs: manifest.targets,
      });

      if (!planned.ok) {
        throw invalid({
          message: planned.refusal.reason,
          code: planned.refusal.code,
          detail: planned.refusal.detail,
        });
      }

      /*
       * A CHANGE IS STRICTER THAN A QUESTION ABOUT THE SAME RECORDS. A question
       * filtered on a field one system does not hold is answered from the
       * systems that do, and says which could not be asked. A change has no
       * such sentence to put beside it: it lands, in every system it writes,
       * on whatever was picked — and a system that cannot apply the condition
       * cannot say which of its records were meant.
       */
      if (planned.unheld.length > 0) {
        const fields = planned.unheld.map((one) => one.fieldPath);
        throw refusal({
          message:
            `Not every system holding ${concept.name} has ${fields.join(' and ')}, so the records ` +
            'this change would land on cannot be picked out in all of them. Pick them by a field ' +
            'every system holds, or select the records themselves.',
          code: 'refusal.unfilterable',
          detail: {
            fields,
            connectionIds: [...new Set(planned.unheld.flatMap((one) => one.connectionIds))].sort(),
          },
        });
      }

      const written = writtenConnections(concept.objects, manifest);

      for (const connectionId of written) {
        const connection = byId.get(connectionId);
        const contributing = concept.objects.find((object) => object.connectionId === connectionId)!;

        if (!connection) {
          throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });
        }

        const object = await assertWritable(db, actor, connection, contributing.objectName, manifest.operation);

        for (const [field, value] of Object.entries(manifest.set)) {
          const column = contributing.fieldMap[field];
          if (!column) continue;

          /*
           * THE IDENTIFIER IS HOW THE WRITE FINDS THE RECORD. Changing it in the
           * same write leaves the receipt, the verification and every revert
           * addressing a record by a name it no longer has.
           */
          if (object.identifier.includes(column)) {
            throw invalid({
              message: `${field} is how ${connection.name} identifies these records, so it cannot be changed here.`,
              code: 'invalid.identifier_write',
            });
          }

          const described = object.fields.find((one) => one.name === column);
          const problem = described
            ? valueProblem(value, described)
            : `${connection.name} does not describe the field ${field} is mapped to.`;

          if (problem) {
            throw invalid({ message: problem, code: 'invalid.value_type', detail: { field, connectionId } });
          }
        }
      }

      const batchSizes = new Map<string, number | null>(
        loaded
          .filter((one) => connectionCapabilities(one.manifest).filters.includes('in'))
          .map((one) => [one.connectionId, connectionCapabilities(one.manifest).maxFilterValues || null]),
      );

      await writeAudit(db, {
        event: 'mutation_proposed',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: {
          mutationId,
          conceptId: concept.id,
          operation: manifest.operation,
          resolution: manifest.resolution,
          fields: Object.keys(manifest.set).sort(),
          connections: written,
        },
      });

      return {
        concept,
        planned,
        byId,
        written,
        /* Which of the columns this change sets are read by a learned name, with what the name rests on. */
        learned: read.applied.flatMap((one) => {
          if (!written.includes(one.connectionId) || !(one.canonicalField in manifest.set)) return [];
          const row = learnedRows.find(
            (alias) => alias.connectionId === one.connectionId && alias.objectName === one.objectName && alias.sourceField === one.sourceField,
          );
          return [{ connectionId: one.connectionId, field: one.canonicalField, column: one.sourceField, compared: row?.compared ?? null, agreed: row?.agreed ?? null }];
        }),
        batchSizes,
        aliases: (await resolutionRepo.confirmedFor(db, concept.id)).map((alias) => ({
          connectionA: alias.connectionA,
          valueRefA: alias.valueRefA,
          connectionB: alias.connectionB,
          valueRefB: alias.valueRefB,
        })),
      };
    }),
  );

  const { concept, planned, byId, written } = gate;
  const objectIn = (connectionId: string) =>
    byId
      .get(connectionId)!
      .manifest.objects.find(
        (object) => object.name === concept.objects.find((one) => one.connectionId === connectionId)!.objectName,
      )!;

  /* A refusal after the gate is recorded as the stage it stopped at, then raised. */
  const refused = async (error: unknown): Promise<never> => {
    if (isAppError(error)) {
      await runWithTenant(tenant, () =>
        withTransaction((db) =>
          writeAudit(db, {
            event: 'mutation_resolved',
            organisationId: actor.organisationId,
            membershipId: actor.membershipId,
            userId: null,
            detail: { mutationId, outcome: 'refused', failureCode: error.code },
          }),
        ),
      );
    }
    throw error;
  };

  /* ── §7 foreign keys, asked of the source before its rows are read ─────── */

  const keysOf = new Map<string, ReturnType<typeof foreignKeysOf>>();
  const extra = new Map<string, string[]>();

  try {
    for (const connectionId of written) {
      const connection = byId.get(connectionId)!;
      const object = objectIn(connectionId);

      const keys = await foreignKeysFor(actor, connection);
      keysOf.set(connectionId, keys);

      /*
       * READ BESIDE THE CONCEPT'S FIELDS, NEVER STORED: every field the system
       * identifies a record by, which the write needs, and for a delete the
       * fields other records reference it through, which the blast radius needs.
       */
      extra.set(connectionId, [
        ...object.identifier,
        ...(manifest.operation === 'delete'
          ? keys.filter((key) => key.toObject === object.name).map((key) => key.toField)
          : []),
      ]);
    }
  } catch (error) {
    return refused(error);
  }

  const withExtra = (connectionId: string, query: Query): Query => ({
    ...query,
    fields: [...new Set([...query.fields, ...(extra.get(connectionId) ?? [])])],
  });

  /* ── §4 resolve and §6 read prior state: one bounded read ──────────────── */

  const readAt = new Date();
  let preview: MutationPreview;
  let priorStates: ReturnType<typeof diffOf>['priorStates'];
  let targets: ReturnType<typeof diffOf>['targets'];

  try {
    const sources: SourceRows[] = [];
    const matched = new Map<string, Row[]>();
    const filters = new Map<string, Filter[]>();

    for (const source of planned.sources) {
      const object = concept.objects.find((one) => one.connectionId === source.connectionId)!;
      const query = withExtra(source.connectionId, source.query);

      const answered = await askComplete({ actor, connectionIds: [source.connectionId], query });
      const rows = answered.flatMap((one) => one.result?.rows ?? []);

      /*
       * §6 — "a mutation touching more records than the bound allows refuses
       * here rather than partially writing." A full page is not the entity set;
       * it is an arbitrary slice of it.
       */
      if (rows.length >= query.limit) {
        throw bounds({
          message:
            `That change reaches more ${concept.name} records than one change may cover. ` +
            'Narrow it with another filter, or make it in parts.',
          code: 'bounds.rows',
          detail: { connectionId: source.connectionId, limit: query.limit },
        });
      }

      sources.push({ connectionId: source.connectionId, object, rows: [...rows] });
      matched.set(source.connectionId, rows);
      filters.set(source.connectionId, source.query.filters);
    }

    let resolution = resolveEntities({ sources, aliases: gate.aliases });
    let unverified: string[] = [];

    if (concept.objects.length > 1) {
      const completion = completionQueries({
        objects: concept.objects,
        selected: planned.selected,
        entities: resolution.entities,
        batchSizes: gate.batchSizes,
        aliases: gate.aliases,
        maxRows: DEFAULT_LIMITS.maxRows,
      });

      unverified = completion.unverified;

      if (completion.queries.length > DEFAULT_LIMITS.maxCompletionRequests) {
        throw bounds({
          message:
            'Resolving that change needs counterparts checked one batch at a time, and it would take ' +
            'more requests of your systems than one change may make. Narrow it with another filter.',
          code: 'bounds.completion_requests',
          detail: { requests: completion.queries.length, limit: DEFAULT_LIMITS.maxCompletionRequests },
        });
      }

      for (const request of completion.queries) {
        const query = withExtra(request.connectionId, request.query);
        const answered = await askComplete({ actor, connectionIds: [request.connectionId], query });
        const found = answered.flatMap((one) => one.result?.rows ?? []);

        if (found.length >= query.limit) {
          throw bounds({
            message:
              `That change needs more counterpart ${concept.name} records than one change may cover. ` +
              'Narrow it with another filter.',
            code: 'bounds.rows',
            detail: { connectionId: request.connectionId, limit: query.limit },
          });
        }

        const source = sources.find((one) => one.connectionId === request.connectionId);
        if (!source) continue;

        /*
         * ONLY WHAT WAS ASKED FOR. A multi-column match key is asked as a cross
         * product, so a source can return rows belonging to no entity here, and
         * the read path's reason for dropping them applies twice over to a write.
         */
        const seen = new Set(source.rows.map((row) => refOf(at(row, source.object.identifierField))));
        source.rows.push(
          ...found.filter((row) => {
            const ref = refOf(at(row, source.object.identifierField));
            const key = keyOf(row, source.object.matchKeys);
            const asked =
              (key !== null && completion.wantedKeys.has(key)) ||
              Boolean(completion.wantedRefs.get(request.connectionId)?.has(ref));
            return ref !== '' && asked && !seen.has(ref);
          }),
        );
      }

      if (completion.queries.length > 0) {
        resolution = resolveEntities({ sources, aliases: gate.aliases });
      }
    }

    const selected = selectTargets({
      entities: resolution.entities,
      matched,
      objects: concept.objects,
      filters,
      written,
      unverified,
    });

    /* §7 — STRICT IS THE DEFAULT, and the refusal says what partial would leave out. */
    if (selected.excluded.length > 0 && manifest.resolution === 'strict') {
      throw refusal({
        message:
          `${describeExclusions(selected.excluded)} Nothing will be changed. Propose it again allowing ` +
          'the rest to go ahead without them, or narrow it.',
        code: 'refusal.unresolved_entities',
        detail: { excluded: selected.excluded.length },
      });
    }

    const diff = diffOf({
      operation: manifest.operation,
      set: manifest.set,
      entities: selected.entities,
      objects: concept.objects,
      identifiers: new Map(written.map((connectionId) => [connectionId, objectIn(connectionId).identifier])),
    });

    if (diff.targets.length === 0) {
      throw refusal({
        message:
          diff.unchanged > 0
            ? `Every ${concept.name} record that change reaches already holds those values.`
            : selected.excluded.length > 0
              ? `${describeExclusions(selected.excluded)} That leaves nothing to change.`
              : `No ${concept.name} records match that.`,
        code: 'refusal.nothing_to_change',
      });
    }

    /* ── §7 blast radius ──────────────────────────────────────────────────── */

    const targetedRows = new Map<string, Row[]>();
    const targetedRefs = new Set(diff.targets.map((target) => `${target.connectionId}\u0000${target.ref}`));

    for (const entity of selected.entities) {
      for (const member of entity.members) {
        if (!targetedRefs.has(`${member.connectionId}\u0000${member.ref}`)) continue;
        targetedRows.set(member.connectionId, [...(targetedRows.get(member.connectionId) ?? []), member.row]);
      }
    }

    const blastRadius = await blastRadiusFor(actor, {
      operation: manifest.operation,
      connections: written.map((connectionId) => ({
        connectionId,
        manifest: byId.get(connectionId)!.manifest,
        object: objectIn(connectionId),
        keys: keysOf.get(connectionId) ?? [],
        fieldMap: concept.objects.find((one) => one.connectionId === connectionId)!.fieldMap,
      })),
      changes: diff.changes,
      rowsOf: targetedRows,
      set: manifest.set,
    });

    /* ── §8 the preview ───────────────────────────────────────────────────── */

    const changedIn = new Set(diff.targets.map((target) => target.connectionId));

    preview = {
      operation: manifest.operation,
      resolution: manifest.resolution,
      connections: written.map((connectionId) => {
        const connection = byId.get(connectionId)!;
        return {
          connectionId,
          name: connection.name,
          object: objectIn(connectionId).name,
          connectorVersion: connection.manifestVersion,
          records: diff.targets.filter((target) => target.connectionId === connectionId).length,
        };
      }),
      entities: new Set(diff.targets.map((target) => target.entity)).size,
      records: diff.targets.length,
      unchanged: diff.unchanged,
      changes: diff.changes,
      excluded: selected.excluded,
      absent: Object.entries(selected.absent)
        .filter(([, entities]) => entities > 0)
        .map(([connectionId, entities]) => ({ connectionId, entities })),
      blastRadius,
      /* Only where a record in that system actually changes. */
      ...(gate.learned.some((one) => changedIn.has(one.connectionId))
        ? { learned: gate.learned.filter((one) => changedIn.has(one.connectionId)) }
        : {}),
      bulk: bulkTier(diff.targets.length),
      atomic: changedIn.size <= 1,
      revertable: manifest.operation === 'update',
    };

    priorStates = diff.priorStates;
    targets = diff.targets;
  } catch (error) {
    return refused(error);
  }

  const digest = digestOf(preview);
  const expiresAt = new Date(readAt.getTime() + PREVIEW_HOURS * 60 * 60 * 1000);

  await runWithTenant(tenant, () =>
    withTransaction(async (db) => {
      await mutationRepo.insert(db, {
        id: mutationId,
        organisationId: actor.organisationId,
        conceptId: concept.id,
        intent: input.intent,
        manifest,
        proposedBy: actor.membershipId,
        preview,
        previewDigest: digest,
        expiresAt,
      });

      await mutationRepo.insertTargets(db, {
        mutationId,
        organisationId: actor.organisationId,
        operation: manifest.operation,
        targets,
      });

      await mutationRepo.insertPriorStates(db, {
        mutationId,
        organisationId: actor.organisationId,
        readAt,
        states: priorStates,
      });

      const audit = { organisationId: actor.organisationId, membershipId: actor.membershipId, userId: null };

      await writeAudit(db, {
        ...audit,
        event: 'mutation_resolved',
        detail: {
          mutationId,
          outcome: 'resolved',
          entities: preview.entities,
          records: preview.records,
          excluded: preview.excluded.length,
          unchanged: preview.unchanged,
        },
      });

      await writeAudit(db, {
        ...audit,
        event: 'blast_radius_computed',
        detail: {
          mutationId,
          consequences: preview.blastRadius.length,
          uncounted: preview.blastRadius.filter((one) => one.records === null).length,
        },
      });

      await writeAudit(db, {
        ...audit,
        event: 'preview_generated',
        detail: { mutationId, records: preview.records, bulk: preview.bulk, digest },
      });
    }),
  );

  log.info({ mutationId, records: preview.records, bulk: preview.bulk }, 'Mutation previewed');

  const { changes, ...summary } = preview;

  return {
    id: mutationId,
    conceptId: concept.id,
    intent: input.intent,
    manifest,
    operation: manifest.operation,
    resolution: manifest.resolution,
    status: 'previewed',
    proposedBy: actor.membershipId,
    preview: summary,
    previewDigest: digest,
    records: preview.records,
    createdAt: readAt,
    expiresAt,
    executedBy: null,
    canaryConfirmedBy: null,
    canaryConfirmedAt: null,
    chain: null,
    revertedBy: [],
    changes: changes.slice(0, CHANGES_PAGE),
  };
}

/**
 * What strict refused, in words.
 *
 * COUNTS BY REASON, NOT IDENTIFIERS. An error's detail goes to the log and never
 * to the caller, so the message is the only thing the proposer sees — and a
 * message listing forty identifiers is not one anybody reads.
 */
function describeExclusions(excluded: readonly Exclusion[]): string {
  const counts = new Map<string, number>();
  for (const one of excluded) counts.set(one.reason, (counts.get(one.reason) ?? 0) + 1);

  const phrase: Record<Exclusion['reason'], string> = {
    ambiguous: 'have more than one record in the same system',
    unkeyed: 'have no match key, so their records elsewhere cannot be found',
    unverified: 'could not be checked in every system being changed',
    disputed: 'meet the filter in one system and not in another',
    unidentified: 'have no identifier to address them by',
    conflicted: 'were changed by somebody else since, and nobody has decided what to do with them',
    record_missing: 'are no longer there to change',
  };

  const parts = [...counts.entries()].map(([reason, count]) => `${count} ${phrase[reason as Exclusion['reason']]}`);
  return `Some records could not be resolved exactly: ${parts.join('; ')}.`;
}

/* ── The gate and the walk, shared with revert ─────────────────────────────── */

/**
 * §5 — whether this person may write to this object of this connection now.
 *
 * The four checks that exist today, in the order the write route made them, and
 * the two §5 adds. A revert is a mutation (§13), so it passes exactly this.
 */
export async function assertWritable(
  db: PoolClient,
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
  objectName: string,
  operation: MutationManifest['operation'],
): Promise<ManifestObject> {
  /* The four checks that exist today, in the order the write route makes them. */
  const writable = await connectorRepo.isWritableBy(db, {
    connectionId: connection.connectionId,
    membershipId: actor.membershipId,
  });
  if (!writable) {
    throw denial({
      message: `You can read ${connection.name} but not change it.`,
      code: 'denial.no_write_grant',
    });
  }
  if (connection.status === 'halted') {
    throw refusal({
      message: `${connection.name} is halted and cannot be changed until somebody looks at it.`,
      code: 'refusal.connection_halted',
    });
  }

  /* §5 — the two additions. */
  if (!connection.writesEnabled) {
    throw refusal({
      message:
        `Writes are not enabled for ${connection.name}. Verify the connector against a test ` +
        'record first.',
      code: 'refusal.writes_disabled',
    });
  }
  if (!transportFor(connection.manifest.transport.kind).writes) {
    throw refusal({
      message:
        `Silo cannot yet write to a ${connection.manifest.transport.kind} source such as ` +
        `${connection.name}. This is a gap in the product rather than a problem with your system.`,
      code: 'refusal.mutation_transport_unsupported',
    });
  }

  const writes = writesOf(connection.manifest, objectName);
  if (!(operation === 'update' ? writes.updatePartial || writes.updateFull : writes.delete)) {
    throw refusal({
      message: `${connection.name} does not allow records to be ${
        operation === 'update' ? 'updated' : 'deleted'
      } through its connector.`,
      code: 'refusal.mutation_unsupported',
    });
  }

  const object = connection.manifest.objects.find((one) => one.name === objectName);
  if (!object || !object.available) {
    throw refusal({
      message: `${objectName} in ${connection.name} has not been mapped, so it cannot be changed.`,
      code: 'refusal.object_unmapped',
    });
  }

  return object;
}

/** §7 — every foreign key touching one connection, with the rules its catalogue states. */
export async function foreignKeysFor(
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
): Promise<ForeignKey[]> {
  const catalogue =
    connection.manifest.transport.kind === 'sql' ? await catalogueKeys(actor, connection.connectionId) : null;
  return foreignKeysOf(connection.manifest, catalogue);
}

/**
 * §7 — what else a change touches, counted within the completion budget.
 *
 * THE SAME REQUEST BUDGET AS A COMPLETION. Counting dependents is a follow-up,
 * not a crawl; past the budget a consequence is still named, uncounted, rather
 * than dropped.
 */
export async function blastRadiusFor(
  actor: Actor,
  input: {
    operation: MutationManifest['operation'];
    connections: Array<{
      connectionId: string;
      manifest: Manifest;
      object: ManifestObject;
      keys: ForeignKey[];
      fieldMap: Record<string, string>;
    }>;
    changes: RecordChange[];
    rowsOf: ReadonlyMap<string, Row[]>;
    set: MutationManifest['set'];
  },
): Promise<Consequence[]> {
  const blastRadius: Consequence[] = [];
  let requests = 0;

  for (const connection of input.connections) {
    const plannedRadius = planBlastRadius({
      operation: input.operation,
      connectionId: connection.connectionId,
      manifest: connection.manifest,
      object: connection.object,
      keys: connection.keys,
      changes: input.changes,
      rows: input.rowsOf.get(connection.connectionId) ?? [],
      set: input.set,
      fieldMap: connection.fieldMap,
      maxRows: DEFAULT_LIMITS.maxRows,
    });

    blastRadius.push(...plannedRadius.settled);

    for (const question of plannedRadius.questions) {
      if (requests + question.queries.length > DEFAULT_LIMITS.maxCompletionRequests) {
        blastRadius.push(unaskable(question));
        continue;
      }
      requests += question.queries.length;

      const answers: Row[][] = [];
      for (const query of question.queries) {
        const answered = await askComplete({ actor, connectionIds: [connection.connectionId], query });
        answers.push(answered.flatMap((one) => one.result?.rows ?? []));
      }

      const consequence = consequenceOf(question, answers);
      if (consequence) blastRadius.push(consequence);
    }
  }

  return blastRadius;
}

/* ── Checks shared by every stage that moves a change on ─────────────────── */

/**
 * Whether the account may start or advance a change.
 *
 * SUSPENSION STOPS CHANGES AND NOTHING ELSE. Reading a preview, rejecting a
 * change and reverting one all stay available, because a billing dispute must
 * not leave somebody unable to stop or undo a write.
 *
 * §13 — "UNDO OUTLIVES BILLING STATE. A suspended account can still revert.
 * Only cancellation and the retention window end it." So a revert, at every
 * stage from asking to running, is refused only once the account is cancelled.
 */
export async function assertMayChange(db: PoolClient, actor: Actor, options: { revert?: boolean } = {}) {
  const organisation = await organisationRepo.findById(db, actor.organisationId);
  const status = organisation?.billingStatus ?? 'cancelled';

  if (options.revert) {
    if (status === 'cancelled') {
      throw denial({
        message: 'This account is cancelled, so its changes can no longer be reverted.',
        code: 'denial.billing_cancelled',
      });
    }
    return organisation;
  }

  const capabilities = capabilitiesFor(status);
  if (!capabilities.canMutate) {
    throw denial({
      message: capabilities.banner ?? 'Changes are unavailable on this account.',
      code: 'denial.billing_canMutate',
    });
  }
  return organisation;
}

/**
 * A permission held "on it" (§9): over the owning scope of every connection a
 * change writes, where a connection has one.
 *
 * An admin of Engineering does not approve or run a write to Finance's ledger
 * by holding the permission somewhere. Reaching every connection and clearance
 * for the concept were already required to see the change at all.
 */
export async function assertOverConnections(
  db: PoolClient,
  authority: Authority,
  mutation: mutationRepo.Mutation,
  permission: 'mutation.approve' | 'mutation.execute',
): Promise<void> {
  assertCan(authority, permission);

  const governance = await mutationPolicyRepo.governanceOf(
    db,
    mutation.preview.connections.map((connection) => connection.connectionId),
  );

  const outside = governance.find(
    (one) => one.owningScopePath !== null && !canAtScope(authority, permission, one.owningScopePath),
  );
  if (outside) {
    throw denial({
      message: `That is for the people who administer ${outside.name}.`,
      code: 'denial.outside_subtree',
    });
  }
}

/* ── Reading a preview ────────────────────────────────────────────────────── */

/**
 * Whether this person may see a mutation.
 *
 * A PREVIEW CARRIES VALUES FROM EVERY SYSTEM IT TOUCHES, so seeing one is
 * reading those systems. The proposer, or somebody who could approve or run it — and
 * in either case only while they can still reach every connection it names and
 * hold clearance for its concept. Somebody who loses a grant after proposing
 * loses the preview with it.
 */
async function visible(
  db: PoolClient,
  actor: Actor,
  authority: Authority,
  mutation: mutationRepo.Mutation,
): Promise<boolean> {
  if (
    mutation.proposedBy !== actor.membershipId &&
    !can(authority, 'mutation.approve') &&
    !can(authority, 'mutation.execute')
  ) {
    return false;
  }

  try {
    await assertCleared(db, authority, {
      type: 'concept',
      id: mutation.conceptId,
      conceptIds: [mutation.conceptId],
    });
  } catch (error) {
    if (isAppError(error) && error.code === 'denial.clearance') return false;
    throw error;
  }

  const ids = mutation.preview.connections.map((connection) => connection.connectionId);
  const readable = await readableIds(db, actor, ids);
  return ids.every((id) => readable.has(id));
}

/*
 * NOT FOUND, NOT DENIED, for a mutation somebody may not see. A denial confirms
 * that a change to something they cannot reach is being proposed.
 *
 * LOCKED WHEN ASKED, for the callers about to move it: two approvals, or an
 * approval and a withdrawal, arriving together are decided one after the other.
 */
export async function visibleMutation(
  db: PoolClient,
  actor: Actor,
  id: string,
  options: { lock?: boolean } = {},
): Promise<{ mutation: mutationRepo.Mutation; authority: Authority }> {
  const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
  const mutation = options.lock ? await mutationRepo.lock(db, id) : await mutationRepo.find(db, id);

  if (!mutation || !(await visible(db, actor, authority, mutation))) {
    throw notFound({ message: 'That change does not exist.', code: 'missing.mutation' });
  }
  return { mutation, authority };
}

/** A mutation as every surface shows it: the stored preview, its chain, and any change reverting it. */
export async function viewOf(db: PoolClient, mutation: mutationRepo.Mutation): Promise<MutationView> {
  return {
    ...mutation,
    chain: await mutationApprovalRepo.chainOf(db, mutation.id),
    revertedBy: await mutationRevertRepo.revertsOf(db, mutation.id),
  };
}

export async function read(actor: Actor, id: string): Promise<MutationView> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const { mutation } = await visibleMutation(db, actor, id);
        return viewOf(db, mutation);
      }),
  );
}

/** §8 — a page of the diff, exactly as it was computed. */
export async function changes(
  actor: Actor,
  id: string,
  page: { offset: number; limit: number },
): Promise<RecordChange[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        await visibleMutation(db, actor, id);
        return mutationRepo.changes(db, { id, offset: page.offset, limit: page.limit });
      }),
  );
}

/**
 * Mutations this person may see, newest first.
 *
 * THEIR OWN, OR EVERY ONE THEY COULD APPROVE — each checked the way `read`
 * checks it, so the list never names a change its reader could not open. With
 * `awaiting_approval`, this is the approvals queue.
 */
export async function list(
  actor: Actor,
  input: { limit: number; status?: mutationRepo.MutationStatus },
): Promise<MutationView[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        const candidates = await mutationRepo.list(db, {
          proposedBy:
            can(authority, 'mutation.approve') || can(authority, 'mutation.execute') ? undefined : actor.membershipId,
          status: input.status,
          limit: input.limit,
        });

        const shown: MutationView[] = [];
        for (const mutation of candidates) {
          if (await visible(db, actor, authority, mutation)) shown.push(await viewOf(db, mutation));
        }
        return shown;
      }),
  );
}
