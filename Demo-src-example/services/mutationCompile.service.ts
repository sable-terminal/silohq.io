import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, refusal } from '../utils/error.util';
import { checkMarkings } from '../utils/markingCheck.util';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import { readableIds } from './connector.service';
import { hiddenFields, visibleObjects } from './fieldPolicy.service';
import * as fieldAliasRepo from '../repos/fieldAlias.repo';
import { withLearned } from '../engine/ontology/derive.ontology';
import { assertMayChange, propose, type MutationView } from './mutation.service';
import * as tokens from './tokens.service';
import * as conceptRepo from '../repos/concept.repo';
import * as connectorRepo from '../repos/connector.repo';
import * as authzRepo from '../repos/authz.repo';
import { compile as askModel, isConfigured, ModelUnavailable } from '../infra/model.infra';
import { connectionCapabilities, writable as canWrite } from '../engine/read/capabilities.read';
import {
  changeShape,
  changeVocabularyOf,
  describeChangeVocabulary,
  validateChange,
  type CompiledChange,
} from '../engine/mutation/compile.mutation';
import type { RecordChange } from '../engine/mutation/preview.mutation';
import type { Comparison } from '../engine/execution/query.execution';
import type { Actor } from './scope.service';

/**
 * Mutations §3 — "Expressed in concept terms, compiled the same way a question
 * is. The user says what should change; they never name a table."
 *
 * ── Three stages, in the order that makes the guarantee ────────────────────
 *
 * What this person may change is worked out first, from grants, clearance,
 * write access and field policy. Only that is described to the model, with
 * their words. What comes back is validated against the same description and
 * rejected rather than repaired, then proposed exactly as a change written by
 * hand would be — through the same gate, which checks everything again.
 *
 * ── Nothing from a record reaches the model ────────────────────────────────
 *
 * The model sees concept and field names and the person's own words. It never
 * sees a value read from a system: resolution, prior state and the preview all
 * happen after it has returned, deterministically.
 */

export type CompiledOutcome =
  | { outcome: 'previewed'; mutation: MutationView & { changes: RecordChange[] } }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'ambiguous'; question: string; options: Array<{ conceptId: string; name: string }> };

export async function compileChange(
  actor: Actor,
  input: { intent: string; history?: Array<{ role: 'user' | 'model'; text: string }> },
): Promise<CompiledOutcome> {
  if (!isConfigured()) {
    throw refusal({
      message: 'No model is configured, so changes in plain English cannot be compiled.',
      code: 'refusal.model_unconfigured',
    });
  }

  /* ── What this person may change ──────────────────────────────────────── */

  const vocabulary = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'mutation.propose');

        /* Before a model call is made, not after one is paid for. */
        await assertMayChange(db, actor);

        const concepts = await conceptRepo.listLive(db);
        const ids = [...new Set(concepts.flatMap((one) => one.objects.map((object) => object.connectionId)))];
        const readable = await readableIds(db, actor, ids);
        const hidden = await hiddenFields(db, actor, [...readable]);
        const loaded = await connectorRepo.load(db, [...readable]);

        const writable = new Set<string>();
        for (const connection of loaded) {
          const allowed =
            connection.status !== 'halted' &&
            connection.writesEnabled &&
            canWrite(connection.manifest) &&
            (await connectorRepo.isWritableBy(db, { connectionId: connection.connectionId, membershipId: actor.membershipId }));
          if (allowed) writable.add(connection.connectionId);
        }

        /* §2.3 (131) — the names a change is planned in are the names it will be read in: learned ones included, one per column. */
        const learned = await fieldAliasRepo.learnedFor(db, ids);

        const visible = [];
        for (const concept of concepts) {
          /* A concept spanning a system this person cannot reach cannot be resolved for a change. */
          if (!concept.objects.every((object) => readable.has(object.connectionId))) continue;

          const required = await authzRepo.markingsOnResource(db, 'concept', concept.id);
          if (!checkMarkings({ required }, { held: authority.clearances }).permitted) continue;

          visible.push({
            id: concept.id,
            name: concept.name,
            objects: visibleObjects(withLearned({ objects: concept.objects, learned, keepOldNames: false }).objects, hidden),
          });
        }

        return changeVocabularyOf({
          concepts: visible,
          writable,
          filters: new Map(
            loaded.map((connection) => [connection.connectionId, connectionCapabilities(connection.manifest).filters]),
          ),
        });
      }),
  );

  if (vocabulary.length === 0) {
    return {
      outcome: 'refused',
      reason: 'There is nothing here you can change yet. You need write access to a connected system a concept covers.',
    };
  }

  /* ── The model sees names, and the request ────────────────────────────── */

  /* Billing §4 — refused before the model runs; charged below only if a change exists. */
  await tokens.afford(actor, 'multi_system_compile');

  /* An unreachable model is a refusal, as it is for questions (see `compile.service`). */
  let result: Awaited<ReturnType<typeof askModel>>;
  try {
    result = await askModel({
      question: input.intent,
      schema: changeShape(),
      ontology: describeChangeVocabulary(vocabulary),
      history: input.history,
    });
  } catch (error) {
    if (error instanceof ModelUnavailable) {
      throw refusal({
        message: 'Changes in plain English need the model, and it cannot be reached right now. Try again shortly.',
        code: 'refusal.model_unavailable',
      });
    }
    throw error;
  }

  const compiled: CompiledChange = result.ok
    ? validateChange(result.raw, vocabulary)
    : { outcome: 'refused', reason: result.refusal ?? 'The model declined to compile that change.' };

  await runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction((db) =>
      writeAudit(db, {
        event: 'mutation_compiled',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        /*
         * THE OUTCOME AND THE COST, NEVER THE WORDS. A request to change a record
         * names the record and the value, which is exactly what the trail must
         * not hold. The words are kept once, on the mutation, inside its retention.
         */
        detail: {
          outcome: compiled.outcome,
          questionLength: input.intent.length,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
      }),
    ),
  );

  if (compiled.outcome === 'rejected') {
    throw invalid({ message: compiled.reason, code: 'invalid.change_rejected', detail: compiled.detail ?? {} });
  }
  if (compiled.outcome === 'refused') return { outcome: 'refused', reason: compiled.reason };
  if (compiled.outcome === 'ambiguous') {
    return { outcome: 'ambiguous', question: compiled.question, options: compiled.options };
  }

  /* ── Proposed like any other change, through the same gate ────────────── */

  const mutation = await propose(actor, { intent: input.intent, manifest: compiled.manifest });

  /* §4 — a change reaching several systems is an advanced compile, like a question. */
  await tokens.spend(actor, mutation.preview.connections.length > 1 ? 'multi_system_compile' : 'compile');

  return { outcome: 'previewed', mutation };
}
