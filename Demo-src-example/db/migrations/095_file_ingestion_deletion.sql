/*
 * 095 — turning a document into data, and taking both away again.
 *
 * ── §5: the second outcome ─────────────────────────────────────────────────
 *
 * "Ingested: The file is structured per the Silo's definition and becomes
 * queryable alongside live systems." And "Ingested files keep their source
 * document. An extracted value's provenance points at the file, the page or
 * cell, and the raw text it was read from."
 *
 * The extraction pipeline already exists and already records that provenance —
 * `silo_extractions` points at a `silo_files` row. So ingestion is not a second
 * pipeline: it is a link. `silo_file_id` ties the document somebody uploaded
 * to the working record the importer reads, both pointing at the same bytes.
 *
 * ── §6: "Leaving the source document behind after a deletion is the failure a
 * reviewer tests for" ──────────────────────────────────────────────────────
 *
 * That link is also what makes deletion complete. Without it, deleting a Files
 * row would leave the extractions and the rows derived from them, and deleting
 * through the Silo would leave the document. One of the two is the failure §6
 * names, and which one is a coin toss.
 */

ALTER TABLE files
  ADD COLUMN silo_file_id uuid REFERENCES silo_files(id) ON DELETE SET NULL;

CREATE INDEX files_by_silo_file ON files (silo_file_id) WHERE silo_file_id IS NOT NULL;

/* An export is never ingested, and a stored upload is not either until it is. */
ALTER TABLE files
  ADD CONSTRAINT files_ingested_has_silo_file CHECK (outcome <> 'ingested' OR silo_file_id IS NOT NULL);

/*
 * §8 — `file_deletions`: "file, scope of removal, counts, requested by,
 * completed at."
 *
 * §6 — "Deletion produces a receipt: what was removed, by whom, and what
 * stopped working as a result."
 *
 * ── THE COUNTS ARE NOT RECOMPUTED HERE ────────────────────────────────────
 *
 * Where a deletion reaches into a Silo, the Silo's own purge does the removing
 * and already writes a `purge_receipts` row carrying the transitions, the rows
 * and the detectors affected. `purge_receipt_id` points at it rather than this
 * table keeping a second set of numbers — two counts of one act is one act and
 * one number that will disagree.
 *
 * ── KEPT AFTER THE FILE IS GONE ───────────────────────────────────────────
 *
 * No foreign key to `files`, for the same reason `file_provenance` has none to
 * its source: a receipt that vanished with the thing it describes would be
 * evidence that disappears exactly when somebody asks for it.
 */
CREATE TABLE file_deletions (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  file_id           uuid        NOT NULL,
  file_name         text        NOT NULL,
  file_kind         text        NOT NULL CHECK (file_kind IN ('export', 'upload')),

  /* What the removal reached: the document alone, or its extractions too. */
  scope             text        NOT NULL CHECK (scope IN ('document', 'document_and_data')),

  /* The Silo purge that did the removing, where there was one. */
  purge_receipt_id  uuid,
  /* §6 — "what stopped working as a result." */
  detectors_affected text[]     NOT NULL DEFAULT '{}',
  rows_removed      integer     NOT NULL DEFAULT 0 CHECK (rows_removed >= 0),
  extractions_removed integer   NOT NULL DEFAULT 0 CHECK (extractions_removed >= 0),

  requested_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  completed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX file_deletions_by_file ON file_deletions (file_id);

ALTER TABLE file_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_deletions FORCE  ROW LEVEL SECURITY;
CREATE POLICY file_deletions_tenant ON file_deletions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT ON file_deletions TO silo_app;

/*
 * §7 — "file.delete: Delete a file. Uploads additionally require silo.purge."
 *
 * "Deleting an ingested upload is a purge, not a tidy-up, because it destroys
 * data a detector may depend on." So the second permission is not a formality:
 * it is the one that already governs destroying Silo data, asked again here
 * because this is another door onto the same act.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('file.delete', 'file', 'Delete a file. Uploads additionally require silo.purge', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'file.delete'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin', 'Member')
ON CONFLICT DO NOTHING;
