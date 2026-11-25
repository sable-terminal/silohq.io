// AI FDE stage 5 (spec 51.7). Write enablement is proposed only from a passed write-verify-undo
// run on a test record a person nominated; no run, a failed run or a transport that does not
// write stops work on that system with the reason; a physical source is never cycled. Then an
// "Update" Action type per type over the connections that have earned writes, write over a
// transport that writes and declare an update: a definition a person could have written, which
// passes the same check a published version does, leaves a property not given as it is, and
// is physical when a source is.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { versionDefinition } from '../../src/contracts/actions/actionType.contract.ts';
import type { ManifestObject } from '../../src/contracts/connect/manifest.contract.ts';
import type { ObjectTypeView, OntologyManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { checkDefinition } from '../../src/services/actions/actionTypes.service.ts';
import type { ConnectionWithManifest } from '../../src/services/actions/deps.service.ts';
import type { WriteClassStatus } from '../../src/contracts/conformance/writeClass.contract.ts';
import type { Manifest } from '../../src/contracts/connect/manifest.contract.ts';
import { actionTypeProposalFor, TaskFailure, writeEnablementFor, type WritableSource } from '../../src/services/fde-orchestrator/roles.service.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';

const crm = uuidv7();
const erp = uuidv7();
const versionId = uuidv7();

const object = (writes: Record<string, unknown> | undefined, fields = ['id', 'status', 'total', 'paid', 'lines']): ManifestObject => ({
  name: 'invoices', identifier: ['id'], fields: fields.map((name) => ({ name, type: 'string', nullable: true })), writes,
} as never);
const update = { update: {}, custom: [], risk: 'standard', bounds: { maxRows: 100 } };

const property = (apiName: string, dataType: string, mapped: Array<[string, string]>, extra: Partial<ObjectTypeView['properties'][number]> = {}) => ({
  identityId: uuidv7(), apiName, displayName: apiName, description: null, dataType, typeParams: {}, nullable: true, isMatchKey: false,
  sharedPropertyId: null, computedFunctionVersionId: null, status: 'active',
  mappings: mapped.map(([connectionId, fieldPath]) => ({ connectionId, sourceObject: 'invoices', fieldPath, valueMap: null, sourceTimeZone: null, confidence: 1 })),
  ...extra,
}) as ObjectTypeView['properties'][number];

function invoice(): ObjectTypeView {
  const id = property('invoice_id', 'string', [[crm, 'id']]);
  return {
    id: uuidv7(), typeVersionId: uuidv7(), apiName: 'invoice', status: 'active', displayName: 'Invoice', pluralName: 'Invoices', description: null,
    resolutionClass: 'single_source', matchKeys: [], primaryKeyPropertyIdentityId: id.identityId, titlePropertyIdentityId: id.identityId,
    defaultTimeFieldPropertyIdentityId: null, timeFields: [], implements: [], visual: {},
    contributingObjects: [crm, erp].map((connectionId) => ({ connectionId, sourceObject: 'invoices', identifierFieldPath: 'id', connectorVersion: '1.0.0' })),
    properties: [
      id,
      property('status', 'enum', [[crm, 'status']]),
      property('total', 'decimal', [[erp, 'total']]),
      property('paid', 'boolean', [[crm, 'paid']]),
      property('lines', 'array', [[crm, 'lines']]),
      property('overdue', 'boolean', [], { computedFunctionVersionId: uuidv7() }),
      property('legacy', 'string', [[crm, 'legacy']], { status: 'deprecated' }),
    ],
  };
}

const source = (id: string, writes: Record<string, unknown> | undefined, writesEnabled = true, protocol = 'rest'): WritableSource =>
  ({ connection: { id, writesEnabled }, protocol, object: object(writes) });

function check(type: ObjectTypeView, sources: WritableSource[], definition: unknown) {
  const ontology = { version: { id: versionId }, objectTypes: [type], linkTypes: [] } as unknown as OntologyManifest;
  const connections = new Map<string, ConnectionWithManifest>(sources.map((s) => [s.connection.id, {
    connection: { id: s.connection.id } as never, manifestId: uuidv7(), connectorVersion: '1.0.0',
    manifest: { protocol: { kind: s.protocol }, objects: [s.object] } as never,
  }]));
  return checkDefinition(versionDefinition.parse(definition), ontology, connections);
}

describe('AI FDE stage 5: Action type proposals (spec 51.7)', () => {
  test('one Update type over every writable source: optional parameters, unchanged when not given, passing the published check', () => {
    const type = invoice();
    const sources = [source(crm, update), source(erp, update)];
    const proposal = actionTypeProposalFor(type, sources, uuidv7(), versionId)!;
    const definition = proposal.payload['definition'] as { properties: string[]; parameters: Array<{ name: string; type: string; required: boolean }>; rules: unknown[] };
    assert.equal(proposal.payload['apiName'], 'update_invoice');
    assert.equal(proposal.payload['displayName'], 'Update Invoice');
    assert.deepEqual(definition.properties, ['status', 'total', 'paid'], 'not the identifier, a computed, a deprecated or a composite property');
    assert.deepEqual(definition.parameters.map((p) => [p.name, p.type, p.required]), [['status', 'string', false], ['total', 'decimal', false], ['paid', 'boolean', false]]);
    assert.deepEqual(definition.rules[1], { kind: 'set_property', property: 'total', value: { cel: 'params.total == null ? current.total : params.total' } });
    assert.deepEqual(proposal.connectionIds, [crm, erp]);
    const checked = check(type, sources, definition);
    assert.equal(checked.riskClass, 'data');
    assert.deepEqual(Object.keys(checked.permittedOperations).sort(), [crm, erp].sort());
  });

  test('a source without earned writes, a declared update or a writing transport is left out; with none, nothing is proposed', () => {
    const type = invoice();
    const proposal = actionTypeProposalFor(type, [source(crm, update), source(erp, update, false)], uuidv7(), versionId)!;
    assert.deepEqual(proposal.connectionIds, [crm]);
    assert.ok(!(proposal.payload['definition'] as { properties: string[] }).properties.includes('total'), 'total is stored only where writes are not earned');
    assert.equal(actionTypeProposalFor(type, [source(crm, { custom: [], risk: 'standard', bounds: { maxRows: 1 } }), source(erp, undefined)], uuidv7(), versionId), undefined);
    assert.equal(actionTypeProposalFor(type, [source(crm, update, true, 'graphql')], uuidv7(), versionId), undefined);
    assert.equal(actionTypeProposalFor(type, [source(crm, update, false), source(erp, update, false)], uuidv7(), versionId), undefined);
  });

  test('a physical source makes the type physical, which the published check requires', () => {
    const type = invoice();
    const sources = [source(crm, { ...update, risk: 'physical' })];
    const proposal = actionTypeProposalFor(type, sources, uuidv7(), versionId)!;
    assert.equal((proposal.payload['definition'] as { riskClass: string }).riskClass, 'physical');
    assert.equal(check(type, sources, proposal.payload['definition']).riskClass, 'physical');
  });
});

describe('AI FDE stage 5: write enablement (spec 51.7)', () => {
  const manifestId = uuidv7();
  const manifest = (writes: Record<string, unknown> | undefined, protocol = 'rest') => ({ protocol: { kind: protocol }, objects: [object(writes)] }) as unknown as Manifest;
  const status = (run: WriteClassStatus['run']) => async (): Promise<WriteClassStatus> => ({ connectionId: crm, manifestId, writesEnabled: false, run });
  const passed = { id: uuidv7(), passed: true, passedCount: 6, failedCount: 0, completedAt: new Date().toISOString() };
  const fails = (semantic: string) => (error: unknown) => error instanceof TaskFailure && error.semantic === semantic && error.subStage === 'write_class';
  const never = async (): Promise<WriteClassStatus> => { throw new Error('the cycle is not read'); };

  test('a passed run on the current manifest version is proposed, with the run as evidence and no values', async () => {
    const proposal = (await writeEnablementFor(crm, manifest(update), status(passed)))!;
    assert.equal(proposal.kind, 'write_enablement');
    assert.deepEqual(proposal.payload, { connectionId: crm, manifestId, conformanceRunId: passed.id, objects: ['invoices'] });
    assert.deepEqual(proposal.evidence.map((e) => [e.type, e['conformance_run_id']]), [['sandbox_cycle', passed.id]]);
  });

  test('no test record, a failed cycle or a transport that does not write stops with the reason; the connector stays read-only', async () => {
    await assert.rejects(writeEnablementFor(crm, manifest(update), status(null)), fails('not_found'));
    await assert.rejects(writeEnablementFor(crm, manifest(update), status({ ...passed, passed: false, failedCount: 2 })), fails('upstream'));
    await assert.rejects(writeEnablementFor(crm, manifest(update, 'graphql'), never), fails('unsupported_transport'));
  });

  test('a read-only manifest has nothing to propose; a physical source is never cycled', async () => {
    assert.equal(await writeEnablementFor(crm, manifest(undefined), never), undefined);
    assert.equal(await writeEnablementFor(crm, manifest({ ...update, risk: 'physical' }), never), undefined);
  });
});
