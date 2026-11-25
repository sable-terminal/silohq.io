// schema-inference (catalogue; spec 14.6, 16.3): reads a connection's objects as probes
// through connect-runtime and infers their structure (infer.service.ts).
//
// Who may: the connection's owner, or a holder of connection.manage at its owning scope
// (spec 14.9), decided by the policy service. A probe needs no active connection: the
// runtime serves probes while a connection is being built.
//
// Each call is one probe run, recorded in connect.probe_runs (stage probe) with what was
// found as structure and counts, and the objects that could not be read by code and
// meaning. Records are read into this process, counted and dropped; none is kept, logged or
// returned. Audited: probe_started, then probe_completed or probe_failed.

import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import { manifestSchema, type Manifest } from '../../contracts/connect/manifest.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import {
  CATALOGUE_OBJECTS, type InferredObject, type InferredSchema, type ProbeFailure,
} from '../../contracts/schema-inference/inference.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import { connectionRepo, connectorManifestRepo, probeRunRepo } from '../../repos/connect/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import {
  findRecords, inferCatalogue, inferFields, inferIdentifier, inferRelationships, pagingHints, type CatalogueRows, type ObjectSample,
} from './infer.service.ts';
import { isRawCapture, RAW_FIELD } from './probeManifest.service.ts';

export interface SchemaInferenceDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
}

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

export interface InferInput {
  connectionId: string;
  objects?: string[] | undefined;
  sampleSize: number;
  schemas?: string[] | undefined;
}

export interface InferOutput {
  probeRunId: string;
  manifestId: string;
  schema: InferredSchema;
  failures: ProbeFailure[];
}

type Row = Record<string, unknown>;

const failureOf = (object: string, error: unknown): ProbeFailure => {
  if (!isAppError(error)) throw error;
  const meaning = typeof error.details['meaning'] === 'string' ? error.details['meaning'] : null;
  return { object, code: error.code, meaning };
};

export function createSchemaInference(deps: SchemaInferenceDeps) {
  const control = deps.databases.pool('control');

  async function mayProbe(ctx: Context, connection: Connection): Promise<void> {
    if (ctx.request.membershipId !== undefined && connection.owningMembershipId === ctx.request.membershipId) return;
    // An AI FDE's Integration principal probes the connections it drafted (51.4), under connector.build.
    const principal = ctx.request.servicePrincipalId !== undefined;
    if (principal && connection.createdByServicePrincipalId !== ctx.request.servicePrincipalId) {
      throw new AppError('forbidden', 'an AI FDE principal probes only the connections it drafted', { code: 'inference.not_permitted', details: { permission: 'connector.build' } });
    }
    const decision = await deps.services.call(authorise, {
      body: { permission: principal ? 'connector.build' : 'connection.manage', scopeId: connection.owningScopeId, resource: { type: 'connection', id: connection.id } },
    }, { request: ctx.request, correlationId: ctx.correlationId });
    if (decision.decision !== 'allow') {
      throw new AppError('forbidden', 'probing a connection is its owner\'s, or needs connection.manage where it is owned', {
        code: 'inference.not_permitted', details: { permission: 'connection.manage' },
      });
    }
  }

  const read = (ctx: Context, connectionId: string, step: Record<string, unknown>) => deps.services.call(readObject, {
    body: { connectionId, reason: 'probe', step: step as never },
  }, { request: ctx.request, correlationId: ctx.correlationId });

  async function records(ctx: Context, connection: Connection, manifest: Manifest, input: InferInput)
    : Promise<{ objects: InferredObject[]; failures: ProbeFailure[] }> {
    const wanted = input.objects ?? manifest.objects.map((o) => o.name);
    const failures: ProbeFailure[] = [];
    const samples: (ObjectSample & { inferred: InferredObject })[] = [];
    for (const name of wanted) {
      const object = manifest.objects.find((o) => o.name === name);
      if (object === undefined) {
        failures.push({ object: name, code: 'inference.object_unknown', meaning: null });
        continue;
      }
      let rows: Row[];
      let typeMismatches = 0;
      try {
        const out = await read(ctx, connection.id, { object: name, limit: input.sampleSize });
        rows = out.rows;
        typeMismatches = out.stats.typeMismatches;
      } catch (error) {
        failures.push(failureOf(name, error));
        continue;
      }
      if (isRawCapture(object)) {
        const found = findRecords(rows.map((r) => r[RAW_FIELD]));
        const sample = found.records.slice(0, input.sampleSize);
        const { fields, values } = inferFields(sample);
        const identifier = inferIdentifier(name, fields, sample.length);
        samples.push({
          name, identifier: identifier?.fields[0] ?? null, fields, values,
          inferred: {
            name, object: name, recordsPath: found.recordsPath, table: null, sampled: sample.length, identifier, fields, relationships: [],
            paging: pagingHints(found.envelope), declared: [], typeMismatches,
          },
        });
      } else {
        const { fields, values } = inferFields(rows);
        const identifier = inferIdentifier(name, fields, rows.length);
        const declared = object.fields.map((f) => ({
          field: f.name, sampled: rows.length, nulls: rows.filter((r) => r[f.name] === null || r[f.name] === undefined).length,
        }));
        samples.push({
          name, identifier: object.identifier.length === 1 ? object.identifier[0]! : identifier?.fields[0] ?? null, fields, values,
          inferred: {
            name, object: name, recordsPath: object.source.kind === 'rest' ? object.source.records.jsonata : null, table: null,
            sampled: rows.length, identifier, fields, relationships: [], paging: [], declared, typeMismatches,
          },
        });
      }
    }
    const relationships = inferRelationships(samples);
    // The values counted above go out of scope here; only structure and counts remain.
    return { objects: samples.map((s) => ({ ...s.inferred, relationships: relationships.get(s.name) ?? [] })), failures };
  }

  async function catalogue(ctx: Context, connection: Connection, manifest: Manifest, input: InferInput)
    : Promise<{ objects: InferredObject[]; failures: ProbeFailure[] }> {
    const missing = Object.values(CATALOGUE_OBJECTS).filter((name) => !manifest.objects.some((o) => o.name === name));
    if (missing.length > 0) {
      throw new AppError('validation', 'a catalogue probe needs the information_schema objects declared', {
        code: 'inference.catalogue_undeclared', details: { missing: missing.join(',') },
      });
    }
    const schemaFilter = (field: string) => (input.schemas === undefined
      ? [{ field, op: 'ne', value: 'information_schema' }]
      : [{ field, op: 'in', value: input.schemas }]);
    const rows: Partial<CatalogueRows> = {};
    const failures: ProbeFailure[] = [];
    for (const [key, object] of Object.entries(CATALOGUE_OBJECTS) as [keyof CatalogueRows, string][]) {
      try {
        const field = key === 'references' ? 'constraint_schema' : 'table_schema';
        rows[key] = (await read(ctx, connection.id, { object, filters: schemaFilter(field) })).rows;
      } catch (error) {
        failures.push(failureOf(object, error));
      }
    }
    if (failures.length > 0) return { objects: [], failures };
    return { objects: inferCatalogue(rows as CatalogueRows, new Set(['information_schema'])), failures };
  }

  return {
    async infer(ctx: Context, input: InferInput): Promise<InferOutput> {
      const membershipId = ctx.request.membershipId;
      if (membershipId === undefined && ctx.request.servicePrincipalId === undefined) {
        throw new AppError('forbidden', 'a probe is started by a member', { code: 'inference.member_required' });
      }
      const organisationId = ctx.request.organisationId!;
      const { connection, manifestRow } = await inTransaction(control, ctx.request, async (db) => {
        const connection = await connectionRepo.findById(db, input.connectionId);
        if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
        return { connection, manifestRow: await connectorManifestRepo.findById(db, connection.manifestId) };
      }, { readOnly: true });
      if (!manifestRow) throw new AppError('integrity', 'the connection names a missing manifest', { code: 'connection.manifest_missing' });
      await mayProbe(ctx, connection);
      const manifest = manifestSchema.parse(manifestRow.document);
      const mode = manifest.protocol.kind === 'sql' ? 'catalogue' as const : 'records' as const;

      const probeRunId = uuidv7();
      await inTransaction(control, ctx.request, async (db) => {
        await probeRunRepo.insert(db, {
          id: probeRunId, organisationId, connectionId: connection.id, manifestId: manifestRow.id, stage: 'probe', status: 'running',
        });
        await recordConnectEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'probe_started', membershipId, servicePrincipalId: ctx.request.servicePrincipalId, resourceType: 'connection',
          resourceId: connection.id, detail: { probe_run_id: probeRunId, mode },
        });
      });

      let result: { objects: InferredObject[]; failures: ProbeFailure[] };
      try {
        result = mode === 'catalogue' ? await catalogue(ctx, connection, manifest, input) : await records(ctx, connection, manifest, input);
      } catch (error) {
        const failure = failureOf('probe', error);
        await finish(ctx, probeRunId, connection.id, { mode, objects: [] }, [failure], membershipId);
        throw error;
      }
      const schema: InferredSchema = { mode, objects: result.objects };
      await finish(ctx, probeRunId, connection.id, schema, result.failures, membershipId);
      return { probeRunId, manifestId: manifestRow.id, schema, failures: result.failures };
    },
  };

  async function finish(ctx: Context, probeRunId: string, connectionId: string, schema: InferredSchema, failures: ProbeFailure[],
    membershipId: string | undefined): Promise<void> {
    const failed = schema.objects.length === 0 && failures.length > 0;
    await inTransaction(control, ctx.request, async (db) => {
      await probeRunRepo.update(db, probeRunId, {
        status: failed ? 'failed' : 'completed', completedAt: new Date().toISOString(),
        findings: schema as never, errors: (failures.length > 0 ? { failures } : null) as never,
      });
      await recordConnectEvent(db, {
        organisationId: ctx.request.organisationId!, correlationId: ctx.correlationId, event: failed ? 'probe_failed' : 'probe_completed',
        membershipId, servicePrincipalId: ctx.request.servicePrincipalId, resourceType: 'connection', resourceId: connectionId,
        detail: {
          probe_run_id: probeRunId, objects: schema.objects.length, failures: failures.length,
          fields: schema.objects.reduce((n, o) => n + o.fields.length, 0),
          ...(failures[0] === undefined ? {} : { first_failure: failures[0].code.slice(0, 100) }),
        },
      });
    });
    deps.logger.info('probe finished', {
      event: 'inference.probe_finished', resourceId: probeRunId, count: schema.objects.length, outcome: failed ? 'failed' : 'completed',
    });
  }
}

export type SchemaInference = ReturnType<typeof createSchemaInference>;
