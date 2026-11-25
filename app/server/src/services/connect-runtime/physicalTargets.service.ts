// The nodes a physical Action would write or command (contracts/connect-runtime/physical.contract.ts):
// read through the agent as an OPC UA read is, each setpoint field's value and, at <path>/$nodeId,
// the address of its node, for the records named; for a command, the address of the method its
// custom action calls, read the same way, or the MQTT topic it publishes to with its payload,
// checked against the declared schema (nothing is read from the broker).

import type { OpcUaSource } from '../../contracts/connect/manifest.contract.ts';
import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import { parametersOf } from '../../contracts/connect/parameters.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { connectionRepo, connectorManifestRepo, industrialEndpointRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { pemToDerBase64 } from '../../utils/pem.util.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';
import { withLogin } from './agent.service.ts';
import { commandOf, commandPayload, commandTopic } from './protocols/mqtt/publish.protocol.ts';
import { methodArguments } from './protocols/opcua/write.protocol.ts';
import type { Caller, RuntimeDeps } from './read.service.ts';

export async function resolvePhysicalTargets(deps: RuntimeDeps, caller: Caller, input: {
  connectionId: string; object: string; targets: { identifier: string; fields: string[] }[];
  commands: { identifier: string; customAction: string; inputs: Record<string, unknown> }[];
}) {
  const { connection, manifest, endpoint } = await inTransaction(deps.databases.pool('control'), caller.request, async (db) => {
    const connection = await connectionRepo.findById(db, input.connectionId);
    if (connection === undefined) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
    const row = await connectorManifestRepo.findById(db, connection.manifestId);
    const parsed = row === undefined ? undefined : manifestSchema.safeParse(row.document);
    if (parsed?.success !== true) throw new AppError('integrity', 'the connection runs a manifest that does not read', { code: 'connection.manifest_unreadable' });
    return { connection, manifest: parsed.data, endpoint: await industrialEndpointRepo.activeForConnection(db, connection.id) };
  }, { readOnly: true });
  if (connection.status !== 'active') throw new AppError('conflict', `a ${connection.status} connection is not written`, { code: 'connection.not_active' });
  const object = manifest.objects.find((o) => o.name === input.object);

  // MQTT commands (47.1): the topic each record's command goes to and its payload, nothing read.
  if (manifest.protocol.kind === 'mqtt' && object?.source.kind === 'mqtt' && input.targets.length === 0) {
    const params = parametersOf(connection.parameters);
    const commands = [];
    for (const c of input.commands) {
      const declared = commandOf(object, c.customAction);
      const value = declared.body === undefined ? c.inputs
        : await compileExpression('write.body', 'jsonata', declared.body.jsonata).evaluate({ input: c.inputs, identifier: c.identifier, params }, new Date());
      commands.push({ identifier: c.identifier, customAction: c.customAction, nodeAddress: commandTopic(declared.mqtt, c.identifier), payload: commandPayload(declared.mqtt, value) });
    }
    return { nodes: [], commands };
  }
  if (manifest.protocol.kind !== 'opc_ua' || object?.source.kind !== 'opc_ua') {
    throw new AppError('validation', 'the physical nodes of an OPC UA object, and the commands of an MQTT one, are resolved here', { code: 'physical.not_industrial' });
  }
  // OPC UA commands: the method each custom action calls, and its input arguments as it would be called now (D245).
  const methods = new Map<string, string>();
  const argumentsOf: { name: string; value: unknown }[][] = [];
  const params = parametersOf(connection.parameters);
  for (const c of input.commands) {
    const declared = object.writes?.custom.find((x) => x.name === c.customAction);
    if (declared?.opcua === undefined) {
      throw new AppError('validation', `the manifest declares no method ${c.customAction} on ${object.name}`, { code: 'write.operation_undeclared', details: { operation: 'custom' } });
    }
    methods.set(c.customAction, declared.opcua.method);
    argumentsOf.push(await methodArguments(declared, c.inputs, { identifier: c.identifier, params, now: new Date() }));
  }
  if (endpoint === undefined || endpoint.plugin !== 'opcua') {
    throw new AppError('conflict', 'the connection has no active server', { code: 'industrial.endpoint_missing' });
  }
  const channel = withLogin(deps.agent, { reason: 'query', request: caller.request, correlationId: caller.correlationId });
  if (channel.opcua === undefined || connection.agentPoolId === null) {
    throw new AppError('source_unreachable', 'OPC UA is read through the connection\'s Silo Agent', { code: 'agent.unavailable' });
  }
  const pathOf = (field: string) => object.fields.find((f) => f.name === field)?.path ?? field;
  const paths = [...new Set(input.targets.flatMap((t) => t.fields.map(pathOf)).filter((p) => !p.startsWith('$')))];
  const source = object.source as OpcUaSource;
  const signed = endpoint.securityPolicy === 'None' || endpoint.appCertificatePem === null || endpoint.serverCertificateThumbprint === null ? undefined
    : { endpointId: endpoint.id, certificate: pemToDerBase64(endpoint.appCertificatePem), serverThumbprint: endpoint.serverCertificateThumbprint };
  const { rows } = await channel.opcua({
    organisationId: connection.organisationId, connectionId: connection.id, agentPoolId: connection.agentPoolId,
    endpointUrl: endpoint.endpointUrl, securityPolicy: endpoint.securityPolicy, signed, root: source.root,
    ...(source.typeDefinition === undefined ? {} : { typeDefinition: source.typeDefinition }),
    paths: ['$browseName', ...paths.flatMap((p) => [p, `${p}/$nodeId`]), ...[...new Set(methods.values())].map((m) => `${m}/$nodeId`)],
    maxInstances: source.maxInstances, timeoutMs: 30_000, signal: caller.signal, sealLogin: manifest.auth.strategy !== 'none',
  });
  const byName = new Map(rows.map((r) => [String(r['$browseName']), r]));
  const addressOf = (identifier: string, path: string) => {
    const address = byName.get(identifier)?.[`${path}/$nodeId`];
    return typeof address === 'string' ? address : null;
  };
  return {
    nodes: input.targets.flatMap((t) => t.fields.map((field) => {
      const path = pathOf(field);
      return { identifier: t.identifier, field, nodeAddress: addressOf(t.identifier, path), current: (byName.get(t.identifier)?.[path] ?? null) as never };
    })),
    commands: input.commands.map((c, i) => ({
      identifier: c.identifier, customAction: c.customAction, nodeAddress: addressOf(c.identifier, methods.get(c.customAction)!), arguments: argumentsOf[i] as never,
    })),
  };
}
