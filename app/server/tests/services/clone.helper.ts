// Shared by the canvas-layout and studio tests: a Connect cell (credential, policy, auth,
// connect-registry) plus ontology, with one connection whose manifest declares sites and
// pumps (pumps polled every five minutes), and main holding two types (site, pump) and a
// link between them, merged through a proposal as people would. canvas-layout and studio
// start as real processes when asked.

import { createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { putLinkType, putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { getManifest, type OntologyManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import type { ServiceDefinition } from '../../src/infra/service.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createConnectCell, doc, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

export interface CloneCell {
  cell: ConnectCell;
  gateway: ServiceClient;
  root: Signed;
  editor: Signed;
  member: Signed;
  outsider: Signed;
  connectionId: string;
  manifest: OntologyManifest;
  pump: OntologyManifest['objectTypes'][number];
  site: OntologyManifest['objectTypes'][number];
  linkTypeId: string;
  prop(apiName: string): string;
  keyed(who: Signed): ReturnType<ConnectCell['as']>;
  /** Audit events written to the outbox, oldest first. */
  events(name?: string): Promise<{ event: string; detail: Record<string, unknown>; resource: { type: string; id: string } | null }[]>;
  close(): Promise<void>;
}

const source = (path: string) => ({ kind: 'rest', request: { method: 'GET', path, query: {} }, records: { jsonata: 'results' } });

export async function startCloneCell(services: { definition: ServiceDefinition; name: 'canvas-layout' | 'studio' | 'notify' | 'files' | 'actions'; env?: Record<string, string> }[])
  : Promise<CloneCell> {
  const cell = await createConnectCell();
  await cell.start(ontologyService, 'ontology', 'test_app');
  for (const s of services) await cell.start(s.definition, s.name, 'test_app', { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, ...s.env });
  const gateway = cell.client('gateway');
  const root = await cell.signIn('root@acme.example');
  const editor = await cell.member('editor@acme.example', 'Super admin');
  const member = await cell.member('member@acme.example', 'Member');
  const outsider = await cell.member('outsider@acme.example', 'Member');
  const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });

  // A connection over sites and pumps; pumps polled every five minutes.
  const connector = await gateway.call(createConnector, { body: { slug: 'plant', name: 'Plant', provider: 'Example', sourceRoute: 'ai' } }, keyed(root));
  const base = restManifest({
    baseUrl: 'https://api.example.com',
    objects: [
      { name: 'sites', identifier: ['id'], source: source('/v1/sites'), fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string' }] },
      {
        name: 'pumps', identifier: ['id'], source: source('/v1/pumps'),
        fields: [
          { name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string' }, { name: 'status_code', type: 'string' },
          { name: 'pressure', type: 'number' }, { name: 'last_service', type: 'date-time' }, { name: 'site_id', type: 'string' },
          { name: 'updated_at', type: 'date-time' },
        ],
        relationships: [{ field: 'site_id', targetObject: 'sites', targetField: 'id', kind: 'foreign_key' }],
        pushdown: { filters: [{ field: 'updated_at', ops: ['gt'], patch: { cel: '{"query": {"since": string(value)}}' } }] },
      },
    ],
  }) as unknown as Record<string, unknown>;
  const document = doc({ ...base, changeStream: { objects: [{ object: 'pumps', sources: [{ kind: 'poll', intervalSeconds: 300, watermarkField: 'updated_at' }] }] } });
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } }, keyed(root));
  const connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'plant', owningScopeId: cell.scopes['engineering']! } },
    keyed(root));

  // Main: site and pump, and the link between them, merged through a proposal.
  const branch = await gateway.call(openBranch, { body: { name: 'plant model' } }, keyed(editor));
  const mapping = (object: string, field: string) => [{ connectionId: connection.id, sourceObject: object, fieldPath: field }];
  await gateway.call(putObjectType, {
    params: { branchId: branch.id, apiName: 'site' },
    body: {
      displayName: 'Site', pluralName: 'Sites', contributingObjects: [{ connectionId: connection.id, sourceObject: 'sites', identifierFieldPath: 'id' }],
      properties: [
        { apiName: 'site_id', displayName: 'Site id', dataType: 'string', mappings: mapping('sites', 'id') },
        { apiName: 'name', displayName: 'Name', dataType: 'string', mappings: mapping('sites', 'name') },
      ],
      primaryKey: 'site_id', title: 'name',
    },
  }, keyed(editor));
  await gateway.call(putObjectType, {
    params: { branchId: branch.id, apiName: 'pump' },
    body: {
      displayName: 'Pump', pluralName: 'Pumps', contributingObjects: [{ connectionId: connection.id, sourceObject: 'pumps', identifierFieldPath: 'id' }],
      properties: [
        { apiName: 'pump_id', displayName: 'Pump id', dataType: 'string', mappings: mapping('pumps', 'id') },
        { apiName: 'name', displayName: 'Name', dataType: 'string', mappings: mapping('pumps', 'name') },
        { apiName: 'status_code', displayName: 'Status', dataType: 'string', mappings: mapping('pumps', 'status_code') },
        { apiName: 'pressure', displayName: 'Discharge pressure', dataType: 'decimal', mappings: mapping('pumps', 'pressure') },
        { apiName: 'last_service', displayName: 'Last service', dataType: 'timestamp', mappings: mapping('pumps', 'last_service') },
        { apiName: 'site_ref', displayName: 'Site', dataType: 'string', mappings: mapping('pumps', 'site_id') },
      ],
      primaryKey: 'pump_id', title: 'name', timeFields: [{ property: 'last_service', meaning: 'serviced', isDefault: true }],
    },
  }, keyed(editor));
  await gateway.call(putLinkType, {
    params: { branchId: branch.id, apiName: 'site_pumps' },
    body: {
      forwardName: 'houses', reverseName: 'sits at', from: 'site', to: 'pump', cardinality: 'one_to_many',
      routes: [{ connectionId: connection.id, sourceObject: 'pumps', foreignKeyField: 'site_id', referencedField: 'id', origin: 'declared_fk' }],
      defaultRoute: 0,
    },
  }, keyed(editor));
  const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Plant' } }, keyed(editor));
  await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
  await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
  const manifest = await gateway.call(getManifest, { query: {} }, cell.as(root));
  const pump = manifest.objectTypes.find((t) => t.apiName === 'pump')!;
  const site = manifest.objectTypes.find((t) => t.apiName === 'site')!;
  const linkTypeId = manifest.linkTypes.find((l) => l.apiName === 'site_pumps')!.id;

  return {
    cell, gateway, root, editor, member, outsider, connectionId: connection.id, manifest, pump, site, linkTypeId, keyed,
    prop: (apiName) => [...pump.properties, ...site.properties].find((p) => p.apiName === apiName)!.identityId,
    async events(name) {
      const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
        `select payload->>'event' as event, payload->'detail' as detail, payload->'resource' as resource from platform.outbox
         where organisation_id = $1 and event = 'audit_event' and ($2::text is null or payload->>'event' = $2) order by created_at, id`,
        [cell.org, name ?? null]));
      return rows as { event: string; detail: Record<string, unknown>; resource: { type: string; id: string } | null }[];
    },
    close: () => cell.close(),
  };
}
