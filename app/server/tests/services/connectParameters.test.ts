// Connection parameters against their manifest, without a database: the save-time check that
// keeps manifest patterns out of catastrophic backtracking, and the value checks (spec 14.3).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { manifestSchema } from '../../src/contracts/connect/manifest.contract.ts';
import { checkParameters, missingParameters, unsafePattern } from '../../src/services/connect-registry/parameters.service.ts';
import { restManifest } from './connect.helper.ts';

describe('parameter patterns (spec 14.3)', () => {
  test('ordinary patterns are accepted', () => {
    for (const pattern of ['[a-z0-9-]+', '[a-z][a-z0-9-]{0,62}', 'eu|uk|us', '\\d{4}-\\d{2}', '(?:prod|test)-[a-z]+', '[^/]+', 'a\\+b*', '(?<zone>[a-z]+)-\\d']) {
      assert.equal(unsafePattern(pattern), undefined, pattern);
    }
  });

  test('backtracking shapes are refused: nested repetition, repeated alternation, backreferences, lookaround, many repeats', () => {
    for (const pattern of ['(a+)+', '(a*)*', '((ab)+)+', '(a|b)+', '(?:x|xy){2,}', '(a)\\1', '(?<n>a)\\k<n>', '(?=a)', '(?!a)', '(?<=a)b', 'a+b+c+d+', '[a-z]*[0-9]*[a-z]*[0-9]*']) {
      assert.notEqual(unsafePattern(pattern), undefined, pattern);
    }
    assert.match(unsafePattern('(')!, /valid/);
  });

  test('checked patterns run fast on the longest value a parameter may have', () => {
    const started = performance.now();
    for (const pattern of ['[a-z]*[a-z]*[a-z]*x', '(?:ab|cd)?[a-z]+\\d+']) {
      assert.equal(unsafePattern(pattern), undefined);
      new RegExp(`^(?:${pattern})$`, 'u').test('a'.repeat(256));
    }
    assert.ok(performance.now() - started < 500);
  });
});

describe('parameter values', () => {
  const manifest = manifestSchema.parse(restManifest({
    baseUrl: 'https://{params.tenant}.crm.example/{params.base}',
    params: [{ name: 'tenant', label: 'Tenant' }, { name: 'base', label: 'Base' }, { name: 'zone', label: 'Zone', required: false, pattern: 'eu|uk' }],
  }));

  test('a host part is one DNS label; a path part may be anything bounded', () => {
    assert.deepEqual(checkParameters(manifest, { tenant: 'acme-1', base: 'v1/api' }), { tenant: 'acme-1', base: 'v1/api' });
    for (const tenant of ['a.b', 'evil.example/x', '-bad', 'a'.repeat(64)]) {
      assert.throws(() => checkParameters(manifest, { tenant }), { code: 'connection.parameter_invalid' }, tenant);
    }
    assert.throws(() => checkParameters(manifest, { base: 'x'.repeat(257) }), { code: 'connection.parameter_invalid' });
  });

  test('patterns are anchored; unknown names are refused; missing required ones are listed', () => {
    assert.throws(() => checkParameters(manifest, { zone: 'europe' }), { code: 'connection.parameter_invalid' });
    assert.throws(() => checkParameters(manifest, { zone: 'xeu' }), { code: 'connection.parameter_invalid' });
    assert.throws(() => checkParameters(manifest, { other: 'x' }), { code: 'connection.parameter_unknown' });
    assert.deepEqual(missingParameters(manifest, { zone: 'uk' }), ['tenant', 'base']);
  });
});
