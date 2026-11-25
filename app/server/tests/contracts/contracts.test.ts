// Service contracts refuse a definition that would let the two sides disagree, or break
// spec 7.1's rules on callers and idempotency.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { defineContract, definedContracts } from '../../src/contracts/endpoint.contract.ts';
import { route } from '../../src/infra/http.infra.ts';

const note = z.object({ id: z.uuid(), text: z.string() });

describe('contracts', () => {
  test('a contract carries its schemas, callers and defaults', () => {
    const getNote = defineContract({
      service: 'workspace', name: 'readNote', method: 'GET', path: '/v1/notes/:noteId', callers: ['gateway'],
      context: 'organisation', idempotency: 'none', params: z.object({ noteId: z.uuid() }), response: note,
    });
    assert.equal(getNote.id, 'workspace.readNote');
    assert.deepEqual(getNote.pathParams, ['noteId']);
    assert.equal(getNote.status, 200);
    assert.ok(definedContracts('workspace').includes(getNote));
    const removeNote = defineContract({
      service: 'workspace', name: 'removeNote', method: 'DELETE', path: '/v1/notes/:noteId', callers: ['gateway'],
      context: 'organisation', idempotency: 'keyed', params: z.object({ noteId: z.uuid() }), response: z.undefined(),
    });
    assert.equal(removeNote.status, 204);
  });

  test('refuses a definition the two sides could read differently', () => {
    const base = { service: 'workspace', method: 'POST', callers: ['gateway'], context: 'organisation', response: note } as const;
    assert.throws(() => defineContract({ ...base, name: 'a1', path: '/v1/a/:id', idempotency: 'none' }), /path parameters/);
    assert.throws(() => defineContract({
      ...base, name: 'a2', path: '/v1/a', idempotency: 'none', params: z.object({ id: z.string() }),
    }), /path parameters/);
    assert.throws(() => defineContract({ ...base, name: 'A3', path: '/v1/b', idempotency: 'none' }), /lowerCamelCase/);
    assert.throws(() => defineContract({ ...base, name: 'a4', path: '/v1/Bad Path', idempotency: 'none' }), /segment/);
    assert.throws(() => defineContract({ ...base, name: 'a5', path: '/v1/c', idempotency: 'none', status: 204 }), /204/);
    defineContract({ ...base, name: 'a6', path: '/v1/d', idempotency: 'none' });
    assert.throws(() => defineContract({ ...base, name: 'a6', path: '/v1/e', idempotency: 'none' }), /already defined/);
    assert.throws(() => defineContract({ ...base, name: 'a7', path: '/v1/d', idempotency: 'none' }), /already workspace.a6/);
  });

  test('keeps spec 7.1: listed callers, and keyed writes in an organisation', () => {
    const base = { service: 'workspace', response: note } as const;
    assert.throws(() => defineContract({
      ...base, name: 'b1', method: 'POST', path: '/v1/f', callers: [], context: 'organisation', idempotency: 'none',
    }), /at least one caller/);
    assert.throws(() => defineContract({
      ...base, name: 'b2', method: 'GET', path: '/v1/g', callers: ['gateway'], context: 'organisation', idempotency: 'keyed',
    }), /never keyed/);
    assert.throws(() => defineContract({
      ...base, name: 'b3', method: 'POST', path: '/v1/h', callers: ['gateway'], context: 'user', idempotency: 'keyed',
    }), /organisation's context/);
    assert.throws(() => defineContract({
      ...base, name: 'b4', method: 'GET', path: '/v1/i', callers: ['gateway'], context: 'none', idempotency: 'none', body: z.object({}),
    }), /no body/);
  });

  test('a keyed route must be able to replay its first result', () => {
    const create = defineContract({
      service: 'workspace', name: 'createThing', method: 'POST', path: '/v1/things', callers: ['gateway'],
      context: 'organisation', idempotency: 'keyed', body: z.object({ text: z.string() }), response: note, status: 201,
    });
    assert.throws(() => route(create, { handle: async () => ({ id: '', text: '' }) }), /resultRef and replay/);
    const bound = route(create, {
      handle: async (input) => ({ id: '018f0000-0000-7000-8000-000000000000', text: input.body.text }),
      resultRef: (output) => output.id,
      replay: async (ref) => ({ id: ref!, text: 'again' }),
    });
    assert.equal(bound.contract, create);
  });
});
