// connector-builder (catalogue; spec 16.3): the AI route, stage by stage, each stage a row in
// connect.probe_runs against the sandbox connection (structure and counts only).
//
// draft (parse): OpenAPI compiled without a model, or pasted documentation through the
// model gateway; the build draft compiled to a manifest and checked as the registry will;
// then a private connector, its first draft version, the generation charge when a model
// drafted it (metering, keyed: a retry charges once), and the sandbox connection in draft.
// The parse stage keeps the draft (structure) and, for pasted documentation, the
// documentation itself (written for the schema, never a record), for the model's second
// round.
//
// probe, in the background, each step re-reading nothing it need not:
// 1. probe: every object read whole as a raw capture, through schema-inference;
// 2. reconcile: documented against observed (reconcile.service.ts); objects the source did
//    not know at their path get one more model round when the model drafted them; every
//    object of the reconciled version is read, and one that does not read is left out
//    and named. Partial success is success; nothing that cannot execute is emitted;
// 3. conform: the conformance suite on that version; a failing pushdown is removed, the
//    version saved again and the suite rerun on it;
// 4. propose_mapping: object types, identifiers, properties and links, with confidence.
// confirm: the person's decisions recorded (mapping_confirmed names them), then the
// connection confirmed by the registry if they hold connector.verify (verify stage), private
// tier, writes off. A failed stage stops the build there; the draft opens in the visual
// builder.
//
// Who may: the sandbox's owner, or connection.manage where it is owned.

import { fetchDocument } from '../../contracts/credential/documentFetch.contract.ts';
import { isDescription, recognise, WELL_KNOWN } from './documentation.service.ts';
import { planGates, requireBuilder } from '../billing/planGates.service.ts';
import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import { changeConnectionStatus, getConnection, type ConnectionView } from '../../contracts/connect-registry/connection.contract.ts';
import { createConnector, getManifestVersion } from '../../contracts/connect-registry/connector.contract.ts';
import { getConformanceRun, startConformanceRun, type ConformanceRunView } from '../../contracts/conformance/conformance.contract.ts';
import { manifestSchema, type Manifest } from '../../contracts/connect/manifest.contract.ts';
import {
  mappingProposal, type BuildStage, type BuildView, type Documentation, type MappingProposal,
} from '../../contracts/connector-builder/build.contract.ts';
import { charge } from '../../contracts/metering/charge.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import { inferConnection, type InferredObject } from '../../contracts/schema-inference/inference.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { ProbeRun } from '../../models/connect/probeRun.model.ts';
import { probeRunRepo } from '../../repos/connect/index.repo.ts';
import { AppError, ContractViolation, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import { rawObject } from '../schema-inference/probeManifest.service.ts';
import { fullIssues } from '../visual-builder/draft.service.ts';
import { derivedKey, sandboxOn, saveVersion, toProbing, type Call, type SandboxSpec } from '../visual-builder/versions.service.ts';
import { compileDraft, draftSchema, type Draft } from './draft.service.ts';
import { draftFromText } from './model.service.ts';
import { draftFromOpenApi, parseOpenApi } from './openapi.service.ts';
import { importGraphql, importWsdl } from '../visual-builder/import.service.ts';
import { importOdataMetadata } from '../visual-builder/odataImport.service.ts';
import { draftFromNotifications, type EmailDraftCounts } from './emailDraft.service.ts';
import type { ManifestObject } from '../../contracts/connect/manifest.contract.ts';
import { proposeMapping, reconcileObject, type ReconcileFindings } from './reconcile.service.ts';

export interface BuilderDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  /** Further model rounds for objects the source did not know (spec 16.3 reconcile). */
  maxRounds?: number;
  /** How long to wait for a conformance run. */
  conformanceWaitMs?: number;
}

type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'idempotencyKey'>;

const RELEASE = '0.1.0';
const SAMPLE = 100;
const VERIFY_ROWS = 5;
/** A stage still running this long after it started is taken as abandoned. */
const STALE_MS = 30 * 60_000;

interface ParseFindings {
  source: Exclude<Documentation['kind'], 'url' | 'base_url'>;
  model: boolean;
  charged: boolean;
  objects: number;
  fields: number;
  notes: string[];
  /** A REST draft (OpenAPI or documentation); absent for a typed description, whose manifest is the record. */
  draft?: Draft | undefined;
  /** Drafted from a typed description (WSDL, GraphQL, OData $metadata) or sample notifications. */
  described?: true;
  /** Email fallback: what the drafted rules extracted from the samples, as counts. */
  email?: EmailDraftCounts;
  documentation?: { title: string; text: string } | undefined;
  /** Read from an address (16.3): the input it was, where it was found, and whether documentation was cut to the model's limit. */
  fetched?: { input: 'url' | 'base_url'; url: string; truncated: boolean } | undefined;
}

const DESCRIBED = ['wsdl', 'graphql', 'odata', 'email'] as const;
const isDescribed = (d: Documentation): d is Extract<Documentation, { kind: (typeof DESCRIBED)[number] }> => (DESCRIBED as readonly string[]).includes(d.kind);

/** A described object as observed by reading it: what proposeMapping reads (fill rates as confidence, the description's links). */
function asObserved(o: ManifestObject, sampled: number, filled: Readonly<Record<string, number>>): InferredObject {
  return {
    name: o.name, object: o.name, recordsPath: null, table: null, sampled, identifier: null,
    fields: o.fields.map((f) => ({
      name: f.name, path: f.path ?? f.name, type: f.type, nullable: f.nullable, format: null,
      confidence: sampled === 0 ? 0.5 : Math.round((0.5 + 0.5 * (filled[f.name] ?? 0) / sampled) * 100) / 100,
      evidence: { sampled, present: filled[f.name] ?? 0, nulls: sampled - (filled[f.name] ?? 0), distinct: 0, types: {} },
    })),
    relationships: o.relationships.map((r) => ({ ...r, confidence: 0.9, evidence: { declared: true, checked: 0, matched: 0 } })),
    paging: [], declared: [], typeMismatches: 0,
  };
}

/**
 * A member, or an AI FDE's Integration principal (51.4), which drafts and probes under
 * connector.build; the registry admits only an AI FDE principal, and its owner owns what it builds.
 */
const builder = (ctx: Context | Call): void => {
  if (ctx.request.membershipId === undefined && ctx.request.servicePrincipalId === undefined) {
    throw new AppError('forbidden', 'connectors are built by a member', { code: 'build.member_required' });
  }
};

const member = (ctx: Context | Call): string => {
  if (ctx.request.membershipId === undefined) throw new AppError('forbidden', 'connectors are built by a member', { code: 'build.member_required' });
  return ctx.request.membershipId;
};

/** The parse an earlier build stage recorded, or a refusal: the build was never drafted here. */
function parseOf(rows: readonly ProbeRun[]): ParseFindings {
  const parse = [...rows].reverse().find((r) => r.stage === 'parse' && r.status === 'completed');
  const found = parse?.findings as Partial<ParseFindings> | null | undefined;
  if (found?.described === true) return found as ParseFindings;
  const draft = draftSchema.safeParse(found?.draft);
  if (found === null || found === undefined || !draft.success) {
    throw new AppError('conflict', 'this connection was not drafted by the AI builder', { code: 'build.not_drafted' });
  }
  return { ...(found as ParseFindings), draft: draft.data };
}

export function createConnectorBuilder(deps: BuilderDeps) {
  const control = deps.databases.pool('control');
  const maxRounds = deps.maxRounds ?? 1;
  const conformanceWaitMs = deps.conformanceWaitMs ?? 5 * 60_000;
  const running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  const call = (ctx: Context | Call): Call => ({ request: ctx.request, correlationId: ctx.correlationId });

  async function mayBuild(ctx: Context | Call, connection: ConnectionView): Promise<void> {
    if (connection.owningMembershipId !== null && connection.owningMembershipId === ctx.request.membershipId) return;
    // An AI FDE's Integration principal (51.4) builds under connector.build, its tool permission; policy keeps its
    // reach to the connections its engaging administrator owns or was granted.
    const permission = ctx.request.servicePrincipalId !== undefined ? 'connector.build' : 'connection.manage';
    const decision = await deps.services.call(authorise, {
      body: { permission, scopeId: connection.owningScopeId, resource: { type: 'connection', id: connection.id } },
    }, call(ctx));
    if (decision.decision !== 'allow') {
      throw new AppError('forbidden', 'a build is its owner\'s, or needs connection.manage where it is owned', {
        code: 'build.not_permitted', details: { permission: 'connection.manage' },
      });
    }
  }

  async function record(ctx: Context | Call, connectionId: string, manifestId: string, stage: BuildStage, status: 'completed' | 'failed',
    findings: unknown, errors: unknown): Promise<string> {
    const id = uuidv7();
    await inTransaction(control, ctx.request, async (db) => {
      await probeRunRepo.insert(db, {
        id, organisationId: ctx.request.organisationId!, connectionId, manifestId, stage, status, completedAt: new Date().toISOString(),
        findings: (findings ?? null) as never, errors: (errors ?? null) as never,
      });
      if (status === 'failed') {
        await recordConnectEvent(db, {
          organisationId: ctx.request.organisationId!, correlationId: ctx.correlationId, event: 'connector_build_stage_failed',
          membershipId: ctx.request.membershipId ?? null, servicePrincipalId: ctx.request.servicePrincipalId ?? null, resourceType: 'connection', resourceId: connectionId,
          detail: { stage, probe_run_id: id, ...(errors !== null && typeof errors === 'object' && 'code' in errors ? { code: String(errors.code).slice(0, 100) } : {}) },
        });
      }
    });
    return id;
  }

  const rowsOf = (ctx: Context | Call, connectionId: string) =>
    inTransaction(control, ctx.request, (db) => probeRunRepo.listForConnection(db, connectionId, 100), { readOnly: true });

  async function manifestOf(ctx: Context | Call, connection: ConnectionView): Promise<{ id: string; version: string; manifest: Manifest }> {
    const v = await deps.services.call(getManifestVersion, { params: { connectorId: connection.connectorId, versionId: connection.manifestId } }, call(ctx));
    return { id: v.id, version: v.version, manifest: manifestSchema.parse(v.document) };
  }

  function compile(draft: Draft, manifest: Manifest) {
    return compileDraft(draft, { name: manifest.identity.name, provider: manifest.identity.provider, version: RELEASE }, manifest.transport.baseUrl);
  }

  /** Saves a compiled document as the next draft and moves the sandbox to it. */
  async function saveAndFollow(ctx: Call, connectionId: string, connectorId: string, document: unknown, key: string)
    : Promise<{ id: string; version: string; manifest: Manifest }> {
    const { manifest, issues } = fullIssues(document);
    if (manifest === undefined) {
      throw new ContractViolation('the reconciled draft is not a valid manifest', 'build.draft_invalid',
        issues.slice(0, 50).map((i) => ({ path: i.path, code: i.code, message: i.message })));
    }
    const saved = await saveVersion(deps.services, ctx, connectorId, manifest, key, 'draft');
    await sandboxOn(deps.services, ctx, connectorId, saved.id, key, { connectionId });
    return { ...saved, manifest };
  }

  async function waitForRun(ctx: Call, runId: string, signal: AbortSignal): Promise<ConformanceRunView> {
    const until = Date.now() + conformanceWaitMs;
    for (;;) {
      const run = await deps.services.call(getConformanceRun, { params: { runId } }, ctx);
      if (run.status !== 'running') return run;
      if (Date.now() > until || signal.aborted) {
        throw new AppError('timeout', 'the conformance run did not finish in time', { code: 'build.conformance_timeout' });
      }
      await sleep(250, signal).catch(() => undefined);
    }
  }

  /** Probe, reconcile, conform and propose (spec 16.3), after the reply. */
  async function pipeline(ctx: Call, connectionId: string, key: string, signal: AbortSignal): Promise<void> {
    let stage: BuildStage = 'probe';
    let connection = await deps.services.call(getConnection, { params: { connectionId } }, ctx);
    let current = await manifestOf(ctx, connection);
    try {
      const parse = parseOf(await rowsOf(ctx, connectionId));
      if (parse.described === true && current.manifest.protocol.kind === 'email') {
        await emailPipeline(ctx, connectionId, connection, current, parse.email);
        return;
      }
      if (parse.described === true) {
        await describedPipeline(ctx, connectionId, key, signal, connection, current);
        return;
      }
      let draft = parse.draft!;
      const connectorName = current.manifest.identity.name;

      // 1. Probe: each object read whole, through schema-inference.
      const rawProbe = async (forDraft: Draft, only: string[] | undefined, round: number) => {
        const compiled = compile(forDraft, current.manifest);
        const raw = { ...compiled.document, objects: compiled.document.objects.map((o) => rawObject(o.name, {
          method: 'GET', path: o.source.kind === 'rest' ? o.source.request.path : '/', query: o.source.kind === 'rest' ? o.source.request.query ?? {} : {}, headers: {},
        })) };
        current = await saveAndFollow(ctx, connectionId, connection.connectorId, raw, derivedKey(key, `raw${round}`));
        const out = await deps.services.call(inferConnection, {
          body: { connectionId, sampleSize: SAMPLE, ...(only === undefined ? {} : { objects: only }) },
        }, { ...ctx, timeoutMs: 120_000 });
        return { compiled, out };
      };
      let { compiled, out } = await rawProbe(draft, undefined, 1);
      if (out.schema.objects.length === 0) {
        await record(ctx, connectionId, current.id, 'probe', 'failed', { probeRunId: out.probeRunId }, { code: out.failures[0]?.code ?? 'build.probe_empty', failures: out.failures });
        return;
      }
      if (signal.aborted) return;

      // 2. Reconcile, with one more model round for objects the source did not know.
      stage = 'reconcile';
      const observed = new Map<string, InferredObject>(out.schema.objects.map((o) => [o.object, o]));
      let failures = out.failures;
      let rounds = 0;
      while (parse.model && parse.documentation !== undefined && rounds < maxRounds && failures.some((f) => f.code === 'source.not_found')) {
        rounds += 1;
        const missing = failures.filter((f) => f.code === 'source.not_found');
        const again = await draftFromText(deps.services, ctx, connectorName, parse.documentation, {
          failures: missing.map((f) => ({ object: f.object, code: f.code })),
          observed: [...observed.values()].map((o) => ({ object: o.object, fields: o.fields.map((f) => ({ name: f.name, type: f.type })) })),
        });
        const replacements = new Map(compile(again.draft, current.manifest).names.flatMap((n, i) => (n === null ? [] : [[n, again.draft.objects[i]!] as const])));
        draft = { ...draft, objects: draft.objects.map((o, i) => replacements.get(compiled.names[i] ?? '') ?? o) };
        // Every object again, so relationships are inferred across all of them (counts only).
        ({ compiled, out } = await rawProbe(draft, undefined, rounds + 1));
        observed.clear();
        for (const o of out.schema.objects) observed.set(o.object, o);
        failures = out.failures;
      }
      const findings: ReconcileFindings[] = [];
      const dropped: { object: string; reason: string }[] = failures.map((f) => ({ object: f.object, reason: f.code }));
      const reconciled = draft.objects.flatMap((o, i) => {
        const name = compiled.names[i];
        const seen = name === null || name === undefined ? undefined : observed.get(name);
        if (seen === undefined) return [];
        const result = reconcileObject(o, seen);
        findings.push(result.findings);
        if (result.object === undefined) dropped.push({ object: name!, reason: 'no_identifier' });
        return result.object === undefined ? [] : [result.object];
      });
      let final: Draft = { ...draft, objects: reconciled };
      if (final.objects.length === 0) {
        await record(ctx, connectionId, current.id, 'reconcile', 'failed', { objects: findings, dropped, rounds }, { code: 'build.nothing_reconciled' });
        return;
      }
      current = await saveAndFollow(ctx, connectionId, connection.connectorId, compile(final, current.manifest).document, derivedKey(key, 'reconciled'));
      // Every object of the version must read; one that does not is left out and named.
      const unreadable: string[] = [];
      for (const o of current.manifest.objects) {
        try {
          await deps.services.call(readObject, { body: { connectionId, reason: 'probe', step: { object: o.name, limit: VERIFY_ROWS } } }, ctx);
        } catch (error) {
          if (!isAppError(error)) throw error;
          unreadable.push(o.name);
          dropped.push({ object: o.name, reason: error.code });
        }
      }
      if (unreadable.length > 0) {
        const names = compile(final, current.manifest).names;
        final = { ...final, objects: final.objects.filter((_, i) => !unreadable.includes(names[i] ?? '')) };
        if (final.objects.length === 0) {
          await record(ctx, connectionId, current.id, 'reconcile', 'failed', { objects: findings, dropped, rounds }, { code: 'build.nothing_reads' });
          return;
        }
        current = await saveAndFollow(ctx, connectionId, connection.connectorId, compile(final, current.manifest).document, derivedKey(key, 'readable'));
      }
      await record(ctx, connectionId, current.id, 'reconcile', 'completed', { objects: findings, dropped, rounds, draft: final }, null);
      if (signal.aborted) return;

      // 3. Conform: the suite, and again without any pushdown that failed it.
      stage = 'conform';
      connection = await toProbing(deps.services, ctx, await deps.services.call(getConnection, { params: { connectionId } }, ctx));
      let run = await waitForRun(ctx, (await deps.services.call(startConformanceRun, { body: { connectionId, trigger: 'build' } },
        { ...ctx, idempotencyKey: derivedKey(key, 'conform1') })).id, signal);
      const removed = run.gate.failingOperators;
      if (removed.length > 0) {
        const names = compile(final, current.manifest).names;
        final = { ...final, objects: final.objects.map((o, i) => ({
          ...o, filters: o.filters.filter((f) => !removed.some((r) => r.object === names[i] && r.op === 'eq' && r.field === f.field)),
        })) };
        current = await saveAndFollow(ctx, connectionId, connection.connectorId, compile(final, current.manifest).document, derivedKey(key, 'conformed'));
        run = await waitForRun(ctx, (await deps.services.call(startConformanceRun, { body: { connectionId, trigger: 'build' } },
          { ...ctx, idempotencyKey: derivedKey(key, 'conform2') })).id, signal);
      }
      const conform = {
        runId: run.id, verified: run.gate.verified, passed: run.passedCount, failed: run.failedCount, failedClasses: run.gate.failedClasses, removed,
      };
      if (!run.gate.verified) {
        await record(ctx, connectionId, current.id, 'conform', 'failed', conform, { code: 'build.conformance_failed', classes: run.gate.failedClasses });
        return;
      }
      await record(ctx, connectionId, current.id, 'conform', 'completed', conform, null);

      // 4. Propose mapping.
      stage = 'propose_mapping';
      const proposals = proposeMapping(current.manifest.objects, [...observed.values()]);
      await record(ctx, connectionId, current.id, 'propose_mapping', 'completed', { proposals }, null);
    } catch (error) {
      const code = isAppError(error) ? error.code : 'build.internal';
      deps.logger.failure('a build stage failed', error, { event: 'build.stage_failed', resourceId: connectionId, outcome: stage });
      await record(ctx, connectionId, current.id, stage, 'failed', null, { code }).catch(() => undefined);
    }
  }

  /**
   * The pipeline for a typed description (WSDL, GraphQL, OData $metadata): the description is
   * the record of structure, so the probe reads each object as declared (a sample), an object
   * that does not read is left out and named, conformance runs and removes what fails as for
   * REST, and the mapping is proposed from the declared fields and links, weighed by how often
   * each was filled.
   */
  async function describedPipeline(ctx: Call, connectionId: string, key: string, signal: AbortSignal, connection: ConnectionView,
    start: { id: string; version: string; manifest: Manifest }): Promise<void> {
    let stage: BuildStage = 'probe';
    let current = start;
    try {
      const observed: InferredObject[] = [];
      const dropped: { object: string; reason: string }[] = [];
      const probed: { object: string; sampled: number; filled: Record<string, number> }[] = [];
      for (const o of current.manifest.objects) {
        try {
          const out = await deps.services.call(readObject, { body: { connectionId, reason: 'probe', step: { object: o.name, limit: SAMPLE } } }, ctx);
          const filled = Object.fromEntries(o.fields.map((f) => [f.name, out.rows.filter((r) => r[f.name] !== null && r[f.name] !== undefined).length]));
          probed.push({ object: o.name, sampled: out.rows.length, filled });
          observed.push(asObserved(o, out.rows.length, filled));
        } catch (error) {
          if (!isAppError(error)) throw error;
          dropped.push({ object: o.name, reason: error.code });
        }
      }
      if (probed.length === 0) {
        await record(ctx, connectionId, current.id, 'probe', 'failed', { dropped, described: true }, { code: 'build.probe_empty', failures: dropped });
        return;
      }
      await record(ctx, connectionId, current.id, 'probe', 'completed', { objects: probed, dropped, described: true }, null);
      if (signal.aborted) return;

      stage = 'reconcile';
      if (dropped.length > 0) {
        const keep = new Set(probed.map((p) => p.object));
        current = await saveAndFollow(ctx, connectionId, connection.connectorId, {
          ...current.manifest,
          objects: current.manifest.objects.filter((o) => keep.has(o.name)).map((o) => ({ ...o, relationships: o.relationships.filter((r) => keep.has(r.targetObject)) })),
        }, derivedKey(key, 'readable'));
      }
      await record(ctx, connectionId, current.id, 'reconcile', 'completed', { dropped, rounds: 0, described: true }, null);
      if (signal.aborted) return;

      stage = 'conform';
      connection = await toProbing(deps.services, ctx, await deps.services.call(getConnection, { params: { connectionId } }, ctx));
      let run = await waitForRun(ctx, (await deps.services.call(startConformanceRun, { body: { connectionId, trigger: 'build' } },
        { ...ctx, idempotencyKey: derivedKey(key, 'conform1') })).id, signal);
      const removed = run.gate.failingOperators;
      if (removed.length > 0) {
        current = await saveAndFollow(ctx, connectionId, connection.connectorId, {
          ...current.manifest,
          objects: current.manifest.objects.map((o) => ({
            ...o,
            pushdown: {
              ...o.pushdown,
              filters: o.pushdown.filters.map((f) => ({ ...f, ops: f.ops.filter((op) => !removed.some((r) => r.object === o.name && r.field === f.field && r.op === op)) }))
                .filter((f) => f.ops.length > 0),
            },
          })),
        }, derivedKey(key, 'conformed'));
        run = await waitForRun(ctx, (await deps.services.call(startConformanceRun, { body: { connectionId, trigger: 'build' } },
          { ...ctx, idempotencyKey: derivedKey(key, 'conform2') })).id, signal);
      }
      const conform = { runId: run.id, verified: run.gate.verified, passed: run.passedCount, failed: run.failedCount, failedClasses: run.gate.failedClasses, removed };
      if (!run.gate.verified) {
        await record(ctx, connectionId, current.id, 'conform', 'failed', conform, { code: 'build.conformance_failed', classes: run.gate.failedClasses });
        return;
      }
      await record(ctx, connectionId, current.id, 'conform', 'completed', conform, null);

      stage = 'propose_mapping';
      const proposals = proposeMapping(current.manifest.objects, observed.filter((o) => current.manifest.objects.some((x) => x.name === o.object)));
      await record(ctx, connectionId, current.id, 'propose_mapping', 'completed', { proposals }, null);
    } catch (error) {
      const code = isAppError(error) ? error.code : 'build.internal';
      deps.logger.failure('a build stage failed', error, { event: 'build.stage_failed', resourceId: connectionId, outcome: stage });
      await record(ctx, connectionId, current.id, stage, 'failed', null, { code }).catch(() => undefined);
    }
  }

  /**
   * Email fallback's pipeline (spec 14.4): nothing is read, so the probe and conformance do not
   * apply and say so; the rules were tried on the samples at draft (counts in the parse), and
   * the mapping is proposed from the fields, weighed by how often each was extracted.
   */
  async function emailPipeline(ctx: Call, connectionId: string, connection: ConnectionView, current: { id: string; manifest: Manifest },
    counts: EmailDraftCounts | undefined): Promise<void> {
    let stage: BuildStage = 'probe';
    try {
      await record(ctx, connectionId, current.id, 'probe', 'completed', { applicable: false, reason: 'email_reads_nothing', samples: counts?.samples ?? 0, matched: counts?.matched ?? 0 }, null);
      stage = 'reconcile';
      await record(ctx, connectionId, current.id, 'reconcile', 'completed', { dropped: [], rounds: 0, described: true }, null);
      stage = 'conform';
      await toProbing(deps.services, ctx, await deps.services.call(getConnection, { params: { connectionId } }, ctx));
      await record(ctx, connectionId, current.id, 'conform', 'completed', { applicable: false, reason: 'email_reads_nothing' }, null);
      stage = 'propose_mapping';
      const observed = current.manifest.objects.map((o) => asObserved(o, counts?.matched ?? 0,
        Object.fromEntries((counts?.fields ?? []).map((f) => [f.field, f.extracted]))));
      await record(ctx, connectionId, current.id, 'propose_mapping', 'completed', { proposals: proposeMapping(current.manifest.objects, observed) }, null);
    } catch (error) {
      const code = isAppError(error) ? error.code : 'build.internal';
      deps.logger.failure('a build stage failed', error, { event: 'build.stage_failed', resourceId: connectionId, outcome: stage });
      await record(ctx, connectionId, current.id, stage, 'failed', null, { code }).catch(() => undefined);
    }
    void connection;
  }

  async function view(ctx: Context | Call, connection: ConnectionView): Promise<BuildView> {
    const [rows, version] = await Promise.all([
      rowsOf(ctx, connection.id),
      deps.services.call(getManifestVersion, { params: { connectorId: connection.connectorId, versionId: connection.manifestId } }, call(ctx)),
    ]);
    const last = rows.at(-1);
    const latest = (stage: BuildStage) => [...rows].reverse().find((r) => r.stage === stage && r.status === 'completed');
    const proposals = mappingProposal.array().safeParse((latest('propose_mapping')?.findings as { proposals?: unknown } | null)?.proposals);
    const conform = [...rows].reverse().find((r) => r.stage === 'conform')?.findings as { runId?: string } | null | undefined;
    const fresh = (r: ProbeRun) => r.status === 'running' && Date.now() - Date.parse(r.startedAt) < STALE_MS;
    return {
      connectorId: connection.connectorId, connectionId: connection.id, connectionStatus: connection.status,
      manifest: { id: version.id, version: version.version },
      stage: last?.stage ?? 'parse', status: last?.status ?? 'running',
      running: running.has(connection.id) || rows.some(fresh),
      stages: rows.map((r) => {
        const { documentation: _documentation, ...findings } = (r.findings ?? {}) as Record<string, unknown>;
        return {
          stage: r.stage, status: r.status, startedAt: r.startedAt, completedAt: r.completedAt,
          findings: (r.findings === null ? null : findings) as never, errors: (r.errors ?? null) as never,
        };
      }),
      proposals: proposals.success ? proposals.data : [],
      conformanceRunId: conform?.runId ?? null,
    };
  }

  async function load(ctx: Context, connectionId: string, reader: 'member' | 'member_or_principal' = 'member'): Promise<ConnectionView> {
    // An AI FDE's Integration principal reads, drafts and probes a build (51.4); confirming stays a person's.
    if (reader === 'member' || ctx.request.servicePrincipalId === undefined) member(ctx);
    const connection = await deps.services.call(getConnection, { params: { connectionId } }, call(ctx));
    await mayBuild(ctx, connection);
    return connection;
  }

  /**
   * The document an address stands for (16.3): a URL's, recognised as what it is; or, for a base
   * URL alone, the first service description at one of its well-known addresses. A document
   * given as such is itself.
   */
  async function resolveDocumentation(ctx: Context, given: Documentation, baseUrl: string | undefined)
    : Promise<{ documentation: Exclude<Documentation, { kind: 'url' | 'base_url' }>; fetched?: { input: 'url' | 'base_url'; url: string; truncated: boolean } }> {
    if (given.kind !== 'url' && given.kind !== 'base_url') return { documentation: given };
    const read = (url: string) => deps.services.call(fetchDocument, { body: { url } }, call(ctx));
    if (given.kind === 'url') {
      const got = await read(given.url);
      if (got.outcome === 'absent') {
        throw new AppError('validation', 'nothing Silo can read is at that address', { code: 'build.document_absent', details: { stage: 'parse', status: got.status } });
      }
      const recognised = recognise(got.text, got.contentType, got.url);
      return { documentation: recognised.documentation, fetched: { input: 'url', url: got.url, truncated: recognised.truncated } };
    }
    if (baseUrl === undefined) throw new AppError('validation', 'a base URL alone needs the base URL', { code: 'build.base_url_required', details: { stage: 'parse' } });
    for (const path of WELL_KNOWN) {
      const url = path.startsWith('?') ? `${baseUrl.replace(/\/$/, '')}${path}` : `${baseUrl.replace(/\/$/, '')}${path}`;
      const got = await read(url).catch(() => undefined);
      if (got === undefined || got.outcome === 'absent') continue;
      const recognised = recognise(got.text, got.contentType, got.url);
      if (isDescription(recognised.documentation)) return { documentation: recognised.documentation, fetched: { input: 'base_url', url: got.url, truncated: false } };
    }
    throw new AppError('validation', 'the system publishes no description at its usual addresses: give its specification or documentation', {
      code: 'build.parse_no_description', details: { stage: 'parse', tried: WELL_KNOWN.length },
    });
  }

  return {
    async draft(ctx: Context, input: {
      name: string; slug: string; provider: string; documentation: Documentation; baseUrl?: string | undefined; sandbox: SandboxSpec;
    }): Promise<BuildView> {
      builder(ctx);
      // Enterprise only (D76): refused before any model call is made or charged.
      requireBuilder(await inTransaction(control, ctx.request, (db) => planGates(db, ctx.request.organisationId!), { readOnly: true }), 'ai');
      const key = ctx.idempotencyKey!;
      // An address (16.3 inputs 1 to 3) becomes the document found there.
      const { documentation, fetched } = await resolveDocumentation(ctx, input.documentation, input.baseUrl);
      // Parse.
      let draft: Draft | undefined;
      let emailCounts: EmailDraftCounts | undefined;
      let notes: string[] = [];
      let document: { objects: unknown[] } & Record<string, unknown>;
      const model = documentation.kind === 'text';
      if (isDescribed(documentation)) {
        // A typed description: compiled as the visual builder imports it, with no model (spec 14.4's discovery models).
        const identity = { name: input.name, provider: input.provider };
        const d = documentation;
        const imported = d.kind === 'email' ? draftFromNotifications(d.samples, identity)
          : d.kind === 'wsdl' ? importWsdl(d.text, identity)
            : d.kind === 'odata' ? importOdataMetadata(d.text, identity, input.baseUrl) : importGraphql(d.text, identity, input.baseUrl);
        document = { ...imported.document, identity: { ...imported.document.identity, version: RELEASE } } as never;
        notes = imported.notes;
        if ('counts' in imported) emailCounts = imported.counts as EmailDraftCounts;
      } else {
        if (documentation.kind === 'openapi') {
          ({ draft, notes } = draftFromOpenApi(parseOpenApi(documentation.text)));
        } else {
          draft = (await draftFromText(deps.services, call(ctx), input.name, documentation)).draft;
        }
        const compiled = compileDraft(draft!, { name: input.name, provider: input.provider, version: RELEASE }, input.baseUrl);
        notes = [...notes, ...compiled.notes.map((n) => `${n.object}:${n.note}`)];
        document = compiled.document as never;
      }
      if (document.objects.length === 0) {
        throw new AppError('validation', 'the documentation gave no object Silo could draft', {
          code: 'build.parse_no_objects', details: { stage: 'parse', notes: notes.join(';').slice(0, 500) },
        });
      }
      const { manifest, issues } = fullIssues(document);
      if (manifest === undefined) {
        throw new ContractViolation('the drafted connector is not a valid manifest', 'build.parse_invalid',
          issues.slice(0, 50).map((i) => ({ path: i.path, code: i.code, message: i.message })));
      }
      const connector = await deps.services.call(createConnector, {
        body: { slug: input.slug, name: input.name, provider: input.provider, sourceRoute: 'ai' },
      }, { ...call(ctx), idempotencyKey: derivedKey(key, 'connector') });
      const saved = await saveVersion(deps.services, call(ctx), connector.id, manifest, key, 'draft');
      // Spec 16.3: generation is metered; a connector drafted without a model call is not generated.
      let charged = false;
      if (model) {
        const outcome = await deps.services.call(charge, {
          body: { operation: 'connector_generation', correlationId: connector.id, connectorManifestId: saved.id },
        }, { ...call(ctx), idempotencyKey: derivedKey(key, 'charge') });
        charged = outcome.charged;
      }
      const sandbox = await sandboxOn(deps.services, call(ctx), connector.id, saved.id, key, { create: input.sandbox });
      const findings: ParseFindings = {
        source: documentation.kind, model, charged, objects: manifest.objects.length,
        fields: manifest.objects.reduce((n, o) => n + o.fields.length, 0), notes: notes.slice(0, 100),
        ...(draft === undefined ? { described: true as const } : { draft }), ...(emailCounts === undefined ? {} : { email: emailCounts }),
        ...(documentation.kind === 'text' ? { documentation: { title: documentation.title, text: documentation.text } } : {}),
        ...(fetched === undefined ? {} : { fetched }),
      };
      await record(ctx, sandbox.id, saved.id, 'parse', 'completed', findings, null);
      await inTransaction(control, ctx.request, (db) => recordConnectEvent(db, {
        organisationId: ctx.request.organisationId!, correlationId: ctx.correlationId, event: 'connector_build_started',
        membershipId: ctx.request.membershipId ?? null, servicePrincipalId: ctx.request.servicePrincipalId ?? null, resourceType: 'connector', resourceId: connector.id,
        detail: { connection_id: sandbox.id, source: documentation.kind, objects: manifest.objects.length, charged },
      }));
      return view(ctx, sandbox);
    },

    async probe(ctx: Context, connectionId: string): Promise<BuildView> {
      const connection = await load(ctx, connectionId, 'member_or_principal');
      const rows = await rowsOf(ctx, connectionId);
      parseOf(rows);
      if (running.has(connectionId) || rows.some((r) => r.status === 'running' && Date.now() - Date.parse(r.startedAt) < STALE_MS)) {
        throw new AppError('conflict', 'this build is already being probed', { code: 'build.running' });
      }
      const abort = new AbortController();
      const done = pipeline(call(ctx), connectionId, ctx.idempotencyKey!, abort.signal)
        .catch((error: unknown) => deps.logger.failure('a build failed', error, { event: 'build.failed', resourceId: connectionId }))
        .finally(() => running.delete(connectionId));
      running.set(connectionId, { abort, done });
      return view(ctx, connection);
    },

    async get(ctx: Context, connectionId: string): Promise<BuildView> {
      return view(ctx, await load(ctx, connectionId, 'member_or_principal'));
    },

    async preview(ctx: Context, connectionId: string, object: string, limit: number) {
      await load(ctx, connectionId);
      const out = await deps.services.call(readObject, { body: { connectionId, reason: 'probe', step: { object, limit } } }, call(ctx));
      return { rows: out.rows };
    },

    async confirm(ctx: Context, connectionId: string, decisions: {
      object: string; accept: boolean; objectType?: string | undefined; identifier?: string[] | undefined;
      properties?: { field: string; property: string }[] | undefined;
    }[]): Promise<BuildView> {
      const membershipId = member(ctx);
      let connection = await load(ctx, connectionId);
      const rows = await rowsOf(ctx, connectionId);
      const proposed = [...rows].reverse().find((r) => r.stage === 'propose_mapping' && r.status === 'completed');
      const proposals = mappingProposal.array().safeParse((proposed?.findings as { proposals?: unknown } | null)?.proposals);
      if (!proposals.success) throw new AppError('conflict', 'nothing is proposed yet: probe the build first', { code: 'build.not_ready' });
      const byObject = new Map<string, MappingProposal>(proposals.data.map((p) => [p.object, p]));
      for (const d of decisions) {
        const p = byObject.get(d.object);
        if (p === undefined) throw new AppError('validation', `${d.object} was not proposed`, { code: 'build.object_unknown' });
        const fields = new Set(p.properties.map((x) => x.field));
        for (const f of [...(d.identifier ?? []), ...(d.properties ?? []).map((x) => x.field)]) {
          if (!fields.has(f)) throw new AppError('validation', `${d.object} has no field ${f}`, { code: 'build.field_unknown' });
        }
      }
      const accepted = decisions.filter((d) => d.accept);
      const confirmed = accepted.map((d) => {
        const p = byObject.get(d.object)!;
        const corrected = d.objectType !== undefined || d.identifier !== undefined || d.properties !== undefined;
        const properties = new Map(p.properties.map((x) => [x.field, x.property]));
        for (const x of d.properties ?? []) properties.set(x.field, x.property);
        return {
          object: d.object, objectType: d.objectType ?? p.objectType, identifier: d.identifier ?? p.identifier, corrected,
          properties: [...properties].map(([field, property]) => ({ field, property })),
        };
      });
      await inTransaction(control, ctx.request, async (db) => {
        await probeRunRepo.insert(db, {
          id: uuidv7(), organisationId: ctx.request.organisationId!, connectionId, manifestId: connection.manifestId, stage: 'confirm',
          status: 'completed', completedAt: new Date().toISOString(),
          findings: { confirmed, rejected: decisions.filter((d) => !d.accept).map((d) => d.object), by: membershipId } as never,
        });
        // Spec 16.6: the event a reviewer reads first, naming who decided an object is a type.
        for (const c of confirmed) {
          await recordConnectEvent(db, {
            organisationId: ctx.request.organisationId!, correlationId: ctx.correlationId, event: 'mapping_confirmed', membershipId,
            resourceType: 'connection', resourceId: connectionId,
            detail: { object: c.object, object_type: c.objectType.slice(0, 200), corrected: c.corrected, properties: c.properties.length },
          });
        }
      });
      // Verify: confirmed by the registry under connector.verify, private tier, writes off.
      if (connection.status === 'probing') {
        try {
          connection = await deps.services.call(changeConnectionStatus, {
            params: { connectionId }, body: { move: 'confirm', version: connection.version },
          }, call(ctx));
          await record(ctx, connectionId, connection.manifestId, 'verify', 'completed', { status: connection.status, tier: connection.trustTier, writes: connection.writesEnabled }, null);
        } catch (error) {
          if (!isAppError(error)) throw error;
          await record(ctx, connectionId, connection.manifestId, 'verify', 'failed', null, { code: error.code });
        }
      }
      return view(ctx, connection);
    },

    async close(): Promise<void> {
      for (const job of running.values()) job.abort.abort();
      await Promise.allSettled([...running.values()].map((j) => j.done));
    },
  };
}

export type ConnectorBuilder = ReturnType<typeof createConnectorBuilder>;
