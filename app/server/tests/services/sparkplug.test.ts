// Sparkplug B (spec 20.2: "a built-in decoder"; D211): the Tahu payload read from its wire
// format by datatype; the spBv1.0 topic namespace; metric aliases resolved by the edge node's or
// device's birth, reset by births and cleared by deaths, never guessed; the shared payload
// decoder for the snapshot read and the change stream; a Sparkplug object only on its namespace.
// Payloads here are built byte by byte, as an edge node would send them.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { manifestSchema } from '../../src/contracts/connect/manifest.contract.ts';
import { mqttObject } from '../../src/services/discovery/proposals.service.ts';
import { compileExpression } from '../../src/services/expression-evaluator/evaluator.service.ts';
import { decodeMqttPayload } from '../../src/services/connect-runtime/protocols/mqtt/payload.protocol.ts';
import { decodeSparkplug, SparkplugAliases, sparkplugTopic } from '../../src/services/connect-runtime/protocols/mqtt/sparkplug.protocol.ts';

// ----------------------------------------------------------------------------- a tiny encoder

function varint(value: bigint | number): Buffer {
  let v = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return Buffer.from(out);
}
const key = (field: number, wire: number) => varint((field << 3) | wire);
const vField = (field: number, value: bigint | number) => Buffer.concat([key(field, 0), varint(value)]);
const lField = (field: number, bytes: Buffer) => Buffer.concat([key(field, 2), varint(bytes.length), bytes]);
const f32 = (field: number, v: number) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return Buffer.concat([key(field, 5), b]); };
const f64 = (field: number, v: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return Buffer.concat([key(field, 1), b]); };

interface M { name?: string; alias?: number; datatype: number; value?: Buffer; isNull?: boolean }
const metric = (m: M) => Buffer.concat([
  ...(m.name === undefined ? [] : [lField(1, Buffer.from(m.name))]), ...(m.alias === undefined ? [] : [vField(2, m.alias)]),
  vField(4, m.datatype), ...(m.isNull === true ? [vField(7, 1)] : []), ...(m.value === undefined ? [] : [m.value]),
]);
const payload = (metrics: M[], seq = 0) => Buffer.concat([vField(1, 1_763_800_000_000), ...metrics.map((m) => lField(2, metric(m))), vField(3, seq)]);

describe('Sparkplug B (spec 20.2; D211)', () => {
  test('a payload\'s metrics by datatype: integers of each width and sign, 64-bit beyond 2^53 as text, floats, booleans, strings, bytes; unsupported kept with no value', () => {
    const decoded = decodeSparkplug(payload([
      { name: 'Int8', datatype: 1, value: vField(10, 0xfffffffb) },
      { name: 'Int32', datatype: 3, value: vField(10, 0xfffe7960) },
      { name: 'UInt16', datatype: 6, value: vField(10, 65_000) },
      { name: 'Int64', datatype: 4, value: vField(11, -9_007_199_254_740_993n) },
      { name: 'UInt64', datatype: 8, value: vField(11, 18_446_744_073_709_551_615n) },
      { name: 'Small64', datatype: 4, value: vField(11, -42) },
      { name: 'Float', datatype: 9, value: f32(12, 1.5) },
      { name: 'Double', datatype: 10, value: f64(13, 2.25) },
      { name: 'Running', datatype: 11, value: vField(14, 1) },
      { name: 'State', datatype: 12, value: lField(15, Buffer.from('running')) },
      { name: 'At', datatype: 13, value: vField(11, 1_763_800_000_123) },
      { name: 'Blob', datatype: 17, value: lField(16, Buffer.from([1, 2, 3])) },
      { name: 'Table', datatype: 16, value: lField(17, Buffer.from([0x08, 0x01])) },
      { name: 'Gone', datatype: 10, isNull: true },
    ], 7));
    assert.deepEqual([decoded.timestamp, decoded.seq], [1_763_800_000_000, 7]);
    const value = (n: string) => decoded.metrics.find((m) => m.name === n)!;
    assert.deepEqual(decoded.metrics.slice(0, 12).map((m) => m.value), [
      -5, -100_000, 65_000, '-9007199254740993', '18446744073709551615', -42, 1.5, 2.25, true, 'running', 1_763_800_000_123, 'AQID',
    ]);
    assert.deepEqual([value('Table').unsupported, value('Table').value, value('Table').datatype], [true, null, 'DataSet']);
    assert.deepEqual([value('Gone').isNull, value('Gone').value], [true, null]);
    assert.throws(() => decodeSparkplug(Buffer.from([0x12, 0x40, 0x01])), /past the end/);
  });

  test('the topic namespace: spBv1.0/<group>/<type>/<edge node>[/<device>]; anything else, and STATE, is not a metric topic', () => {
    assert.deepEqual(sparkplugTopic('spBv1.0/Plant1/DDATA/Edge7/Pump3'), { groupId: 'Plant1', messageType: 'DDATA', edgeNodeId: 'Edge7', deviceId: 'Pump3' });
    assert.deepEqual(sparkplugTopic('spBv1.0/Plant1/NBIRTH/Edge7')?.deviceId, null);
    for (const t of ['spBv1.0/STATE/host', 'spAv1.0/Plant1/NDATA/Edge7', 'spBv1.0/Plant1/NOPE/Edge7', 'spBv1.0//NDATA/Edge7', 'site/1/temp']) assert.equal(sparkplugTopic(t), undefined, t);
  });

  test('aliases: defined by the birth, used alone in data, reset by a rebirth, cleared by a death; one not yet defined is counted, never guessed', () => {
    const aliases = new SparkplugAliases();
    const at = (type: string, device?: string) => sparkplugTopic(`spBv1.0/Plant1/${type}/Edge7${device === undefined ? '' : `/${device}`}`)!;
    aliases.resolve('conn', at('NBIRTH'), decodeSparkplug(payload([{ name: 'Node/Uptime', alias: 1, datatype: 7, value: vField(10, 0) }])));
    aliases.resolve('conn', at('DBIRTH', 'Pump3'), decodeSparkplug(payload([{ name: 'Speed', alias: 10, datatype: 10, value: f64(13, 0) }])));
    const data = aliases.resolve('conn', at('DDATA', 'Pump3'), decodeSparkplug(payload([{ alias: 10, datatype: 10, value: f64(13, 1450) }, { alias: 99, datatype: 10, value: f64(13, 1) }])));
    assert.deepEqual([data.metrics.map((m) => [m.name, m.value]), data.unresolved], [[['Speed', 1450]], 1]);
    assert.equal(aliases.resolve('other', at('DDATA', 'Pump3'), decodeSparkplug(payload([{ alias: 10, datatype: 10, value: f64(13, 1) }]))).unresolved, 1,
      'kept per connection');
    aliases.resolve('conn', at('NDEATH'), decodeSparkplug(payload([])));
    assert.equal(aliases.resolve('conn', at('DDATA', 'Pump3'), decodeSparkplug(payload([{ alias: 10, datatype: 10, value: f64(13, 1) }]))).unresolved, 1,
      'the node\'s death clears it and its devices');
  });

  test('the shared decoder: JSON, text and Sparkplug B as declared, each refused when it is not what is declared', () => {
    const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
    assert.deepEqual(decodeMqttPayload({ payload: 'json' }, 'c', 'site/1/temp', b64('{"celsius":21}')), { ok: true, payload: { celsius: 21 } });
    assert.deepEqual(decodeMqttPayload({ payload: 'json' }, 'c', 'site/1/temp', b64('21 C')), { ok: false, reason: 'not_json' });
    assert.deepEqual(decodeMqttPayload({ payload: 'text' }, 'c', 'site/1/temp', b64('21 C')), { ok: true, payload: '21 C' });
    const out = decodeMqttPayload({ payload: 'sparkplug_b' }, 'c', 'spBv1.0/Plant1/NDATA/Edge7', b64(payload([{ name: 'Temperature', datatype: 10, value: f64(13, 21.5) }], 3)));
    assert.equal(out.ok, true);
    const p = (out as { payload: Record<string, unknown> }).payload;
    assert.deepEqual([p['messageType'], p['edgeNodeId'], p['deviceId'], p['seq'], p['values']], ['NDATA', 'Edge7', null, 3, { Temperature: 21.5 }]);
    assert.deepEqual(decodeMqttPayload({ payload: 'sparkplug_b' }, 'c', 'site/1/temp', b64(payload([]))), { ok: false, reason: 'not_sparkplug_topic' });
    assert.deepEqual(decodeMqttPayload({ payload: 'sparkplug_b' }, 'c', 'spBv1.0/Plant1/NDATA/Edge7', b64(Buffer.from([0x12, 0x40]))), { ok: false, reason: 'not_sparkplug' });
  });

  test('discovery proposes a Sparkplug family as an object: births and data of the group\'s devices, by edge node and device, each metric by name', async () => {
    const plan = mqttObject({ filter: 'spBv1.0/Plant1/DDATA/+/+', topics: 4, encoding: 'sparkplug_b', fields: [{ name: 'Speed', type: 'number' }, { name: 'Running', type: 'boolean' }] });
    assert.deepEqual([plan.name, plan.topic, plan.identifier, plan.fields.map((f) => [f.name, f.type])],
      ['plant1_devices', 'spBv1.0/Plant1/+/+/+', ['edge_node', 'device'], [['edge_node', 'string'], ['device', 'string'], ['speed', 'number'], ['running', 'boolean']]]);
    const decode = compileExpression('source.decode', 'jsonata', plan.decode);
    const message = (type: string) => decodeMqttPayload({ payload: 'sparkplug_b' }, 'disc', `spBv1.0/Plant1/${type}/Edge7/Pump3`,
      payload([{ name: 'Speed', datatype: 10, value: f64(13, 900) }, { name: 'Running', datatype: 11, value: vField(14, 1) }]).toString('base64'));
    const evaluate = async (type: string) => decode.evaluate({ input: { topic: [], payload: (message(type) as { payload: unknown }).payload, receivedAt: '' }, params: {} }, new Date());
    assert.deepEqual(await evaluate('DDATA'), { edge_node: 'Edge7', device: 'Pump3', speed: 900, running: true });
    assert.equal(await evaluate('DDEATH') ?? null, null, 'a death carries no values');
  });

  test('a Sparkplug B object reads its namespace only', () => {
    const doc = (topic: string) => ({
      schemaVersion: '1', identity: { name: 'Plant', provider: 'Example plant', version: '1.0.0' }, transport: { viaAgent: true }, protocol: { kind: 'mqtt' },
      auth: { strategy: 'none' },
      objects: [{
        name: 'pumps', identifier: ['id'], fields: [{ name: 'id', type: 'string' }, { name: 'speed', type: 'number' }],
        source: { kind: 'mqtt', topic, payload: 'sparkplug_b', decode: { jsonata: '{ "id": payload.deviceId, "speed": payload.values.Speed }' } },
      }],
    });
    assert.equal(manifestSchema.safeParse(doc('spBv1.0/Plant1/DDATA/+/+')).success, true);
    const off = manifestSchema.safeParse(doc('plant/+/pumps'));
    assert.equal(off.success, false);
    assert.ok(off.error!.issues.some((i) => i.message.includes('spBv1.0')));
  });
});
