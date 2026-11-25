// Data access for siloes.extraction_confirmations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  extractionConfirmationTable,
  type ExtractionConfirmation,
  type NewExtractionConfirmation,
} from '../../models/siloes/extractionConfirmation.model.ts';

export const extractionConfirmationRepo = {
  insert(db: Queryable, row: NewExtractionConfirmation): Promise<ExtractionConfirmation> {
    return insertRow(db, extractionConfirmationTable, row);
  },

  findById(db: Queryable, id: ExtractionConfirmation['id']): Promise<ExtractionConfirmation | undefined> {
    return findRow(db, extractionConfirmationTable, { id });
  },

  findByExtractionId(
    db: Queryable,
    key: Pick<ExtractionConfirmation, 'organisationId' | 'extractionId'>,
  ): Promise<ExtractionConfirmation | undefined> {
    return findRow(db, extractionConfirmationTable, key);
  },
};
