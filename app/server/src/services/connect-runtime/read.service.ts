// connect-runtime's read (catalogue: connect-runtime; spec 14.5): one plan step against one
// source object, through the protocol engine the manifest names.
//
// 1. The connection must serve the reason: a query needs an active connection; a probe may
//    run while it is being built. A halted or revoked connection serves nothing.
// 2. The pushdown compiler splits the step: the source computes what the manifest declares;
//    the rest is computed here after, over rows the step's bound already limits.
// 3. Bounds refuse, never truncate: rows per source step, pages per read, wall time.
// The first read of a manifest version freezes it (spec 14.3: immutable once used).
// Pushdown that failed the latest conformance run on the version is computed after the
// source instead (spec 17.2), except for conformance itself, which retests what is declared.

import type { KeyObject } from 'node:crypto';
import type { EgressResponse, PreparedRequest } from '../../contracts/credential/connectionCredential.contract.ts';
import { sendAuthorisedRequest, sendSftpRequest } from '../../contracts/credential/connectionCredential.contract.ts';
import { gateOf } from '../../contracts/conformance/conformance.contract.ts';
import { manifestSchema, type ManifestField } from '../../contracts/connect/manifest.contract.ts';
import { parametersOf } from '../../contracts/connect/parameters.contract.ts';
import type { PlanStep, PushdownSplit } from '../../contracts/connect/step.contract.ts';
import { refreshConnectionToken } from '../../contracts/oauth/oauth.contract.ts';
import type { ExecutorBounds } from '../../config/limits.config.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { conformanceRunRepo, connectionRepo, connectorManifestRepo, industrialEndpointRepo } from '../../repos/connect/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { markUntrusted } from './industrialProbe.service.ts';
import { objectOf, splitPushdown, withoutFailing } from '../pushdown-compiler/compile.service.ts';
import { withLogin, type AgentChannel } from './agent.service.ts';
import type { SiloStoreChannel } from './siloStore.service.ts';
import { applyResidual, filesFor, SourceError, type ReadContext, type ReadStats, type Row } from './engine.service.ts';
import { ENGINES } from './protocols/index.protocol.ts';

export interface RuntimeDeps {
  databases: Databases;
  services: ServiceClient;
  agent: AgentChannel;
  siloStore: SiloStoreChannel;
  bounds: Pick<ExecutorBounds, 'maxRowsPerSourceStep' | 'wallTimeMs'>;
  /** The key execution grants are checked against before a write leaves the cell (spec 10.4). */
  grantKey?: KeyObject | undefined;
}

export interface ReadInput {
  connectionId: string;
  reason: 'query' | 'probe' | 'change_stream';
  step: PlanStep;
  /** Conformance's error class: wrong values in place of every credential, and no refresh. */
  invalidCredentials?: true | undefined;
  /** Conformance: every declared pushdown, including what failed before. */
  declaredPushdown?: true | undefined;
  /** Conformance's sandbox: another version of the connection's connector, not yet applied. */
  manifestId?: string | undefined;
  /** Field profiles only (spec 22.3): values as the source sent them, not coerced to their declared types. */
  rawValues?: true | undefined;
}

export interface ReadOutput {
  rows: Row[];
  pushdown: PushdownSplit;
  stats: ReadStats;
  /** The object's declared fields. */
  fields: ManifestField[];
  /** The version of the connector the read ran. */
  connectorVersion: string;
  /** The Import Silo whose store holds the records (66.5); null for a customer system. */
  siloId: string | null;
}

export interface Caller {
  request: RequestContext;
  correlationId: string;
  signal: AbortSignal;
}

/** The fields the source must return: those asked for, and those the residual part reads. */
function neededFields(all: readonly ManifestField[], step: PlanStep, split: PushdownSplit): ManifestField[] {
  if (step.fields === undefined && step.aggregate === undefined) return [...all];
  const names = new Set<string>(step.aggregate === undefined ? step.fields ?? [] : []);
  for (const f of split.residual.filters) names.add(f.field);
  for (const s of split.residual.sort) names.add(s.field);
  for (const g of split.residual.aggregate?.groupBy ?? []) names.add(g);
  for (const m of split.residual.aggregate?.measures ?? []) if (m.field !== undefined) names.add(m.field);
  const picked = all.filter((f) => names.has(f.name));
  return picked.length > 0 ? picked : [all[0]!];
}

export async function readObject(deps: RuntimeDeps, caller: Caller, input: ReadInput): Promise<ReadOutput> {
  const control = deps.databases.pool('control');
  const { connection, manifestRow, conformed, industrial } = await inTransaction(control, caller.request, async (db) => {
    const connection = await connectionRepo.findById(db, input.connectionId);
    if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
    const manifestId = input.manifestId ?? connection.manifestId;
    return {
      connection,
      // An industrial connection's broker or server (20.7), where it has one.
      industrial: await industrialEndpointRepo.activeForConnection(db, connection.id),
      manifestRow: await connectorManifestRepo.findById(db, manifestId),
      conformed: input.declaredPushdown === true ? undefined : await conformanceRunRepo.latestCompleted(db, connection.id, manifestId),
    };
  }, { readOnly: true });
  if (!manifestRow) throw new AppError('integrity', 'the connection names a missing manifest', { code: 'connection.manifest_missing' });
  if (manifestRow.connectorId !== connection.connectorId) {
    throw new AppError('validation', 'a sandbox read uses a version of the connection\'s own connector', { code: 'read.sandbox_manifest_foreign' });
  }
  if (connection.status === 'revoked') throw new AppError('forbidden', 'the connection is revoked', { code: 'connection.revoked' });
  // A halted version serves nothing; a repair of it is tested in the sandbox before it is applied.
  const sandbox = input.manifestId !== undefined && input.manifestId !== connection.manifestId;
  if (connection.status === 'halted' && !sandbox) throw new AppError('forbidden', 'the connection is halted and serves nothing', { code: 'connection.halted' });
  if (input.reason !== 'probe' && connection.status !== 'active') {
    throw new AppError('conflict', `a ${connection.status} connection does not answer questions yet`, {
      code: 'connection.not_active', details: { status: connection.status },
    });
  }

  const declared = manifestSchema.parse(manifestRow.document);
  const manifest = conformed === undefined ? declared : withoutFailing(declared, gateOf(conformed).failingOperators);
  const object = objectOf(manifest, input.step.object);
  const split = splitPushdown(manifest, object, input.step);
  const options = { request: caller.request, correlationId: caller.correlationId };
  const params = parametersOf(connection.parameters);
  const invalid = input.invalidCredentials === true;

  const timeout = AbortSignal.timeout(deps.bounds.wallTimeMs);
  const ctx: ReadContext = {
    manifest,
    connection: { id: connection.id, organisationId: connection.organisationId, agentPoolId: connection.agentPoolId },
    params,
    now: new Date(),
    deadline: performance.now() + deps.bounds.wallTimeMs,
    signal: AbortSignal.any([caller.signal, timeout]),
    maxRows: deps.bounds.maxRowsPerSourceStep,
    send: (request: PreparedRequest): Promise<EgressResponse> => deps.services.call(sendAuthorisedRequest, {
      body: { connectionId: connection.id, reason: input.reason, request, ...(invalid ? { invalidCredentials: true as const } : {}) },
    }, { ...options, signal: caller.signal }),
    files: filesFor({
      manifest, connection: { id: connection.id, organisationId: connection.organisationId, agentPoolId: connection.agentPoolId, parameters: parametersOf(connection.parameters) },
      // The agent with the login this read may have sealed to it (SFTP through the agent).
      agent: withLogin(deps.agent, { reason: input.reason, request: caller.request, correlationId: caller.correlationId }), deadline: performance.now() + deps.bounds.wallTimeMs, signal: AbortSignal.any([caller.signal, timeout]),
      sftp: (operation) => deps.services.call(sendSftpRequest, {
        body: { connectionId: connection.id, reason: sftpReason(input.reason), operation },
      }, { ...options, signal: caller.signal }),
    }),
    industrial: industrial === undefined ? undefined : {
      id: industrial.id, plugin: industrial.plugin, endpointUrl: industrial.endpointUrl, securityPolicy: industrial.securityPolicy,
      appCertificatePem: industrial.appCertificatePem, serverCertificateThumbprint: industrial.serverCertificateThumbprint,
    },
    refresh: async () => {
      // A probe with wrong credentials must see the refusal, not a fresh token.
      if (invalid) throw new SourceError('auth', { reason: 'invalid_credentials_probe' });
      await deps.services.call(refreshConnectionToken, { body: { connectionId: connection.id } }, options);
    },
    agent: withLogin(deps.agent, { reason: input.reason, request: caller.request, correlationId: caller.correlationId }),
    siloStore: deps.siloStore,
    stats: { pages: 0, sourceRows: 0, typeMismatches: 0, retries: 0 },
  };

  const needed = neededFields(object.fields, input.step, split);
  // Read as json, a field's value is passed through as the source sent it.
  const fields = input.rawValues === true ? needed.map((f) => ({ ...f, type: 'json' as const })) : needed;
  let sourced: Awaited<ReturnType<(typeof ENGINES)[keyof typeof ENGINES]['read']>>;
  try {
    sourced = await ENGINES[manifest.protocol.kind].read(ctx, object, split.native, fields);
  } catch (error) {
    // The server stopped trusting the endpoint's application certificate (20.3): untrusted until verified again.
    if (industrial !== undefined && isAppError(error) && error.code === 'industrial.endpoint_untrusted') await markUntrusted(deps, caller, industrial);
    throw error;
  }
  let rows = applyResidual(sourced, split.residual);
  if (input.step.fields !== undefined && input.step.aggregate === undefined) {
    const keep = input.step.fields;
    rows = rows.map((row) => Object.fromEntries(keep.map((f) => [f, row[f] ?? null])));
  }
  if (manifestRow.firstUsedAt === null && manifestRow.organisationId !== null) {
    await inTransaction(control, caller.request, (db) => connectorManifestRepo.markFirstUsed(db, manifestRow.id));
  }
  return {
    rows, pushdown: split, stats: ctx.stats, fields: object.fields, connectorVersion: manifest.identity.version,
    siloId: manifest.transport.store?.siloId ?? null,
  };
}

/** A read's reason as the SFTP mediator records it: a read-back or a mutation never reads files. */
function sftpReason(reason: string): 'connect' | 'query' | 'probe' | 'change_stream' {
  return reason === 'connect' || reason === 'probe' || reason === 'change_stream' ? reason : 'query';
}
