// Typed logging (spec 13.1) and health checks.

import assert from 'node:assert/strict';
import { createRequestSignals } from '../../src/infra/signals.infra.ts';
import { describe, test } from 'node:test';
import { Health } from '../../src/infra/health.infra.ts';
import { createLogger, REDACTED_MESSAGE, type LogFields } from '../../src/infra/logger.infra.ts';
import { AppError } from '../../src/utils/errors.util.ts';
import type { RecordValue } from '../../src/utils/recordValue.util.ts';
import { sleep } from '../../src/utils/time.util.ts';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const violations: string[][] = [];
  const logger = createLogger({
    service: 'executor', cell: 'uk-lon-1', release: 'r1', level: 'info',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    onViolation: (kinds) => violations.push(kinds),
  });
  return { logger, lines, violations };
}

describe('logger', () => {
  test('writes allowed fields and drops everything else', () => {
    const { logger, lines } = capture();
    logger.info('plan executed', { planId: 'p1', rowCount: 42, durationMs: 12, ...({ rows: [{ email: 'x' }], secret: 's' } as LogFields) });
    assert.equal(lines.length, 1);
    const { time, ...rest } = lines[0]!;
    assert.match(String(time), /^\d{4}-/);
    assert.deepEqual(rest, {
      level: 'info', message: 'plan executed', service: 'executor', cell: 'uk-lon-1', release: 'r1',
      planId: 'p1', rowCount: 42, durationMs: 12,
    });
  });

  test('a value pattern in a message or field is removed and counted', () => {
    const { logger, lines, violations } = capture();
    logger.warn(`lookup failed for ada@acme.example` as string, { resourceId: '4111111111111111', count: 1 });
    assert.equal(lines[0]!['message'], REDACTED_MESSAGE);
    assert.equal('resourceId' in lines[0]!, false);
    assert.equal(lines[0]!['count'], 1);
    assert.deepEqual(violations, [['email'], ['card_number', 'long_digit_string']]);
  });

  test('a violation names the organisation the line was about, so its audit log can record it (D209); the signals count it', async () => {
    const named: (string | undefined)[] = [];
    const lines: string[] = [];
    const org = '0190f3a1-2b3c-7d4e-8f90-123456789abc';
    const logger = createLogger({
      service: 'test', cell: 'test', release: 'test', level: 'info', write: (line) => lines.push(line), onViolation: (_kinds, organisationId) => named.push(organisationId),
    }, { organisationId: org });
    logger.info('sent to someone@example.com');
    logger.child({ organisationId: 'not-an-id' }).info('call 4111 1111 1111 1111');
    assert.deepEqual(named, [org, undefined], 'by identifier only');
    const signals = createRequestSignals();
    signals.redaction(org, ['email']);
    signals.redaction(org, ['card_number']);
    assert.deepEqual((await signals.snapshot()).redactions, [{ organisationId: org, count: 2, kinds: ['card_number', 'email'] }]);
    assert.equal((await createRequestSignals().snapshot()).redactions, undefined, 'absent when there are none');
  });

  test('a record value does not compile as a log field', () => {
    const { logger } = capture();
    const value = 'ada@acme.example' as RecordValue<string>;
    // @ts-expect-error typed logging cannot accept record-value types (spec 13.1)
    logger.info('row', { resourceId: value });
  });

  test('errors are logged by category and class, never by message', () => {
    const { logger, lines } = capture();
    logger.failure('query failed', Object.assign(new Error('Key (email)=(ada@acme.example) already exists'), { code: '23505' }));
    logger.failure('refused', new AppError('bounds', 'refused: rows', { code: 'bound.rows' }));
    assert.deepEqual([lines[0]!['level'], lines[0]!['errorCategory'], lines[0]!['errorClass']], ['error', 'internal', 'Error']);
    assert.ok(!JSON.stringify(lines).includes('ada@'));
    assert.deepEqual([lines[1]!['level'], lines[1]!['refusal']], ['info', true], 'a refusal is not an error');
  });

  test('child loggers carry their context, and levels below the threshold are skipped', () => {
    const { logger, lines } = capture();
    logger.child({ organisationId: 'o1', correlationId: 'c1' }).debug('hidden');
    logger.child({ organisationId: 'o1', correlationId: 'c1' }).info('shown', { count: 2 });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!['organisationId'], 'o1');
  });
});

describe('health', () => {
  test('a check that does not answer in time fails (spec 11.2)', async () => {
    const health = new Health()
      .register({ name: 'fast', check: async () => undefined })
      .register({ name: 'slow', timeoutMs: 20, check: () => sleep(1_000) })
      .register({ name: 'down', check: async () => { throw new AppError('unavailable', 'down'); } });
    const { ok, checks } = await health.readiness();
    assert.equal(ok, false);
    assert.deepEqual(checks.map((c) => [c.name, c.ok, c.errorCategory]),
      [['fast', true, undefined], ['slow', false, 'timeout'], ['down', false, 'unavailable']]);
  });
});
