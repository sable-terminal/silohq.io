// The bounded expression evaluator (spec 14.2): what each block may read, the bounds that
// stop an expression from inside, the refusals at compile, and a randomised run that
// every evaluation either returns or refuses quickly, never hangs or leaks a value.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compileExpression, checkManifestExpressions } from '../../src/services/expression-evaluator/evaluator.service.ts';
import { canonicalQuery, hex, hmacSha256, parseLinkHeader } from '../../src/services/expression-evaluator/library.service.ts';
import { manifestSchema } from '../../src/contracts/connect/manifest.contract.ts';
import { isAppError } from '../../src/utils/errors.util.ts';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const cel = (block: Parameters<typeof compileExpression>[0], source: string) => compileExpression(block, 'cel', source);
const jsonata = (block: Parameters<typeof compileExpression>[0], source: string) => compileExpression(block, 'jsonata', source);

async function refused(work: () => unknown, code: string): Promise<Record<string, unknown>> {
  try {
    await work();
  } catch (error) {
    assert.ok(isAppError(error), `an AppError, not ${String(error)}`);
    assert.equal(error.code, code);
    return { ...error.details, message: error.message };
  }
  assert.fail(`expected ${code}`);
}

describe('the library', () => {
  test('HMAC-SHA256 matches RFC 4231 test case 2', () => {
    assert.equal(hex(hmacSha256('Jefe', 'what do ya want for nothing?')), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  test('canonical query strings sort and encode; link headers parse', () => {
    assert.equal(canonicalQuery({ b: 'x y', a: 2, 'c~': "it's" }), 'a=2&b=x%20y&c~=it%27s');
    assert.deepEqual(parseLinkHeader('<https://api.example.com/x?page=2>; rel="next", <https://api.example.com/x?page=9>; rel="last"'),
      { next: 'https://api.example.com/x?page=2', last: 'https://api.example.com/x?page=9' });
  });
});

describe('CEL blocks', () => {
  test('paging returns the next request patch, or stops', async () => {
    const next = cel('paging.next', 'has(response.body.paging) ? {"query": {"after": response.body.paging.next.after}} : stop()');
    assert.deepEqual(await next.evaluate({ response: { body: { paging: { next: { after: 'abc' } } } } }, NOW), { query: { after: 'abc' } });
    assert.equal(await next.evaluate({ response: { body: {} } }, NOW), null);
    const offset = cel('paging.next', 'page.records < 100 ? dyn(null) : {"query": {"offset": page.received}}');
    assert.deepEqual(await offset.evaluate({ page: { records: 100, received: 300 } }, NOW), { query: { offset: 300 } });
  });

  test('error rules and retry delays read status, headers and body', async () => {
    const when = cel('errors.when', 'status == 400 && body.error.type == "RATE_LIMIT"');
    assert.equal(await when.evaluate({ status: 400, headers: {}, body: { error: { type: 'RATE_LIMIT' } } }, NOW), true);
    const after = cel('errors.retryAfter', 'int(headers["retry-after"])');
    assert.equal(await after.evaluate({ status: 429, headers: { 'retry-after': '7' }, body: null }, NOW), 7);
  });

  test('a secret is nameable in auth.sign only, and signs the request', async () => {
    await refused(() => cel('paging.next', 'secret.key'), 'expression.invalid');
    await refused(() => cel('errors.when', 'secret.key == "x"'), 'expression.invalid');
    const sign = cel('auth.sign', String.raw`{"headers": {"X-Key-Id": public.key_id, "X-Timestamp": string(epoch_seconds(now)),
      "X-Signature": hex(hmac_sha256(secret.signing_key, request.method + "\n" + request.path + "\n" + canonical_query(request.query) + "\n" + string(epoch_seconds(now))))}}`);
    const signed = await sign.evaluate({ request: { method: 'GET', path: '/v1/x', query: { b: '2', a: '1' } }, public: { key_id: 'k1' }, secret: { signing_key: 'shh' } }, NOW) as { headers: Record<string, string> };
    const expected = hex(hmacSha256('shh', `GET\n/v1/x\na=1&b=2\n${NOW.getTime() / 1000}`));
    assert.deepEqual(signed, { headers: { 'X-Key-Id': 'k1', 'X-Timestamp': String(NOW.getTime() / 1000), 'X-Signature': expected } });
  });

  test('a nested comprehension is stopped at the step budget, quickly', async () => {
    const quadratic = cel('paging.next', 'response.body.items.map(a, response.body.items.map(b, a + b)).size() > 0 ? {"query": {}} : stop()');
    const items = Array.from({ length: 2_000 }, (_, i) => i);
    const started = performance.now();
    const details = await refused(() => quadratic.evaluate({ response: { body: { items } } }, NOW), 'expression.budget');
    assert.equal(details['bound'], 'steps');
    assert.ok(performance.now() - started < 100, 'refused well inside the budget');
  });

  test('the wrong shape, an integer beyond 2^53 and a failing access are refused without quoting values', async () => {
    await refused(() => cel('paging.next', '{"query": {"page": 1}, "extra": 1}').evaluate({}, NOW), 'expression.result_shape');
    await refused(() => cel('paging.next', '{"query": {"n": 9007199254740993}}').evaluate({}, NOW), 'expression.integer_range');
    const details = await refused(() => cel('errors.when', 'int(body.token) > 0').evaluate({ status: 200, body: { token: 'tok_secret_value' } }, NOW),
      'expression.failed');
    assert.ok(!JSON.stringify(details).includes('tok_secret_value'));
  });

  test('a block in the wrong language, or an unknown name, is refused at compile', async () => {
    await refused(() => compileExpression('records', 'cel', 'true'), 'expression.invalid');
    const details = await refused(() => cel('paging.next', 'credentials.token'), 'expression.invalid');
    assert.equal(details['stage'], 'type');
    await refused(() => cel('paging.next', '{{{'), 'expression.invalid');
  });
});

describe('JSONata blocks', () => {
  test('records unwrap an envelope; fields compute from the record', async () => {
    const records = jsonata('records', 'results');
    assert.deepEqual(await records.evaluate({ input: { results: [{ id: 1 }, { id: 2 }] } }, NOW), [{ id: 1 }, { id: 2 }]);
    const name = jsonata('field', 'properties.firstname & " " & properties.lastname');
    assert.equal(await name.evaluate({ input: { properties: { firstname: 'Ada', lastname: 'Lovelace' } } }, NOW), 'Ada Lovelace');
  });

  test('now is the injected one; the real clock and randomness are not reachable', async () => {
    assert.equal(await jsonata('field', '$now()').evaluate({ input: {} }, NOW), NOW.toISOString());
    assert.equal(await jsonata('field', '$millis()').evaluate({ input: {} }, NOW), NOW.getTime());
    await refused(() => jsonata('field', '$random()'), 'expression.invalid');
    await refused(() => jsonata('field', '$shuffle([1,2])'), 'expression.invalid');
    await refused(() => jsonata('field', '$eval("1 + 1")'), 'expression.invalid');
  });

  test('no credential is in scope', async () => {
    for (const name of ['secret', 'credential', 'token', 'password', 'env', 'connection']) {
      assert.equal(await jsonata('field', `$${name}`).evaluate({ input: {}, secret: 'x', token: 'y' }, NOW), null, name);
    }
  });

  test('recursion is refused at compile, and indirect recursion is stopped at run time', async () => {
    await refused(() => jsonata('field', '($f := function($n){ $n <= 0 ? 0 : 1 + $f($n - 1) }; $f(10))'), 'expression.invalid');
    const indirect = jsonata('field', '($y := function($g, $n){ $n <= 0 ? 0 : 1 + $g($g, $n - 1) }; $y($y, 100000))');
    const started = performance.now();
    await refused(() => indirect.evaluate({ input: {} }, NOW), 'expression.budget');
    assert.ok(performance.now() - started < 200);
  });

  test('ranges, padding and output size are bounded', async () => {
    await refused(() => jsonata('field', '[1..10000000]'), 'expression.invalid');
    await refused(() => jsonata('field', '[1..$count($)]'), 'expression.invalid');
    assert.equal((await jsonata('field', '$count([1..100])').evaluate({ input: {} }, NOW)), 100);
    await refused(() => jsonata('field', '$pad("x", 100000000)').evaluate({ input: {} }, NOW), 'expression.budget');
    const big = Array.from({ length: 5_000 }, (_, i) => ({ id: i, text: 'x'.repeat(20) }));
    await refused(() => jsonata('field', '$').evaluate({ input: big }, NOW), 'expression.budget');
  });
});

describe('randomised expressions', () => {
  // A small grammar over the paging inputs; every evaluation must return or refuse with an
  // AppError in well under its budget, whatever the input.
  const pick = <T>(xs: readonly T[], r: () => number): T => xs[Math.floor(r() * xs.length)]!;
  const atoms = ['page.number', 'page.records', 'response.status', '"x"', '1', '2.5', 'true', 'null', 'response.body.items',
    'response.body.next', 'size(response.body.items)', 'request.query'];
  const ops = ['+', '-', '*', '==', '!=', '<', '&&', '||', 'in'];
  function expression(r: () => number, depth: number): string {
    if (depth <= 0 || r() < 0.3) return pick(atoms, r);
    const kind = r();
    if (kind < 0.4) return `(${expression(r, depth - 1)} ${pick(ops, r)} ${expression(r, depth - 1)})`;
    if (kind < 0.6) return `response.body.items.map(i, ${expression(r, depth - 1)})`;
    if (kind < 0.8) return `(${expression(r, depth - 1)} ? ${expression(r, depth - 1)} : ${expression(r, depth - 1)})`;
    return `response.body.items.filter(i, ${expression(r, depth - 1)}).size()`;
  }

  test('CEL: 500 random expressions over random inputs', async () => {
    let seed = 42;
    const r = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    let compiled = 0;
    for (let i = 0; i < 500; i++) {
      const source = `${expression(r, 4)} == null ? stop() : {"query": {"n": "1"}}`;
      let program;
      try {
        program = cel('paging.next', source);
      } catch (error) {
        assert.ok(isAppError(error) && error.code === 'expression.invalid', source);
        continue;
      }
      compiled += 1;
      const items = Array.from({ length: Math.floor(r() * 3_000) }, (_, k) => (r() < 0.5 ? k : `s${k}`));
      const started = performance.now();
      try {
        await program.evaluate({ page: { number: 1, records: items.length }, response: { status: 200, body: { items, next: r() < 0.5 ? 'c' : null } }, request: { query: {} } }, NOW);
      } catch (error) {
        assert.ok(isAppError(error), `${source}: ${String(error)}`);
        assert.ok(['expression.budget', 'expression.failed', 'expression.result_shape', 'expression.integer_range'].includes(error.code), error.code);
      }
      assert.ok(performance.now() - started < 150, `${source} took too long`);
    }
    assert.ok(compiled > 50, `only ${compiled} compiled`);
  });

  test('JSONata: random paths and functions over random documents', async () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const parts = ['a', 'b.c', 'items', 'items[0]', '$count(items)', '$string(a)', 'items.v', '$sum(items.v)', '$keys($)', 'items[v > 2]',
      '$map(items, function($x){ $x.v * 2 })', '$join(items.$string(v), ",")', '$sort(items, function($l, $r){ $l.v > $r.v })'];
    for (let i = 0; i < 300; i++) {
      const source = `${pick(parts, r)} ${pick(['&', '+', '=', 'and'], r)} ${pick(parts, r)}`;
      let program;
      try {
        program = jsonata('field', source);
      } catch (error) {
        assert.ok(isAppError(error) && error.code === 'expression.invalid', source);
        continue;
      }
      const input = { a: r() < 0.5 ? 1 : 'x', b: { c: [1, 2] }, items: Array.from({ length: Math.floor(r() * 2_000) }, (_, k) => ({ v: k })) };
      const started = performance.now();
      try {
        await program.evaluate({ input }, NOW);
      } catch (error) {
        assert.ok(isAppError(error), `${source}: ${String(error)}`);
      }
      assert.ok(performance.now() - started < 250, `${source} took too long`);
    }
  });
});

describe('manifest expressions are checked at save', () => {
  test('every expression of a manifest compiles for its block, or is reported by path', () => {
    const manifest = manifestSchema.parse({
      schemaVersion: '1',
      identity: { name: 'Example CRM', provider: 'Example', version: '1.0.0' },
      transport: { viaAgent: false, baseUrl: 'https://api.example.com' },
      protocol: { kind: 'rest' },
      auth: { strategy: 'none' },
      errors: { classify: [{ when: { cel: 'secret.x == 1' }, meaning: 'auth' }] },
      objects: [{
        name: 'contacts', identifier: ['id'], fields: [{ name: 'id', type: 'string' }],
        source: { kind: 'rest', request: { method: 'GET', path: '/contacts' }, records: { jsonata: '$eval("x")' },
          paging: { next: { cel: 'stop()' }, maxPages: 10 } },
      }],
    });
    const issues = checkManifestExpressions(manifest);
    assert.deepEqual(issues.map((i) => i.path).sort(), ['errors.classify.0.when', 'objects.0.source.records']);
  });
});

describe('regular expressions', () => {
  test('are refused in both languages: one native call is beyond the meter', async () => {
    await refused(() => cel('errors.when', 'body.message.matches("^(a+)+$")'), 'expression.invalid');
    await refused(() => jsonata('field', '$match(name, /^(a+)+$/)'), 'expression.invalid');
    await refused(() => jsonata('field', '$replace(name, /a/, "b")'), 'expression.invalid');
    assert.equal(await jsonata('field', '$replace(name, "a", "b")').evaluate({ input: { name: 'banana' } }, NOW), 'bbnbnb');
  });
});
