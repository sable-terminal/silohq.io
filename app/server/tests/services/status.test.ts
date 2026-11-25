// The status service end to end (spec 7.2, 13.2): a real status process reading the cell
// registry from a fresh directory database, keeping reports and notices in the status
// tables, and publishing the public page to a directory as static hosting would serve it.
// A second replica on the same tables agrees with the first.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import {
  putNotice, putNoticeUpdate, readStatus, reportCellStatus, type PublicStatusDocument,
} from '../../src/contracts/status/status.contract.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createStatusService } from '../../src/routes/status/index.route.ts';
import { buildDocument } from '../../src/services/status/status.service.ts';
import { createHarness, uuidv7, type Harness } from '../db/harness.helper.ts';

let h: Harness;
let dir: string;
let status: RunningProcess;
let fleet: ServiceClient;
let portal: ServiceClient;
let config: Config;
let clock = Date.now();
const operator = uuidv7();
const quiet = createLogger({ service: 'status', cell: 'global-uk', release: 'test', level: 'error', write: () => undefined });

const start = async (): Promise<void> => {
  status = await runProcess([createStatusService({ now: () => clock })], config, { logger: quiet });
  const http = { ...config.http, serviceUrls: { status: `http://127.0.0.1:${status.port}` } };
  fleet = createServiceClient({ caller: 'fleet-control', http });
  portal = createServiceClient({ caller: 'admin-portal', http });
};
const stop = async (): Promise<void> => {
  fleet.close();
  portal.close();
  await status.stop('test');
};

const published = async (): Promise<PublicStatusDocument> =>
  JSON.parse(await readFile(path.join(dir, 'status.json'), 'utf8')) as PublicStatusDocument;

async function waitFor(check: (document: PublicStatusDocument) => boolean): Promise<PublicStatusDocument> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const document = await published().catch(() => undefined);
    if (document !== undefined && check(document)) return document;
    if (Date.now() > deadline) assert.fail(`the page did not show it in time: ${JSON.stringify(document)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const cellOf = (document: PublicStatusDocument, id: string) => document.cells.find((c) => c.id === id)!;
const stateOf = (document: PublicStatusDocument, id: string, component: string) =>
  cellOf(document, id).components.find((c) => c.component === component)!.state;

const report = (cellId: string, reportedAt: number, components: { component: string; state: string }[]) =>
  fleet.call(reportCellStatus, {
    params: { cellId },
    body: { reportedAt: new Date(reportedAt).toISOString(), components: components as never },
  });

before(async () => {
  h = await createHarness();
  const writer: pg.Client = await h.connect('test_dir_writer', 'directory');
  for (const [id, kind, residency, state] of [['uk-lon-1', 'commercial', 'uk', 'active'], ['eu-fra-1', 'commercial', 'eu', 'active'],
    ['ded-acme', 'dedicated', 'uk', 'active'], ['uk-sov-1', 'sovereign', 'uk', 'active'], ['uk-lon-2', 'commercial', 'uk', 'provisioning'],
    ['us-old-1', 'commercial', 'us', 'retired']]) {
    await writer.query('insert into directory.cells (id, kind, residency, hostname, status) values ($1, $2, $3, $4, $5)',
      [id, kind, residency, `${id}.silohq.io`, state]);
  }
  dir = await mkdtemp(path.join(tmpdir(), 'silo-status-'));
  config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'status', SILO_CELL_ID: 'global-uk', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
    PG_DIRECTORY_URL: h.url('test_status', 'directory'), STATUS_PUBLISH_DIR: dir, STATUS_PUBLISH_INTERVAL_SECONDS: '1',
    STATUS_STALE_AFTER_SECONDS: '180',
  });
  await start();
});

after(async () => {
  await stop().catch(() => undefined);
  await h?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the page', () => {
  test('shows the shared commercial cells only, unknown until they report', async () => {
    const document = await waitFor((d) => d.cells.length > 0);
    assert.deepEqual(document.cells.map((c) => c.id), ['eu-fra-1', 'uk-lon-1'], 'no dedicated, sovereign, provisioning or retired cell');
    assert.ok(document.cells.every((c) => c.stale && c.reportedAt === null && c.components.every((x) => x.state === 'unknown')));
    assert.equal(document.cells[0]!.components.length, 8);
    const html = await readFile(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /<title>Silo status<\/title>/);
    assert.ok(!html.includes('ded-acme') && !html.includes('uk-sov-1'));
  });
});

describe('reports', () => {
  test('a report sets each component; one it leaves out shows unknown', async () => {
    assert.deepEqual(await report('uk-lon-1', clock, [{ component: 'app', state: 'operational' }, { component: 'login', state: 'degraded' }]),
      { accepted: true });
    const document = await waitFor((d) => cellOf(d, 'uk-lon-1').reportedAt !== null);
    assert.equal(stateOf(document, 'uk-lon-1', 'app'), 'operational');
    assert.equal(stateOf(document, 'uk-lon-1', 'login'), 'degraded');
    assert.equal(stateOf(document, 'uk-lon-1', 'questions'), 'unknown');
    assert.equal(cellOf(document, 'uk-lon-1').stale, false);
  });

  test('since moves only when the state changes; an older report is ignored', async () => {
    const first = await published();
    const appSince = cellOf(first, 'uk-lon-1').components.find((c) => c.component === 'app')!.since;
    await report('uk-lon-1', clock + 1_000, [{ component: 'app', state: 'operational' }, { component: 'login', state: 'operational' }]);
    assert.deepEqual(await report('uk-lon-1', clock - 1_000, [{ component: 'app', state: 'major_outage' }]), { accepted: false });
    const document = await waitFor((d) => stateOf(d, 'uk-lon-1', 'login') === 'operational');
    const app = cellOf(document, 'uk-lon-1').components.find((c) => c.component === 'app')!;
    assert.equal(app.state, 'operational');
    assert.equal(app.since, appSince);
    assert.equal(cellOf(document, 'uk-lon-1').components.find((c) => c.component === 'login')!.since, new Date(clock + 1_000).toISOString());
  });

  test('refused: a report from the future, an unknown or retired cell; a provisioning cell reports unseen', async () => {
    await assert.rejects(report('uk-lon-1', clock + 3_600_000, []), { code: 'status.report_in_future' });
    await assert.rejects(report('uk-nowhere-1', clock, []), { code: 'status.cell_unknown' });
    await assert.rejects(report('us-old-1', clock, []), { code: 'status.cell_unknown' });
    assert.deepEqual(await report('uk-lon-2', clock, [{ component: 'app', state: 'operational' }]), { accepted: true });
    await assert.rejects(report('uk-lon-1', clock, [{ component: 'app', state: 'operational' }, { component: 'app', state: 'degraded' }]),
      { code: 'contract.request_invalid' });
  });

  test('a cell that stops reporting turns unknown without anyone saying so', async () => {
    await report('eu-fra-1', clock, [{ component: 'app', state: 'operational' }]);
    await waitFor((d) => stateOf(d, 'eu-fra-1', 'app') === 'operational');
    clock += 10 * 60_000;
    await report('uk-lon-1', clock, [{ component: 'app', state: 'operational' }]);
    const document = await waitFor((d) => cellOf(d, 'eu-fra-1').stale);
    assert.equal(stateOf(document, 'eu-fra-1', 'app'), 'unknown');
    assert.equal(cellOf(document, 'uk-lon-1').stale, false);
  });

  test('a cell reports only for itself', async () => {
    const http = { ...config.http, serviceUrls: { status: `http://127.0.0.1:${status.port}` } };
    const frankfurt = createServiceClient({ caller: 'fleet-control', cell: 'eu-fra-1', http });
    try {
      await assert.rejects(frankfurt.call(reportCellStatus, {
        params: { cellId: 'uk-lon-1' }, body: { reportedAt: new Date(clock).toISOString(), components: [] },
      }), { category: 'forbidden', code: 'status.foreign_cell' });
      assert.deepEqual(await frankfurt.call(reportCellStatus, {
        params: { cellId: 'eu-fra-1' }, body: { reportedAt: new Date(clock - 60_000).toISOString(), components: [{ component: 'app', state: 'operational' }] },
      }), { accepted: true });
    } finally {
      frankfurt.close();
    }
  });

  test('only the cell Fleet agent reports', async () => {
    const response = await fetch(`http://127.0.0.1:${status.port}/v1/cells/uk-lon-1/report`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-silo-caller': 'gateway' },
      body: JSON.stringify({ reportedAt: new Date(clock).toISOString(), components: [] }),
    });
    assert.equal(response.status, 403);
  });
});

describe('notices', () => {
  const incident = uuidv7();

  test('an incident commander opens an incident on cells the page shows, never a dedicated or sovereign one', async () => {
    const notice = await portal.call(putNotice, {
      params: { noticeId: incident },
      body: { kind: 'incident', severity: 'sev2', title: 'Slow questions <script>alert(1)</script>', cellIds: ['uk-lon-1'],
        components: ['questions'], postedBy: operator },
    });
    assert.equal(notice.state, 'investigating');
    assert.equal(notice.resolvedAt, null);
    for (const hidden of ['ded-acme', 'uk-sov-1', 'uk-lon-2']) {
      await assert.rejects(portal.call(putNotice, {
        params: { noticeId: uuidv7() }, body: { kind: 'incident', severity: 'sev1', title: 'x', cellIds: [hidden], postedBy: operator },
      }), { code: 'status.cell_not_public' });
    }
    await assert.rejects(portal.call(putNotice, {
      params: { noticeId: uuidv7() }, body: { kind: 'maintenance', title: 'Upgrade', cellIds: ['uk-lon-1'], postedBy: operator },
    }), { code: 'contract.request_invalid' }, 'maintenance needs a window');
  });

  test('updates move the incident to resolved; a replay changes nothing, a changed replay is refused', async () => {
    const update = (updateId: string, state: string, message: string) => portal.call(putNoticeUpdate, {
      params: { noticeId: incident, updateId }, body: { state: state as never, message, postedBy: operator },
    });
    const first = uuidv7();
    assert.equal((await update(first, 'identified', 'A slow index rebuild.')).state, 'identified');
    assert.equal((await update(first, 'identified', 'A slow index rebuild.')).updates.length, 1);
    await assert.rejects(update(first, 'monitoring', 'Different'), { code: 'status.update_changed' });
    await assert.rejects(update(uuidv7(), 'completed', 'x'), { code: 'status.state_invalid' });
    const resolved = await update(uuidv7(), 'resolved', 'Fixed.');
    assert.equal(resolved.state, 'resolved');
    assert.ok(resolved.resolvedAt !== null);
    await assert.rejects(portal.call(putNoticeUpdate, {
      params: { noticeId: uuidv7(), updateId: uuidv7() }, body: { state: 'resolved', message: 'x', postedBy: operator },
    }), { code: 'status.notice_unknown' });

    const document = await waitFor((d) => d.notices.some((n) => n.id === incident && n.state === 'resolved'));
    const shown = document.notices.find((n) => n.id === incident)!;
    assert.deepEqual(shown.updates.map((u) => u.state), ['identified', 'resolved']);
    assert.ok(!JSON.stringify(document).includes(operator), 'who posted is not published');
    // The page is written beside the document, not with it: wait for the page of this publish too.
    let html = '';
    for (const deadline = Date.now() + 5_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 25))) {
      html = await readFile(path.join(dir, 'index.html'), 'utf8').catch(() => '');
      if (html.includes('Fixed.')) break;
    }
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&#60;script&#62;'));
  });

  test('maintenance is scheduled for a window and completes', async () => {
    const id = uuidv7();
    const notice = await portal.call(putNotice, {
      params: { noticeId: id },
      body: { kind: 'maintenance', title: 'Database upgrade', cellIds: ['eu-fra-1', 'uk-lon-1'],
        window: { startsAt: new Date(clock + 3_600_000).toISOString(), endsAt: new Date(clock + 7_200_000).toISOString() }, postedBy: operator },
    });
    assert.equal(notice.state, 'scheduled');
    assert.equal(notice.severity, null);
    await assert.rejects(portal.call(putNotice, {
      params: { noticeId: id }, body: { kind: 'incident', severity: 'sev3', title: 'x', cellIds: ['uk-lon-1'], postedBy: operator },
    }), { code: 'status.notice_kind_fixed' });
  });
});

describe('replicas, restart and retention', () => {
  test('a second replica on the same tables sees and refuses what the first took', async () => {
    const second = await runProcess([createStatusService({ now: () => clock })], config, { logger: quiet });
    const http = { ...config.http, serviceUrls: { status: `http://127.0.0.1:${second.port}` } };
    const fleet2 = createServiceClient({ caller: 'fleet-control', http });
    const portal2 = createServiceClient({ caller: 'admin-portal', http });
    try {
      const last = (await portal.call(readStatus, {})).cells.find((c) => c.id === 'uk-lon-1')!.reportedAt!;
      assert.deepEqual(await fleet2.call(reportCellStatus, { params: { cellId: 'uk-lon-1' }, body: { reportedAt: last, components: [] } }),
        { accepted: false }, 'the same report through another replica is not newer');
      await fleet2.call(reportCellStatus, {
        params: { cellId: 'uk-lon-1' }, body: { reportedAt: new Date(Date.parse(last) + 1_000).toISOString(), components: [{ component: 'files', state: 'degraded' }] },
      });
      assert.equal(stateOf(await portal.call(readStatus, {}), 'uk-lon-1', 'files'), 'degraded', 'the first replica reads it');
      const notice = uuidv7();
      await portal2.call(putNotice, { params: { noticeId: notice }, body: { kind: 'incident', severity: 'sev3', title: 'Slow files', cellIds: ['uk-lon-1'], postedBy: operator } });
      await waitFor((d) => d.notices.some((n) => n.id === notice));
    } finally {
      fleet2.close();
      portal2.close();
      await second.stop('test');
    }
  });

  test('a new process reads the notices and states back from the tables', async () => {
    const before = await portal.call(readStatus, {});
    await stop();
    await start();
    const after = await portal.call(readStatus, {});
    assert.deepEqual(after.notices, before.notices);
    assert.equal(stateOf(after, 'uk-lon-1', 'app'), stateOf(before, 'uk-lon-1', 'app'));
    assert.equal(cellOf(after, 'uk-lon-1').reportedAt, cellOf(before, 'uk-lon-1').reportedAt);
  });

  test('resolved notices leave the page after the retention period; open ones stay', () => {
    const now = Date.parse('2026-11-01T00:00:00Z');
    const notice = (id: string, resolvedAt: string | null) => ({
      id, kind: 'incident' as const, severity: 'sev3' as const, title: id, cellIds: [], components: [], state: 'resolved' as const,
      startedAt: '2026-01-01T00:00:00.000Z', resolvedAt, window: null, updates: [],
    });
    const document = buildDocument({
      cells: [], reports: new Map(), now, sovereign: false, staleAfterSeconds: 180, noticeRetentionDays: 90,
      notices: [notice(uuidv7(), '2026-01-02T00:00:00.000Z'), notice('open', null), notice('recent', '2026-10-30T00:00:00.000Z')],
    });
    assert.deepEqual(document.notices.map((n) => n.title), ['open', 'recent']);
  });
});
