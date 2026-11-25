// The Zod schemas: the column rules mirror Postgres (code points, spaces-only btrim, no
// NUL, 64-bit integers), the check translator reads Postgres's own definitions, and
// every generated schema loads and refuses what it should. Comparisons against a real
// database are in tests/db/schemas.test.ts.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { translateChecks, type SchemaColumn } from '../../src/db/scripts/generateSchemas.script.ts';
import { column, jsonbTextBytes } from '../../src/schemas/column.schema.ts';
import { newOrganisationSchema, organisationChangesSchema, organisationSchema } from '../../src/schemas/iam/index.schema.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

describe('column rules', () => {
  test('text counts characters as Postgres does, trims spaces only, and refuses NUL', () => {
    assert.equal(ok(column.text({ maxChars: 2 }), '😀😀'), true, 'two code points, four UTF-16 units');
    assert.equal(ok(column.text({ maxChars: 1 }), '😀😀'), false);
    assert.equal(ok(column.text({ maxBytes: 4 }), '😀'), true);
    assert.equal(ok(column.text({ maxBytes: 3 }), '😀'), false);
    assert.equal(ok(column.text({ nonBlank: true }), '   '), false);
    assert.equal(ok(column.text({ nonBlank: true }), '\t'), true, 'btrim(x) removes spaces only');
    assert.equal(ok(column.text(), 'a\u0000b'), false);
    assert.equal(ok(column.text({ pattern: /^a.b$/su }), 'a\nb'), true, 'in Postgres . matches a newline');
  });

  test('integers stay within their width; bigint is a string within 64 bits', () => {
    assert.equal(ok(column.int2(), 32_767), true);
    assert.equal(ok(column.int2(), 32_768), false);
    assert.equal(ok(column.int4({ gt: 0 }), 0), false);
    assert.equal(ok(column.int4(), 1.5), false);
    assert.equal(ok(column.int8(), '9223372036854775807'), true);
    assert.equal(ok(column.int8(), '9223372036854775808'), false);
    assert.equal(ok(column.int8({ gte: 0 }), '-1'), false);
    assert.equal(ok(column.int8(), 'abc'), false, 'a bad value is refused, not thrown');
  });

  test('numeric refuses digits beyond its precision before the point, and checks its range', () => {
    const confidence = column.numeric({ precision: 4, scale: 3, gte: 0, lte: 1 });
    assert.equal(ok(confidence, '0.951'), true);
    assert.equal(ok(confidence, '1.5'), false);
    assert.equal(ok(column.numeric({ precision: 4, scale: 3 }), '12.5'), false);
    assert.equal(ok(column.numeric(), '1e3'), false);
  });

  test('timestamps carry an offset; dates are calendar dates', () => {
    assert.equal(ok(column.timestamptz(), '2026-10-29T18:50:48.776638+00:00'), true);
    assert.equal(ok(column.timestamptz(), '2026-10-29T18:50:48Z'), true);
    assert.equal(ok(column.timestamptz(), '2026-10-29 18:50:48'), false);
    assert.equal(ok(column.date(), '2026-02-30'), false);
    assert.equal(ok(column.date(), '2026-10-29'), true);
  });

  test('bytes, JSON and arrays', () => {
    assert.equal(ok(column.bytes({ minBytes: 12, maxBytes: 12 }), Buffer.alloc(12)), true);
    assert.equal(ok(column.bytes({ minBytes: 12, maxBytes: 12 }), Buffer.alloc(11)), false);
    assert.equal(ok(column.json({ type: 'object' }), [1]), false);
    assert.equal(ok(column.json({ type: 'object' }), { a: 1 }), true);
    assert.equal(jsonbTextBytes({ a: [1, 2], b: 'x' }), '{"a": [1, 2], "b": "x"}'.length);
    assert.equal(ok(column.array(column.uuid(), { maxItems: 1 }), [uuidv7(), uuidv7()]), false);
    assert.equal(ok(column.vector(3), '[0.1,0.2,0.3]'), true);
    assert.equal(ok(column.vector(3), '[0.1,0.2]'), false);
    assert.equal(ok(column.uuid(), uuidv7().toUpperCase()), false, 'ids are lowercase, as Postgres prints them');
  });
});

describe('check translation', () => {
  const col = (name: string, pgType: string, checks: string[], pgElement: string | null = null): SchemaColumn => ({
    name, property: name, pgType, pgElement, typmod: -1, notNull: true, hasDefault: false, insertable: true, updatable: true, checks,
  });

  test('reads the forms Postgres prints', () => {
    assert.deepEqual(translateChecks(col('name', 'text', ['CHECK ((length(btrim(name)) > 0))'])).text, { nonBlank: 'true' });
    assert.deepEqual(translateChecks(col('slug', 'citext', ["CHECK (((slug)::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'::text))"])).text,
      { pattern: '/^[a-z0-9][a-z0-9-]{1,62}$/su' });
    assert.deepEqual(translateChecks(col('issuer', 'text', ['CHECK (((length(issuer) >= 1) AND (length(issuer) <= 2048)))'])).text,
      { minChars: '1', maxChars: '2048' });
    assert.deepEqual(translateChecks(col('nonce', 'bytea', ['CHECK (((nonce IS NULL) OR (octet_length(nonce) = 12)))'])).bytes,
      { minBytes: 12, maxBytes: 12 });
    assert.deepEqual(translateChecks(col('confidence', 'numeric',
      ['CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))'])).range, { gte: 0, lte: 1 });
    assert.deepEqual(translateChecks(col('status', 'text', ["CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))"])).enumValues,
      ['a', 'b']);
    assert.deepEqual(translateChecks(col('meta', 'jsonb',
      ["CHECK (((jsonb_typeof(meta) = 'object'::text) AND (octet_length((meta)::text) <= 65536)))"])).json,
      { type: "'object'", maxBytes: 65536 });
    assert.equal(translateChecks(col('shared', 'bool', ['CHECK ((shared = false))'])).literal, false);
    assert.equal(translateChecks(col('whole', 'bool', ['CHECK ((whole IS NOT FALSE))'])).literal, true);
  });

  test('leaves what it cannot translate to the database, keeping the parts it can', () => {
    const partial = translateChecks(col('email', 'citext',
      ["CHECK (((POSITION(('@'::text) IN (email)) > 1) AND (length(email) <= 320)))"]));
    assert.deepEqual(partial.text, { maxChars: '320' });
    assert.equal(partial.untranslated.length, 1);
    const either = translateChecks(col('k', 'text', ["CHECK (((k = 'a'::text) OR (k ~ '^x'::text)))"]));
    assert.deepEqual(either.text, {});
    assert.equal(either.untranslated.length, 1, 'an OR other than "is null" is never applied in part');
    const posix = translateChecks(col('w', 'text', ["CHECK ((w ~ '^[[:alpha:]]+$'::text))"]));
    assert.equal(posix.untranslated.length, 1, 'a POSIX class means something else in JavaScript');
  });
});

describe('generated schemas', () => {
  test('every schema folder loads', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/schemas');
    const folders = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    assert.ok(folders.length >= 17);
    for (const folder of folders) {
      const loaded = await import(path.join(root, folder, 'index.schema.ts')) as Record<string, unknown>;
      assert.ok(Object.values(loaded).every((s) => s instanceof z.ZodType), folder);
    }
  });

  test('insert and change schemas refuse unknown properties and columns that never change', () => {
    const insert = {
      id: uuidv7(), name: 'Acme', slug: 'acme', plan: 'business', cellId: 'uk-lon-1', calendarTimeZone: 'Europe/London',
    };
    assert.equal(ok(newOrganisationSchema, insert), true);
    assert.equal(ok(newOrganisationSchema, { ...insert, isSystem: true }), false, 'not insertable by a service');
    assert.equal(ok(newOrganisationSchema, { ...insert, slug: 'Acme Ltd' }), false);
    assert.equal(ok(newOrganisationSchema, { ...insert, status: undefined }), false, 'absent, not undefined');
    assert.equal(ok(organisationChangesSchema, { name: 'Acme Ltd' }), true);
    assert.equal(ok(organisationChangesSchema, { id: uuidv7() }), false, 'a key never changes');
    assert.equal(ok(organisationChangesSchema, { externalSharingPermitted: true }), false);
    assert.equal(ok(organisationSchema.shape.externalSharingPermitted, true), false, 'checked: always false');
  });
});
