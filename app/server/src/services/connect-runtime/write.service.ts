// connect-runtime's write path (contracts/connect-runtime/write.contract.ts; spec 43.4 checks
// 4 to 6, 45.2, 45.3) and the record reads around it.
//
// Before anything is sent:
// - the connection is active and has earned writes (writes_enabled, spec 17.1); a halted or
//   revoked connection serves nothing. The conformance write class alone runs on a connection
//   being verified (sandbox), before writes are enabled;
// - the transport writes (REST, SQL); the object declares every operation; the plan fits the
//   manifest's write bound; the manifest's value check passes for every operation, or none
//   is sent; a physical connection's write rate limit holds (spec 47.5).
// Then the protocol's writer runs the plan: SQL in one transaction, REST operation by
// operation. The secret is placed by the credential service with the unwrap reason
// mutation (probe in the sandbox); record reads use mutation or read_back.
//
// A write through the Silo Agent (SQL) runs only on an execution grant actions signed for
// exactly its statements (spec 10.4): prepareWrites says what they hash to, and the grant is
// checked here before it leaves the cell, then again by the agent.

import { soapWrite } from './protocols/soap/write.protocol.ts';
import { odataWrite } from './protocols/odata/write.protocol.ts';
import { graphqlWrite } from './protocols/graphql/write.protocol.ts';
import type { EgressResponse, PreparedRequest } from '../../contracts/credential/connectionCredential.contract.ts';
import { sendAuthorisedRequest } from '../../contracts/credential/connectionCredential.contract.ts';
import type { WriteOperation, WriteResult } from '../../contracts/connect-runtime/write.contract.ts';
import { manifestSchema, type Manifest, type ManifestObject } from '../../contracts/connect/manifest.contract.ts';
import { parametersOf } from '../../contracts/connect/parameters.contract.ts';
import type { PlanStep } from '../../contracts/connect/step.contract.ts';
import { refreshConnectionToken } from '../../contracts/oauth/oauth.contract.ts';
import type { ServiceName } from '../../config/service.config.ts';
import { inTransaction, type RequestContext } from '../../infra/postgres.infra.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import { connectionRepo, connectorManifestRepo, industrialEndpointRepo } from '../../repos/connect/index.repo.ts';
import { opcuaCall, opcuaCallStatements, opcuaStatements, opcuaWrite } from './protocols/opcua/write.protocol.ts';
import { mqttPublish, mqttStatements } from './protocols/mqtt/publish.protocol.ts';
import { AppError } from '../../utils/errors.util.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';
import { objectOf, splitPushdown } from '../pushdown-compiler/compile.service.ts';
import { RowCountMismatch, SourceSqlError, withLogin } from './agent.service.ts';
import { applyResidual, classify, SourceError, type ReadContext, type Row } from './engine.service.ts';
import { ENGINES } from './protocols/index.protocol.ts';
import { restWrite } from './protocols/rest/write.protocol.ts';
import { isDialect } from './protocols/sql/checks.protocol.ts';
import { sqlStandard } from './protocols/sql/sql.protocol.ts';
import { writeStatement } from './protocols/sql/write.protocol.ts';
import type { RuntimeDeps } from './read.service.ts';
import type { SignedExecutionGrant } from '../../contracts/actions/grant.contract.ts';
import { statementsDigest, verifyExecutionGrant } from '../actions/grants.service.ts';

interface Caller {
  caller: ServiceName;
  request: RequestContext;
  correlationId: string;
  signal: AbortSignal;
}

type Reason = 'mutation' | 'read_back' | 'probe';

const MANIFEST_OP = { create: 'create', update_full: 'updateFull', update_partial: 'update', delete: 'delete', upsert: 'upsert', custom: 'custom' } as const;

async function load(deps: RuntimeDeps, caller: Caller, connectionId: string, sandbox: boolean)
  : Promise<{ connection: Connection; manifest: Manifest; manifestRowId: string; firstUsed: boolean }> {
  if (sandbox && caller.caller !== 'conformance') {
    throw new AppError('forbidden', 'only the conformance write class writes before writes are enabled', { code: 'write.sandbox_refused' });
  }
  const { connection, row } = await inTransaction(deps.databases.pool('control'), caller.request, async (db) => {
    const connection = await connectionRepo.findById(db, connectionId);
    if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
    return { connection, row: await connectorManifestRepo.findById(db, connection.manifestId) };
  }, { readOnly: true });
  if (!row) throw new AppError('integrity', 'the connection names a missing manifest', { code: 'connection.manifest_missing' });
  if (connection.status === 'revoked') throw new AppError('forbidden', 'the connection is revoked', { code: 'connection.revoked' });
  if (connection.status === 'halted') throw new AppError('forbidden', 'the connection is halted and serves nothing', { code: 'connection.halted' });
  if (sandbox ? connection.status === 'draft' : connection.status !== 'active') {
    throw new AppError('conflict', `a ${connection.status} connection does not take writes`, { code: 'connection.not_active', details: { status: connection.status } });
  }
  return { connection, manifest: manifestSchema.parse(row.document), manifestRowId: row.id, firstUsed: row.firstUsedAt !== null || row.organisationId === null };
}

/** An industrial connection's active broker or server (20.7), as a read reaches it. */
async function withIndustrial(deps: RuntimeDeps, caller: Caller, connection: Connection, manifest: Manifest, ctx: ReadContext): Promise<ReadContext> {
  if (manifest.protocol.kind !== 'opc_ua' && manifest.protocol.kind !== 'mqtt') return ctx;
  const endpoint = await inTransaction(deps.databases.pool('control'), caller.request, (db) => industrialEndpointRepo.activeForConnection(db, connection.id), { readOnly: true });
  ctx.industrial = endpoint === undefined ? undefined : {
    id: endpoint.id, plugin: endpoint.plugin, endpointUrl: endpoint.endpointUrl, securityPolicy: endpoint.securityPolicy,
    appCertificatePem: endpoint.appCertificatePem, serverCertificateThumbprint: endpoint.serverCertificateThumbprint,
  };
  return ctx;
}

function contextFor(deps: RuntimeDeps, caller: Caller, connection: Connection, manifest: Manifest, reason: Reason): ReadContext {
  const options = { request: caller.request, correlationId: caller.correlationId };
  const timeout = AbortSignal.timeout(deps.bounds.wallTimeMs);
  return {
    manifest,
    connection: { id: connection.id, organisationId: connection.organisationId, agentPoolId: connection.agentPoolId },
    params: parametersOf(connection.parameters),
    now: new Date(),
    deadline: performance.now() + deps.bounds.wallTimeMs,
    signal: AbortSignal.any([caller.signal, timeout]),
    maxRows: deps.bounds.maxRowsPerSourceStep,
    send: (request: PreparedRequest): Promise<EgressResponse> => deps.services.call(sendAuthorisedRequest, {
      body: { connectionId: connection.id, reason, request },
    }, { ...options, signal: caller.signal }),
    files: () => Promise.reject(new AppError('validation', 'files are read, never written, in this release', { code: 'sftp.not_writable' })),
    refresh: async () => {
      await deps.services.call(refreshConnectionToken, { body: { connectionId: connection.id } }, options);
    },
    agent: withLogin(deps.agent, { reason: reason, request: caller.request, correlationId: caller.correlationId }),
    siloStore: deps.siloStore,
    stats: { pages: 0, sourceRows: 0, typeMismatches: 0, retries: 0 },
  };
}

function singleIdentifier(object: ManifestObject): string {
  if (object.identifier.length !== 1) {
    throw new AppError('validation', 'records with a composite identifier are not written yet', { code: 'write.composite_identifier' });
  }
  return object.identifier[0]!;
}

// ----------------------------------------------------------------------------- physical rate

const physicalWindows = new Map<string, { windowStart: number; count: number }>();

/** A physical connection's writes per minute (spec 47.5), counted in this process. */
function chargePhysical(connection: Connection, writes: number): void {
  const limit = connection.maxPhysicalWritesPerMinute;
  if (limit === null) return;
  const now = Date.now();
  const window = physicalWindows.get(connection.id);
  const current = window === undefined || now - window.windowStart >= 60_000 ? { windowStart: now, count: 0 } : window;
  if (current.count + writes > limit) {
    throw new AppError('rate_limited', 'the connection\'s physical write rate is reached', {
      code: 'write.physical_rate', details: { bound: 'max_physical_writes_per_minute', limit }, retryAfterSeconds: Math.ceil((current.windowStart + 60_000 - now) / 1000),
    });
  }
  current.count += writes;
  physicalWindows.set(connection.id, current);
}

// ----------------------------------------------------------------------------- reads

export async function readRecords(deps: RuntimeDeps, caller: Caller, input: {
  connectionId: string; object: string; identifiers: string[]; fields: string[]; reason: 'mutation' | 'read_back'; sandbox?: true | undefined;
}): Promise<{ records: { identifier: string; values: Row | null }[]; connectorVersion: string }> {
  const sandbox = input.sandbox === true;
  const { connection, manifest } = await load(deps, caller, input.connectionId, sandbox);
  const object = objectOf(manifest, input.object);
  const idField = singleIdentifier(object);
  const fields = [...new Set([idField, ...input.fields])];
  const declared = object.pushdown.filters.find((f) => f.field === idField)?.ops ?? [];
  const identifiers = [...new Set(input.identifiers)];
  const steps: PlanStep[] = declared.includes('in') && identifiers.length > 1
    ? [{ object: object.name, fields, filters: [{ field: idField, op: 'in', value: identifiers }], sort: [] }]
    : declared.includes('eq')
      ? identifiers.map((id) => ({ object: object.name, fields, filters: [{ field: idField, op: 'eq' as const, value: id }], sort: [] }))
      : [{ object: object.name, fields, filters: [{ field: idField, op: 'in', value: identifiers }], sort: [] }];
  const ctx = await withIndustrial(deps, caller, connection, manifest, contextFor(deps, caller, connection, manifest, sandbox ? 'probe' : input.reason));
  const byId = new Map<string, Row>();
  for (const step of steps) {
    const split = splitPushdown(manifest, object, step);
    const rows = applyResidual(await ENGINES[manifest.protocol.kind].read(ctx, object, split.native, object.fields.filter((f) => fields.includes(f.name))), split.residual);
    for (const row of rows) {
      const key = row[idField];
      if (key === null || key === undefined) continue;
      byId.set(String(key), Object.fromEntries(fields.map((f) => [f, row[f] ?? null])));
    }
  }
  return {
    records: input.identifiers.map((identifier) => ({ identifier, values: byId.get(identifier) ?? null })),
    connectorVersion: manifest.identity.version,
  };
}

// ----------------------------------------------------------------------------- writes

export interface WriteInput {
  connectionId: string;
  object: string;
  operations: {
    key: string; operation: WriteOperation; identifier?: string | undefined; values: Record<string, unknown>; prior: Record<string, unknown> | null;
    customAction?: string | undefined;
  }[];
  sandbox?: true | undefined;
  grant?: SignedExecutionGrant | undefined;
  /** A physical Action's dry run (47.5). */
  dryRun?: true | undefined;
  /** The plan's moment (an MQTT command's payload is computed at it). */
  at?: string | undefined;
}

/** A physical plan of commands (47.1): custom actions on an OPC UA or MQTT connection, never mixed with setpoints. */
const commandsIn = (input: WriteInput) => input.operations.some((op) => op.operation === 'custom');

/** The checks every write passes before anything is sent. */
async function checked(deps: RuntimeDeps, caller: Caller, input: WriteInput) {
  const sandbox = input.sandbox === true;
  const { connection, manifest, manifestRowId, firstUsed } = await load(deps, caller, input.connectionId, sandbox);
  if (!sandbox && !connection.writesEnabled) {
    throw new AppError('forbidden', 'the connection has not earned writes: its write class has not passed (spec 17.1)', { code: 'write.not_enabled' });
  }
  if (manifest.transport.store !== undefined) {
    throw new AppError('forbidden', 'a Silo holds a copy: nothing is written to it (66.5)', { code: 'write.silo_read_only' });
  }
  const object = objectOf(manifest, input.object);
  const idField = singleIdentifier(object);
  if (object.writes === undefined) throw new AppError('validation', `the manifest declares no writes on ${object.name}`, { code: 'write.operation_undeclared' });
  for (const op of input.operations) {
    if (op.operation === 'custom') {
      // A custom action's values are its inputs, not the object's fields; it speaks the connection's protocol.
      const declared = object.writes.custom.find((c) => c.name === op.customAction);
      const kind = manifest.protocol.kind;
      if (declared === undefined || !(kind === 'rest' ? declared.request !== undefined : kind === 'opc_ua' ? declared.opcua !== undefined
        : kind === 'mqtt' && declared.mqtt !== undefined)) {
        throw new AppError('validation', `the manifest declares no custom action ${op.customAction ?? ''} on ${object.name}`, {
          code: 'write.operation_undeclared', details: { operation: 'custom' },
        });
      }
      continue;
    }
    if (object.writes[MANIFEST_OP[op.operation]] === undefined) {
      throw new AppError('validation', `the manifest declares no ${op.operation} on ${object.name}`, { code: 'write.operation_undeclared', details: { operation: op.operation } });
    }
    for (const field of Object.keys(op.values)) {
      if (!object.fields.some((f) => f.name === field)) throw new AppError('validation', 'the write names a field the object does not have', { code: 'write.field_unknown', details: { field } });
    }
    if (op.operation === 'update_full') {
      // The source replaces the record: a field left out would be cleared.
      const missing = object.fields.find((f) => f.name !== idField && !(f.name in op.values));
      if (missing !== undefined) {
        throw new AppError('validation', 'a full update sends every field of the record', { code: 'write.full_update_incomplete', details: { field: missing.name } });
      }
    }
    if (op.operation === 'upsert' && op.values[idField] !== undefined && op.values[idField] !== null && String(op.values[idField]) !== op.identifier) {
      throw new AppError('validation', 'an upsert\'s identifier and its identifier field agree', { code: 'write.identifier_mismatch' });
    }
  }
  if (commandsIn(input) && input.operations.some((op) => op.operation !== 'custom') && (manifest.protocol.kind === 'opc_ua' || manifest.protocol.kind === 'mqtt')) {
    throw new AppError('validation', 'a physical plan sends commands or writes setpoints, not both', { code: 'write.commands_mixed' });
  }
  if (input.operations.length > object.writes.bounds.maxRows) {
    throw new AppError('bounds', 'the plan writes more records than the manifest allows at once', {
      code: 'write.max_rows', details: { bound: 'writes.bounds.maxRows', limit: object.writes.bounds.maxRows },
    });
  }

  const ctx = await withIndustrial(deps, caller, connection, manifest, contextFor(deps, caller, connection, manifest, sandbox ? 'probe' : 'mutation'));
  return { connection, manifest, manifestRowId, firstUsed, object, writes: object.writes, idField, ctx };
}

/** A write through the Silo Agent: how many statements, and what their JSON hashes to, for its grant. */
export async function prepareWrites(deps: RuntimeDeps, caller: Caller, input: WriteInput)
  : Promise<{ grantRequired: boolean; statements?: number; payloadSha256?: string }> {
  const { connection, manifest, object, ctx } = await checked(deps, caller, input);
  if (manifest.protocol.kind === 'opc_ua' || manifest.protocol.kind === 'mqtt') {
    // Setpoints and commands through the agent (47.1): their statements, exactly as they are sent, are what the grant covers.
    const statements = await physicalStatements(ctx, connection, manifest, object, input);
    return { grantRequired: true, statements: statements.length, payloadSha256: statementsDigest(statements) };
  }
  if (manifest.protocol.kind !== 'sql') return { grantRequired: false };
  const { statements } = sqlStatements(ctx, object, input.operations);
  return { grantRequired: true, statements: statements.length, payloadSha256: statementsDigest(statements) };
}

export async function writeRecords(deps: RuntimeDeps, caller: Caller, input: WriteInput)
  : Promise<{ results: WriteResult[]; transactional: boolean; connectorVersion: string }> {
  const { connection, manifest, manifestRowId, firstUsed, object, writes, idField, ctx } = await checked(deps, caller, input);
  // The manifest's value check, over every operation, before anything is sent.
  const check = writes.bounds.valueCheck;
  if (check !== undefined) {
    const compiled = compileExpression('write.valueCheck', 'cel', check.cel);
    const failed = new Set<string>();
    for (const op of input.operations) {
      if (op.operation === 'delete' || op.operation === 'custom') continue;
      if (await compiled.evaluate({ values: op.values, prior: op.prior }, ctx.now) !== true) failed.add(op.key);
    }
    if (failed.size > 0) {
      return {
        results: input.operations.map((op) => failed.has(op.key)
          ? { key: op.key, outcome: 'failed' as const, identifier: op.identifier ?? null, error: { meaning: 'value_check' as const, code: 'write.value_check' } }
          : { key: op.key, outcome: 'not_attempted' as const, identifier: op.identifier ?? null, error: null }),
        transactional: manifest.protocol.kind === 'sql', connectorVersion: manifest.identity.version,
      };
    }
  }
  if (writes.risk === 'physical') chargePhysical(connection, input.operations.length);

  if (input.dryRun === true && manifest.protocol.kind !== 'opc_ua' && manifest.protocol.kind !== 'mqtt') {
    throw new AppError('validation', 'a dry run writes the simulator nodes of an OPC UA or MQTT connection (47.5)', { code: 'write.dry_run_unsupported' });
  }
  let results: WriteResult[];
  if (manifest.protocol.kind === 'opc_ua' || manifest.protocol.kind === 'mqtt') {
    // Checked here before it leaves the cell; the agent checks it again.
    const statements = await physicalStatements(ctx, connection, manifest, object, input);
    if (deps.grantKey !== undefined) {
      verifyExecutionGrant(deps.grantKey, input.grant, { organisationId: connection.organisationId, connectionId: connection.id, object: object.name, statements });
    }
    const dryRun = input.dryRun === true;
    results = manifest.protocol.kind === 'mqtt' ? await mqttPublish(ctx, connection, input.operations, statements as never, input.grant)
      : commandsIn(input) ? await opcuaCall(ctx, connection, object, input.operations, statements as never, input.grant)
        : await opcuaWrite(ctx, connection, object, input.operations, input.grant, dryRun);
  } else if (manifest.protocol.kind === 'odata') {
    results = await odataWrite(ctx, object, input.operations.map((op) => ({
      key: op.key, operation: op.operation, identifier: op.identifier, values: op.values, customAction: op.customAction,
    })));
  } else if (manifest.protocol.kind === 'soap') {
    results = await soapWrite(ctx, object, input.operations.map((op) => ({
      key: op.key, operation: op.operation, identifier: op.identifier, values: op.values, customAction: op.customAction,
    })));
  } else if (manifest.protocol.kind === 'graphql') {
    results = await graphqlWrite(ctx, object, input.operations.map((op) => ({
      key: op.key, operation: op.operation, identifier: op.identifier, values: op.values, customAction: op.customAction,
    })));
  } else if (manifest.protocol.kind === 'rest') {
    results = await restWrite(ctx, object, input.operations.map((op) => ({
      key: op.key, operation: op.operation, identifier: op.identifier, values: op.values, customAction: op.customAction,
    })));
  } else {
    results = await sqlPlan(deps, ctx, object, idField, input.operations, input.grant);
  }
  if (!firstUsed && results.some((r) => r.outcome === 'applied')) {
    await inTransaction(deps.databases.pool('control'), caller.request, (db) => connectorManifestRepo.markFirstUsed(db, manifestRowId));
  }
  return { results, transactional: manifest.protocol.kind === 'sql', connectorVersion: manifest.identity.version };
}

/** A physical plan's statements, as they are sent (47.1): setpoints or method calls on OPC UA, commands published on MQTT. */
async function physicalStatements(ctx: ReadContext, connection: Connection, manifest: Manifest, object: ManifestObject, input: WriteInput): Promise<unknown[]> {
  const dryRun = input.dryRun === true;
  const at = input.at === undefined ? ctx.now : new Date(input.at);
  if (manifest.protocol.kind === 'mqtt') return mqttStatements(ctx, connection, object, input.operations, { dryRun, at });
  return commandsIn(input) ? opcuaCallStatements(ctx, connection, object, input.operations, { dryRun, at }) : opcuaStatements(connection, object, input.operations, dryRun);
}

/** The plan's statements, as they are sent: updates and deletes carry the prior state Silo recorded as their guard (48.1). */
function sqlStatements(ctx: ReadContext, object: ManifestObject, operations: WriteInput['operations']) {
  if (ctx.manifest.protocol.kind !== 'sql' || !isDialect(ctx.manifest.protocol.dialect)) {
    throw new AppError('integrity', 'the manifest names no grammar of the SQL engine', { code: 'manifest.dialect_unknown' });
  }
  const dialect = ctx.manifest.protocol.dialect;
  const rendered = operations.map((op) => writeStatement(dialect, object, { operation: op.operation, identifier: op.identifier, values: op.values, prior: op.prior }));
  const statements = rendered.map((r) => ({ text: r.text, values: r.values, ...(r.expectRows === undefined ? {} : { expectRows: r.expectRows }) }));
  return { dialect, rendered, statements };
}

async function sqlPlan(deps: RuntimeDeps, ctx: ReadContext, object: ManifestObject, idField: string, operations: WriteInput['operations'],
  grant: SignedExecutionGrant | undefined): Promise<WriteResult[]> {
  const { dialect, rendered, statements } = sqlStatements(ctx, object, operations);
  if (ctx.connection.agentPoolId === null) throw new AppError('integrity', 'an agent connection has no agent pool', { code: 'connection.agent_pool_missing' });
  if (ctx.agent.transaction === undefined) {
    throw new AppError('source_unreachable', 'no Silo Agent of the connection\'s pool takes writes', { code: 'agent.unavailable' });
  }
  // Checked here before it leaves the cell; the agent checks it again.
  if (deps.grantKey !== undefined) {
    verifyExecutionGrant(deps.grantKey, grant, {
      organisationId: ctx.connection.organisationId, connectionId: ctx.connection.id, object: object.name, statements,
    });
  }
  const identifierOf = (op: WriteInput['operations'][number]): string | null =>
    op.operation === 'create' ? String(op.values[idField]) : op.identifier ?? null;
  try {
    await ctx.agent.transaction({
      organisationId: ctx.connection.organisationId, connectionId: ctx.connection.id, agentPoolId: ctx.connection.agentPoolId, dialect,
      statements, timeoutMs: Math.max(1, Math.floor(ctx.deadline - performance.now())), signal: ctx.signal, ...(grant === undefined ? {} : { grant }),
    });
    return operations.map((op) => ({ key: op.key, outcome: 'applied' as const, identifier: identifierOf(op), error: null }));
  } catch (error) {
    // The transaction rolled back: nothing of the plan applied.
    let meaning: NonNullable<WriteResult['error']>['meaning'] = 'upstream';
    let code: string | null = null;
    let at = -1;
    if (error instanceof RowCountMismatch) {
      at = error.index;
      // A guarded statement that matched nothing: the record is gone or no longer holds its prior state.
      const guarded = rendered[at]?.guarded === true && error.rows === 0;
      meaning = guarded ? 'conflict' : error.rows === 0 ? 'not_found' : 'row_count';
      if (guarded) code = 'write.prior_changed';
    } else if (error instanceof SourceSqlError) {
      meaning = (await classify(ctx.manifest, { status: 0, headers: {}, body: null, sqlstate: error.sqlstate }, sqlStandard, ctx.now))?.meaning ?? 'upstream';
    } else if (error instanceof SourceError) {
      meaning = error.meaning;
    } else {
      throw error;
    }
    return operations.map((op, i) => ({
      key: op.key, outcome: 'failed' as const, identifier: op.identifier ?? null,
      error: at === -1 || i === at ? { meaning, code: code ?? `write.${meaning}` } : { meaning: 'conflict' as const, code: 'write.rolled_back' },
    }));
  }
}
