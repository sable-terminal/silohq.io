/**
 * Siloes — run every BigQuery statement the product sends against a real
 * dataset, and check each answer.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `bigquery.infra` is written against the REST API and tested as text: the
 * tests prove what is sent, and nothing in them can prove what BigQuery makes
 * of it. Everywhere else the product is tested against the Postgres stand-in,
 * which answers the same questions in different SQL. So a statement can be
 * exactly what was intended and still be wrong in production — and reading a
 * kept copy, adding one up, comparing two, and finding the field that marks
 * change are all statements of that kind.
 *
 * This makes a dataset of its own, loads two small copies of one table whose
 * every answer is worked out below in plain code, asks BigQuery each question
 * the product asks, and compares. It makes the dataset of views another tool
 * would read and checks what each view shows. Then it removes both.
 *
 * WHAT IT CANNOT CHECK: that a reader named on a Silo's list can read the
 * views and cannot read the tables. That takes a second identity, which this
 * does not have. It checks that the list is written without disturbing what
 * was on it; whether access follows is for a person to try once, as a reader.
 *
 * ── NOTHING OF ANYBODY'S IS TOUCHED ───────────────────────────────────────
 *
 * The dataset is named from an id made here, carries a label only this script
 * gives, and `dropVerifyDataset` refuses to remove one without it.
 *
 * Run before relying on Siloes in a cell, and after any change to
 * `bigquery.infra`:  npm run silo:verify-store
 * It needs BIGQUERY_PROJECT_ID, BIGQUERY_LOCATION, STORAGE_BUCKET and Google
 * credentials that can create a dataset there.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import * as bigquery from '../../infra/bigquery.infra';
import { env } from '../../config/env.config';
import type { StoredField } from '../../models/rowStore.model';

/* `Billing City` is not an identifier: a connected system may call a field anything, and it is held under a made column. */
type Invoice = { id: string; status: string; total: number; raised: string; updated_at: string; meta: { n: number }; 'Billing City': string };

const FIELDS: StoredField[] = [
  { name: 'id', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'total', type: 'number' },
  { name: 'raised', type: 'date' },
  { name: 'updated_at', type: 'datetime' },
  { name: 'meta', type: 'json' },
  { name: 'Billing City', type: 'string' },
];

const HOUR = 60 * 60 * 1000;

/* Two hundred invoices as an earlier copy found them, last touched a month before it. */
function earlierRows(at: Date): Invoice[] {
  const touched = new Date(at.getTime() - 30 * 24 * HOUR).toISOString();
  return Array.from({ length: 200 }, (_unused, i) => ({
    id: `inv-${String(i).padStart(4, '0')}`,
    status: i % 4 === 0 ? 'OVERDUE' : 'PAID',
    total: 100 + (i % 7) + 0.25,
    raised: `2026-0${1 + (i % 6)}-15`,
    updated_at: touched,
    meta: { n: i },
    'Billing City': i % 2 === 0 ? 'Leeds' : 'York',
  }));
}

/* And as the later copy found them: ten paid, three raised, two gone. Every change carries a later `updated_at`. */
function laterRows(earlier: Invoice[], between: Date): Invoice[] {
  const stamp = between.toISOString();
  return [
    ...earlier
      .filter((one) => one.id !== 'inv-0198' && one.id !== 'inv-0199')
      .map((one, i) => (i < 40 && i % 4 === 0 ? { ...one, status: 'PAID', updated_at: stamp } : one)),
    { id: 'inv-0200', status: 'OVERDUE', total: 55.5, raised: '2026-07-15', updated_at: stamp, meta: { n: 200 }, 'Billing City': 'Leeds' },
    { id: 'inv-0201', status: 'PAID', total: 60, raised: '2026-07-15', updated_at: stamp, meta: { n: 201 }, 'Billing City': 'York' },
    { id: 'inv-0202', status: 'PAID', total: 65, raised: '2026-07-15', updated_at: stamp, meta: { n: 202 }, 'Billing City': 'York' },
  ];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = <T,>(rows: T[], key: (row: T) => string) => [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
/* A sum as BigQuery holds it: exact decimals, so compared to the penny rather than as floats. */
const pence = (value: number | null) => (value === null ? null : Math.round(value * 100));

async function main(): Promise<void> {
  if (!bigquery.isConfigured() || !env.STORAGE_BUCKET) {
    console.error('Set BIGQUERY_PROJECT_ID, BIGQUERY_LOCATION and STORAGE_BUCKET: this runs against a real BigQuery, and loads through the bucket.');
    process.exitCode = 1;
    return;
  }

  const organisationId = randomUUID();
  const sourceId = randomUUID();
  const object = { name: 'invoice', fields: FIELDS };
  const earlier = { id: randomUUID(), at: new Date(Date.now() - 2 * HOUR) };
  const later = { id: randomUUID(), at: new Date(Date.now() - HOUR) };

  const was = earlierRows(earlier.at);
  const now = laterRows(was, new Date(earlier.at.getTime() + HOUR / 2));
  const base = { organisationId, sourceId, object };

  let failed = 0;
  const check = (what: string, got: unknown, expected: unknown) => {
    const ok = same(got, expected);
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${what}`);
    if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(got)}`);
  };

  console.log(`  dataset ${bigquery.datasetFor(organisationId)} in ${env.BIGQUERY_PROJECT_ID} (${env.BIGQUERY_LOCATION})`);

  try {
    await bigquery.ensureDataset(organisationId, 'silo-verify');
    await bigquery.ensureTable({ organisationId, sourceId, objectName: object.name, fields: FIELDS, retentionDays: 7 });

    const load = (batch: { id: string; at: Date }, rows: Invoice[]) =>
      bigquery.load({
        organisationId,
        sourceId,
        objectName: object.name,
        fileId: batch.id,
        receivedAt: batch.at,
        fields: FIELDS,
        rows: rows.map((values, index) => ({ rowRef: String(index), values, methods: {} })),
      });

    check('loads the earlier copy', (await load(earlier, was)).rows, was.length);
    check('loads the later copy beside it', (await load(later, now)).rows, now.length);

    /* ── One copy, read by its own batch ─────────────────────────────────── */

    const read = async (batch: { id: string; at: Date }, filters: Parameters<typeof bigquery.read>[0]['filters'], limit: number) =>
      (await bigquery.read({ ...base, filters, sort: [{ field: 'id', direction: 'asc' }], fields: [], limit, sinceReceived: batch.at, batch })).rows.map((row) => ({
        id: row.values.id,
        status: row.values.status,
        total: Number(row.values.total),
      }));
    const listed = (rows: Invoice[]) => sorted(rows, (row) => row.id).map((row) => ({ id: row.id, status: row.status, total: row.total }));

    check('reads the later copy and none of the earlier', (await read(later, [], 1_000)).length, now.length);
    check('reads the earlier copy and none of the later', (await read(earlier, [], 1_000)).length, was.length);
    check(
      'applies a condition, an order and a limit to one copy',
      await read(later, [{ field: 'status', op: 'eq', value: 'OVERDUE' }, { field: 'total', op: 'gt', value: 103 }], 5),
      listed(now.filter((row) => row.status === 'OVERDUE' && row.total > 103)).slice(0, 5),
    );
    check(
      'filters on a field whose name is not an identifier, held under a made column',
      (await read(later, [{ field: 'Billing City', op: 'eq', value: 'Leeds' }], 1_000)).length,
      now.filter((row) => row['Billing City'] === 'Leeds').length,
    );
    check(
      'and reads it back under the name its system gives it',
      (await bigquery.read({ ...base, filters: [{ field: 'id', op: 'eq', value: 'inv-0001' }], sort: [], fields: ['Billing City'], limit: 1, sinceReceived: later.at, batch: later })).rows[0]?.values,
      { 'Billing City': 'York' },
    );
    check(
      'leaves out named records, as a caught-up answer does of the ones it reads live',
      (await read(later, [{ field: 'id', op: 'nin', value: ['inv-0001', 'inv-0002', 'inv-9999'] }], 1_000)).length,
      now.length - 2,
    );
    check(
      'picks records by identifier',
      await read(later, [{ field: 'id', op: 'in', value: ['inv-0001', 'inv-0200', 'inv-0199'] }], 10),
      listed(now.filter((row) => ['inv-0001', 'inv-0200'].includes(row.id))),
    );

    /* ── One copy, added up where it is ──────────────────────────────────── */

    const grouped = async (groupBy: Parameters<typeof bigquery.summarise>[0]['groupBy'], filters: Parameters<typeof bigquery.summarise>[0]['filters'] = []) =>
      sorted(
        (await bigquery.summarise({ ...base, batch: later, filters, groupBy, measures: [{ operation: 'sum', field: 'total' }, { operation: 'count' }], limit: 1_000 })).rows.map((row) => ({
          key: row.key,
          records: row.records,
          sum: pence(row.measures[0] ?? null),
        })),
        (row) => row.key.join('|'),
      );
    const expectGrouped = (rows: Invoice[], key: (row: Invoice) => string) => {
      const groups = new Map<string, { records: number; sum: number }>();
      for (const row of rows) {
        const held = groups.get(key(row)) ?? { records: 0, sum: 0 };
        held.records += 1;
        held.sum += row.total;
        groups.set(key(row), held);
      }
      return sorted([...groups].map(([name, held]) => ({ key: [name], records: held.records, sum: pence(held.sum) })), (row) => row.key.join('|'));
    };

    check('counts and totals a copy with no groups', await grouped([]), [{ key: [], records: now.length, sum: pence(now.reduce((sum, row) => sum + row.total, 0)) }]);
    check('groups by a field', await grouped([{ field: 'status' }]), expectGrouped(now, (row) => row.status));
    check('groups by a field whose name is not an identifier', await grouped([{ field: 'Billing City' }]), expectGrouped(now, (row) => row['Billing City']));
    check('groups by the month a date falls in', await grouped([{ field: 'raised', every: 'month' }]), expectGrouped(now, (row) => row.raised.slice(0, 7)));
    check(
      'groups by the quarter a date falls in',
      await grouped([{ field: 'raised', every: 'quarter' }]),
      expectGrouped(now, (row) => `${row.raised.slice(0, 4)}-Q${Math.ceil(Number(row.raised.slice(5, 7)) / 3)}`),
    );
    check(
      'applies a condition before adding up',
      await grouped([{ field: 'status' }], [{ field: 'total', op: 'gte', value: 104 }]),
      expectGrouped(now.filter((row) => row.total >= 104), (row) => row.status),
    );

    /* ── Two copies compared ─────────────────────────────────────────────── */

    const before = new Map(was.map((row) => [row.id, row]));
    const after = new Map(now.map((row) => [row.id, row]));
    const added = now.filter((row) => !before.has(row.id));
    const gone = was.filter((row) => !after.has(row.id));
    const differsIn = (field: keyof Invoice) => now.filter((row) => before.has(row.id) && JSON.stringify(before.get(row.id)![field]) !== JSON.stringify(row[field]));
    const changed = now.filter((row) => before.has(row.id) && (['status', 'total', 'raised', 'updated_at', 'meta', 'Billing City'] as const).some((field) => JSON.stringify(before.get(row.id)![field]) !== JSON.stringify(row[field])));

    const compared = { ...base, earlier, later, identifier: 'id', watch: ['status', 'total', 'raised', 'updated_at', 'meta', 'Billing City'], filters: [] as Parameters<typeof bigquery.difference>[0]['filters'] };

    check('counts what is new, changed and gone between two copies, and in which fields', await bigquery.difference(compared), {
      added: added.length,
      removed: gone.length,
      changed: changed.length,
      fields: [
        { field: 'status', records: differsIn('status').length },
        { field: 'updated_at', records: differsIn('updated_at').length },
      ],
    });
    check(
      'counts only changes to the fields asked about',
      await bigquery.difference({ ...compared, watch: ['total'] }),
      { added: added.length, removed: gone.length, changed: 0, fields: [] },
    );
    check(
      'applies a condition to a record as it is now, or as it last was where it has gone',
      await bigquery.difference({ ...compared, filters: [{ field: 'status', op: 'eq', value: 'OVERDUE' }] }),
      {
        added: added.filter((row) => row.status === 'OVERDUE').length,
        removed: gone.filter((row) => row.status === 'OVERDUE').length,
        changed: changed.filter((row) => row.status === 'OVERDUE').length,
        fields: [
          { field: 'status', records: differsIn('status').filter((row) => row.status === 'OVERDUE').length },
          { field: 'updated_at', records: differsIn('updated_at').filter((row) => row.status === 'OVERDUE').length },
        ].filter((one) => one.records > 0),
      },
    );
    check(
      'lists the records that are new or changed',
      await bigquery.differing({ ...compared, which: 'held', limit: 1_000 }),
      sorted([...added.map((row) => ({ ref: row.id, added: true })), ...changed.map((row) => ({ ref: row.id, added: false }))], (row) => row.ref),
    );
    check('lists only the changed', (await bigquery.differing({ ...compared, which: 'changed', limit: 1_000 })).map((row) => row.ref), sorted(changed, (row) => row.id).map((row) => row.id));
    check('lists the records that have gone', (await bigquery.differing({ ...compared, which: 'gone', limit: 1_000 })).map((row) => row.ref), sorted(gone, (row) => row.id).map((row) => row.id));

    /* ── The field that marks change ─────────────────────────────────────── */

    const since = new Date(earlier.at.getTime() - 10 * 60 * 1000);
    const differ = added.length + changed.length;
    check(
      'weighs each date field as the mark of change: `updated_at` marks every changed record, `raised` does not',
      await bigquery.markerEvidence({ ...base, earlier, later, identifier: 'id', candidates: ['updated_at', 'raised'], since }),
      [
        { field: 'updated_at', differ: added.length + now.filter((row) => before.has(row.id) && before.get(row.id)!.status !== row.status).length, marked: differ, recent: differ, rows: now.length },
        { field: 'raised', differ, marked: 0, recent: 0, rows: now.length },
      ],
    );

    /* ── Read by another tool: a dataset of views ────────────────────────── */

    const siloId = randomUUID();
    try {
      await bigquery.ensureReadDataset(organisationId, siloId);
      /* Twice, because the second time must find the authorisation there and leave the list alone. */
      await bigquery.ensureReadDataset(organisationId, siloId);

      const view = { organisationId, siloId, sourceId, objectName: object.name, fields: FIELDS.map((field) => field.name) };
      await bigquery.replaceView({ ...view, name: 'invoice__ledger', batches: [later] });
      check('a view of the copy being served shows that copy and no other', await bigquery.viewRows(organisationId, siloId, 'invoice__ledger'), now.length);

      await bigquery.replaceView({ ...view, name: 'invoice__ledger__history', batches: [earlier, later] });
      check('a view of past copies shows every one of them', await bigquery.viewRows(organisationId, siloId, 'invoice__ledger__history'), was.length + now.length);

      await bigquery.replaceView({ ...view, name: 'invoice__ledger', batches: [earlier] });
      check('a view is remade over the copy it should now show', await bigquery.viewRows(organisationId, siloId, 'invoice__ledger'), was.length);

      /* With nobody on the list, the access is whatever the project gave the dataset: written back as it was. */
      await bigquery.setReaders(organisationId, siloId, []);
      check('the views still answer once the list of readers has been written', await bigquery.viewRows(organisationId, siloId, 'invoice__ledger'), was.length);

      check('removes the views of what is no longer kept', await bigquery.dropViewsExcept(organisationId, siloId, ['invoice__ledger']), ['invoice__ledger__history']);
    } finally {
      await bigquery.dropReadDataset(organisationId, siloId).catch((error: unknown) => {
        failed += 1;
        console.error(`  ✗ the dataset ${bigquery.readDatasetFor(organisationId, siloId)} could not be removed, and should be by hand:`, error instanceof Error ? error.message : error);
      });
    }

    /* ── A copy replaced ─────────────────────────────────────────────────── */

    check('removes one copy by its batch', await bigquery.deleteRows({ organisationId, sourceId, objectName: object.name, where: { fileId: earlier.id } }), was.length);
    check('and leaves the other whole', (await read(later, [], 1_000)).length, now.length);
    check('with nothing of the removed one left to read', (await read(earlier, [], 1_000)).length, 0);
  } finally {
    await bigquery.dropVerifyDataset(organisationId).catch((error: unknown) => {
      failed += 1;
      console.error(`  ✗ the dataset ${bigquery.datasetFor(organisationId)} could not be removed, and should be by hand:`, error instanceof Error ? error.message : error);
    });
  }

  console.log(failed === 0 ? '  every statement answered as the product expects' : `  ${failed} did not: BigQuery is not to be relied on in this cell until they do`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('The store could not be verified:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
