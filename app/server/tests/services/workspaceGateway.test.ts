// The workspace and Ask through the public edge: real HTTP with the session cookie and the
// cross-site rules, the gateway deciding each route's permission (or ownRecords) and
// forwarding with the context it resolved, never the browser's.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setSiloesEnabled } from '../../src/contracts/siloes/siloes.contract.ts';
import { SESSION_COOKIE } from '../../src/middleware/cookies.middleware.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { ORIGIN, PASSWORD, startWorkspaceCell, type WorkspaceCell } from './workspace.helper.ts';

let cell: WorkspaceCell;
let addresses = 0;

interface Browser { cookie: string | undefined; address: string; membershipId?: string }
interface Reply { status: number; body: any; text: string }

async function call(who: Browser, method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'x-forwarded-for': who.address, ...options.headers };
  if (method !== 'GET') {
    headers['origin'] = ORIGIN;
    headers['x-silo-csrf'] = '1';
  }
  if (who.cookie) headers['cookie'] = `${SESSION_COOKIE}=${who.cookie}`;
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${cell.edgeUrl}/api/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
  const text = await res.text();
  for (const cookie of res.headers.getSetCookie()) {
    const match = /^__Host-silo_session=([^;]*);.*Max-Age=(\d+)$/.exec(cookie);
    if (match) who.cookie = match[2] === '0' ? undefined : match[1];
  }
  return { status: res.status, body: text === '' ? undefined : JSON.parse(text), text };
}

async function browserFor(email: string): Promise<Browser> {
  const who: Browser = { cookie: undefined, address: `203.0.113.${++addresses}` };
  const reply = await call(who, 'POST', '/sessions', { body: { organisationSlug: 'acme', email, password: PASSWORD } });
  assert.equal(reply.status, 201, reply.text);
  who.membershipId = reply.body.membershipId;
  return who;
}

let alice: Browser;
let bob: Browser;

before(async () => {
  cell = await startWorkspaceCell({ edge: true });
  await cell.join('alice@acme.example', 'Member');
  await cell.join('bob@acme.example', 'Member');
  alice = await browserFor('alice@acme.example');
  bob = await browserFor('bob@acme.example');
});

after(async () => {
  await cell?.close();
});

describe('the shell at the edge (spec 33)', () => {
  test('the rail: every item in its fixed order, each open or disabled with the permission class it needs', async () => {
    const rail = await call(alice, 'GET', '/workspace/rail');
    assert.equal(rail.status, 200, rail.text);
    assert.deepEqual(rail.body.items.map((i: { item: string }) => i.item),
      ['home', 'explorer', 'clones', 'studio', 'ask', 'scenarios', 'governance', 'connect', 'ontology', 'files'], 'Siloes absent until a Silo is enabled');
    const byItem = new Map(rail.body.items.map((i: { item: string }) => [i.item, i]));
    assert.deepEqual(byItem.get('scenarios'), { item: 'scenarios', available: false, needs: { class: 'simulation', permissions: ['simulation.run'] } },
      'a member holds no simulation permission: the item is shown, disabled, naming what it needs');
    for (const item of ['home', 'explorer', 'clones', 'studio', 'ask', 'governance', 'connect', 'ontology', 'files']) {
      assert.deepEqual(byItem.get(item), { item, available: true, needs: null }, item);
    }

    await cell.join('carol@acme.example', 'Billing');
    const carol = await browserFor('carol@acme.example');
    const billing = new Map((await call(carol, 'GET', '/workspace/rail')).body.items.map((i: { item: string }) => [i.item, i]));
    assert.equal((billing.get('ask') as { needs: { class: string } }).needs.class, 'query');
    assert.equal((billing.get('connect') as { needs: { class: string } }).needs.class, 'connection');
    assert.equal((billing.get('home') as { available: boolean }).available, true, 'Home, Explorer, Studio and Governance are every member\'s');
    assert.equal((await call({ cookie: undefined, address: '203.0.113.250' }, 'GET', '/workspace/rail')).status, 401, 'a person\'s own rail needs their session');
  });

  test('Siloes joins the rail once a Silo is enabled, disabled for a member who holds no silo permission', async () => {
    await cell.call(setSiloesEnabled, { body: { enabled: true } }, cell.root);
    try {
      const items = (await call(alice, 'GET', '/workspace/rail')).body.items as { item: string; available: boolean; needs: { class: string } | null }[];
      assert.equal(items.at(-1)?.item, 'siloes', 'last, in its fixed place');
      assert.deepEqual({ available: items.at(-1)?.available, class: items.at(-1)?.needs?.class }, { available: false, class: 'silo' });
    } finally {
      await cell.call(setSiloesEnabled, { body: { enabled: false } }, cell.root);
    }
  });

  test('the identity menu: the person\'s own name and email', async () => {
    const person = await call(alice, 'GET', '/session/person');
    assert.equal(person.status, 200, person.text);
    assert.equal(person.body.email, 'alice@acme.example');
    assert.equal(typeof person.body.firstName, 'string');
    assert.equal(person.body.userId.length, 36);
  });
});

describe('the workspace and Ask at the edge', () => {
  test('ask, save the answer as a view, share it, and the recipient opens it as themselves', async () => {
    const thread = await call(alice, 'POST', '/ask/threads', { body: { scope: { kind: 'page', page: 'home' } }, headers: { 'idempotency-key': uuidv7() } });
    assert.equal(thread.status, 201, thread.text);
    const asked = await call(alice, 'POST', `/ask/threads/${thread.body.id}/turns`, {
      body: { question: 'How many open deals?' }, headers: { 'idempotency-key': uuidv7() },
    });
    assert.equal(asked.status, 201, asked.text);
    assert.equal(asked.body.turn.outcome, 'answer');
    assert.equal(cell.engine.compiles.at(-1)!.caller.request.membershipId, alice.membershipId, 'context from the session, not the browser');

    const saved = await call(alice, 'POST', '/workspace/views', {
      body: { kind: 'result', name: 'Open deals', manifestId: asked.body.turn.manifestId }, headers: { 'idempotency-key': uuidv7() },
    });
    assert.equal(saved.status, 201, saved.text);
    assert.equal((await call(bob, 'GET', `/workspace/views/${saved.body.id}`)).status, 404);

    const shared = await call(alice, 'PUT', `/workspace/views/${saved.body.id}/shares`, {
      body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'run' },
    });
    assert.equal(shared.status, 200, shared.text);
    const opened = await call(bob, 'GET', `/workspace/views/${saved.body.id}`);
    assert.equal(opened.status, 200, opened.text);
    assert.equal(opened.body.view.access, 'run');
    const ran = await call(bob, 'POST', `/workspace/views/${saved.body.id}/runs`);
    assert.equal(ran.status, 200, ran.text);
    assert.equal(cell.engine.runs.at(-1)!.membershipId, bob.membershipId);

    const threads = await call(alice, 'GET', '/ask/threads?archived=false');
    assert.equal(threads.status, 200, threads.text);
    assert.ok(threads.body.threads.some((t: { id: string }) => t.id === thread.body.id));
    assert.equal((await call(bob, 'GET', `/ask/threads/${thread.body.id}`)).status, 404, 'a thread is private');
  });

  test('forged identity headers are ignored; a member cannot set the organisation policy', async () => {
    const forged = await call(bob, 'GET', '/workspace/views?set=mine', { headers: { 'x-silo-membership-id': alice.membershipId! } });
    assert.equal(forged.status, 200);
    assert.ok(forged.body.views.every((v: { ownerMembershipId: string }) => v.ownerMembershipId === bob.membershipId));
    const refused = await call(bob, 'PUT', '/workspace/sharing-policy', { body: { viewSharingPolicy: 'open', orgWideSharingPermitted: true } });
    assert.equal(refused.status, 403, refused.text);
  });

  test('a state-changing request without the cross-site header is refused', async () => {
    const res = await fetch(`${cell.edgeUrl}/api/v1/workspace/preferences`, {
      method: 'PATCH', headers: { 'x-forwarded-for': alice.address, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${alice.cookie}`, 'content-type': 'application/json' },
      body: JSON.stringify({ askPanelOpen: true }),
    });
    assert.equal(res.status, 403);
    const ok = await call(alice, 'PATCH', '/workspace/preferences', { body: { askPanelOpen: true } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.askPanelOpen, true);
  });
});

describe('a tenant migration\'s window (spec 6.4)', () => {
  test('every write is refused at the edge, with the session, before its body is read; reads, and routes that say they read, go on', async () => {
    const destination = `uk-lon-${uuidv7().slice(-6)}`;
    await cell.migrate.query(`insert into platform.cells (id, kind, residency, location, hosting, hostname, is_local, status, placement_open)
      values ($1, 'commercial', 'uk', 'London', 'gke', $2, false, 'active', true)`, [destination, `${destination}.silohq.io`]);
    const operator = uuidv7();
    await cell.migrate.query(`insert into platform.operators (id, idp_subject, display_name, clearance, uk_resident, sovereign_access_listed, status)
      values ($1, $2, 'Ops', 'sc', true, false, 'active')`, [operator, `ops-${operator}`]);
    const migration = uuidv7();
    await cell.migrate.query(`insert into platform.tenant_migrations (id, organisation_id, source_cell_id, destination_cell_id, reason, status,
        requested_by_operator_id, notice_given_at, window_starts_at, window_ends_at, read_only_at, destination_key_id, destination_import_key)
      select $1, o.id, o.cell_id, $2, 'rebalancing', 'read_only', $3, now() - interval '31 days', now() - interval '1 minute', now() + interval '3 hours',
        now(), repeat('a', 64), 'key' from iam.organisations o where o.id = $4`, [migration, destination, operator, cell.org]);
    try {
      const refused = await call(alice, 'PATCH', '/workspace/preferences', { body: { askPanelOpen: false } });
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body.error.code, 'tenant_migrations.writes_paused');
      const saved = await call(alice, 'POST', '/workspace/views', { body: { name: 'x', definition: {} }, headers: { 'idempotency-key': uuidv7() } });
      assert.equal(saved.status, 409, 'refused before the body is even read');
      assert.equal((await call(alice, 'GET', '/workspace/rail')).status, 200, 'a GET reads');
      const noted = await call(alice, 'POST', '/workspace/interactions', { body: { event: 'palette_command_run', command: 'ask', page: 'home' } });
      assert.equal(noted.status, 201, `a route that says it reads: ${noted.text}`);
      assert.equal((await call(alice, 'GET', '/workspace/preferences')).body.askPanelOpen, true, 'nothing was written');
    } finally {
      await cell.migrate.query(`update platform.tenant_migrations set status = 'aborted', aborted_at = now() where id = $1`, [migration]);
    }
    const after = await call(alice, 'PATCH', '/workspace/preferences', { body: { askPanelOpen: false } });
    assert.equal(after.status, 200, `writes resume once the migration ends: ${after.text}`);
  });
});
