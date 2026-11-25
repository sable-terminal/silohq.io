// The daily partition job. Runs platform.maintain_partitions() as silo_migrate, which
// creates partitions ahead and moves any row that reached a default partition into a
// partition of its own, then checks platform.partition_status(). Exits 1 when a planned
// table is behind, missing or still holds rows in its default partition, so the
// scheduler's failed-run alert is the partition alert.
//
// No write depends on this job: every range-partitioned table has a default partition.
// The job keeps retention (dropping a whole month) and sealing working.
//
// Usage: node src/db/scripts/maintainPartitions.script.ts   (uses CELL_MIGRATE_URL)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export interface PartitionStatus {
  parent: string;
  granularity: string;
  covered_until: Date | null;
  required_until: Date;
  default_rows: string | null;
  healthy: boolean;
}

export async function maintainPartitions(connectionString: string): Promise<PartitionStatus[]> {
  const client = new pg.Client({ connectionString, application_name: 'silo-partition-job' });
  await client.connect();
  try {
    await client.query('set role silo_migrate');
    await client.query('begin');
    try {
      await client.query('select platform.maintain_partitions()');
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    const { rows } = await client.query<PartitionStatus>('select * from platform.partition_status()');
    return rows;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const url = process.env['CELL_MIGRATE_URL'];
  if (!url) {
    console.error('CELL_MIGRATE_URL is not set');
    process.exit(2);
  }
  const status = await maintainPartitions(url);
  const unhealthy = status.filter((s) => !s.healthy);
  for (const s of unhealthy) {
    const reason = s.covered_until === null && s.default_rows === null
      ? 'table missing: remove its plan row or restore it'
      : `covered until ${s.covered_until?.toISOString() ?? 'nothing'}, needs ${s.required_until.toISOString()}, `
        + `${s.default_rows} rows in the default partition`;
    console.error(`partition alert: ${s.parent}: ${reason}`);
  }
  console.log(`${status.length - unhealthy.length} of ${status.length} partitioned tables healthy`);
  if (unhealthy.length > 0) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
