// The web client's route table (app/web/src/api/routes.generated.ts) is the gateway's current
// one: a public route added, renamed or removed fails here until the table is regenerated
// (node src/scripts/webRoutes.script.ts), so the client's calls never drift from the API.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { WEB_ROUTES_FILE, webRoutes } from '../../src/scripts/webRoutes.script.ts';

test('the web client\'s route table is the gateway\'s current one', async () => {
  const current = await readFile(WEB_ROUTES_FILE, 'utf8').catch(() => '');
  assert.ok(current === await webRoutes(), 'regenerate it: node src/scripts/webRoutes.script.ts in app/server');
});
