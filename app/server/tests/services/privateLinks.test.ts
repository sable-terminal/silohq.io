// Private links (decision 2026-11-09): an Enterprise organisation's VPC-to-VPC link carries
// private ranges into the cell, and its connections reach addresses inside them without the
// Silo Agent. What this shows: only staff (through the admin portal) add or remove a link,
// only for an Enterprise organisation; a range must be private, no wider than a /8, and
// clear of the cell's own networks; no two live links overlap, whoever holds them; each
// organisation sees only its own; every change is in its audit log; and the egress reaches
// a private address only inside the requesting organisation's links, never the cell's own
// networks or the metadata server whatever a link says.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addPrivateLink, listPrivateLinks, removePrivateLink } from '../../src/contracts/connect-registry/privateLink.contract.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { createEgress, reachable } from '../../src/infra/egress.infra.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { privateLinkRepo } from '../../src/repos/connect/index.repo.ts';
import { checkLinkRange } from '../../src/services/connect-registry/privateLinks.service.ts';
import { parseCidr } from '../../src/utils/network.util.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, PASSWORD, type ConnectCell } from './connect.helper.ts';

let cell: ConnectCell;
let staff: ServiceClient;
let gateway: ServiceClient;
let other: string;
const operator = uuidv7();

before(async () => {
  cell = await createConnectCell();
  staff = cell.client('admin-portal');
  gateway = cell.client('gateway');
  await cell.migrate.query(
    `insert into platform.operators (id, idp_subject, display_name, clearance, uk_resident, sovereign_access_listed, status)
     values ($1, $2, 'Net Ops', 'sc', true, false, 'active')`, [operator, `sub-${operator}`]);
  const created = await withTransaction(cell.migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'globex', name: 'Globex', email: 'root@globex.example', firstName: 'Root', lastName: 'Admin', password: PASSWORD, cellId: CELL_ID,
    plan: 'enterprise', timeZone: 'Europe/London',
  }, { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' }));
  other = created.organisationId;
});

after(async () => {
  await cell?.close();
});

const asStaff = (organisationId: string) => ({ request: { organisationId }, correlationId: uuidv7() });
const add = (organisationId: string, network: string, name = 'Head office') =>
  staff.call(addPrivateLink, { body: { name, linkKind: 'vpc_peering', network, operatorId: operator } }, asStaff(organisationId));

describe('private links (decision 2026-11-09)', () => {
  test('Enterprise only: a Business organisation is refused', async () => {
    await assert.rejects(add(cell.org, '10.20.0.0/16'), { code: 'private_link.enterprise_only' });
    await cell.migrate.query(`update iam.organisations set plan = 'enterprise' where id = $1`, [cell.org]);
  });

  test('a range must be private, a network, no wider than a /8 or /16, and clear of the cell\'s own networks', async () => {
    await assert.rejects(add(cell.org, '8.8.8.0/24'), { code: 'private_link.not_private' });
    await assert.rejects(add(cell.org, '169.254.0.0/16'), { code: 'private_link.not_private' });
    await assert.rejects(add(cell.org, '10.20.0.1/16'), { code: 'private_link.network_invalid' });
    await assert.rejects(add(cell.org, 'intranet.acme'), { code: 'private_link.network_invalid' });
    await assert.rejects(add(cell.org, 'fd00::/12'), { code: 'private_link.too_wide' });
    const cellNetworks = [parseCidr('10.0.0.0/16')!];
    assert.throws(() => checkLinkRange('10.0.128.0/24', cellNetworks), { code: 'private_link.overlaps_cell' });
    assert.equal(checkLinkRange('10.1.0.0/16', cellNetworks).text, '10.1.0.0/16');
  });

  test('staff add a link; a second that overlaps it is refused, whichever organisation asks', async () => {
    const link = await add(cell.org, '10.20.0.0/16');
    assert.equal(link.network, '10.20.0.0/16');
    assert.equal(link.status, 'active');
    await assert.rejects(add(cell.org, '10.20.4.0/24', 'Branch'), { code: 'private_link.overlaps' });
    await assert.rejects(add(other, '10.0.0.0/8', 'Globex'), { code: 'private_link.overlaps' });
    const globex = await add(other, 'fd00:1234::/48', 'Globex VPC');
    assert.equal(globex.network, 'fd00:1234::/48');
  });

  test('each organisation sees only its own links, through the gateway or the portal', async () => {
    const root = await cell.signIn('root@acme.example');
    const seen = await gateway.call(listPrivateLinks, { query: {} }, cell.as(root));
    assert.deepEqual(seen.privateLinks.map((l) => l.network), ['10.20.0.0/16']);
    const theirs = await staff.call(listPrivateLinks, { query: {} }, asStaff(other));
    assert.deepEqual(theirs.privateLinks.map((l) => l.network), ['fd00:1234::/48']);
    // The egress reads the live ranges under the organisation's own row-level security.
    const ranges = await inTx(cell.credential, { orgId: cell.org }, () => privateLinkRepo.liveNetworks(cell.credential));
    assert.deepEqual(ranges, ['10.20.0.0/16']);
  });

  test('removing a link takes effect at once, is versioned, and is final', async () => {
    const [link] = (await staff.call(listPrivateLinks, { query: {} }, asStaff(cell.org))).privateLinks;
    await assert.rejects(staff.call(removePrivateLink, { params: { linkId: link!.id }, body: { operatorId: operator, version: link!.version + 1 } },
      asStaff(cell.org)), { code: 'private_link.version' });
    const removed = await staff.call(removePrivateLink, { params: { linkId: link!.id }, body: { operatorId: operator, version: link!.version } },
      asStaff(cell.org));
    assert.equal(removed.status, 'removed');
    await assert.rejects(staff.call(removePrivateLink, { params: { linkId: link!.id }, body: { operatorId: operator, version: removed.version } },
      asStaff(cell.org)), { code: 'private_link.removed' });
    assert.deepEqual(await inTx(cell.credential, { orgId: cell.org }, () => privateLinkRepo.liveNetworks(cell.credential)), []);
    const all = await staff.call(listPrivateLinks, { query: { includeRemoved: 'true' } }, asStaff(cell.org));
    assert.deepEqual(all.privateLinks.map((l) => l.status), ['removed']);
    // The range is free again.
    await add(other, '10.20.0.0/16', 'Globex office');
  });

  test('every change is in the organisation\'s audit log, naming the member of staff', async () => {
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->>'event' as event, payload->'detail'->>'operator_id' as operator from platform.outbox
       where organisation_id = $1 and payload->>'event' like 'private_link_%' order by created_at, id`, [cell.org]));
    assert.deepEqual(rows.map((r) => [r.event, r.operator]), [['private_link_added', operator], ['private_link_removed', operator]]);
  });

  test('only the admin portal adds or removes a link', async () => {
    const root = await cell.signIn('root@acme.example');
    await assert.rejects(gateway.call(addPrivateLink, { body: { name: 'x', linkKind: 'vpc_peering', network: '10.30.0.0/16', operatorId: operator } },
      cell.as(root)), { code: 'caller.not_listed' });
  });
});

describe('the egress and private links', () => {
  const links = ['10.255.0.0/16'].map((text) => parseCidr(text)!);
  const cellNetworks = ['10.0.0.0/16'].map((text) => parseCidr(text)!);

  test('a private address is reached only inside the organisation\'s links; the cell\'s own networks never', () => {
    assert.equal(reachable('203.0.113.9', [], []), false, 'documentation space is not public');
    assert.equal(reachable('8.8.8.8', [], []), true);
    assert.equal(reachable('10.255.3.4', [], []), false);
    assert.equal(reachable('10.255.3.4', links, []), true);
    assert.equal(reachable('10.254.3.4', links, []), false);
    assert.equal(reachable('10.0.0.5', [parseCidr('10.0.0.0/8')!], cellNetworks), false);
    assert.equal(reachable('169.254.169.254', links, []), false);
    assert.equal(reachable('::ffff:10.255.3.4', links, []), true);
  });

  test('a request carries its links; one outside private space is ignored', async () => {
    const egress = createEgress({ egressAllowPrivate: false, egressAllowHttp: true, egressTimeoutMs: 300, egressMaxResponseBytes: 1_000,
      cellNetworks: ['10.0.0.0/16'] });
    const url = new URL('http://10.255.255.1:9/x');
    await assert.rejects(egress.send({ url, method: 'GET', headers: {} }), { code: 'egress.private_address' });
    // Inside a link the request goes out; this address answers nothing, so it times out or is unreachable.
    await assert.rejects(egress.send({ url, method: 'GET', headers: {}, privateLinks: ['10.255.0.0/16'] }),
      (error: { code: string }) => error.code !== 'egress.private_address');
    await assert.rejects(egress.send({ url: new URL('http://10.0.0.7:9/x'), method: 'GET', headers: {}, privateLinks: ['10.0.0.0/8'] }),
      { code: 'egress.private_address' });
    await assert.rejects(egress.send({ url: new URL('http://169.254.169.254/latest'), method: 'GET', headers: {}, privateLinks: ['169.254.0.0/16'] }),
      { code: 'egress.private_address' });
  });
});
