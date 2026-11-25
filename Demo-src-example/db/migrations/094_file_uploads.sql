/*
 * 094 — a document a customer put here, which is storage.
 *
 * ── §1: "Every upload requires a Silo" ─────────────────────────────────────
 *
 * "Uploading is storage, and a second storage path outside the Silo disclosure
 * would break the claim that nothing is retained unless a customer switched it
 * on. A customer with storage off can export and download; they cannot upload."
 *
 * 092 already made that a CHECK — an upload without a Silo cannot be written.
 * What this migration adds is the rest of §5: which of the two outcomes was
 * chosen, and whether the bytes have actually turned up.
 *
 * ── `received_at` EXISTS BECAUSE THE BYTES ARRIVE SEPARATELY ───────────────
 *
 * A large document is PUT straight to the object store against a signed URL, so
 * there is a moment where a row exists and its contents do not. §5 asks for
 * validation "before anything reaches storage", and with a signed upload the
 * honest version of that is in two halves: what can be judged from the request
 * — the declared type, the size, the Silo, the clearance — is judged before the
 * URL is issued, and what can only be judged from the bytes is judged on
 * receipt, with the object removed if it fails.
 *
 * A row with no `received_at` is not a file. It is not listed, not
 * downloadable, and not counted as anything.
 */

ALTER TABLE files
  ADD COLUMN outcome text CHECK (outcome IN ('stored', 'ingested')),
  ADD COLUMN received_at timestamptz;

/*
 * §5 — "Stored is the default. Ingestion is a deliberate act, because it is
 * what turns a document into data the ontology can join." The default lives in
 * the code that reads the request, not here, so that a row written without an
 * outcome is a bug rather than a silent 'stored'.
 */
ALTER TABLE files
  ADD CONSTRAINT files_upload_has_outcome CHECK (kind <> 'upload' OR outcome IS NOT NULL),
  ADD CONSTRAINT files_export_has_no_outcome CHECK (kind <> 'export' OR outcome IS NULL);

/* An export is complete the moment it is written; only an upload waits. */
UPDATE files SET received_at = created_at WHERE kind = 'export' AND received_at IS NULL;

ALTER TABLE files
  ADD CONSTRAINT files_export_is_received CHECK (kind <> 'export' OR received_at IS NOT NULL);

CREATE INDEX files_awaiting_bytes ON files (created_at) WHERE received_at IS NULL AND deleted_at IS NULL;

/*
 * §7 — "file.upload: Upload into a Silo. Requires silo.import."
 *
 * TWO PERMISSIONS, AND THE SECOND IS NOT IMPLIED BY THE FIRST. `file.upload`
 * says somebody may put documents in Files; `silo.import` says they may put
 * data into that Silo. Granting the first alone would let somebody write into
 * storage they have no business writing into, through a door labelled Files.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('file.upload', 'file', 'Upload a document into a Silo', true);

/*
 * NOT ON `Member`. Exporting is reading something you can already see; putting
 * a document into a customer's retained storage is not, and §5 makes it
 * conditional on `silo.import`, which Member does not hold either.
 */
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'file.upload'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin')
ON CONFLICT DO NOTHING;
