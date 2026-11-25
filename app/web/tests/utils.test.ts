// The client's pure helpers: where a floating panel goes, how times, sizes and counts are
// written, which redirects are safe, what an organisation's short name becomes, and the one
// address each kind of thing has.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { appHref, hitHref, objectHref, viewHref } from '../src/navigation/links.navigation.ts';
import { formatBytes, formatDuration, formatRelative, humanise, plural } from '../src/utils/format.util.ts';
import { hrefWith, safeNext, signInHref } from '../src/utils/href.util.ts';
import { placement } from '../src/utils/position.util.ts';
import { slugOf } from '../src/utils/slug.util.ts';

const viewport = { width: 1000, height: 800 };

describe('floating panels', () => {
  test('below its anchor, aligned to its start, when it fits', () => {
    assert.deepEqual(placement({ top: 10, left: 100, width: 40, height: 30 }, { width: 200, height: 100 }, viewport, 'bottom', 'start'), { top: 46, left: 100, side: 'bottom' });
  });
  test('flipped above when there is no room below, and kept inside the viewport', () => {
    const at = placement({ top: 760, left: 950, width: 40, height: 30 }, { width: 200, height: 100 }, viewport, 'bottom', 'start');
    assert.equal(at.side, 'top');
    assert.equal(at.top, 654);
    assert.equal(at.left, 792, 'clamped 8px from the right edge');
  });
  test('beside a collapsed sidebar item, to its right', () => {
    const at = placement({ top: 100, left: 8, width: 40, height: 36 }, { width: 160, height: 200 }, viewport, 'right', 'start');
    assert.deepEqual(at, { top: 100, left: 54, side: 'right' });
  });
});

describe('formatting', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  test('moments relative to now', () => {
    assert.equal(formatRelative('2026-11-24T11:59:55Z', now), 'just now');
    assert.equal(formatRelative('2026-11-24T11:55:00Z', now), '5 minutes ago');
    assert.equal(formatRelative('2026-11-24T14:00:00Z', now), 'in 2 hours');
    assert.equal(formatRelative('2026-11-23T12:00:00Z', now), 'yesterday');
    assert.equal(formatRelative(null, now), '—');
  });
  test('sizes, durations, counts and machine words', () => {
    assert.equal(formatBytes(1), '1 byte');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(50 * 1024 * 1024), '50 MB');
    assert.equal(formatDuration(450), '450 ms');
    assert.equal(formatDuration(125_000), '2 min 5 s');
    assert.equal(formatDuration(3 * 3_600_000), '3 h');
    assert.equal(plural(1, 'connection'), '1 connection');
    assert.equal(plural(1200, 'entity', 'entities'), '1,200 entities');
    assert.equal(humanise('source_unreachable'), 'Source unreachable');
    assert.equal(humanise('waitingOnCustomer'), 'Waiting on customer');
  });
});

describe('addresses', () => {
  test('after sign-in, only this client\'s own pages', () => {
    assert.equal(safeNext('/connect/connections/?connection=x'), '/connect/connections/?connection=x');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '/api/v1/session', '/sign-in/?next=/', 'javascript:alert(1)', '/x\u0000y', null, '']) {
      assert.equal(safeNext(bad), '/', String(bad));
    }
    assert.equal(signInHref('/governance/crons/'), '/sign-in/?next=%2Fgovernance%2Fcrons%2F');
    assert.equal(signInHref('/', 'mfa'), '/sign-in/?step=mfa');
    assert.equal(hrefWith('/a/', { b: 1, c: undefined, d: '' }), '/a/?b=1');
  });
  test('one address for each kind of thing', () => {
    const type = '01a20e94-3c00-732b-b1b9-c39a97b2468d';
    assert.equal(objectHref({ objectTypeId: type, objectId: 'abc' }), `/explorer/object/?type=${type}&id=abc`);
    assert.equal(hitHref({ objectTypeId: type, identifier: 'P 101', sources: [{ connectionId: 'c1' }] }), `/explorer/object/?type=${type}&connection=c1&ref=P+101`);
    assert.equal(hitHref({ objectTypeId: type, identifier: 'silo-id', sources: [] }), `/explorer/object/?type=${type}&id=silo-id`);
    assert.equal(viewHref('v', 'object_set'), '/explorer/types/?view=v');
    assert.equal(viewHref('v', 'table'), '/ask/views/?view=v');
    assert.equal(appHref('a', 3), '/studio/apps/?app=a&version=3');
  });
  test('an organisation\'s short name from its name', () => {
    assert.equal(slugOf('Northwind Water Ltd'), 'northwind-water-ltd');
    assert.equal(slugOf('  Café & Co. '), 'cafe-co');
    assert.equal(slugOf('ACME--Widgets!!'), 'acme-widgets');
  });
});

describe('values in free text', async () => {
  const { valuesIn } = await import('../src/utils/values.util.ts');
  const { findValuePatterns } = await import('../../server/src/utils/redaction.util.ts');
  test('the browser warns of exactly what the server refuses', () => {
    const samples = [
      'Customer jo.bloggs@example.com cannot see orders', 'Card 4111 1111 1111 1111 was charged twice', 'NI number QQ 12 34 56 C',
      'Account 12345678901 is wrong', `token silo_ses_${'a'.repeat(43)}`, 'The connection 01a20e94-3c00-732b-b1b9-c39a97b2468d fails',
      'Testing fails since 09:30 on 24 Nov', 'Order 1234 is late', '4111 1111 1111 1112 is not a card',
    ];
    for (const text of samples) assert.deepEqual(valuesIn(text).sort(), [...findValuePatterns(text)].sort(), text);
    assert.deepEqual(valuesIn('The connection 01a20e94-3c00-732b-b1b9-c39a97b2468d fails'), [], 'an id is a reference, not a value');
  });
});
