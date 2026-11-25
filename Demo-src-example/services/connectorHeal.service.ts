import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { notFound, policy, refusal, toResponse } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import {
  diff,
  withoutSamples,
  type FieldShape,
  type SchemaChange,
} from '../utils/schemaDiffer.util';
import { childLogger } from '../config/logger.config';
import * as connectorRepo from '../repos/connector.repo';
import * as automationService from './automation.service';
import * as healRepo from '../repos/heal.repo';
import * as lifecycle from '../repos/connectorVerify.repo';
import { autoAdoptPrebuilt } from './connectionVersion.service';
import * as connectorService from './connector.service';
import { executeRead } from '../engine/read/execute.read';
import { columnsOf, sampleRows } from '../engine/transports/sql/catalogue.sql';
import { tableOf } from '../engine/read/capabilities.read';
import { getPath } from '../engine/expression/paths.expression';
import { isPipeline, isVariants, type Manifest, type ManifestObject, type OperationV2, type PipelineV2 } from '../schemas/manifest.schema';
import { withConnection } from './connectorRuntime.service';
import type { Actor } from './scope.service';

const log = childLogger('connector-heal');

/**
 * §8 — maintenance.
 *
 *   Field renamed          propose repair, sandbox test, apply
 *   Field changed meaning  HALT and report. Not a repair.
 *   New field appears      propose mapping. Never apply silently.
 *   Object disappears      HALT.
 *
 * THE RENAME-VERSUS-MEANING DISTINCTION IS WHY THIS IS CAREFUL RATHER THAN
 * CLEVER. "Erring permissive silently corrupts every answer downstream": a
 * connector that quietly repoints `amount` at a column now holding something
 * else keeps answering, keeps looking healthy, and is wrong in every figure it
 * produces from then on. `schemaDiffer` halts wherever it cannot tell, and this
 * service never overrides that.
 *
 * WHY HALT IS NOT AN OUTAGE. A halted connection refuses every query, loudly,
 * naming itself. That is deliberately worse-looking than a wrong number and
 * deliberately better than one.
 */

/* ── Observing what the source actually has ─────────────────────────────── */

function typeOf(value: unknown): FieldShape['type'] {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  switch (typeof value) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    default: return 'string';
  }
}

/**
 * The shape of what came back, from a handful of rows.
 *
 * SAMPLES ARE CARRIED BECAUSE THE SAMPLES ARE THE EVIDENCE. A field that kept
 * its name and its type and changed its values is the dangerous case, and names
 * and types alone cannot see it.
 */
/**
 * WHAT A FIELD READS AT THE SOURCE, when that is one path: no expression, or an
 * expression that is only a path. A field computed from several keys has no
 * single source path, and is checked by its value instead.
 */
const SIMPLE_PATH = /^\{\{\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*\}\}$/;

function readsOf(object: ManifestObject): Array<OperationV2 | PipelineV2> {
  return isVariants(object.read) ? (object.read as Array<OperationV2 | PipelineV2>) : [object.read];
}

/** The `fields` map the object's (default) read projects with. */
function fieldsOf(object: ManifestObject): Record<string, string> {
  const reads = readsOf(object);
  return reads[reads.length - 1]!.fields ?? {};
}

function sourcePathOf(object: ManifestObject, field: string): string | null {
  const expression = fieldsOf(object)[field];
  if (expression === undefined) return field;
  const match = SIMPLE_PATH.exec(expression);
  return match ? match[1]! : null;
}

const DECLARED: Record<string, FieldShape['type']> = {
  string: 'string',
  number: 'number',
  money: 'number',
  boolean: 'boolean',
  date: 'date',
  datetime: 'date',
  json: 'object',
  unknown: 'string',
};

/** A value's type in the declared vocabulary, so an ISO date string is a date where a date was declared. */
function typeAs(value: unknown, declared: FieldShape['type']): FieldShape['type'] {
  const raw = typeOf(value);
  if (declared === 'date' && raw === 'string' && !Number.isNaN(Date.parse(String(value)))) return 'date';
  if (declared === 'object' && (raw === 'array' || raw === 'object')) return 'object';
  return raw;
}

/**
 * The declared shape: each field at the source path it reads (its own name
 * when it is computed), typed as declared.
 */
const declaredShapes = (object: ManifestObject): FieldShape[] =>
  object.fields.map((field) => ({
    path: sourcePathOf(object, field.name) ?? field.name,
    type: DECLARED[field.type] ?? 'string',
    nullable: field.nullable ?? true,
  }));

/**
 * The observed shape, compared like with like.
 *
 * A DECLARED FIELD IS JUDGED BY WHAT IT PRODUCED. Its projected values, typed
 * in the declared vocabulary; a field that was null in every sample is no
 * evidence of change and keeps its declared type — a halt on an empty sample
 * would stop a healthy connection. A field that reads one path which the
 * source no longer sends is left OUT, so the differ sees it gone.
 *
 * EVERY SOURCE KEY NO FIELD READS is offered too — the candidates for a rename
 * and for a new field.
 */
function observedShapes(object: ManifestObject, rows: Record<string, unknown>[], raw: unknown[], columns: FieldShape[] = []): FieldShape[] {
  const records = raw.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r));
  const out: FieldShape[] = [];
  const readRoots = new Set<string>();

  for (const field of object.fields) {
    const path = sourcePathOf(object, field.name);
    if (path) readRoots.add(path.split('.')[0]!);
    const declared = DECLARED[field.type] ?? 'string';
    if (path && records.length > 0 && records.every((r) => getPath(r, path) === undefined) && !columns.some((c) => c.path === path)) continue;
    const values = rows.map((row) => row[field.name]);
    const real = values.find((v) => v !== null && v !== undefined);
    out.push({
      path: path ?? field.name,
      type: real === undefined ? declared : typeAs(real, declared),
      nullable: values.some((v) => v === null || v === undefined),
      sample: values.slice(0, 20),
    });
  }

  for (const expression of Object.values(fieldsOf(object))) {
    for (const match of expression.matchAll(/\b([A-Za-z_][\w]*)\b/g)) readRoots.add(match[1]!);
  }

  const keys = new Set([...records.flatMap((r) => Object.keys(r)), ...columns.map((c) => c.path)]);
  for (const key of keys) {
    if (readRoots.has(key)) continue;
    const values = records.map((r) => r[key]);
    const real = values.find((v) => v !== null && v !== undefined);
    const column = columns.find((c) => c.path === key);
    out.push({
      path: key,
      type: real === undefined ? column?.type ?? 'null' : typeOf(real),
      nullable: values.some((v) => v === null || v === undefined) || (column?.nullable ?? false),
      sample: values.slice(0, 20),
    });
  }
  return out;
}

/* ── The check ──────────────────────────────────────────────────────────── */

export interface HealOutcome {
  connectionId: string;
  checked: string[];
  proposals: Array<{
    id: string;
    changeKind: 'rename' | 'semantic' | 'new_field' | 'object_removed';
    subject: string;
    autoApplied: boolean;
    note: string;
  }>;
  halted: boolean;
  haltedReason: string | null;
}

/**
 * Re-check a connection against the system it points at.
 *
 * READ-ONLY, ALWAYS. A maintenance pass that writes would be a maintenance pass
 * that can break something while checking whether anything is broken.
 */
export async function recheck(actor: Actor, connectionId: string): Promise<HealOutcome> {
  const connection = await connectorService.readableConnection(actor, connectionId);

  const outcome: HealOutcome = {
    connectionId,
    checked: [],
    proposals: [],
    halted: false,
    haltedReason: null,
  };

  const objects = connection.manifest.objects.filter((o) => o.available);

  for (const object of objects) {
    let observed: FieldShape[];

    try {
      observed = await observe(actor, connection, object);
    } catch (error: unknown) {
      const response = toResponse(error);

      /*
       * AN OBJECT THAT NO LONGER EXISTS IS A HALT, NOT A RETRY. §8 — "a query
       * referencing it would silently return nothing", which is the one outcome
       * worse than refusing to answer.
       */
      if (response.body.error.code === 'missing.source_object' ||
          response.body.error.code === 'refusal.source_object_missing') {
        await halt(actor, connection, `${object.name} is no longer present in the source.`, {
          changeKind: 'object_removed',
          objectOrField: object.name,
        });
        outcome.proposals.push(
          await propose(actor, connection, {
            changeKind: 'object_removed',
            subject: object.name,
            diff: { object: object.name, reason: response.body.error.message },
            note: response.body.error.message,
          }),
        );
        outcome.halted = true;
        outcome.haltedReason = `${object.name} is no longer present in the source.`;
        return outcome;
      }

      // Anything else is the source being unreachable, which is not a change.
      log.info(
        { connectionId, object: object.name, code: response.body.error.code },
        'Re-check could not read an object',
      );
      continue;
    }

    outcome.checked.push(object.name);

    /*
     * NOTHING OBSERVED IS NOT A SCHEMA CHANGE. A transport that could not
     * describe the object tells us nothing, and diffing against nothing would
     * report every declared field as removed and halt a healthy connection.
     */
    if (observed.length === 0) continue;

    for (const change of diff(declaredShapes(object), observed)) {
      const proposal = await handle(actor, connection, object, change);
      if (proposal) outcome.proposals.push(proposal);

      if (change.type === 'semantics-suspected' || change.type === 'type-changed') {
        await halt(actor, connection, change.note, {
          changeKind: change.type === 'type-changed' ? 'type_changed' : 'semantic',
          objectOrField: `${object.name}.${(change.before ?? change.after)!.path}`,
        });
        outcome.halted = true;
        outcome.haltedReason = change.note;
        return outcome;
      }
    }
  }

  if (!outcome.halted) {
    await withTransaction((db) => lifecycle.markHealthy(db, connectionId));
  }

  return outcome;
}

async function handle(
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
  object: ManifestObject,
  change: SchemaChange,
): Promise<HealOutcome['proposals'][number] | null> {
  switch (change.type) {
    case 'renamed': {
      /*
       * THE ONLY CHANGE THAT MAY APPLY ITSELF, and only after it has been tested
       * against the live source. 018 enforces both halves as CHECK constraints,
       * because "we only auto-apply renames" is the kind of rule that survives
       * in code exactly until somebody adds a case to a switch.
       */
      const repaired = renameField(connection.manifest, object.name, change.before!.path, change.after!.path);
      const tested = await sandboxTest(actor, connection, repaired, object.name);

      const proposal = await propose(actor, connection, {
        changeKind: 'rename',
        subject: `${object.name}.${change.before!.path} → ${change.after!.path}`,
        diff: { object: object.name, from: change.before!.path, to: change.after!.path },
        note: change.note,
        sandboxStatus: tested.passed ? 'passed' : 'failed',
        sandboxResult: tested.detail,
      });

      /*
       * §8 — BOTH CONDITIONS, NOT JUST THE SANDBOX.
       *
       * The differ computes `autoRepairable` — name similarity at or above
       * 0.75 AND values that actually agree — and this read only
       * `tested.passed`, so the figure was calculated and thrown away. The
       * effective bar was 0.6 with no value evidence at all.
       *
       * And a sandbox test is the weaker of the two by some way: it proves the
       * new column is SELECTABLE, not that it means what the old one meant.
       * `total` becoming `total_ex_vat` passes it comfortably.
       */
      if (tested.passed && change.autoRepairable) {
        await apply(actor, connection, repaired, proposal.id, true);
        proposal.autoApplied = true;
      }

      return proposal;
    }

    case 'added':
      /*
       * A NEW FIELD IS OFFERED, NEVER TAKEN. §8 — "propose mapping. Never apply
       * silently." Silo has no idea what it means, and a field added to the
       * manifest without a mapping is a field queries can name and nothing can
       * interpret.
       */
      return propose(actor, connection, {
        changeKind: 'new_field',
        subject: `${object.name}.${change.after!.path}`,
        diff: { object: object.name, field: change.after!.path, type: change.after!.type },
        note: change.note,
      });

    case 'semantics-suspected':
    case 'type-changed':
      return propose(actor, connection, {
        changeKind: 'semantic',
        subject: `${object.name}.${(change.before ?? change.after)!.path}`,
        /*
         * `withoutSamples` IS NOT TIDINESS. A `FieldShape` carries up to twenty
         * live values from the column, which is how the differ judges whether
         * two fields still mean the same thing — and this branch was the only
         * one that wrote a whole shape rather than a path and a type, so those
         * values were being persisted into `heal_proposals.proposed_diff` with
         * no expiry, no bound and no sweep.
         *
         * What a reviewer needs from this row is that `total` went from number
         * to string. The twenty balances that proved it are evidence for a
         * comparison that has already been made.
         */
        diff: {
          object: object.name,
          before: withoutSamples(change.before),
          after: withoutSamples(change.after),
        },
        note: change.note,
      });

    case 'removed':
      /*
       * A FIELD THAT VANISHED WITHOUT A PLAUSIBLE REPLACEMENT. The differ has
       * already looked for a rename and not found one, so this is a change of
       * shape somebody has to look at — it is not auto-repairable and it does
       * not halt the whole connection, because the other fields still answer.
       */
      return propose(actor, connection, {
        changeKind: 'semantic',
        subject: `${object.name}.${change.before!.path}`,
        diff: { object: object.name, removed: change.before!.path },
        note: change.note,
      });

    case 'nullability-changed':
      return null;
  }
}

/* ── Proposals ──────────────────────────────────────────────────────────── */

async function propose(
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
  input: {
    changeKind: 'rename' | 'semantic' | 'new_field' | 'object_removed';
    subject: string;
    diff: Record<string, unknown>;
    note: string;
    sandboxStatus?: 'passed' | 'failed';
    sandboxResult?: Record<string, unknown>;
  },
): Promise<HealOutcome['proposals'][number]> {
  const id = await withTransaction(async (db) => {
    const proposalId = await healRepo.insert(db, {
      connectionId: connection.connectionId,
      /* The version this was noticed against. A proposal outlives the document
         it describes, and a diff applied to whatever manifest is current when
         somebody gets round to reviewing it is a diff applied to something
         else. */
      manifestId: connection.manifestId,
      changeKind: input.changeKind,
      subject: input.subject,
      proposedDiff: input.diff,
      sandboxStatus: input.sandboxStatus ?? null,
      sandboxResult: input.sandboxResult ?? null,
    });

    await writeAudit(db, {
      event: 'heal_proposed',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: {
        connectionId: connection.connectionId,
        proposalId,
        changeKind: input.changeKind,
        subject: input.subject,
      },
    });

    return proposalId;
  });

  return {
    id,
    changeKind: input.changeKind,
    subject: input.subject,
    autoApplied: false,
    note: input.note,
  };
}

/* ── Applying a rename ──────────────────────────────────────────────────── */

/**
 * A source key renamed, repaired where it is read.
 *
 * THE FIELD KEEPS ITS NAME. Ontology mappings, field policies and every saved
 * question refer to the field; what moved is the key it reads at the source, so
 * the repair is to the `fields` expression — `total` now reads `total_amount` —
 * and nothing downstream changes.
 */
function renameField(manifest: Manifest, objectName: string, from: string, to: string): Manifest {
  const quote = (path: string) => path.split('.').map((part) => (/^[A-Za-z_][\w]*$/.test(part) ? part : `\`${part}\``)).join('.');
  const repoint = (fields: Record<string, string>, object: ManifestObject) => {
    const next = { ...fields };
    for (const field of object.fields) {
      if (sourcePathOf(object, field.name) === from) next[field.name] = `{{ ${quote(to)} }}`;
    }
    return next;
  };
  return {
    ...manifest,
    objects: manifest.objects.map((object) => {
      if (object.name !== objectName) return object;
      const repair = (read: OperationV2 | PipelineV2) => ({ ...read, fields: repoint(read.fields ?? {}, object) });
      const read = isVariants(object.read)
        ? (object.read as Array<OperationV2 | PipelineV2>).map((one) => repair(one))
        : repair(object.read as OperationV2 | PipelineV2);
      return { ...object, read } as ManifestObject;
    }),
  };
}

/**
 * Run the repaired manifest against the live source before trusting it.
 *
 * §8 SAYS "sandbox test" AND THIS IS IT: the proposed document is executed
 * read-only, and a rename that does not actually read is not applied. Without
 * this, a differ that guessed wrong would rewrite the connector and the failure
 * would appear later, in an answer.
 */
async function sandboxTest(
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
  repaired: Manifest,
  objectName: string,
): Promise<{ passed: boolean; detail: Record<string, unknown> }> {
  try {
    const object = repaired.objects.find((o) => o.name === objectName)!;

    /*
     * THE REPAIRED DOCUMENT IS EXECUTED AS A QUERY, not described. Describing it
     * again would only re-read the catalogue this proposal came from and agree
     * with itself; running it is what proves the renamed field can actually be
     * selected.
     */
    const rows = await withCredentials(actor, { ...connection, manifest: repaired }, async (open) =>
      (await executeRead(await open(object.name), { object: object.name, filters: [], sort: [], fields: [], limit: 5 })).rows,
    );

    /* A repair that reads, but reads nothing into the field it repaired, did not repair it. */
    const filled = rows.some((row) => Object.values(row).some((v) => v !== null && v !== undefined));
    return { passed: rows.length > 0 && filled, detail: { rowsRead: rows.length } };
  } catch (error: unknown) {
    const response = toResponse(error);
    return { passed: false, detail: { error: response.body.error } };
  }
}

async function apply(
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
  repaired: Manifest,
  proposalId: string,
  /*
   * WHO APPLIED IT, AND 018 CARES. `auto_applied` means Silo decided by itself,
   * which its CHECK permits only for a tested rename. A new field adopted
   * because a person accepted it is not that — recording it as automatic would
   * both violate the constraint and misattribute the decision, and the
   * constraint is what caught this.
   */
  automatically: boolean,
): Promise<void> {
  await withTransaction(async (db) => {
    /*
     * A NEW VERSION, NEVER AN EDIT. Manifests are immutable and answers cite the
     * version that produced them — a repair that rewrote the document in place
     * would make every past answer unreconcilable with the connector that
     * supposedly produced it.
     */
    const connectorKey = await lifecycle.connectorKeyOf(db, connection.manifestId);
    if (!connectorKey) throw notFound({ message: 'Manifest missing.', code: 'missing.manifest' });

    /*
     * COUNTED IN THE TENANT THIS IS ABOUT TO BE WRITTEN INTO, WHICH IS THE
     * ACTOR'S AND NOT THE HEALED MANIFEST'S. A prebuilt manifest belongs to
     * Silo and has no organisation, so counting its versions against its own
     * (null) organisation matched nothing and answered 1 every time — while the
     * row went into the customer's tenant. An organisation running ten
     * connections off one prebuilt connector healed the first and then hit
     * 013's `manifests_tenant_version` on every other one, reported mid-heal as
     * a duplicate.
     *
     * THE LOCK IS TAKEN BEFORE THE COUNT AND HELD FOR THE TRANSACTION, on the
     * same key `connectorBuilder.publishDraft` takes — a heal racing another
     * heal, or a heal racing a publish, would otherwise both read the same
     * highest version and one would fail on that index instead of becoming the
     * next version.
     */
    await lifecycle.lockLineage(db, `manifest:${actor.organisationId}:${connectorKey}`);

    const version = await lifecycle.nextVersion(db, {
      organisationId: actor.organisationId,
      connectorKey,
    });

    const manifestId = await lifecycle.insertVersion(db, {
      organisationId: actor.organisationId,
      connectorKey,
      version,
      document: {
        ...repaired,
        identity: { ...repaired.identity, version },
      },
      schemaVersion: repaired.schemaVersion,
      /*
       * `ai`, WHATEVER ROUTE THE ORIGINAL CAME FROM. A repaired manifest was
       * written by Silo rather than by a person, and recording it as `visual`
       * would attribute a machine's edit to whoever last opened the builder.
       */
      sourceRoute: 'ai',
      createdBy: actor.membershipId,
    });

    /*
     * A FORK OFF A PREBUILT MANIFEST SUPERSEDES NOTHING, and that is right: the
     * row belongs to Silo, carries a SELECT-only policy, and a customer healing
     * their copy must not stamp the global one. What was wrong was that it
     * happened silently — the row count was discarded, so "marked superseded"
     * and "declined by policy" looked identical from here, and the manifest
     * lineage of a prebuilt-derived connector was quietly incomplete.
     */
    const superseded = await lifecycle.supersede(db, {
      manifestId: connection.manifestId,
      byManifestId: manifestId,
    });

    if (!superseded) {
      log.info(
        { connectionId: connection.connectionId, from: connection.manifestId, to: manifestId },
        'Healed off a manifest this tenant does not own, so nothing was superseded',
      );
    }
    await lifecycle.pointAtManifest(db, connection.connectionId, manifestId);
    await healRepo.markApplied(db, { id: proposalId, automatically });

    await writeAudit(db, {
      event: 'heal_applied',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: {
        connectionId: connection.connectionId,
        proposalId,
        manifestId,
        version,
      },
    });
  });
}

/* ── Halting ────────────────────────────────────────────────────────────── */

async function halt(
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
  reason: string,
  change?: { changeKind: string; objectOrField: string },
): Promise<void> {
  await withTransaction(async (db) => {
    await lifecycle.halt(db, connection.connectionId, reason);

    /*
     * Automations §8 — "A halted connection pauses every automation depending
     * on it, and says so." In the halting transaction, so a connection cannot
     * be halted while a scheduled check is left pointing at it: running a
     * condition against a system that is down produces a false negative, which
     * is the failure mode most likely to be trusted.
     */
    await automationService.pauseOnHalt(db, {
      organisationId: actor.organisationId,
      connectionId: connection.connectionId,
    });

    await writeAudit(db, {
      event: 'connection_halted',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { connectionId: connection.connectionId, cause: reason },
    });

    /*
     * TWO EVENTS, NOT ONE, AND THEY ANSWER DIFFERENT QUESTIONS. `connection_halted`
     * is operational — this system stopped answering. `heal_halted` is diagnostic
     * — a maintenance pass found a specific change it would not repair, and names
     * which field and what kind of change. A single event would force whoever
     * reads the trail to infer the second from the first.
     */
    if (change) {
      await writeAudit(db, {
        event: 'heal_halted',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: {
          connectionId: connection.connectionId,
          changeKind: change.changeKind,
          objectOrField: change.objectOrField,
        },
      });
    }
  });

  log.warn({ connectionId: connection.connectionId, reason }, 'Connection halted by self-heal');
}

/* ── Seeing what is actually there ──────────────────────────────────────── */

const SAMPLE_ROWS = 20;

/**
 * The shape of the object as the SOURCE has it, not as the manifest hopes.
 *
 * HOW THAT IS FOUND OUT DIFFERS BY TRANSPORT, and the difference is not
 * cosmetic. A database is asked its catalogue, because a `SELECT` names the
 * columns the manifest declares — so a column ADDED is invisible to it and a
 * column RENAMED makes the statement fail rather than reveal anything. An HTTP
 * source has no catalogue, so its records are the only evidence and a sample is
 * what there is.
 *
 * SAMPLES ARE CARRIED WHEREVER THEY CAN BE, because names and types cannot see
 * the dangerous case: a field that kept both and changed what it means.
 */
async function observe(
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
  object: ManifestObject,
): Promise<FieldShape[]> {
  return withCredentials(actor, connection, async (open) => {
    const ctx = await open(object.name);

    /*
     * A DATABASE IS ASKED WHAT COLUMNS IT HAS, and sampled on those. Selecting
     * the declared ones would fail outright on the very rename this pass
     * exists to notice.
     */
    const table = ctx.manifest.transport.kind === 'sql' ? tableOf(object) : null;
    if (table) {
      const catalogue = (await columnsOf(ctx, table)) ?? [];
      const columns = catalogue.map((c) => ({ path: c.name, type: DECLARED[c.type] ?? 'string', nullable: c.nullable }));
      const raw = await sampleRows(ctx, table, catalogue.map((c) => c.name), SAMPLE_ROWS);
      const rows = raw.map((record) =>
        Object.fromEntries(object.fields.map((f) => [f.name, record[sourcePathOf(object, f.name) ?? f.name] ?? null])),
      );
      return observedShapes(object, rows, raw, columns);
    }

    const raw: unknown[] = [];
    ctx.observe = (records) => raw.push(...records);
    /*
     * NO FIELD SELECTION. Asking for the declared fields would return exactly
     * the declared fields and prove nothing — the point is to see what the
     * source sends when it is not being told what to send.
     */
    const result = await executeRead(ctx, { object: object.name, filters: [], sort: [], fields: [], limit: SAMPLE_ROWS });
    return observedShapes(object, result.rows, raw);
  });
}

async function withCredentials<T>(
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
  use: Parameters<typeof withConnection<T>>[0]['use'],
): Promise<T> {
  const stored = await withTransaction((db) => connectorRepo.credentialsFor(db, [connection.connectionId]));
  return withConnection({ actor, connection, credential: stored.get(connection.connectionId), reason: 'connection-verify', use });
}

/* ── The weekly pass ────────────────────────────────────────────────────── */

/**
 * Every active connection in one organisation.
 *
 * DRIVEN FROM OUTSIDE THE PROCESS, NOT BY A TIMER IN IT. Cloud Run scales to
 * zero, so an in-process weekly interval fires only if an instance happens to be
 * alive — which is to say, never reliably. The schedule belongs to Cloud
 * Scheduler and this is what it calls.
 *
 * ONE CONNECTION'S FAILURE DOES NOT STOP THE PASS. A source being unreachable on
 * a Tuesday is ordinary, and letting it abandon the other eleven checks would
 * mean the whole estate goes unchecked whenever any one system is down.
 */
export async function recheckOrganisation(actor: Actor): Promise<HealOutcome[]> {
  /*
   * §3.7 — PREBUILT CONNECTORS MOVE FIRST, where the organisation asked for it
   * and the move needs nobody's confirmation, so this week's check is of the
   * version the connection will actually run.
   */
  for (const moved of await autoAdoptPrebuilt(actor)) {
    log.info({ connectionId: moved.connectionId, toManifestId: moved.toManifestId, outcome: moved.outcome, reason: moved.reason }, 'Prebuilt connector version');
  }

  const connections = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () => withTransaction((db) => connectorRepo.loadActive(db)),
  );

  const outcomes: HealOutcome[] = [];

  for (const connection of connections) {
    try {
      outcomes.push(await recheck(actor, connection.connectionId));
    } catch (error: unknown) {
      log.warn(
        { connectionId: connection.connectionId, err: error },
        'Re-check failed for one connection',
      );
    }
  }

  return outcomes;
}


/**
 * What is waiting for a person.
 *
 * AUTO-APPLIED RENAMES ARE INCLUDED, NOT HIDDEN. They were applied without
 * asking, which makes seeing them afterwards the only chance anybody gets to
 * disagree — a queue showing only the unresolved would quietly become a list of
 * everything Silo decided not to do by itself.
 */
export async function proposalsFor(
  actor: Actor,
  connectionId: string,
): Promise<Array<{
  id: string;
  changeKind: string;
  subject: string;
  autoApplied: boolean;
  sandboxStatus: string | null;
  decision: string | null;
  createdAt: string;
}>> {
  await connectorService.readableConnection(actor, connectionId);

  const proposals = await withTransaction((db) => healRepo.listFor(db, connectionId));

  /* The timestamp becomes a string HERE and not in the repo: a `Date` is what
     the row holds, and which representation goes over the wire is this layer's
     question. */
  return proposals.map((proposal) => ({
    ...proposal,
    createdAt: proposal.createdAt.toISOString(),
  }));
}


/* ── Deciding a proposal ────────────────────────────────────────────────── */

/**
 * A person accepts or rejects what a re-check proposed.
 *
 * ACCEPTING A NEW FIELD ADOPTS IT, and that is the only decision that changes
 * the connector. §8 — "New field appears. Propose mapping. Never apply
 * silently." This is where the not-silently happens: somebody looked at a field
 * Silo found, decided it belongs, and the manifest gains a version saying so.
 *
 * ACCEPTING A SEMANTIC CHANGE CHANGES NOTHING BY ITSELF, deliberately. Silo does
 * not know what `amount` means now that it has stopped meaning what it did, and
 * guessing is the exact failure the halt exists to prevent. Accepting records
 * that a person has seen it; fixing the connector is a separate act in the
 * builder, and resuming the connection is a third.
 */
export async function decideProposal(
  actor: Actor,
  proposalId: string,
  decision: 'accepted' | 'rejected',
): Promise<{ decision: string; manifestId: string | null }> {
  const proposal = await withTransaction((db) => healRepo.read(db, proposalId));

  if (!proposal) {
    throw notFound({ message: 'That proposal does not exist.', code: 'missing.proposal' });
  }
  if (proposal.decision) {
    throw policy({
      message: `That proposal was already ${proposal.decision}.`,
      code: 'policy.proposal_decided',
    });
  }
  if (proposal.autoApplied) {
    throw policy({
      message: 'That repair was applied automatically and cannot be decided again.',
      code: 'policy.proposal_applied',
    });
  }

  const connection = await connectorService.manageableConnection(actor, proposal.connectionId);

  let manifestId: string | null = null;

  if (decision === 'accepted' && proposal.changeKind === 'new_field') {
    const field = String(proposal.proposedDiff.field ?? '');
    const objectName = String(proposal.proposedDiff.object ?? '');
    const type = String(proposal.proposedDiff.type ?? 'string');

    const adopted: Manifest = {
      ...connection.manifest,
      objects: connection.manifest.objects.map((object) =>
        object.name !== objectName
          ? object
          : {
              ...object,
              fields: [
                ...object.fields,
                { name: field, type: (['string', 'number', 'boolean', 'date', 'json'].includes(type) ? type : 'string') as (typeof object.fields)[number]['type'], nullable: true },
              ],
            },
      ),
    };

    await apply(actor, connection, adopted, proposalId, false);

    /* Read back rather than reusing what `apply` wrote, because what the caller
       is told must be the version the connection is actually on. */
    manifestId = await withTransaction((db) =>
      lifecycle.manifestIdOf(db, proposal.connectionId),
    );
  }

  await withTransaction(async (db) => {
    await healRepo.recordDecision(db, {
      id: proposalId,
      decision,
      reviewedBy: actor.membershipId,
    });

    await writeAudit(db, {
      event: 'heal_reviewed',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: {
        connectionId: proposal.connectionId,
        proposalId,
        decision,
        subject: proposal.subject,
      },
    });
  });

  return { decision, manifestId };
}
