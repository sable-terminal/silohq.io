// The build check (guarantee 1): every route a browser may call is called from the client, by
// name, from the page that homes it. The only exceptions are routes no page fetches (a browser
// navigates to them, or another device calls them), each with its reason in NOT_FETCHED.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUTES } from '../src/api/routes.generated.ts';
import { calledRoutes } from './coverage.helper.ts';

/** Routes a browser reaches without a page calling them by name, and why. */
const NOT_FETCHED: Record<string, string> = {
  registerPushDevice: 'the Silo mobile app registers its device with the push provider\'s token; a browser has no such token (D85)',
};

test('every route is called from the client, or says why no page fetches it', async () => {
  const called = await calledRoutes();
  const uncalled = Object.keys(ROUTES).filter((r) => !called.has(r) && NOT_FETCHED[r] === undefined);
  assert.deepEqual(uncalled, [], 'routes no page calls: build their page, or say why no page fetches them');
  const fetched = Object.keys(NOT_FETCHED).filter((r) => called.has(r));
  assert.deepEqual(fetched, [], 'routes said not to be fetched that a page now calls');
  const gone = Object.keys(NOT_FETCHED).filter((r) => !(r in ROUTES));
  assert.deepEqual(gone, [], 'listed routes that no longer exist');
});
