// Data access for fleet.promotions, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  promotionTable,
  type NewPromotion,
  type Promotion,
  type PromotionChanges,
} from '../../models/fleet/promotion.model.ts';

export const promotionRepo = {
  insert(db: Queryable, row: NewPromotion): Promise<Promotion> {
    return insertRow(db, promotionTable, row);
  },

  findById(db: Queryable, id: Promotion['id']): Promise<Promotion | undefined> {
    return findRow(db, promotionTable, { id });
  },

  update(db: Queryable, id: Promotion['id'], changes: PromotionChanges): Promise<Promotion | undefined> {
    return updateRow(db, promotionTable, { id }, changes);
  },
};
