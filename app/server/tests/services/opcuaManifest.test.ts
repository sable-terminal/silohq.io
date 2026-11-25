// The OPC UA manifest (spec 20.3): nodes by namespace URI and identifier, never an index; the
// Silo Agent reads it, the server is the connection's endpoint, fields are browse paths;
// writes are physical: setpoint updates and method calls (and MQTT's, commands published).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { manifestSchema } from '../../src/contracts/connect/manifest.contract.ts';

const base = () => ({
  schemaVersion: '1', identity: { name: 'Pump house', provider: 'Example plant', version: '1.0.0' },
  transport: { viaAgent: true } as Record<string, unknown>, protocol: { kind: 'opc_ua' }, auth: { strategy: 'none' } as Record<string, unknown>,
  objects: [{
    name: 'pumps', identifier: ['id'],
    fields: [
      { name: 'id', type: 'string', path: '$browseName' },
      { name: 'rpm', type: 'integer', path: 'Motor/Speed' },
    ] as Record<string, unknown>[],
    source: { kind: 'opc_ua', root: 'nsu=urn:silo:test:plant;s=Pumps' } as Record<string, unknown>,
  }] as Record<string, unknown>[],
});

const issues = (document: unknown): string[] => {
  const parsed = manifestSchema.safeParse(document);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
};

describe('the OPC UA manifest (spec 20.3)', () => {
  test('a root by namespace URI, fields by browse path, read through the agent', () => {
    const parsed = manifestSchema.parse(base());
    assert.equal(parsed.objects[0]!.source.kind, 'opc_ua');
    assert.equal((parsed.objects[0]!.source as { maxInstances: number }).maxInstances, 1_000);
    for (const root of ['nsu=urn:x;i=85', 'nsu=http://example.com/plant/;g=0190f4a8-0000-7000-8000-000000000001', 'nsu=urn:x;b=AAEC']) {
      const document = base();
      document.objects[0]!['source'] = { kind: 'opc_ua', root, typeDefinition: 'nsu=urn:x;i=1002' };
      assert.deepEqual(issues(document), [], root);
    }
  });

  test('a namespace index, a server in the manifest, a direct read, half a login, computed fields and empty browse levels are refused', () => {
    const indexed = base();
    indexed.objects[0]!['source'] = { kind: 'opc_ua', root: 'ns=2;s=Pumps' };
    assert.ok(issues(indexed).some((m) => m.includes('namespace URI')));

    const direct = base();
    direct.transport = { viaAgent: false };
    assert.ok(issues(direct).includes('OPC UA runs in the Silo Agent'));

    const addressed = base();
    addressed.transport = { viaAgent: true, baseUrl: 'https://plant.example.com' };
    assert.ok(issues(addressed).some((m) => m.includes('industrial endpoint')));

    const login = base();
    login.auth = { strategy: 'username_password', fields: [{ name: 'user', kind: 'public', label: 'User', role: 'username' }] };
    assert.deepEqual(issues(login), ['an OPC UA login is a username and a password']);
    login.auth = { strategy: 'username_password', fields: [
      { name: 'user', kind: 'public', label: 'User', role: 'username' }, { name: 'pass', kind: 'secret', label: 'Password', role: 'password' },
    ] };
    assert.deepEqual(issues(login), []);

    const computed = base();
    computed.objects[0]!['fields'] = [{ name: 'id', type: 'string', value: { jsonata: '$.x' } }];
    assert.ok(issues(computed).some((m) => m.includes('derived property')));

    const empty = base();
    empty.objects[0]!['fields'] = [{ name: 'id', type: 'string', path: 'Motor//Speed' }];
    assert.ok(issues(empty).some((m) => m.includes('no empty segment')));
  });

  test('a subscription streams an OPC UA object identified by its instance, with its sampling, queue and deadband', () => {
    const streamed = (identifierPath: string, extra: Record<string, unknown> = {}) => {
      const document = base() as Record<string, unknown> & ReturnType<typeof base>;
      document.objects[0]!['fields'] = [{ name: 'id', type: 'string', path: identifierPath }, { name: 'rpm', type: 'integer', path: 'Motor/Speed' }];
      return { ...document, changeStream: { objects: [{ object: 'pumps', sources: [{ kind: 'opcua', ...extra }] }] } };
    };
    const parsed = manifestSchema.parse(streamed('$browseName'));
    assert.deepEqual(parsed.changeStream!.objects[0]!.sources[0], { kind: 'opcua', samplingMs: 1_000, queueSize: 10 });
    assert.deepEqual(issues(streamed('$nodeId', { samplingMs: 0, deadband: { type: 'percent', value: 2.5 } })), []);
    assert.ok(issues(streamed('Serial')).includes('a subscribed OPC UA object is identified by its instance: $browseName or $nodeId'));
    assert.ok(issues(streamed('$browseName', { deadband: { type: 'percent', value: 120 } })).includes('a percent deadband is at most 100'));
  });

  test('setpoint updates: declared alone, physical, on an object identified by browse name (spec 47.1)', () => {
    const writable = (writes: Record<string, unknown>, identifierPath = '$browseName') => {
      const document = base();
      document.objects[0]!['fields'] = [{ name: 'id', type: 'string', path: identifierPath }, { name: 'rpm', type: 'integer', path: 'Motor/Speed' }];
      document.objects[0]!['writes'] = { bounds: { maxRows: 10 }, ...writes };
      return document;
    };
    assert.deepEqual(issues(writable({ update: {}, risk: 'physical' })), []);
    assert.ok(issues(writable({ update: {} })).includes('every OPC UA write is physical (47.1)'));
    assert.ok(issues(writable({ update: {}, create: {}, risk: 'physical' })).includes('an OPC UA object takes setpoint updates and method calls'));
    assert.ok(issues(writable({ update: { body: { jsonata: '$' } }, risk: 'physical' })).includes('an OPC UA update is the declaration alone: the agent writes each field\'s variable'));
    assert.ok(issues(writable({ update: {}, risk: 'physical' }, '$nodeId')).includes('a written OPC UA object is identified by its instances\' browse names ($browseName)'));
  });

  test('commands: a method call by browse path, no state, the input arguments it declares; an MQTT command to a topic with its payload schema (spec 47.1)', () => {
    const commanded = (custom: Record<string, unknown>[]) => {
      const document = base();
      document.objects[0]!['writes'] = { bounds: { maxRows: 10 }, risk: 'physical', custom };
      return document;
    };
    const start = { name: 'start', opcua: { method: 'Motor/Start' }, compensatedBy: 'stop' };
    const stop = { name: 'stop', opcua: { method: 'Motor/Stop' }, compensatedBy: 'start' };
    assert.deepEqual(issues(commanded([start, stop])), []);
    assert.deepEqual(manifestSchema.parse(commanded([start, stop])).objects[0]!.writes!.custom[0]!.changes, []);
    assert.ok(issues(commanded([{ name: 'start', request: { method: 'POST', path: '/start' } }])).includes('an OPC UA custom action names the method it calls'));
    assert.ok(issues(commanded([{ ...start, compensatedBy: undefined, body: { jsonata: '{"rpm": 5}' } }]))
      .includes('a method that takes no input arguments has no body'));
    // Input arguments (D245): each by its name and type, from an input of its own; an inverse takes none.
    const ramp = { name: 'ramp', opcua: { method: 'Motor/Ramp', arguments: [{ name: 'Rpm', type: 'Int32', input: 'rpm' }, { name: 'mode', type: 'String' }] } };
    assert.deepEqual(issues(commanded([ramp])), []);
    assert.deepEqual(issues(commanded([{ ...ramp, opcua: { method: 'Motor/Ramp', arguments: [{ name: 'Rpm', type: 'Int32' }] }, body: { jsonata: '{"Rpm": rpm}' } }])), []);
    assert.ok(issues(commanded([{ ...ramp, opcua: { method: 'Motor/Ramp', arguments: [{ name: 'Rpm', type: 'Int32' }] } }])).some((m) => m.startsWith('name the input Rpm')));
    assert.ok(issues(commanded([{ ...ramp, opcua: { method: 'Motor/Ramp', arguments: [{ name: 'Rpm', type: 'Int32', input: 'x' }, { name: 'Speed', type: 'Int32', input: 'x' }] } }]))
      .includes('each input argument is taken from an input of its own'));
    assert.ok(issues(commanded([{ ...ramp, opcua: { method: 'Motor/Ramp', arguments: [{ name: 'Rpm', type: 'Int64' }, { name: 'Rpm', type: 'Int32' }] }, body: { jsonata: '{}' } }]))
      .includes('a method names each input argument once'));
    assert.ok(issues(commanded([{ ...start, compensatedBy: 'ramp' }, ramp]))
      .includes('an inverse method takes no input arguments: it is called with none'));
    assert.ok(issues(commanded([{ ...start, compensatedBy: undefined, changes: ['rpm'] }]))
      .includes('a command has no state: it changes no field, and is verified by acknowledgement (47.6)'));
    assert.ok(issues(commanded([{ name: 'start', opcua: { method: 'Motor//Start' } }])).some((m) => m.includes('no empty level')));
    assert.ok(issues(commanded([{ name: 'start', opcua: { method: '$nodeId' } }])).some((m) => m.includes('a browse path')));

    // MQTT: a command published to a topic naming its record, with a declared payload schema.
    const mqtt = (writes: Record<string, unknown> | undefined) => ({
      schemaVersion: '1', identity: { name: 'Lines', provider: 'Example plant', version: '1.0.0' },
      transport: { viaAgent: true }, protocol: { kind: 'mqtt' }, auth: { strategy: 'none' },
      objects: [{
        name: 'lines', identifier: ['line'], fields: [{ name: 'line', type: 'string' }, { name: 'state', type: 'string' }],
        source: { kind: 'mqtt', topic: 'site/+/line/+/state', decode: { jsonata: '{"line": topic[3], "state": payload.state}' } },
        ...(writes === undefined ? {} : { writes: { bounds: { maxRows: 5 }, risk: 'physical', ...writes } }),
      }],
    });
    const run = { name: 'run', mqtt: { topic: 'site/a/line/{identifier}/cmd', schema: [{ name: 'run', type: 'boolean' }] }, compensatedBy: 'halt' };
    const halt = { name: 'halt', mqtt: { topic: 'site/a/line/{identifier}/cmd', payload: 'text' }, body: { jsonata: '"halt"' }, compensatedBy: 'run' };
    assert.deepEqual(issues(mqtt({ custom: [run, halt] })), []);
    assert.deepEqual(manifestSchema.parse(mqtt({ custom: [run, halt] })).objects[0]!.writes!.custom[0]!.mqtt, {
      topic: 'site/a/line/{identifier}/cmd', qos: 1, retained: false, payload: 'json', schema: [{ name: 'run', type: 'boolean', required: true }],
    });
    assert.ok(issues(mqtt({ custom: [run], risk: 'standard' })).includes('every MQTT publish is physical (47.1)'));
    assert.ok(issues(mqtt({ update: {}, custom: [] })).includes('an MQTT object publishes commands: its custom actions'));
    assert.ok(issues(mqtt({ custom: [{ name: 'run', opcua: { method: 'Start' } }] })).includes('an MQTT custom action names the command it publishes'));
    for (const topic of ['site/+/cmd', 'site/#', '$SYS/cmd', 'site/{line}/cmd', 'site/x{identifier}/cmd']) {
      assert.ok(issues(mqtt({ custom: [{ name: 'run', mqtt: { topic } }] })).some((m) => m.includes('no wildcard')), topic);
    }
    assert.ok(issues(mqtt({ custom: [{ name: 'run', mqtt: { topic: '{identifier}/{identifier}' } }] })).includes('the topic names the record once'));
    assert.ok(issues(mqtt({ custom: [{ name: 'run', mqtt: { topic: 'a/b', payload: 'text', schema: [{ name: 'x', type: 'string' }] } }] }))
      .includes('a text payload has no keys'));
  });
});
