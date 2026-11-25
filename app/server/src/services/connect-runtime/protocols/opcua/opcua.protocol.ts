// The OPC UA protocol engine (spec 20.3), the cell's half of the agent's plugin: the agent
// browses the object's root node on the customer's network, reads each instance's values at the
// fields' browse paths, and returns one row an instance; the cell reads the fields from it.
//
// - The server is the connection's active industrial endpoint (20.7), reached only by its agent
//   pool: under security policy None (the owner's recorded exception for a segregated network)
//   or a signed policy, as the endpoint's application, its certificate trusted on the server and
//   verified (an endpoint is active only once verified), the server's own certificate pinned.
// - More instances than the step may read, or than the source declares, are refused, never
//   truncated.

import type { ManifestField, ManifestObject, OpcUaSource } from '../../../../contracts/connect/manifest.contract.ts';
import { AppError } from '../../../../utils/errors.util.ts';
import { pemToDerBase64 } from '../../../../utils/pem.util.ts';
import { coerce, rowsBound, type ProtocolEngine, type ReadContext, type Row } from '../../engine.service.ts';

export const opcUaEngine: ProtocolEngine = {
  async read(ctx: ReadContext, object: ManifestObject, _native, fields: readonly ManifestField[]): Promise<Row[]> {
    const source = object.source as OpcUaSource;
    if (ctx.industrial === undefined || ctx.industrial.plugin !== 'opcua') {
      throw new AppError('conflict', 'the connection has no active server: create its industrial endpoint and, for a signed policy, verify it', {
        code: 'industrial.endpoint_missing',
      });
    }
    const { appCertificatePem, serverCertificateThumbprint } = ctx.industrial;
    const signed = ctx.industrial.securityPolicy === 'None' ? undefined : appCertificatePem === null || serverCertificateThumbprint === null
      ? (() => { throw new AppError('integrity', 'a signed endpoint has no application certificate or pinned server', { code: 'industrial.endpoint_incomplete' }); })()
      : { endpointId: ctx.industrial.id, certificate: pemToDerBase64(appCertificatePem), serverThumbprint: serverCertificateThumbprint };
    if (ctx.connection.agentPoolId === null || ctx.agent.opcua === undefined) {
      throw new AppError('source_unreachable', 'OPC UA is read through the connection\'s Silo Agent', { code: 'agent.unavailable' });
    }
    const paths = [...new Set(fields.map((f) => f.path ?? f.name))];
    const maxInstances = Math.min(source.maxInstances, ctx.maxRows + 1);
    const out = await ctx.agent.opcua({
      organisationId: ctx.connection.organisationId, connectionId: ctx.connection.id, agentPoolId: ctx.connection.agentPoolId,
      endpointUrl: ctx.industrial.endpointUrl, securityPolicy: ctx.industrial.securityPolicy, signed, root: source.root,
      ...(source.typeDefinition === undefined ? {} : { typeDefinition: source.typeDefinition }), paths, maxInstances,
      timeoutMs: Math.max(1_000, Math.min(60_000, ctx.deadline - performance.now())), signal: ctx.signal, sealLogin: ctx.manifest.auth.strategy !== 'none',
    });
    if (out.truncated) {
      if (out.rows.length > ctx.maxRows) throw rowsBound(ctx);
      throw new AppError('bounds', `more than ${source.maxInstances} instances under the root; raise maxInstances or narrow the root`, {
        code: 'opcua.too_many_instances', details: { bound: 'max_instances', limit: source.maxInstances },
      });
    }
    if (out.rows.length > ctx.maxRows) throw rowsBound(ctx);
    ctx.stats.pages += 1;
    return out.rows.map((record) => {
      ctx.stats.sourceRows += 1;
      const row: Row = {};
      for (const field of fields) row[field.name] = coerce(record[field.path ?? field.name], field.type, ctx.stats);
      return row;
    });
  },
};
