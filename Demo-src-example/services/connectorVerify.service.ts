import { withTransaction } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';
import { invalid, notFound, policy, refusal, toResponse } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import * as connectorRepo from '../repos/connector.repo';
import * as lifecycle from '../repos/connectorVerify.repo';
import * as probeRuns from '../repos/probe.repo';
import { nextTier, type RunStatus } from '../models/connectorLifecycle.model';
import * as connectorService from './connector.service';
import { runWrite } from '../engine/write/run.write';
import { readBack } from '../engine/write/verify.write';
import { ensureSystemConcepts } from './concept.service';
import { writesOf } from '../engine/read/capabilities.read';
import type { ReadContext } from '../engine/read/context.read';
import { withConnection } from './connectorRuntime.service';
import { childLogger } from '../config/logger.config';
import type { Actor } from './scope.service';

const log = childLogger('connector-verify');

/**
 * §7 — verification. Identical on all three routes, and no route skips it.
 *
 *   1. Sandbox probe, read-only                    `connectorProbe.service`
 *   2. Human confirmation of objects and mappings  `confirmMappings`
 *   3. Private trust tier by default               the table's own default
 *   4. Writes disabled until write-verify-undo     `verifyWrites`
 *   5. Promotion, one rung at a time               `promote`
 *
 * "A prebuilt connector was verified when built. A generated one is verified
 * now." Nothing here asks which route a manifest came from.
 */

/* ── Step 2: somebody looked at it ──────────────────────────────────────── */

/**
 * A person confirms the objects and mappings.
 *
 * THE POINT IS THAT A HUMAN LOOKED, so this records WHO and WHAT THEY SAW. A
 * confirmation that does not say which manifest version was on the screen is
 * worthless the moment the connector is edited — the reviewer approved
 * something, and afterwards nobody can say what.
 */
export async function confirmMappings(
  actor: Actor,
  connectionId: string,
): Promise<{ status: string; manifestId: string }> {
  const connection = await connectorService.readableConnection(actor, connectionId);

  if (connection.status === 'halted') {
    throw refusal({
      message: 'This connection is halted and has to be looked at before it can be confirmed.',
      code: 'refusal.connection_halted',
    });
  }

  return withTransaction(async (db) => {
    /*
     * `active`, NOT `verified`, AND THE DIFFERENCE MATTERS. `status` says
     * whether a connection is in service; the TRUST TIER says how thoroughly it
     * has been checked, and that ladder already has a rung called `verified`.
     * Setting the status to the same word left the two vocabularies overlapping
     * and a confirmed connection out of `loadActive` — queryable when named and
     * invisible to a fan-out, which is the kind of inconsistency somebody spends
     * an afternoon on.
     */
    await lifecycle.activate(db, connectionId);
    /* What a person just confirmed can be asked about now, not after an ontology is built (128). */
    await ensureSystemConcepts(db, actor, [connectionId]);

    await writeAudit(db, {
      event: 'mapping_confirmed',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: {
        connectionId,
        manifestId: connection.manifestId,
        objectCount: connection.manifest.objects.filter((o) => o.available).length,
      },
    });

    return { status: 'active', manifestId: connection.manifestId };
  });

  /*
   * WHAT IT HOLDS IN COMMON WITH THE OTHER SYSTEMS IS NOT LOOKED FOR HERE (133).
   * That reads a page of every system and takes as long as the slowest; a
   * confirmed connection is left marked as not yet looked across, and
   * `joinIfPending` does it from wherever something is already being waited for.
   */
}

/* ── Step 4: the write, the verify and the undo ─────────────────────────── */

export interface WriteVerification {
  passed: boolean;
  object: string;
  /** Set when the undo failed and something is still in the customer's system. */
  strandedRecord: Record<string, unknown> | null;
  stage: 'write' | 'verify' | 'undo' | 'complete';
  error: { kind: string; code: string; message: string } | null;
}

/**
 * Prove the connector can write, by writing something and taking it back.
 *
 * §7.4 — "Writes disabled until a sandboxed write, verify and undo cycle passes
 * against a test record." All three steps, in that order, and the flag only
 * moves if every one of them does.
 *
 * THE VERIFY STEP IS NOT CEREMONY. A source that accepts a write and stores
 * something different — coercing a type, truncating a string, ignoring a field
 * it does not recognise — has a connector that will corrupt records quietly for
 * as long as it is enabled. Reading the record back is the only way to find that
 * out before it matters.
 *
 * A FAILED UNDO DOES NOT ENABLE WRITES, even though the write itself worked.
 * Something is now sitting in the customer's system that Silo put there and
 * cannot remove, and the identifier of it is the most important thing this
 * function can return.
 */
export async function verifyWrites(
  actor: Actor,
  input: { connectionId: string; object: string; testRecord: Record<string, unknown> },
): Promise<WriteVerification> {
  const connection = await connectorService.readableConnection(actor, input.connectionId);

  const object = connection.manifest.objects.find((o) => o.name === input.object);
  if (!object) {
    throw notFound({
      message: `This connector does not describe an object called ${input.object}.`,
      code: 'missing.object',
    });
  }

  const writes = writesOf(connection.manifest, input.object);
  if (!writes.create || !writes.undoable) {
    /*
     * BOTH HALVES OR NEITHER. A connector that can create and cannot remove —
     * by deleting, or by the compensating action it declares, a void or a
     * reversal — cannot be verified without leaving the test record behind, and
     * enabling writes on that basis means every later repair is one-way too.
     */
    throw refusal({
      message:
        'Verifying writes needs a connector that can both create a record and remove or reverse it, and this ' +
        'one cannot. Writes stay disabled.',
      code: 'refusal.undo_impossible',
    });
  }

  const runId = generateId();
  await recordRun(runId, input.connectionId, 'running', {}, [], false);

  const progress: { stage: WriteVerification['stage'] } = { stage: 'write' };
  let written: Record<string, unknown> | null = null;
  let identifier: Record<string, unknown> = {};

  try {
    const stored = await withTransaction((db) => connectorRepo.credentialsFor(db, [connection.connectionId]));
    const credential = stored.get(connection.connectionId);
    if (!credential) {
      throw invalid({ message: 'This connection has no credential, so there is nothing to verify with.', code: 'invalid.no_credential' });
    }
    const testRecord = input.testRecord;

    await withConnection({
      actor,
      connection,
      credential,
      reason: 'connection-verify',
      use: async (open) => {
        const ctx = await open(input.object);
        const created = await runWrite(ctx, { object: input.object, kind: 'create', values: testRecord });
        written = created.record;
        identifier = created.identifier;

        progress.stage = 'verify';
        const stored = await readBack(ctx, object, identifier, testRecord);

        /*
         * EVERY FIELD WRITTEN MUST BE THERE, AND BE WHAT WAS SENT (finding F22).
         * Defaults and triggers legitimately add fields, so only what was written
         * is compared — a value that changed on the way in, or vanished, is the
         * connector quietly corrupting records.
         */
        const missing = Object.keys(testRecord).filter((field) => !(field in stored));
        if (missing.length > 0) {
          throw refusal({
            message: `The source did not return ${missing.join(', ')} after the test write, so Silo cannot tell whether it was stored.`,
            code: 'refusal.write_not_visible',
            detail: { fields: missing },
          });
        }
        const altered = Object.entries(testRecord).filter(([field, value]) => String(stored[field]) !== String(value));
        if (altered.length > 0) {
          throw refusal({
            message:
              `The source stored something different from what was sent for ` +
              `${altered.map(([f]) => f).join(', ')}. The connector needs re-checking before writes.`,
            code: 'refusal.write_altered',
          });
        }

        progress.stage = 'undo';
        /* A declared compensating action — a void, a reversal — is how this system removes a record. */
        const undo = object.write?.verify.undo;
        await runWrite(ctx, undo ? { object: input.object, kind: undo, identifier } : { object: input.object, kind: 'delete', identifier });

        progress.stage = 'complete';
      },
    });
  } catch (error: unknown) {
    const response = toResponse(error);
    const failure = {
      kind: response.body.error.kind,
      code: response.body.error.code,
      message: response.body.error.message,
    };

    /*
     * A RECORD LEFT BEHIND IS THE THING TO SAY LOUDEST. It is in the customer's
     * system, Silo put it there, and only its identifier makes it findable.
     */
    const stranded = progress.stage === 'undo' ? (written ?? identifier) : null;
    if (stranded) {
      log.error(
        { connectionId: input.connectionId, identifier },
        'Write verification could not undo its test record',
      );
    }

    await recordRun(runId, input.connectionId, 'failed', { stage: progress.stage }, [failure], false);

    return {
      passed: false,
      object: input.object,
      strandedRecord: stranded,
      stage: progress.stage,
      error: failure,
    };
  }

  await withTransaction(async (db) => {
    await lifecycle.enableWrites(db, {
      connectionId: input.connectionId,
      by: actor.membershipId,
    });

    await writeAudit(db, {
      event: 'writes_enabled',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { connectionId: input.connectionId, manifestId: connection.manifestId },
    });
  });

  await recordRun(runId, input.connectionId, 'passed', { stage: 'complete', object: input.object }, [], false);

  return { passed: true, object: input.object, strandedRecord: null, stage: 'complete', error: null };
}

/* ── Step 5: promotion ──────────────────────────────────────────────────── */

/**
 * One rung.
 *
 * THE DATABASE ENFORCES THIS AND SO DOES THIS FUNCTION, which is not redundant:
 * the trigger is what makes it true of every path including a direct UPDATE, and
 * this is what makes the refusal say something a person can act on rather than
 * surfacing a constraint violation.
 *
 * THE LADDER ITSELF IS READ FROM THE MODEL. It used to be a second copy of
 * 014's CHECK written out here, which is one list to keep in step with the
 * database and with everything else that needs the order.
 */
export async function promote(
  actor: Actor,
  connectionId: string,
): Promise<{ from: string; to: string }> {
  const connection = await connectorService.readableConnection(actor, connectionId);

  return withTransaction(async (db) => {
    const current = await lifecycle.trustState(db, connectionId);
    if (!current) {
      throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });
    }

    const next = nextTier(current.trustTier);

    if (!next) {
      throw policy({
        message: 'This connection is already at the highest tier.',
        code: 'policy.already_certified',
      });
    }

    /*
     * NOTHING IS PROMOTED PAST `private` UNTIL SOMEBODY CONFIRMED IT. §7's steps
     * are an order, not a menu — a connector promoted before a human looked at
     * its mappings is one whose tier says "reviewed" and means "created".
     */
    if (current.status === 'draft' || current.status === 'probing') {
      throw policy({
        message: 'Confirm this connection’s objects and mappings before promoting it.',
        code: 'policy.unconfirmed',
      });
    }

    await lifecycle.setTrustTier(db, connectionId, next);

    await writeAudit(db, {
      event: 'trust_tier_promoted',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { connectionId, from: current.trustTier, to: next, manifestId: connection.manifestId },
    });

    return { from: current.trustTier, to: next };
  });
}

/* ── Shared ─────────────────────────────────────────────────────────────── */

/**
 * `read_only` IS FALSE ON EVERY CALL FROM HERE AND STILL AN ARGUMENT. 017 keeps
 * the flag per run rather than per stage, and a `verify` row that was actually
 * read-only is a thing the trail should be able to say.
 */
async function recordRun(
  id: string,
  connectionId: string,
  status: RunStatus,
  findings: Record<string, unknown>,
  errors: unknown[],
  readOnly: boolean,
): Promise<void> {
  await withTransaction((db) =>
    probeRuns.record(db, {
      id,
      connectionId,
      stage: 'verify',
      status,
      findings,
      errors,
      readOnly,
    }),
  );
}
