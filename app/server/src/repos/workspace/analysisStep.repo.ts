// Data access for workspace.analysis_steps, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  analysisStepTable,
  type AnalysisStep,
  type NewAnalysisStep,
} from '../../models/workspace/analysisStep.model.ts';

export const analysisStepRepo = {
  insert(db: Queryable, row: NewAnalysisStep): Promise<AnalysisStep> {
    return insertRow(db, analysisStepTable, row);
  },

  findById(db: Queryable, id: AnalysisStep['id']): Promise<AnalysisStep | undefined> {
    return findRow(db, analysisStepTable, { id });
  },

  /** A chain's steps, written once: a manifest already in use keeps the steps it has (steps are immutable). */
  async insertMissing(db: Queryable, rows: readonly NewAnalysisStep[]): Promise<void> {
    for (const row of rows) {
      await db.query(
        `insert into workspace.analysis_steps (id, organisation_id, manifest_id, position, operation, input_steps, definition, output_kind, bound)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (organisation_id, manifest_id, position) do nothing`,
        [row.id, row.organisationId, row.manifestId, row.position, row.operation, row.inputSteps ?? [], JSON.stringify(row.definition), row.outputKind, row.bound]);
    }
  },

  findByManifestIdAndPosition(
    db: Queryable,
    key: Pick<AnalysisStep, 'organisationId' | 'manifestId' | 'position'>,
  ): Promise<AnalysisStep | undefined> {
    return findRow(db, analysisStepTable, key);
  },
};
