// Industrial discovery's proposals (spec 19.4, 20.2, 20.3): an OPC UA server's types and
// folders as object types (identified by browse name, a field per variable at its browse path),
// links from references between them; MQTT topic families as object types (a field per +
// level and per payload field, decoded by JSONata). Each promoted manifest is one Connect takes.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import jsonata from 'jsonata';
import type { FoundStructure } from '../../src/contracts/discovery/discovery.contract.ts';
import { foundStructure } from '../../src/contracts/discovery/discovery.contract.ts';
import { manifestSchema } from '../../src/contracts/connect/manifest.contract.ts';
import { promotedManifest, proposeStructure, proposedConnectorType } from '../../src/services/discovery/proposals.service.ts';

const PLANT = 'urn:silo:test:plant';
const base = { product: null, version: null, dialect: null, port: 4840, schemas: [], nodeClasses: [], topics: [] };

const opcua: FoundStructure = foundStructure.parse({
  ...base, protocol: 'opc_ua', nodeClasses: ['PumpType', 'MotorType'],
  opcua: {
    namespaceUris: ['http://opcfoundation.org/UA/', PLANT], truncated: false,
    types: [
      {
        name: 'PumpType', typeDefinition: `nsu=${PLANT};i=1001`, root: `nsu=${PLANT};s=Pumps`, instances: 12,
        variables: [
          { path: 'Temperature', dataType: 'Double', writable: false }, { path: 'Mode', dataType: 'String', writable: false },
          { path: 'Motor/Speed', dataType: 'Int32', writable: true }, { path: 'Started', dataType: 'DateTime', writable: false },
        ],
        references: [{ path: 'Motor', type: 'MotorType' }],
      },
      { name: 'MotorType', typeDefinition: `nsu=${PLANT};i=1002`, root: `nsu=${PLANT};s=Motors`, instances: 12, variables: [{ path: 'Speed', dataType: 'Int32', writable: true }], references: [] },
    ],
  },
});

const mqtt: FoundStructure = foundStructure.parse({
  ...base, protocol: 'mqtt', port: 1883, topics: ['plant/site/+/line/+/temp', 'plant/status', 'plant/blob/+'],
  mqtt: {
    truncated: false,
    families: [
      { filter: 'plant/site/+/line/+/temp', topics: 6, encoding: 'json', fields: [{ name: 'celsius', type: 'number' }, { name: 'ok', type: 'boolean' }] },
      { filter: 'plant/status', topics: 1, encoding: 'text', fields: [] },
      { filter: 'plant/blob/+', topics: 3, encoding: 'binary', fields: [] },
    ],
  },
});

describe('industrial discovery proposals (spec 19.4, 20.2, 20.3)', () => {
  test('OPC UA: an object type per family, identified by browse name; links from references between proposed types', () => {
    assert.equal(proposedConnectorType(opcua), 'opc_ua');
    const proposed = proposeStructure(opcua, undefined);
    assert.deepEqual(proposed.objectTypes.map((t) => [t.sourceObject, t.apiName, t.identifier.join(), t.fields, t.rowCount]), [
      ['PumpType', 'pump_type', 'id', 6, 12], ['MotorType', 'motor_type', 'id', 3, 12],
    ]);
    assert.deepEqual(proposed.links, [{ from: 'PumpType', to: 'MotorType', fromColumns: ['motor'], toColumns: ['node'], cardinality: 'one_to_one', origin: 'declared', confidence: 0.8 }]);
    assert.equal(proposed.confidence, 0.8);
  });

  test('OPC UA: the promoted connector reads each family\'s root through the agent, a field per variable', () => {
    const manifest = manifestSchema.parse(promotedManifest(opcua, [], '10.0.0.5'));
    assert.deepEqual([manifest.protocol.kind, manifest.transport.viaAgent], ['opc_ua', true]);
    const pump = manifest.objects.find((o) => o.name === 'pump_type')!;
    assert.deepEqual(pump.source, { kind: 'opc_ua', root: `nsu=${PLANT};s=Pumps`, typeDefinition: `nsu=${PLANT};i=1001`, maxInstances: 100 });
    assert.deepEqual(pump.fields.map((f) => [f.name, f.type, f.path]), [
      ['id', 'string', '$browseName'], ['node', 'string', '$nodeId'], ['temperature', 'number', 'Temperature'], ['mode', 'string', 'Mode'],
      ['motor_speed', 'integer', 'Motor/Speed'], ['started', 'date-time', 'Started'],
    ]);
  });

  test('MQTT: a topic family is an object, its + levels the identifier, its payload fields decoded; binary families are left out', async () => {
    const proposed = proposeStructure(mqtt, undefined);
    assert.deepEqual(proposed.objectTypes.map((t) => [t.sourceObject, t.apiName, t.identifier.join()]), [
      ['plant/site/+/line/+/temp', 'line_temp', 'site,line'], ['plant/status', 'plant_status', 'topic'],
    ]);
    const manifest = manifestSchema.parse(promotedManifest(mqtt, [], '10.0.0.6'));
    const temp = manifest.objects.find((o) => o.name === 'line_temp')!;
    assert.deepEqual(temp.fields.map((f) => [f.name, f.type]), [['site', 'string'], ['line', 'string'], ['celsius', 'number'], ['ok', 'boolean']]);
    assert.equal(temp.source.kind, 'mqtt');
    const decode = (temp.source as { decode: { jsonata: string } }).decode.jsonata;
    const record = await jsonata(decode).evaluate({ topic: ['plant', 'site', '3', 'line', '9', 'temp'], payload: { celsius: 20.5, ok: true } });
    assert.deepEqual({ ...record }, { site: '3', line: '9', celsius: 20.5, ok: true });
    const status = manifest.objects.find((o) => o.name === 'plant_status')!;
    const text = await jsonata((status.source as { decode: { jsonata: string } }).decode.jsonata).evaluate({ topic: ['plant', 'status'], payload: 'online' });
    assert.deepEqual({ ...text }, { topic: 'plant/status', text: 'online' });
    assert.ok(!manifest.objects.some((o) => o.label === 'plant/blob/+'));
  });
});
