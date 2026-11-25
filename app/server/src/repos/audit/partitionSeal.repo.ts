// Data access for audit.partition_seals, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_audit_writer, silo_report; written by silo_audit_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  partitionSealTable,
  type NewPartitionSeal,
  type PartitionSeal,
} from '../../models/audit/partitionSeal.model.ts';

export const partitionSealRepo = {
  insert(db: Queryable, row: NewPartitionSeal): Promise<PartitionSeal> {
    return insertRow(db, partitionSealTable, row);
  },

  findById(db: Queryable, id: PartitionSeal['id']): Promise<PartitionSeal | undefined> {
    return findRow(db, partitionSealTable, { id });
  },

  findByLedgerAndPartitionName(
    db: Queryable,
    key: Pick<PartitionSeal, 'ledger' | 'partitionName'>,
  ): Promise<PartitionSeal | undefined> {
    return findRow(db, partitionSealTable, key);
  },

  /** Seals of one ledger, or all, whose range overlaps [from, to), oldest first. */
  async list(db: Queryable, filter: { ledger?: PartitionSeal['ledger'] | undefined; from?: string | undefined; to?: string | undefined; limit: number })
    : Promise<PartitionSeal[]> {
    const { rows } = await db.query(
      `select ${partitionSealTable.select} from audit.partition_seals
       where ($1::text is null or ledger = $1) and ($2::timestamptz is null or range_end > $2) and ($3::timestamptz is null or range_start < $3)
       order by range_start, ledger, partition_name limit $4`,
      [filter.ledger ?? null, filter.from ?? null, filter.to ?? null, filter.limit]);
    return rows as PartitionSeal[];
  },
};
