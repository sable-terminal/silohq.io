// What a source's value becomes in a field of the manifest's type (connect-runtime's engine):
// here, the booleans of databases without a boolean type.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coerce } from '../../src/services/connect-runtime/engine.service.ts';

test('a boolean field takes true and false, their text, and 1 and 0; nothing else', () => {
  const stats = { pages: 0, sourceRows: 0, typeMismatches: 0, retries: 0 };
  assert.deepEqual([true, false, 'true', 'false', 1, 0].map((v) => coerce(v, 'boolean', stats)), [true, false, true, false, true, false]);
  assert.equal(stats.typeMismatches, 0);
  assert.deepEqual([2, -1, '1', 'yes'].map((v) => coerce(v, 'boolean', stats)), [null, null, null, null]);
  assert.equal(stats.typeMismatches, 4, 'each counted as a mismatch, never guessed');
});

test('a date field takes a date, or a moment at midnight UTC as its date; a moment in the day is a mismatch', () => {
  const stats = { pages: 0, sourceRows: 0, typeMismatches: 0, retries: 0 };
  assert.deepEqual(['2026-11-03', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00Z', '2026-11-03T00:00:00+00:00'].map((v) => coerce(v, 'date', stats)),
    ['2026-11-03', '2026-11-03', '2026-11-03', '2026-11-03']);
  assert.equal(stats.typeMismatches, 0);
  assert.equal(coerce('2026-11-03T10:00:00.000Z', 'date', stats), null, 'a time of day is never dropped silently');
  assert.equal(stats.typeMismatches, 1);
});
