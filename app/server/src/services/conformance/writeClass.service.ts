// The write-verify-undo class and the switch it gates (contracts/conformance/writeClass.contract.ts;
// spec 17.1, 43.4 check 5). The cycle runs through connect-runtime's write path in the
// sandbox: create, verify, update, verify, delete, verify absence; or, for an object that
// only updates, update, verify, restore, verify. Each step is a test with an outcome and a
// reason code; a step that cannot run (the object does not declare the operation) is not
// applicable, never passed.

import { prepareWrites, readRecords, writeRecords, type WriteResult } from '../../contracts/connect-runtime/write.contract.ts';
import { signSandboxWriteGrant } from '../../contracts/actions/grant.contract.ts';
import type { ConformanceTest } from '../../contracts/conformance/conformance.contract.ts';
import { SUITE_VERSION } from '../../contracts/conformance/conformance.contract.ts';
import type { WriteClassStatus } from '../../contracts/conformance/writeClass.contract.ts';
import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { ConformanceRun } from '../../models/connect/conformanceRun.model.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import { conformanceRunRepo, connectionRepo, connectorManifestRepo, connectorRepo } from '../../repos/connect/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordActionEvent } from '../actions/events.service.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import { demandPhysicalOperations } from '../connect-registry/registry.service.ts';

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

const same = (a: unknown, b: unknown): boolean => canonicalJsonBytes({ v: a ?? null }).equals(canonicalJsonBytes({ v: b ?? null }));

/** A completed write class run with no failure and at least one passed write-verify-undo test. */
function passedWriteClass(run: ConformanceRun): boolean {
  const tests = (Array.isArray(run.results) ? run.results : []) as ConformanceTest[];
  return run.failedCount === 0 && tests.some((t) => t.class === 'write_verify_undo' && t.outcome === 'passed');
}

export function createWriteClass(deps: { databases: Databases; services: ServiceClient }) {
  const control = deps.databases.pool('control');
  const options = (ctx: Context) => ({ request: ctx.request, correlationId: ctx.correlationId });

  async function decide(ctx: Context, permission: string, connection: Connection): Promise<boolean> {
    const decision = await deps.services.call(authorise, {
      body: { permission, scopeId: connection.owningScopeId, resource: { type: 'connection', id: connection.id } },
    }, options(ctx));
    return decision.decision === 'allow';
  }

  async function load(ctx: Context, connectionId: string): Promise<Connection> {
    if (ctx.request.membershipId === undefined) throw new AppError('forbidden', 'this is done by a member', { code: 'conformance.member_required' });
    const connection = await inTransaction(control, ctx.request, (db) => connectionRepo.findById(db, connectionId), { readOnly: true });
    if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
    return connection;
  }

  return {
    /** Whether the connection's current manifest version passed the write class. Read by any member or principal of the organisation. */
    async status(ctx: Context, connectionId: string): Promise<WriteClassStatus> {
      return inTransaction(control, ctx.request, async (db) => {
        const connection = await connectionRepo.findById(db, connectionId);
        if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
        const run = await conformanceRunRepo.latestWriteClass(db, connectionId, connection.manifestId);
        return {
          connectionId, manifestId: connection.manifestId, writesEnabled: connection.writesEnabled,
          run: run === undefined ? null : {
            id: run.id, passed: passedWriteClass(run), passedCount: run.passedCount, failedCount: run.failedCount, completedAt: run.completedAt!,
          },
        };
      }, { readOnly: true });
    },

    async run(ctx: Context, connectionId: string, input: { object: string; create?: Record<string, unknown> | undefined; identifier?: string | undefined; update?: Record<string, unknown> | undefined }) {
      const connection = await load(ctx, connectionId);
      if (connection.owningMembershipId !== ctx.request.membershipId && !await decide(ctx, 'connector.verify', connection)) {
        throw new AppError('forbidden', 'you do not hold connector.verify here', { code: 'connect.not_permitted', details: { permission: 'connector.verify' } });
      }
      const { manifestRow, connector } = await inTransaction(control, ctx.request, async (db) => ({
        manifestRow: (await connectorManifestRepo.findById(db, connection.manifestId))!,
        connector: (await connectorRepo.findById(db, connection.connectorId))!,
      }), { readOnly: true });
      const route = connector.sourceRoute;
      if (route === 'silo') throw new AppError('validation', 'a Silo holds a copy: nothing is written to it (66.5)', { code: 'conformance.silo_store' });
      const manifest = manifestSchema.parse(manifestRow.document);
      const object = manifest.objects.find((o) => o.name === input.object);
      if (object === undefined) throw new AppError('validation', 'the connector has no such object', { code: 'step.object_unknown' });
      const tests: ConformanceTest[] = [];
      const at = (step: string) => `write_verify_undo.${step}.${object.name}`;
      const record = (step: string, outcome: ConformanceTest['outcome'], started: number, reason: string | null) =>
        tests.push({ id: at(step), class: 'write_verify_undo', object: object.name, outcome, durationMs: Math.round(performance.now() - started), reason, operator: null });
      // The run's id is the Action a write through the Silo Agent's grant names (spec 10.4).
      const runId = uuidv7();
      const write = async (op: { operation: 'create' | 'update_partial' | 'delete'; identifier?: string; values?: Record<string, unknown> }): Promise<WriteResult> => {
        const body = { connectionId, object: object.name, sandbox: true as const, operations: [{ key: uuidv7(), ...op, values: (op.values ?? {}) as never }] };
        const prepared = await deps.services.call(prepareWrites, { body }, options(ctx));
        const grant = !prepared.grantRequired ? undefined : await deps.services.call(signSandboxWriteGrant, {
          body: { connectionId, runId, object: object.name, statements: prepared.statements!, payloadSha256: prepared.payloadSha256! },
        }, options(ctx));
        const out = await deps.services.call(writeRecords, { body: { ...body, ...(grant === undefined ? {} : { grant }) } }, options(ctx));
        return out.results[0]!;
      };
      const readBack = async (identifier: string, fields: string[]) => (await deps.services.call(readRecords, {
        body: { connectionId, object: object.name, identifiers: [identifier], fields: fields.length > 0 ? fields : [object.identifier[0]!], reason: 'read_back', sandbox: true },
      }, options(ctx))).records[0]!.values;
      const matches = (observed: Record<string, unknown> | null, intended: Record<string, unknown>) =>
        observed !== null && Object.entries(intended).every(([f, v]) => same(observed[f], v));

      let testRecord: string | null = null;
      if (input.create !== undefined) {
        if (object.writes?.create === undefined || object.writes.delete === undefined) {
          record('create', 'not_applicable', performance.now(), 'create_or_delete_undeclared');
        } else {
          let started = performance.now();
          const created = await write({ operation: 'create', values: input.create });
          if (created.outcome !== 'applied' || created.identifier === null) {
            record('create', 'failed', started, created.error?.code ?? 'no_identifier');
          } else {
            testRecord = created.identifier;
            record('create', matches(await readBack(created.identifier, Object.keys(input.create)), input.create) ? 'passed' : 'failed', started, null);
            if (input.update !== undefined && object.writes.update !== undefined) {
              started = performance.now();
              const updated = await write({ operation: 'update_partial', identifier: created.identifier, values: input.update });
              record('update', updated.outcome === 'applied' && matches(await readBack(created.identifier, Object.keys(input.update)), input.update) ? 'passed' : 'failed',
                started, updated.error?.code ?? null);
            } else {
              record('update', 'not_applicable', performance.now(), 'update_not_exercised');
            }
            started = performance.now();
            const deleted = await write({ operation: 'delete', identifier: created.identifier });
            record('undo', deleted.outcome === 'applied' && await readBack(created.identifier, []) === null ? 'passed' : 'failed', started, deleted.error?.code ?? null);
          }
        }
      } else if (object.writes?.update === undefined) {
        record('update', 'not_applicable', performance.now(), 'update_undeclared');
      } else {
        const fields = Object.keys(input.update!);
        let started = performance.now();
        const prior = await readBack(input.identifier!, fields);
        if (prior === null) {
          record('update', 'failed', started, 'record_not_found');
        } else {
          const before = Object.fromEntries(fields.map((f) => [f, prior[f] ?? null]));
          const updated = await write({ operation: 'update_partial', identifier: input.identifier!, values: input.update! });
          record('update', updated.outcome === 'applied' && matches(await readBack(input.identifier!, fields), input.update!) ? 'passed' : 'failed', started, updated.error?.code ?? null);
          started = performance.now();
          const restored = await write({ operation: 'update_partial', identifier: input.identifier!, values: before });
          record('undo', restored.outcome === 'applied' && matches(await readBack(input.identifier!, fields), before) ? 'passed' : 'failed', started, restored.error?.code ?? null);
        }
      }

      const passedCount = tests.filter((t) => t.outcome === 'passed').length;
      const failed = tests.filter((t) => t.outcome === 'failed');
      await inTransaction(control, ctx.request, async (db) => {
        await conformanceRunRepo.insert(db, {
          id: runId, organisationId: connection.organisationId, connectionId, manifestId: connection.manifestId, suiteVersion: SUITE_VERSION,
          trigger: 'manual', route, classesRun: ['write_verify_undo'], results: tests as never, passedCount,
          failedCount: failed.length, testRecordRef: testRecord, completedAt: new Date().toISOString(),
        });
        const event = { organisationId: connection.organisationId, correlationId: ctx.correlationId, membershipId: ctx.request.membershipId, service: 'conformance' as const };
        await recordConnectEvent(db, {
          ...event, event: 'conformance_run_completed', resourceType: 'conformance_run', resourceId: runId,
          detail: { connection_id: connectionId, class: 'write_verify_undo', passed: passedCount, failed: failed.length },
        });
        for (const test of failed) {
          await recordConnectEvent(db, { ...event, event: 'conformance_test_failed', resourceType: 'conformance_run', resourceId: runId, detail: { test: test.id.slice(0, 200), reason: (test.reason ?? 'failed').slice(0, 200) } });
        }
      });
      return { runId, passed: failed.length === 0 && passedCount > 0, tests };
    },

    async setWrites(ctx: Context, connectionId: string, enabled: boolean) {
      const connection = await load(ctx, connectionId);
      if (!await decide(ctx, 'connector.enable_writes', connection)) {
        throw new AppError('forbidden', 'enabling writes needs connector.enable_writes', { code: 'connect.not_permitted', details: { permission: 'connector.enable_writes' } });
      }
      let runId: string | null = null;
      if (enabled) {
        if (connection.status !== 'active' && connection.status !== 'halted') {
          throw new AppError('conflict', 'writes are enabled on an active connection', { code: 'connection.not_active' });
        }
        const run = await inTransaction(control, ctx.request, (db) => conformanceRunRepo.latestWriteClass(db, connectionId, connection.manifestId), { readOnly: true });
        if (run === undefined || !passedWriteClass(run)) {
          throw new AppError('conflict', 'the connection has not passed the write-verify-undo class on its current manifest version', { code: 'connection.write_class_not_passed' });
        }
        runId = run!.id;
        // A connection whose manifest writes physical equipment is physical (20.5): someone must be able to approve (47.8).
        const manifest = await inTransaction(control, ctx.request, (db) => connectorManifestRepo.findById(db, connection.manifestId), { readOnly: true });
        const parsed = manifestSchema.safeParse(manifest?.document);
        if (connection.physicalWebhook || (parsed.success && parsed.data.objects.some((o) => o.writes?.risk === 'physical'))) {
          await demandPhysicalOperations(deps.databases, ctx);
        }
      }
      await inTransaction(control, ctx.request, async (db) => {
        await connectionRepo.update(db, connectionId, { writesEnabled: enabled });
        await recordActionEvent(db, {
          organisationId: connection.organisationId, correlationId: ctx.correlationId, event: enabled ? 'writes_enabled' : 'writes_disabled',
          request: ctx.request, service: 'conformance', resource: { type: 'connection', id: connectionId }, scopeId: connection.owningScopeId,
          detail: { conformance_run_id: runId },
        });
      });
      return { connectionId, writesEnabled: enabled, runId };
    },
  };
}

export type WriteClass = ReturnType<typeof createWriteClass>;
