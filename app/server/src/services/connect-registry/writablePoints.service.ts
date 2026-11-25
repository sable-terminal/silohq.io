// Writable points (spec 20.3, 20.5, 20.7): declared write targets on a connection, against the
// manifest version it runs, by a holder of industrial.declare_writable at its owning scope.
//
// - The address is the transport's: an OPC UA node by namespace URI and identifier
//   ("nsu=<uri>;i=|s=|g=|b=<id>", never a namespace index, which can change on restart), an MQTT
//   topic with no wildcard, or a webhook action's name for any other connection.
// - The value check is required and must compile as CEL over values and prior returning a
//   boolean (the write.valueCheck block): a point without one cannot be written.
// - The risk class is at least the transport's default: every MQTT and OPC UA write is
//   physical (47.1, 20.5); it can be raised, never lowered (the table's guard refuses it too).
// - A point is retired, never deleted; its declaration is immutable but for test_safe.

import type { WritablePointView } from '../../contracts/connect-registry/writablePoint.contract.ts';
import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { WritablePoint } from '../../models/connect/writablePoint.model.ts';
import { connectorManifestRepo, writablePointRepo } from '../../repos/connect/index.repo.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';
import { recordConnectEvent } from './connectEvents.service.ts';
import { demand, loadConnection, type RegistryDeps } from './registry.service.ts';

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

const viewOf = (p: WritablePoint): WritablePointView => ({
  id: p.id, connectionId: p.connectionId, manifestId: p.manifestId, address: p.address, riskClass: p.riskClass, valueCheck: p.valueCheck,
  feedbackAddress: p.feedbackAddress, settleSeconds: p.settleSeconds, testSafe: p.testSafe, declaredBy: p.declaredBy, declaredAt: p.declaredAt,
  retiredAt: p.retiredAt,
});

const OPCUA_NODE = /^nsu=[^;\s]{1,500};(i=\d{1,10}|s=[^\s]{1,500}|g=[0-9a-fA-F-]{36}|b=[A-Za-z0-9+/=]{1,700})$/;
const ACTION = /^[a-z][a-z0-9_]{0,62}$/;

/** Whether the address is one the protocol writes: a topic with no wildcard, a node by URI, or an action's name. */
function addressFits(protocol: string, address: string): boolean {
  if (protocol === 'mqtt') return address.length <= 1_024 && !/[+#\u0000]/.test(address) && !address.startsWith('$');
  if (protocol === 'opc_ua') return OPCUA_NODE.test(address);
  return ACTION.test(address);
}

const member = (ctx: Context): string => {
  if (ctx.request.membershipId === undefined) throw new AppError('forbidden', 'a person declares a writable point', { code: 'industrial.member_required' });
  return ctx.request.membershipId;
};

export async function declareWritablePoint(deps: RegistryDeps, ctx: Context, connectionId: string, input: {
  address: string; riskClass?: 'standard' | 'physical' | undefined; valueCheck: { cel: string }; feedbackAddress?: string | undefined;
  settleSeconds: number; testSafe: boolean;
}): Promise<WritablePointView> {
  const connection = await loadConnection(deps, ctx, connectionId);
  await demand(deps, ctx, 'industrial.declare_writable', connection.owningScopeId, connection.id);
  const membershipId = member(ctx);
  if (connection.status === 'revoked') throw new AppError('conflict', 'a revoked connection writes nothing', { code: 'connection.revoked' });
  const control = deps.databases.pool('control');
  const row = await inTransaction(control, ctx.request, (db) => connectorManifestRepo.findById(db, connection.manifestId), { readOnly: true });
  const manifest = row === undefined ? undefined : manifestSchema.safeParse(row.document);
  if (manifest?.success !== true) throw new AppError('integrity', 'the connection runs a manifest that does not read', { code: 'connection.manifest_unreadable' });
  const protocol = manifest.data.protocol.kind;
  for (const [field, value] of [['address', input.address], ['feedbackAddress', input.feedbackAddress]] as const) {
    if (value !== undefined && !addressFits(protocol, value)) {
      throw new AppError('validation', protocol === 'opc_ua' ? 'an OPC UA node is named by namespace URI and identifier (nsu=...;i=|s=|g=|b=...), never a namespace index'
        : protocol === 'mqtt' ? 'an MQTT point is a topic with no wildcard' : 'a webhook point is an action\'s name', { code: 'industrial.address_invalid', details: { field } });
    }
  }
  // Every MQTT and OPC UA write is physical (47.1); anything else is standard unless the owner raises it.
  const floor = protocol === 'mqtt' || protocol === 'opc_ua' ? 'physical' : 'standard';
  const riskClass = input.riskClass ?? floor;
  if (floor === 'physical' && riskClass !== 'physical') {
    throw new AppError('validation', `a ${protocol} write is physical: its class is never lowered below its transport's`, { code: 'industrial.risk_below_transport' });
  }
  try {
    compileExpression('write.valueCheck', 'cel', input.valueCheck.cel);
  } catch (error) {
    if (isAppError(error)) throw new AppError('validation', 'the value check does not compile as CEL over values and prior', { code: 'industrial.value_check_invalid' });
    throw error;
  }
  try {
    const point = await inTransaction(control, ctx.request, async (db) => {
      const inserted = await writablePointRepo.insert(db, {
        id: uuidv7(), organisationId: connection.organisationId, connectionId, manifestId: connection.manifestId, address: input.address,
        riskClass, valueCheck: input.valueCheck.cel, feedbackAddress: input.feedbackAddress ?? null, settleSeconds: input.settleSeconds,
        testSafe: input.testSafe, declaredBy: membershipId,
      });
      await recordConnectEvent(db, {
        organisationId: connection.organisationId, correlationId: ctx.correlationId, event: 'writable_point_declared', membershipId,
        resourceType: 'connection', resourceId: connection.id,
        detail: { point_id: inserted.id, risk_class: riskClass, test_safe: input.testSafe, feedback: input.feedbackAddress !== undefined, settle_seconds: input.settleSeconds },
      });
      return inserted;
    });
    return viewOf(point);
  } catch (error) {
    if (fromDatabaseError(error).category === 'conflict') {
      throw new AppError('conflict', 'that address is declared on this manifest version already', { code: 'industrial.point_exists' });
    }
    throw error;
  }
}

export async function listWritablePoints(deps: RegistryDeps, ctx: Context, connectionId: string, includeRetired: boolean): Promise<WritablePointView[]> {
  await loadConnection(deps, ctx, connectionId);
  const rows = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => writablePointRepo.listForConnection(db, connectionId, includeRetired), { readOnly: true });
  return rows.map(viewOf);
}

/** A change to one point: risk raised, test safety set, or retired; each by a holder of industrial.declare_writable. */
async function change(deps: RegistryDeps, ctx: Context, pointId: string,
  apply: (point: WritablePoint) => { changes: Partial<Pick<WritablePoint, 'riskClass' | 'testSafe' | 'retiredAt'>>; event?: 'writable_point_risk_raised' } | undefined)
  : Promise<WritablePointView> {
  const control = deps.databases.pool('control');
  const point = await inTransaction(control, ctx.request, (db) => writablePointRepo.findById(db, pointId), { readOnly: true });
  if (point === undefined) throw new AppError('not_found', 'no such writable point', { code: 'industrial.point_not_found' });
  const connection = await loadConnection(deps, ctx, point.connectionId);
  await demand(deps, ctx, 'industrial.declare_writable', connection.owningScopeId, connection.id);
  const membershipId = member(ctx);
  if (point.retiredAt !== null) throw new AppError('conflict', 'the point is retired', { code: 'industrial.point_retired' });
  const decided = apply(point);
  if (decided === undefined) return viewOf(point);
  const updated = await inTransaction(control, ctx.request, async (db) => {
    const row = (await writablePointRepo.update(db, pointId, decided.changes))!;
    if (decided.event !== undefined) {
      await recordConnectEvent(db, {
        organisationId: connection.organisationId, correlationId: ctx.correlationId, event: decided.event, membershipId,
        resourceType: 'connection', resourceId: connection.id, detail: { point_id: pointId, from: point.riskClass, to: row.riskClass },
      });
    }
    return row;
  });
  return viewOf(updated);
}

export const raiseWritablePointRisk = (deps: RegistryDeps, ctx: Context, pointId: string) =>
  change(deps, ctx, pointId, (p) => (p.riskClass === 'physical' ? undefined : { changes: { riskClass: 'physical' }, event: 'writable_point_risk_raised' }));

export const setWritablePointTestSafe = (deps: RegistryDeps, ctx: Context, pointId: string, testSafe: boolean) =>
  change(deps, ctx, pointId, (p) => (p.testSafe === testSafe ? undefined : { changes: { testSafe } }));

export const retireWritablePoint = (deps: RegistryDeps, ctx: Context, pointId: string) =>
  change(deps, ctx, pointId, () => ({ changes: { retiredAt: new Date().toISOString() } }));
