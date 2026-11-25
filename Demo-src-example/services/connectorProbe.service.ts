import { withTransaction } from '../infra/db.infra';
import { childLogger } from '../config/logger.config';
import { generateId } from '../utils/tokens.util';
import { invalid, notFound, toResponse } from '../utils/error.util';
import * as connectorRepo from '../repos/connector.repo';
import * as drafts from '../repos/connectorDraft.repo';
import * as probeRuns from '../repos/probe.repo';
import type { RunStatus } from '../models/connectorLifecycle.model';
import * as connectorService from '../services/connector.service';
import { log as writeAudit } from './audit.service';
import * as builder from './connectorBuilder.service';
import { executeRead } from '../engine/read/execute.read';
import { recordKeysRead } from '../engine/expression/lint.expression';
import { isVariants } from '../schemas/manifest.schema';
import { withConnection } from './connectorRuntime.service';
import type { Manifest } from '../schemas/manifest.schema';
import type { Actor } from './scope.service';

const log = childLogger('connector-probe');

/**
 * The builder's live test panel — §5, "executes against the sandbox without
 * leaving the page".
 *
 * IT RUNS THE DRAFT, NOT A PUBLISHED MANIFEST. `execute` takes a manifest as a
 * value, so the document being edited can be executed directly without ever
 * being written to `connector_manifests` — which is what keeps the guarantee
 * that the engine's own load path cannot reach a draft while still letting
 * somebody see rows before they commit to anything.
 *
 * SAMPLE ROWS MATTER MORE THAN FIELD NAMES. §5 — a person recognises their own
 * data and does not recognise `acct_ref_2`. So the rows come back, and they are
 * the point of the panel rather than a debugging extra.
 *
 * READ-ONLY BY CONSTRUCTION. This calls `execute`, which is the query path;
 * mutations go through a different one that this file does not import. §7's
 * write-verify-undo cycle is a separate stage and does not run here.
 */

export interface ProbeOutcome {
  status: 'passed' | 'failed';
  object: string;
  /** Real records from the customer's own system. Returned, never stored. */
  rows: Record<string, unknown>[];
  /** The field names actually observed, which are often not the documented ones. */
  observedFields: string[];
  /** Fields the manifest declares that the system did not return. */
  missingFields: string[];
  /** Fields the system returned that the manifest does not declare. */
  undeclaredFields: string[];
  durationMs: number;
  error: { kind: string; code: string; message: string } | null;
  /**
   * When asked: whether paging works. `confirmed` — a second page held records
   * the first did not; `one_page` — the source said there was nothing more;
   * `repeated` — the second page was the first again, so the paging is wrong;
   * `none` — the object declares no paging.
   */
  paging?: { verdict: 'confirmed' | 'one_page' | 'repeated' | 'none'; recordsPerPage: number[] };
}

export async function probe(
  actor: Actor,
  input: { draftId: string; connectionId: string; object: string; limit?: number; checkPaging?: boolean },
): Promise<ProbeOutcome> {
  const draft = await withTransaction((db) => drafts.find(db, input.draftId));
  if (!draft) throw notFound({ message: 'That draft does not exist.', code: 'missing.draft' });

  /*
   * A DOCUMENT THAT IS NOT A MANIFEST CANNOT BE EXECUTED, and saying so with the
   * same field errors the form is already showing beats a failure from inside
   * the engine about a field somebody has not filled in yet.
   */
  const validation = builder.validate(draft.document);
  const executable = validation.valid ? builder.executable(draft.document) : null;
  if (!executable) {
    throw invalid({
      message: 'This connector is not complete enough to test yet.',
      code: 'invalid.draft_incomplete',
      detail: { ...validation },
    });
  }

  let manifest: Manifest = executable;
  const target = manifest.objects.find((o) => o.name === input.object);
  const pagedRead = target && !isVariants(target.read) && !('steps' in (target.read as object)) && (target.read as { page?: unknown }).page;
  if (input.checkPaging && target && pagedRead) {
    /* Two pages are enough to tell; the rest are the source's time and the customer's data. */
    manifest = {
      ...manifest,
      objects: manifest.objects.map((o) => (o === target ? { ...o, read: { ...(o.read as object), page: { ...(pagedRead as object), maxPages: 2 } } } : o)) as Manifest['objects'],
    };
  }
  if (!manifest.objects.some((o) => o.name === input.object)) {
    throw notFound({
      message: `This connector does not describe an object called ${input.object}.`,
      code: 'missing.object',
    });
  }

  /*
   * THE CREDENTIAL COMES FROM A CONNECTION, THE SHAPE FROM THE DRAFT. Which is
   * the whole trick: a connection can be set up and authorised once, and the
   * document tested against it as many times as it takes.
   */
  const connection = await connectorService.readableConnection(actor, input.connectionId);

  const runId = generateId();
  const started = Date.now();
  await record(runId, input.connectionId, 'running', {}, []);

  /*
   * §11 WANTS THE START AS WELL AS THE OUTCOME. A probe that begins and never
   * finishes leaves no completion row, so without this the trail is silent about
   * a run that hung against somebody's system — which is exactly the run worth
   * knowing about.
   */
  await audit(actor, 'probe_started', { connectionId: input.connectionId, stage: 'probe', runId });

  const pages: unknown[][] = [];
  try {
    const { rows, raw } = await runOnce(actor, connection, manifest, input.object, input.checkPaging ? 1_000 : (input.limit ?? 10), (records) => pages.push(records));
    const durationMs = Date.now() - started;

    const object = manifest.objects.find((o) => o.name === input.object)!;
    const declared = object.fields.map((f) => f.name);
    /* The source keys the document reads: fields named as they are, and every key a field's expression reads. */
    const read = new Set<string>(declared);
    const reads = isVariants(object.read) ? object.read : [object.read];
    for (const one of reads) {
      const fields = (one as { fields?: Record<string, string> }).fields ?? {};
      for (const expression of Object.values(fields)) for (const key of recordKeysRead(expression)) read.add(key);
    }
    const observed = new Set(raw.flatMap((record) => (record && typeof record === 'object' && !Array.isArray(record) ? Object.keys(record) : [])));

    const outcome: ProbeOutcome = {
      status: 'passed',
      object: input.object,
      rows,
      observedFields: [...observed].sort(),
      /*
       * §7's RECONCILE, IN MINIATURE. "Documentation is wrong constantly; the
       * probe is the source of truth." A declared field that came back empty in
       * every row is the single most common way a connector is subtly wrong —
       * usually a path that does not match the response — and it is invisible
       * unless something compares the two.
       */
      missingFields: rows.length === 0 ? [] : declared.filter((f) => rows.every((row) => row[f] === null || row[f] === undefined)).sort(),
      undeclaredFields: [...observed].filter((f) => !read.has(f)).sort(),
      durationMs,
      error: null,
      ...(input.checkPaging ? { paging: pagingVerdict(target!, pages, Boolean(pagedRead)) } : {}),
    };
    if (input.checkPaging) outcome.rows = outcome.rows.slice(0, input.limit ?? 10);

    await record(runId, input.connectionId, 'passed', findingsOf(outcome), []);
    await audit(actor, 'probe_completed', {
      connectionId: input.connectionId,
      stage: 'probe',
      objectsFound: 1,
      runId,
    });

    return outcome;
  } catch (error: unknown) {
    /*
     * TWO PAGES OF A LONGER LIST END AT THE CEILING THE CHECK SET, and that is
     * the answer rather than a failure: the pages were seen before it stopped.
     */
    if (input.checkPaging && target && pages.length >= 2 && (error as { code?: string }).code === 'bounds.read_ceiling') {
      const outcome: ProbeOutcome = {
        status: 'passed',
        object: input.object,
        rows: [],
        observedFields: [],
        missingFields: [],
        undeclaredFields: [],
        durationMs: Date.now() - started,
        error: null,
        paging: pagingVerdict(target, pages, true),
      };
      await record(runId, input.connectionId, 'passed', findingsOf(outcome), []);
      await audit(actor, 'probe_completed', { connectionId: input.connectionId, stage: 'probe', objectsFound: 1, runId });
      return outcome;
    }
    const response = toResponse(error);
    const failure = {
      kind: response.body.error.kind,
      code: response.body.error.code,
      message: response.body.error.message,
    };

    log.info({ connectionId: input.connectionId, code: failure.code }, 'Probe failed');
    await record(runId, input.connectionId, 'failed', {}, [failure]);
    await audit(actor, 'probe_failed', {
      connectionId: input.connectionId,
      stage: 'probe',
      reason: failure.code,
      runId,
    });

    /*
     * A FAILED PROBE IS A RESULT, NOT AN EXCEPTION. §5 — "failure is honest":
     * the panel names what went wrong so somebody can fix the field that caused
     * it, and a 500 out of the test panel would tell them only that testing is
     * broken.
     */
    return {
      status: 'failed',
      object: input.object,
      rows: [],
      observedFields: [],
      missingFields: [],
      undeclaredFields: [],
      durationMs: Date.now() - started,
      error: failure,
      /* The runner refuses to ask for the same page twice: that is the paging being wrong. */
      ...(input.checkPaging && failure.code === 'refusal.page_loop' ? { paging: { verdict: 'repeated' as const, recordsPerPage: [] } } : {}),
    };
  }
}

/** Whether a second page was really the next one. */
function pagingVerdict(object: Manifest['objects'][number], pages: unknown[][], declared: boolean): NonNullable<ProbeOutcome['paging']> {
  const recordsPerPage = pages.map((p) => p.length);
  if (!declared) return { verdict: 'none', recordsPerPage };
  if (pages.length < 2 || pages[1]!.length === 0) return { verdict: 'one_page', recordsPerPage };
  const key = object.identifier[0]!;
  const idOf = (r: unknown) => (r && typeof r === 'object' ? JSON.stringify((r as Record<string, unknown>)[key] ?? r) : String(r));
  const first = new Set(pages[0]!.map(idOf));
  return { verdict: pages[1]!.some((r) => !first.has(idOf(r))) ? 'confirmed' : 'repeated', recordsPerPage };
}

async function runOnce(
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
  manifest: Manifest,
  object: string,
  limit: number,
  onPage?: (records: unknown[]) => void,
) {
  const stored = await withTransaction((db) =>
    connectorRepo.credentialsFor(db, [connection.connectionId]),
  );
  const credential = stored.get(connection.connectionId);

  if (!credential) {
    throw invalid({
      message: 'This connection has no credential yet, so there is nothing to test with.',
      code: 'invalid.no_credential',
    });
  }

  /*
   * THE TEST PANEL OPENS A REAL CREDENTIAL AND IS AUDITED LIKE ANY OTHER ACCESS,
   * through the same runtime a question uses — with the draft's document in
   * place of the published one.
   */
  const raw: unknown[] = [];
  const result = await withConnection({
    actor,
    connection: { ...connection, manifest },
    credential,
    use: async (open) => {
      const ctx = await open(object);
      ctx.observe = (records) => {
        raw.push(...records);
        onPage?.(records);
      };
      return executeRead(ctx, { object, filters: [], sort: [], fields: [], limit });
    },
  });
  return { rows: result.rows, raw };
}

/**
 * What is kept afterwards, and what is not.
 *
 * NO ROWS. The panel returns real records from a customer's own system, and
 * those are the one thing that must not land in a table — 019 makes the same
 * guarantee structurally for discovery by having no column for row contents, and
 * a probe log full of sample invoices would reintroduce exactly what that
 * avoided. What is worth keeping is the SHAPE: which fields were seen, which
 * were declared and not returned, and how long it took.
 */
function findingsOf(outcome: ProbeOutcome) {
  return {
    object: outcome.object,
    rowCount: outcome.rows.length,
    observedFields: outcome.observedFields,
    missingFields: outcome.missingFields,
    undeclaredFields: outcome.undeclaredFields,
    durationMs: outcome.durationMs,
  };
}

/**
 * `read_only` IS TRUE HERE AND IS NOT A DEFAULT. §7 step 1 is the read-only
 * sandbox probe and this file is it — it calls `execute` and imports no
 * mutation path — so the flag is a statement about this stage rather than a
 * value somebody chose.
 */
async function record(
  id: string,
  connectionId: string,
  status: RunStatus,
  findings: Record<string, unknown>,
  errors: unknown[],
): Promise<void> {
  await withTransaction((db) =>
    probeRuns.record(db, {
      id,
      connectionId,
      stage: 'probe',
      status,
      findings,
      errors,
      readOnly: true,
    }),
  );
}


/**
 * One place that writes a probe's audit rows.
 *
 * IN ITS OWN TRANSACTION, because a probe is a sequence of things that happen
 * over a network and there is no single unit of work to attach them to — the
 * start is recorded before the request goes out and the outcome after it comes
 * back, which is the whole point of recording both.
 */
async function audit(
  actor: Actor,
  event: 'probe_started' | 'probe_completed' | 'probe_failed',
  detail: Record<string, unknown>,
): Promise<void> {
  await withTransaction((db) =>
    writeAudit(db, {
      event,
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail,
    }),
  );
}
