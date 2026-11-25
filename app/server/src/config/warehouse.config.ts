// The Warehouse (spec 69.12 to 69.23): Silo's own BigQuery warehouse for an organisation
// that has none. The cell's siloes project and location are BIGQUERY_PROJECT_ID and
// BIGQUERY_LOCATION (storage.config.ts); these are the Warehouse's own settings.
//
// - Writers: the service accounts that alone hold access to a Warehouse dataset (69.13
//   step 4: the cell's capture and import accounts, and the warehouse services'). Members
//   in IAM form, such as serviceAccount:siloes-capture@project.iam.gserviceaccount.com.
// - The folder and billing account a new project is created under (one folder per cell).
// - Sync and reconciliation intervals, and the rows one write carries.

import { z } from 'zod';
import { parseSection, read, zList, zPositiveInt, type Env } from './env.config.ts';

const member = z.string().regex(/^(serviceAccount|user|group):[^\s,]{3,254}$/, 'must be an IAM member such as serviceAccount:name@project.iam.gserviceaccount.com');

const schema = z.object({
  writerMembers: z.array(member).max(20).default([]),
  folderId: z.string().regex(/^\d{6,20}$/, 'must be a folder number').optional(),
  billingAccountId: z.string().regex(/^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/, 'must be a billing account id').optional(),
  syncIntervalSeconds: zPositiveInt(7 * 86_400).default(3_600),
  reconcileIntervalSeconds: zPositiveInt(30 * 86_400).default(86_400),
  reconcileSample: zPositiveInt(1_000).default(50),
  batchRows: zPositiveInt(10_000).default(500),
  accessCheckSeconds: zPositiveInt(86_400).default(300),
});

export interface WarehouseConfig {
  /** IAM members granted write access to every Warehouse dataset, and nobody else. */
  writerMembers: string[];
  folderId: string | undefined;
  billingAccountId: string | undefined;
  /** How often a Warehouse table without a change stream is re-read (spec 69.15). */
  syncIntervalSeconds: number;
  /** How often row counts and a sample of keys are compared with the sources. */
  reconcileIntervalSeconds: number;
  /** Keys compared per table at each reconciliation. */
  reconcileSample: number;
  /** Rows one write statement carries. */
  batchRows: number;
  /** How often live direct SQL grants are checked against markings (spec 69.16). */
  accessCheckSeconds: number;
}

export function loadWarehouseConfig(env: Env, problems: string[]): WarehouseConfig | undefined {
  const parsed = parseSection(schema, {
    writerMembers: read(env, 'WAREHOUSE_WRITER_MEMBERS') === undefined ? undefined : zList.parse(read(env, 'WAREHOUSE_WRITER_MEMBERS')),
    folderId: read(env, 'WAREHOUSE_FOLDER_ID'),
    billingAccountId: read(env, 'WAREHOUSE_BILLING_ACCOUNT_ID'),
    syncIntervalSeconds: read(env, 'WAREHOUSE_SYNC_INTERVAL_SECONDS'),
    reconcileIntervalSeconds: read(env, 'WAREHOUSE_RECONCILE_INTERVAL_SECONDS'),
    reconcileSample: read(env, 'WAREHOUSE_RECONCILE_SAMPLE'),
    batchRows: read(env, 'WAREHOUSE_BATCH_ROWS'),
    accessCheckSeconds: read(env, 'WAREHOUSE_ACCESS_CHECK_SECONDS'),
  }, {
    writerMembers: 'WAREHOUSE_WRITER_MEMBERS', folderId: 'WAREHOUSE_FOLDER_ID', billingAccountId: 'WAREHOUSE_BILLING_ACCOUNT_ID',
    syncIntervalSeconds: 'WAREHOUSE_SYNC_INTERVAL_SECONDS', reconcileIntervalSeconds: 'WAREHOUSE_RECONCILE_INTERVAL_SECONDS',
    reconcileSample: 'WAREHOUSE_RECONCILE_SAMPLE', batchRows: 'WAREHOUSE_BATCH_ROWS', accessCheckSeconds: 'WAREHOUSE_ACCESS_CHECK_SECONDS',
  }, problems);
  return parsed === undefined ? undefined : {
    ...parsed, folderId: parsed.folderId ?? undefined, billingAccountId: parsed.billingAccountId ?? undefined,
  };
}
