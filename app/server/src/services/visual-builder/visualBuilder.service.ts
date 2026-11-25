// visual-builder (catalogue; spec 16.4): building a connector by hand, block by block.
//
// Checking and converting are pure (draft.service.ts). Trying a draft saves it as the next
// prerelease version, moves the sandbox connection to it and reads one object as a probe:
// the rows go back to the person and nowhere else, and the probe run is recorded as
// structure and counts (connect.probe_runs, stage probe). Publishing saves the release,
// moves the connection to it and to probing, and starts the conformance suite, after which
// a holder of connector.verify confirms it (spec 17.1).
//
// Decisions are the services' own: connect-registry for versions and connections
// (connector.build, connector.edit, connection.create, the owner or connection.manage),
// conformance for runs. A probe reads only through a connection the registry has just let
// this person move or create.

import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import { getConnection, setConnectionSecrets } from '../../contracts/connect-registry/connection.contract.ts';
import { getManifestVersion } from '../../contracts/connect-registry/connector.contract.ts';
import { getConformanceRun, startConformanceRun } from '../../contracts/conformance/conformance.contract.ts';
import type { Manifest } from '../../contracts/connect/manifest.contract.ts';
import type { BuildStep, DraftIssue, tryDraft } from '../../contracts/visual-builder/builder.contract.ts';
import type { CallOutput } from '../../contracts/endpoint.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { probeRunRepo } from '../../repos/connect/index.repo.ts';
import { AppError, ContractViolation, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import { fromYaml, fullIssues, stepIssues, toYaml } from './draft.service.ts';
import { importGraphql, importWsdl } from './import.service.ts';
import { importOdataMetadata } from './odataImport.service.ts';
import { derivedKey, isRelease, sandboxOn, saveVersion, toProbing, type SandboxSpec } from './versions.service.ts';

export interface VisualBuilderDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
}

type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'idempotencyKey'>;
type TryOutput = CallOutput<typeof tryDraft>;

/** A draft that is not a valid manifest: refused with every path at fault, nothing saved. */
function refuseInvalid(issues: readonly DraftIssue[]): never {
  throw new ContractViolation('the draft is not a valid manifest yet', 'visual.draft_invalid',
    issues.slice(0, 50).map((i) => ({ path: i.path, code: i.code, message: i.message })));
}

const member = (ctx: Context): string => {
  if (ctx.request.membershipId === undefined) throw new AppError('forbidden', 'connectors are built by a member', { code: 'visual.member_required' });
  return ctx.request.membershipId;
};

export function createVisualBuilder(deps: VisualBuilderDeps) {
  const control = deps.databases.pool('control');
  const call = (ctx: Context) => ({ request: ctx.request, correlationId: ctx.correlationId });

  /** One probe read of an object, recorded as a probe run; rows returned, never kept. */
  async function probe(ctx: Context, connectionId: string, manifestId: string, object: string, limit: number) {
    const membershipId = member(ctx);
    const organisationId = ctx.request.organisationId!;
    const probeRunId = uuidv7();
    await inTransaction(control, ctx.request, async (db) => {
      await probeRunRepo.insert(db, { id: probeRunId, organisationId, connectionId, manifestId, stage: 'probe', status: 'running' });
      await recordConnectEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: 'probe_started', membershipId, resourceType: 'connection', resourceId: connectionId,
        detail: { probe_run_id: probeRunId, route: 'visual' },
      });
    });
    let read: Awaited<ReturnType<typeof readOnce>> | undefined;
    let failure: { code: string; meaning: string | null } | null = null;
    try {
      read = await readOnce(ctx, connectionId, object, limit);
    } catch (error) {
      if (!isAppError(error)) throw error;
      failure = { code: error.code, meaning: typeof error.details['meaning'] === 'string' ? error.details['meaning'] : null };
    }
    await inTransaction(control, ctx.request, async (db) => {
      await probeRunRepo.update(db, probeRunId, {
        status: failure === null ? 'completed' : 'failed', completedAt: new Date().toISOString(),
        findings: (read === undefined ? { object, limit } : {
          object, limit, rows: read.rows.length, pages: read.stats.pages, typeMismatches: read.stats.typeMismatches,
          nativeFilters: read.pushdown.native.filters.length, residualFilters: read.pushdown.residual.filters.length,
        }) as never,
        errors: (failure === null ? null : { failure }) as never,
      });
      await recordConnectEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: failure === null ? 'probe_completed' : 'probe_failed', membershipId,
        resourceType: 'connection', resourceId: connectionId,
        detail: { probe_run_id: probeRunId, rows: read?.rows.length ?? 0, ...(failure === null ? {} : { code: failure.code.slice(0, 100) }) },
      });
    });
    return { probeRunId, read, failure };
  }

  const readOnce = (ctx: Context, connectionId: string, object: string, limit: number) => deps.services.call(readObject, {
    body: { connectionId, reason: 'probe', step: { object, limit } },
  }, call(ctx));

  function answer(manifest: { id: string; version: string }, connection: { id: string; status: string; version: number },
    result: Awaited<ReturnType<typeof probe>>): TryOutput {
    return {
      outcome: result.failure === null ? 'read' : 'refused', probeRunId: result.probeRunId,
      manifest, connection: { id: connection.id, status: connection.status, version: connection.version },
      rows: (result.read?.rows ?? []) as TryOutput['rows'], stats: result.read?.stats ?? null, pushdown: result.read?.pushdown ?? null,
      failure: result.failure,
    };
  }

  return {
    validate(_ctx: Context, input: { document: Record<string, unknown>; step?: BuildStep | undefined; object?: string | undefined }) {
      const full = fullIssues(input.document);
      const issues = input.step === undefined ? full.issues : stepIssues(input.document, input.step, input.object);
      return { complete: full.manifest !== undefined, valid: issues.length === 0, issues };
    },

    import(_ctx: Context, input: { kind: 'wsdl' | 'graphql' | 'odata'; text: string; name: string; provider: string; baseUrl?: string | undefined })
      : { document: Record<string, never>; notes: string[]; issues: DraftIssue[] } {
      const identity = { name: input.name, provider: input.provider };
      const { document, notes } = input.kind === 'wsdl' ? importWsdl(input.text, identity)
        : input.kind === 'odata' ? importOdataMetadata(input.text, identity, input.baseUrl) : importGraphql(input.text, identity, input.baseUrl);
      return { document: document as unknown as Record<string, never>, notes: notes.slice(0, 200).map((n) => n.slice(0, 300)), issues: fullIssues(document as never).issues };
    },

    convert(_ctx: Context, input: { to: 'yaml'; document: Record<string, unknown> } | { to: 'json'; yaml: string })
      : { document: Record<string, never> | null; yaml: string | null; issues: DraftIssue[] } {
      if (input.to === 'yaml') {
        return { document: input.document as Record<string, never>, yaml: toYaml(input.document), issues: fullIssues(input.document).issues };
      }
      const { document, issues } = fromYaml(input.yaml);
      return { document: document as Record<string, never> | null, yaml: input.yaml, issues };
    },

    async tryDraft(ctx: Context, input: {
      connectorId: string; document: Record<string, unknown>; connectionId?: string | undefined; connection?: SandboxSpec | undefined;
      object: string; limit: number;
    }): Promise<TryOutput> {
      member(ctx);
      const { manifest, issues } = fullIssues(input.document);
      if (manifest === undefined) refuseInvalid(issues);
      if (!manifest.objects.some((o) => o.name === input.object)) {
        throw new AppError('validation', `the draft has no object ${input.object}`, { code: 'visual.object_unknown' });
      }
      const key = ctx.idempotencyKey!;
      const saved = await saveVersion(deps.services, call(ctx), input.connectorId, manifest, key, 'draft');
      const connection = await sandboxOn(deps.services, call(ctx), input.connectorId, saved.id, key,
        input.connectionId !== undefined ? { connectionId: input.connectionId } : { create: input.connection! });
      const result = await probe(ctx, connection.id, saved.id, input.object, input.limit);
      return answer(saved, connection, result);
    },

    /** A retried try: the same version and connection, read again. */
    async replayTry(ctx: Context, probeRunId: string): Promise<TryOutput> {
      const run = await inTransaction(control, ctx.request, (db) => probeRunRepo.findById(db, probeRunId), { readOnly: true });
      if (!run) throw new AppError('not_found', 'no such try', { code: 'visual.try_not_found' });
      const findings = (run.findings ?? {}) as { object?: string; limit?: number };
      const connection = await deps.services.call(getConnection, { params: { connectionId: run.connectionId } }, call(ctx));
      const version = await deps.services.call(getManifestVersion, { params: { connectorId: connection.connectorId, versionId: run.manifestId } }, call(ctx));
      const result = await probe(ctx, connection.id, run.manifestId, findings.object ?? '', findings.limit ?? 10);
      return answer({ id: version.id, version: version.version }, connection, result);
    },

    async publish(ctx: Context, input: { connectorId: string; connectionId: string; document: Record<string, unknown> }) {
      member(ctx);
      const { manifest, issues } = fullIssues(input.document);
      if (manifest === undefined) refuseInvalid(issues);
      if (!isRelease(manifest.identity.version)) {
        throw new AppError('validation', 'publish a release version (major.minor.patch); drafts carry their own', { code: 'visual.release_version_required' });
      }
      const key = ctx.idempotencyKey!;
      const saved = await saveVersion(deps.services, call(ctx), input.connectorId, manifest as Manifest, key, 'release');
      const moved = await sandboxOn(deps.services, call(ctx), input.connectorId, saved.id, key, { connectionId: input.connectionId });
      const probing = await toProbing(deps.services, call(ctx), moved);
      const run = await deps.services.call(startConformanceRun, { body: { connectionId: probing.id, trigger: 'build' } },
        { ...call(ctx), idempotencyKey: derivedKey(key, 'conformance') });
      return {
        manifest: saved, connection: { id: probing.id, status: probing.status, version: probing.version }, conformanceRunId: run.id,
      };
    },

    /** A retried publish: the run it started, and where the connection stands. */
    async replayPublish(ctx: Context, conformanceRunId: string) {
      const run = await deps.services.call(getConformanceRun, { params: { runId: conformanceRunId } }, call(ctx));
      const connection = await deps.services.call(getConnection, { params: { connectionId: run.connectionId } }, call(ctx));
      const version = await deps.services.call(getManifestVersion, { params: { connectorId: connection.connectorId, versionId: run.manifestId } }, call(ctx));
      return {
        manifest: { id: version.id, version: version.version }, connection: { id: connection.id, status: connection.status, version: connection.version },
        conformanceRunId: run.id,
      };
    },

    async setSecrets(ctx: Context, connectionId: string, values: Record<string, string>) {
      member(ctx);
      return deps.services.call(setConnectionSecrets, { params: { connectionId }, body: { values } }, call(ctx));
    },
  };
}

export type VisualBuilder = ReturnType<typeof createVisualBuilder>;
