// connect-runtime's structural observation (contracts/connect-runtime/observe.contract.ts):
// a bounded sample of one object read as a read would be, reduced to structure before it
// leaves. REST reads each record whole (a computed field `$`), so the paths the source sends
// are seen whether or not the manifest declares them; that is what drift detection and
// schema derivation need. Values are held in memory only for the counts.
//
// The connection must serve a probe: any status but halted and revoked.

import { withLogin } from './agent.service.ts';
import type { EgressResponse, PreparedRequest } from '../../contracts/credential/connectionCredential.contract.ts';
import { sendAuthorisedRequest, sendSftpRequest } from '../../contracts/credential/connectionCredential.contract.ts';
import {
  OBSERVE_DEPTH, OBSERVE_MAX_PATHS, OBSERVED_KINDS, type Observation, type ObservedField, type ObservedKind,
} from '../../contracts/connect-runtime/observe.contract.ts';
import { manifestSchema, type ManifestField } from '../../contracts/connect/manifest.contract.ts';
import { parametersOf } from '../../contracts/connect/parameters.contract.ts';
import { refreshConnectionToken } from '../../contracts/oauth/oauth.contract.ts';
import { inTransaction, type RequestContext } from '../../infra/postgres.infra.ts';
import { connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { filesFor, type ReadContext } from './engine.service.ts';
import { restEngine } from './protocols/rest/rest.protocol.ts';
import type { RuntimeDeps } from './read.service.ts';

interface Caller {
  request: RequestContext;
  correlationId: string;
  signal: AbortSignal;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
/** A key that cannot be a dot path segment is skipped: a manifest could not name it. */
const SEGMENT = /^[^.\s][^.]*$/;

/** The whole record, as one computed field: the structure is taken from it in this process. */
const RECORD: ManifestField = { name: 'record', type: 'json', nullable: true, value: { jsonata: '$' }, provenance: 'observed' };

interface Tally {
  present: number;
  nulls: number;
  kinds: Record<ObservedKind, number>;
  values: Set<string>;
  dateLike: number;
  dateTimeLike: number;
  numericStrings: number;
  lengths: number;
  strings: number;
}

const emptyKinds = (): Record<ObservedKind, number> => Object.fromEntries(OBSERVED_KINDS.map((k) => [k, 0])) as Record<ObservedKind, number>;

function kindOf(value: unknown): ObservedKind | undefined {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object' && value !== null) return 'object';
  return undefined;
}

/**
 * The structure of a sample of records: every path to depth OBSERVE_DEPTH (objects are
 * walked, arrays are leaves), with counts. Pure: values are compared by a hash and dropped.
 */
export function structureOf(records: readonly unknown[]): { fields: ObservedField[]; omittedPaths: number } {
  const tallies = new Map<string, Tally>();
  const tally = (path: string): Tally => {
    let t = tallies.get(path);
    if (t === undefined) {
      t = { present: 0, nulls: 0, kinds: emptyKinds(), values: new Set(), dateLike: 0, dateTimeLike: 0, numericStrings: 0, lengths: 0, strings: 0 };
      tallies.set(path, t);
    }
    return t;
  };
  const visit = (value: unknown, path: string, depth: number): void => {
    const t = tally(path);
    if (value === null) {
      t.nulls += 1;
      return;
    }
    const kind = kindOf(value);
    if (kind === undefined) return;
    t.present += 1;
    t.kinds[kind] += 1;
    t.values.add(sha256(canonicalJsonBytes(value as never)).toString('base64'));
    if (kind === 'string') {
      const s = value as string;
      t.strings += 1;
      t.lengths += s.length;
      if (DATE.test(s)) t.dateLike += 1;
      if (DATE_TIME.test(s)) t.dateTimeLike += 1;
      if (NUMERIC.test(s.trim())) t.numericStrings += 1;
    }
    if (kind === 'object' && depth < OBSERVE_DEPTH) walk(value as Record<string, unknown>, path, depth + 1);
  };
  const walk = (record: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const [key, value] of Object.entries(record)) {
      if (!SEGMENT.test(key)) continue;
      visit(value, prefix === '' ? key : `${prefix}.${key}`, depth);
    }
  };
  for (const record of records) {
    if (typeof record === 'object' && record !== null && !Array.isArray(record)) walk(record as Record<string, unknown>, '', 1);
  }
  const all = [...tallies.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const fields = all.slice(0, OBSERVE_MAX_PATHS).map(([path, t]): ObservedField => ({
    path, present: t.present, nulls: t.nulls, kinds: t.kinds, distinct: t.values.size, dateLike: t.dateLike, dateTimeLike: t.dateTimeLike,
    numericStrings: t.numericStrings, meanLength: t.strings === 0 ? null : Math.round((t.lengths / t.strings) * 10) / 10,
  }));
  for (const [, t] of all) t.values.clear();
  return { fields, omittedPaths: Math.max(0, all.length - OBSERVE_MAX_PATHS) };
}

export async function observeObject(deps: RuntimeDeps, caller: Caller, input: { connectionId: string; object: string; sampleRows: number })
  : Promise<Observation> {
  const control = deps.databases.pool('control');
  const { connection, manifestRow } = await inTransaction(control, caller.request, async (db) => {
    const connection = await connectionRepo.findById(db, input.connectionId);
    if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
    return { connection, manifestRow: await connectorManifestRepo.findById(db, connection.manifestId) };
  }, { readOnly: true });
  if (!manifestRow) throw new AppError('integrity', 'the connection names a missing manifest', { code: 'connection.manifest_missing' });
  if (connection.status === 'revoked') throw new AppError('forbidden', 'the connection is revoked', { code: 'connection.revoked' });
  if (connection.status === 'halted') throw new AppError('forbidden', 'the connection is halted and serves nothing', { code: 'connection.halted' });

  const manifest = manifestSchema.parse(manifestRow.document);
  const object = manifest.objects.find((o) => o.name === input.object);
  if (object === undefined) {
    throw new AppError('not_found', `the manifest declares no object ${input.object}`, { code: 'connect.object_unknown', details: { object: input.object } });
  }
  const base = { object: object.name, protocol: manifest.protocol.kind };
  if (object.source.kind !== 'rest') {
    return { ...base, observable: false, reason: `protocol:${manifest.protocol.kind}`, records: 0, fields: [], omittedPaths: 0 };
  }

  const options = { request: caller.request, correlationId: caller.correlationId };
  const timeout = AbortSignal.timeout(deps.bounds.wallTimeMs);
  const ctx: ReadContext = {
    manifest,
    connection: { id: connection.id, organisationId: connection.organisationId, agentPoolId: connection.agentPoolId },
    params: parametersOf(connection.parameters),
    now: new Date(),
    deadline: performance.now() + deps.bounds.wallTimeMs,
    signal: AbortSignal.any([caller.signal, timeout]),
    maxRows: Math.min(deps.bounds.maxRowsPerSourceStep, input.sampleRows * 10),
    send: (request: PreparedRequest): Promise<EgressResponse> => deps.services.call(sendAuthorisedRequest, {
      body: { connectionId: connection.id, reason: 'probe', request },
    }, { ...options, signal: caller.signal }),
    files: filesFor({
      manifest, connection: { id: connection.id, organisationId: connection.organisationId, agentPoolId: connection.agentPoolId, parameters: parametersOf(connection.parameters) },
      // The agent with the login this read may have sealed to it (SFTP through the agent).
      agent: withLogin(deps.agent, { reason: 'probe', request: caller.request, correlationId: caller.correlationId }), deadline: performance.now() + deps.bounds.wallTimeMs, signal: AbortSignal.any([caller.signal, timeout]),
      sftp: (operation) => deps.services.call(sendSftpRequest, {
        body: { connectionId: connection.id, reason: 'probe', operation },
      }, { ...options, signal: caller.signal }),
    }),
    refresh: async () => {
      await deps.services.call(refreshConnectionToken, { body: { connectionId: connection.id } }, options);
    },
    agent: withLogin(deps.agent, { reason: 'probe', request: caller.request, correlationId: caller.correlationId }),
    siloStore: deps.siloStore,
    stats: { pages: 0, sourceRows: 0, typeMismatches: 0, retries: 0 },
  };
  // The first page or pages up to the sample: no filter, no sort, the limit as the source declares it.
  const rows = await restEngine.read(ctx, object, { filters: [], sort: [], limit: input.sampleRows, aggregate: null }, [RECORD]);
  const records = rows.map((row) => row['record']);
  const { fields, omittedPaths } = structureOf(records);
  return { ...base, observable: true, reason: null, records: records.length, fields, omittedPaths };
}
