import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { refusal } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import {
  assertMayChange,
  assertWritable,
  blastRadiusFor,
  foreignKeysFor,
  visibleMutation,
  type MutationView,
} from './mutation.service';
import { readRecords } from './mutationExecution.service';
import * as connectorRepo from '../repos/connector.repo';
import * as mutationRepo from '../repos/mutation.repo';
import * as executionRepo from '../repos/mutationExecution.repo';
import * as revertRepo from '../repos/mutationRevert.repo';
import { threeWay, type Conflict, type ConflictChoice, type ThreeWay } from '../engine/mutation/revert.mutation';
import { bulkTier, digestOf, type MutationPreview, type RecordChange } from '../engine/mutation/preview.mutation';
import type { Receipt } from '../engine/mutation/receipt.mutation';
import type { MutationManifest } from '../engine/mutation/resolve.mutation';
import type { Row } from '../engine/detectors/shared.detector';
import type { Actor } from './scope.service';

/**
 * Mutations §13 — reverting a change.
 *
 * ── Asked, then decided, then governed ─────────────────────────────────────
 *
 * `inspect` reads every record the change wrote and reports, without storing
 * anything, which fields revert cleanly, which are already back, which records
 * are gone, and which fields somebody has changed since — with who, where Silo
 * made that change. `request` does the same reading again, applies the person's
 * decision on each conflict, and proposes the result as a change of its own:
 * previewed, submitted, approved and run like any other, with its own receipt.
 *
 * ── Only what the change left ──────────────────────────────────────────────
 *
 * A field the change failed to write is not reverted, because nothing of the
 * change is there to undo. A partially executed change offers a revert of what
 * succeeded, which is exactly §10's "offers a revert of what succeeded".
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

export type ConflictView = Conflict & {
  /** Changes made through Silo to this field since, and who ran them. Empty when not knowable. */
  changedBy: Array<{ mutationId: string; executedBy: string | null }>;
};

export type RevertInspection = {
  revertsMutationId: string;
  receiptId: string;
  /** Fields that will be put back. */
  fields: number;
  records: number;
  /** Fields already holding what they held before the change. */
  unchanged: number;
  missing: Array<{ connectionId: string; ref: string }>;
  conflicts: ConflictView[];
  kept: number;
};

type Examined = {
  original: mutationRepo.Mutation;
  receipt: { id: string; document: Receipt; createdAt: Date };
  connections: connectorRepo.LoadedConnection[];
  result: ThreeWay;
  conflicts: ConflictView[];
  readAt: Date;
};

/** The reading both `inspect` and `request` do: gated, fresh, three-way. */
async function examine(actor: Actor, mutationId: string, choices: readonly ConflictChoice[]): Promise<Examined> {
  const gated = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'mutation.revert');
      await assertMayChange(db, actor, { revert: true });

      const { mutation: original } = await visibleMutation(db, actor, mutationId);

      if (original.operation === 'delete') {
        throw refusal({
          message: 'A deleted record cannot be recreated: the whole record was never read.',
          code: 'refusal.delete_not_revertable',
        });
      }

      /* No receipt: it never ran, or its retention has ended, and either way there is nothing to undo. */
      const receipt = await executionRepo.receiptFor(db, original.id);
      if (!receipt) {
        throw refusal({
          message: 'That change has no receipt to revert from. It never ran, or it is past its retention.',
          code: 'refusal.nothing_to_revert',
        });
      }

      const open = (await revertRepo.revertsOf(db, original.id)).find((one) =>
        ['previewed', 'awaiting_approval', 'approved', 'executing', 'canary_paused'].includes(one.status),
      );
      if (open) {
        throw refusal({
          message: 'A revert of that change is already under way. Finish or withdraw it first.',
          code: 'refusal.revert_in_progress',
          detail: { mutationId: open.mutationId },
        });
      }

      const touched = [...new Set(receipt.document.verifications.map((one) => one.connectionId))];
      const connections = await connectorRepo.load(db, touched);

      /* §13 — "A revert is a mutation. It goes through the same policy gate." */
      for (const connection of connections) {
        const lineage = receipt.document.lineage.find((one) => one.connectionId === connection.connectionId);
        await assertWritable(db, actor, connection, lineage?.object ?? '', 'update');
      }

      return { original, receipt, connections };
    }),
  );

  const { receipt } = gated;
  const readAt = new Date();
  const current = new Map<string, Map<string, Row>>();

  for (const connection of gated.connections) {
    const lineage = receipt.document.lineage.find((one) => one.connectionId === connection.connectionId)!;
    const records = new Set(
      receipt.document.verifications
        .filter((one) => one.connectionId === connection.connectionId && one.outcome !== 'failed')
        .map((one) => one.ref),
    );

    current.set(
      connection.connectionId,
      await readRecords({
        actor,
        connectionId: connection.connectionId,
        manifest: connection.manifest,
        object: lineage.object,
        targets: receipt.document.entitySet.filter(
          (target) => target.connectionId === connection.connectionId && records.has(target.ref),
        ),
        columns: lineage.fields.map((field) => field.column),
      }),
    );
  }

  const result = threeWay({ receipt: receipt.document, current, choices });

  const later = await runWithTenant(tenantOf(actor), () =>
    withTransaction((db) =>
      revertRepo.laterWrites(db, {
        after: gated.original.createdAt,
        excluding: gated.original.id,
        records: result.conflicts.map((one) => ({ connectionId: one.connectionId, ref: one.ref })),
      }),
    ),
  );

  const conflicts = result.conflicts.map((conflict) => ({
    ...conflict,
    changedBy: later
      .filter(
        (one) =>
          one.connectionId === conflict.connectionId && one.ref === conflict.ref && one.fields.includes(conflict.field),
      )
      .map((one) => ({ mutationId: one.mutationId, executedBy: one.executedBy })),
  }));

  return { ...gated, result, conflicts, readAt };
}

function inspection(examined: Examined): RevertInspection {
  const { result } = examined;
  return {
    revertsMutationId: examined.original.id,
    receiptId: examined.receipt.id,
    fields: result.changes.reduce((sum, change) => sum + change.fields.length, 0),
    records: result.changes.length,
    unchanged: result.unchanged,
    missing: result.excluded
      .filter((one) => one.reason === 'record_missing')
      .map((one) => ({ connectionId: one.connectionId, ref: one.ref! })),
    conflicts: examined.conflicts,
    kept: result.kept,
  };
}

/**
 * §13 — what a revert would do now. Reads; stores nothing; writes no audit row.
 */
export async function inspect(actor: Actor, mutationId: string): Promise<RevertInspection> {
  return inspection(await examine(actor, mutationId, []));
}

/**
 * §13 — ask for a revert: a new change, previewed, linked to the receipt it undoes.
 *
 * `choices` DECIDE CONFLICTS, FIELD BY FIELD. A conflict with no choice is left
 * alone and named in the preview; the rest reverts regardless.
 */
export async function request(
  actor: Actor,
  mutationId: string,
  input: { intent: string; choices: readonly ConflictChoice[] },
): Promise<MutationView & { changes: RecordChange[]; revert: RevertInspection }> {
  const examined = await examine(actor, mutationId, input.choices);
  const { original, receipt, result } = examined;

  if (result.changes.length === 0) {
    const unresolved = result.excluded.filter((one) => one.reason === 'conflicted').length;
    throw refusal({
      message:
        unresolved > 0
          ? `Every field left to revert was changed by somebody since. Decide what to do with the ${unresolved} ` +
            'record' + (unresolved === 1 ? '' : 's') + ' in conflict, then ask again.'
          : 'There is nothing left to revert: every field already holds what it held before, or its record is gone.',
      code: 'refusal.nothing_to_revert',
    });
  }

  const revertId = generateId();
  const written = new Set(result.changes.map((change) => change.connectionId));

  const connections = receipt.document.diff.connections
    .filter((connection) => written.has(connection.connectionId))
    .map((connection) => {
      const loaded = examined.connections.find((one) => one.connectionId === connection.connectionId)!;
      return {
        ...connection,
        connectorVersion: loaded.manifestVersion,
        records: result.changes.filter((change) => change.connectionId === connection.connectionId).length,
      };
    });

  /* §7 — the walk a revert makes is the walk any change makes. */
  const blastRadius = await blastRadiusFor(actor, {
    operation: 'update',
    connections: await Promise.all(
      connections.map(async (connection) => {
        const loaded = examined.connections.find((one) => one.connectionId === connection.connectionId)!;
        const lineage = receipt.document.lineage.find((one) => one.connectionId === connection.connectionId)!;
        return {
          connectionId: connection.connectionId,
          manifest: loaded.manifest,
          object: loaded.manifest.objects.find((one) => one.name === lineage.object)!,
          keys: await foreignKeysFor(actor, loaded),
          fieldMap: Object.fromEntries(lineage.fields.map((field) => [field.field, field.column])),
        };
      }),
    ),
    changes: result.changes,
    rowsOf: new Map(),
    set: {},
  });

  const preview: MutationPreview = {
    operation: 'update',
    resolution: 'partial',
    connections,
    entities: new Set(result.changes.map((change) => change.entity)).size,
    records: result.changes.length,
    unchanged: result.unchanged,
    changes: result.changes,
    excluded: result.excluded,
    absent: [],
    blastRadius,
    bulk: bulkTier(result.changes.length),
    atomic: connections.length <= 1,
    revertable: true,
  };

  const manifest: MutationManifest = {
    conceptId: original.conceptId,
    operation: 'update',
    where: [],
    set: {},
    resolution: 'partial',
    reverts: { mutationId: original.id, receiptId: receipt.id },
  };

  const digest = digestOf(preview);
  const expiresAt = new Date(examined.readAt.getTime() + 24 * 60 * 60 * 1000);
  const described = inspection(examined);

  await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mutationRepo.insert(db, {
        id: revertId,
        organisationId: actor.organisationId,
        conceptId: original.conceptId,
        intent: input.intent,
        manifest,
        proposedBy: actor.membershipId,
        preview,
        previewDigest: digest,
        expiresAt,
      });
      await mutationRepo.insertTargets(db, {
        mutationId: revertId,
        organisationId: actor.organisationId,
        operation: 'update',
        targets: result.targets,
      });
      await mutationRepo.insertPriorStates(db, {
        mutationId: revertId,
        organisationId: actor.organisationId,
        readAt: examined.readAt,
        states: result.priorStates,
      });
      await revertRepo.insert(db, {
        mutationId: revertId,
        organisationId: actor.organisationId,
        revertedMutationId: original.id,
        receiptId: receipt.id,
        conflicts: result.conflicts,
        choices: input.choices,
        requestedBy: actor.membershipId,
      });

      const audit = { organisationId: actor.organisationId, membershipId: actor.membershipId, userId: null };

      await writeAudit(db, {
        ...audit,
        event: 'revert_requested',
        detail: {
          mutationId: revertId,
          revertsMutationId: original.id,
          receiptId: receipt.id,
          records: preview.records,
          conflicts: result.conflicts.length,
          missing: described.missing.length,
          kept: result.kept,
        },
      });

      if (result.conflicts.length > 0) {
        await writeAudit(db, {
          ...audit,
          event: 'revert_conflicted',
          detail: {
            mutationId: revertId,
            revertsMutationId: original.id,
            refs: [...new Set(result.conflicts.map((one) => one.ref))],
            fields: [...new Set(result.conflicts.map((one) => one.field))].sort(),
          },
        });
      }

      await writeAudit(db, {
        ...audit,
        event: 'preview_generated',
        detail: { mutationId: revertId, records: preview.records, bulk: preview.bulk, digest },
      });
    }),
  );

  const { changes, ...summary } = preview;

  return {
    id: revertId,
    conceptId: original.conceptId,
    intent: input.intent,
    manifest,
    operation: 'update',
    resolution: 'partial',
    status: 'previewed',
    proposedBy: actor.membershipId,
    preview: summary,
    previewDigest: digest,
    records: preview.records,
    createdAt: examined.readAt,
    expiresAt,
    executedBy: null,
    canaryConfirmedBy: null,
    canaryConfirmedAt: null,
    chain: null,
    revertedBy: [],
    changes: changes.slice(0, 100),
    revert: described,
  };
}
