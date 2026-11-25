/*
 * 075 — a change carried out: what was attempted in each system, what each
 * record holds afterwards, and the receipt.
 *
 * ── Per connection, and not atomic ─────────────────────────────────────────
 *
 * Mutations §10: "Two source systems have no shared transaction. A mutation
 * touching three systems can succeed in two and fail in one, and the receipt
 * records exactly that rather than reporting a single outcome." So an execution
 * is a row per connection per phase, and a verification is a row per record per
 * field.
 *
 * ── The receipt is immutable, and not permanent ────────────────────────────
 *
 * §12: "One per mutation, immutable." No UPDATE grant exists for it. It holds
 * what every record held before and after, which is customer data, so it has a
 * retention date the schema bounds, and the retention sweep deletes the receipt
 * with the mutation and everything under it once that date passes.
 */

INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('mutation.execute', 'mutation', 'Run an approved change where the organisation separates running from approving', true);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'mutation.execute'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin')
ON CONFLICT DO NOTHING;

/* ── Statuses past approval ──────────────────────────────────────────────── */

ALTER TABLE mutations DROP CONSTRAINT mutations_status_check;
ALTER TABLE mutations ADD CONSTRAINT mutations_status_check
  CHECK (status IN (
    'previewed', 'awaiting_approval', 'approved', 'rejected',
    'executing', 'canary_paused', 'executed', 'partially_executed', 'failed'
  ));

/*
 * WHO IS RUNNING IT, AND SINCE WHEN. A claim an instance abandoned — it died
 * mid-run — is found by its age and picked up again; the run is resumable
 * record by record, so picking it up writes nothing twice.
 *
 * Not covered by `mutations_describe_once`, which names the columns that
 * describe a change and nothing else.
 */
ALTER TABLE mutations ADD COLUMN claimed_at timestamptz;
ALTER TABLE mutations ADD COLUMN executed_by uuid REFERENCES memberships(id) ON DELETE RESTRICT;

/*
 * WHEN SOMEBODY LOOKED AT THE CANARY AND SAID GO ON. Its own column rather than
 * inferred from which phases exist, because a run that died between writing the
 * sample and pausing would otherwise read as confirmed and carry straight on.
 */
ALTER TABLE mutations ADD COLUMN canary_confirmed_at timestamptz;
ALTER TABLE mutations ADD COLUMN canary_confirmed_by uuid REFERENCES memberships(id) ON DELETE RESTRICT;

/* ── Each system, each phase ─────────────────────────────────────────────── */

/*
 * `phase` IS THE CANARY'S. A change of ten thousand records or more writes a
 * bounded sample first (§8), verifies it and waits; the rest is its own phase,
 * so the receipt says which records went before anybody confirmed.
 *
 * `skipped` IS A SYSTEM NOT ATTEMPTED because an earlier one failed outright. A
 * failure to reach a system at all stops the change there rather than widening
 * the disagreement it has already caused.
 */
CREATE TABLE mutation_executions (
  id              uuid        PRIMARY KEY,
  mutation_id     uuid        NOT NULL REFERENCES mutations(id) ON DELETE CASCADE,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  phase           text        NOT NULL CHECK (phase IN ('canary', 'remainder', 'full')),
  status          text        NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped')),
  records         integer     NOT NULL DEFAULT 0 CHECK (records >= 0),
  applied         integer     NOT NULL DEFAULT 0 CHECK (applied >= 0),
  failed          integer     NOT NULL DEFAULT 0 CHECK (failed >= 0),
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  /* A code, never a message: a source's error text can quote the record. */
  error           text        CHECK (error IS NULL OR error ~ '^[a-z_]+\.[A-Za-z0-9_.]+$'),
  UNIQUE (mutation_id, connection_id, phase)
);

ALTER TABLE mutation_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_executions FORCE  ROW LEVEL SECURITY;
CREATE POLICY mutation_executions_tenant ON mutation_executions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON mutation_executions TO silo_app;

/* ── What each record holds afterwards ───────────────────────────────────── */

/*
 * §11 — "verified, meaning the source holds what was intended; diverged,
 * meaning the write applied but the result differs, typically a source-side
 * transform or truncation; failed, meaning the write did not apply."
 *
 * `field` IS NULL FOR A DELETE, whose outcome is the record's rather than any
 * field's. `detail` is a code: why a record failed, or that it had already
 * changed since the preview and so was not written.
 *
 * APPEND-ONLY. What a record held when it was checked is evidence.
 */
CREATE TABLE mutation_verifications (
  execution_id    uuid        NOT NULL REFERENCES mutation_executions(id) ON DELETE CASCADE,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  ref             text        NOT NULL,
  field           text,
  intended        jsonb,
  observed        jsonb,
  outcome         text        NOT NULL CHECK (outcome IN ('verified', 'diverged', 'failed')),
  detail          text        CHECK (detail IS NULL OR detail ~ '^[a-z_]+\.[A-Za-z0-9_.]+$'),
  checked_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mutation_verifications_once
  ON mutation_verifications (execution_id, ref, COALESCE(field, ''));

ALTER TABLE mutation_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_verifications FORCE  ROW LEVEL SECURITY;
CREATE POLICY mutation_verifications_tenant ON mutation_verifications
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT ON mutation_verifications TO silo_app;

/* ── The receipt ─────────────────────────────────────────────────────────── */

/*
 * THE DOCUMENT IS ASSEMBLED ONCE, FROM ROWS, WHEN THE CHANGE FINISHES. "It
 * answers what changed, who authorised it, and what it was before, without
 * anything being reconstructed afterwards" — so nothing reads it back together
 * from the tables later, and `digest` is its SHA-256.
 *
 * `retain_until` IS THE BOUND ON HOW LONG ANY OF IT IS KEPT: the receipt, and
 * the mutation, targets, prior states and verifications it was assembled from.
 * Never past 730 days, the same ceiling a Silo has.
 */
CREATE TABLE mutation_receipts (
  id              uuid        PRIMARY KEY,
  mutation_id     uuid        NOT NULL UNIQUE REFERENCES mutations(id) ON DELETE CASCADE,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  document        jsonb       NOT NULL,
  digest          text        NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  retain_until    timestamptz NOT NULL,
  CONSTRAINT mutation_receipts_retention CHECK (
    retain_until > created_at AND retain_until <= created_at + interval '730 days'
  )
);

CREATE INDEX mutation_receipts_expiring ON mutation_receipts (retain_until);

ALTER TABLE mutation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_receipts FORCE  ROW LEVEL SECURITY;
CREATE POLICY mutation_receipts_tenant ON mutation_receipts
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* IMMUTABLE: no UPDATE, and no DELETE but the sweep's. */
GRANT SELECT, INSERT ON mutation_receipts TO silo_app;
