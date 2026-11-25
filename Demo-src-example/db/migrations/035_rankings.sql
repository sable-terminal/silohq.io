-- 035_rankings — the one stage where a model participates, kept where it can be
-- audited.
--
-- ── Why a ranking is stored at all ──────────────────────────────────────────
--
-- §5.2: "A user challenging a ranking is shown the computation, not an
-- assertion." That promise only holds if the ranking somebody saw still exists
-- when they challenge it — a re-run answers a different question, because the
-- findings will have moved and the model may have changed version.
--
-- ── What it may contain ─────────────────────────────────────────────────────
--
-- References and commentary. `ordered_findings` is finding ids with a rank and
-- a rationale; `groupings` is ids with a shared factor; `omissions` is ids with
-- a reason. There is no column here for a figure, a row, or a value of any
-- kind, because the model was never sent one — §5.2 again, and the same
-- structural guarantee 019 makes about discovery.

CREATE TABLE rankings (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /*
   * WHAT THIS RANKING WAS FOR.
   *
   * TEXT AND NULLABLE, because investigations are not a thing this codebase has
   * yet. When they are, this becomes a foreign key — and naming that here is
   * better than a uuid pointing at nothing while looking like it points at
   * something. `discovery_authorisations.approval_id` carries the same note for
   * the same reason.
   */
  investigation_ref text      CHECK (investigation_ref IS NULL
                                OR length(trim(investigation_ref)) BETWEEN 1 AND 128),

  /*
   * WHICH MODEL SAID THIS. §5.2 promises a challenge is answered with the
   * computation; half of answering "why was this first in March" is knowing
   * what was doing the ordering, and model versions change underneath a
   * deployment without anybody in this system being told.
   */
  model_version   text        NOT NULL CHECK (length(trim(model_version)) BETWEEN 1 AND 128),

  /* [{ findingId, rank, rationale }] — every entry cites, which §5.2 requires. */
  ordered_findings jsonb      NOT NULL DEFAULT '[]',
  /* [{ findingIds[], sharedFactor }] */
  groupings       jsonb       NOT NULL DEFAULT '[]',
  /*
   * [{ findingId, reason }] — KEPT, NOT DISCARDED. §5.3: omitted findings remain
   * visible on request. The model narrows attention; it never removes evidence,
   * and a column that dropped them would make it do exactly that.
   */
  omissions       jsonb       NOT NULL DEFAULT '[]',

  /*
   * §5.4 — a compile-class operation, weighted accordingly.
   *
   * NULLABLE AND UNREFERENCED, because metering is not built in this repo: there
   * is no token transaction table for this to point at. The tokens are recorded
   * beside it meanwhile, so the usage exists in the row even while the billing
   * link does not.
   */
  token_transaction_ref text,
  input_tokens    integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens   integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),

  created_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rankings_recent ON rankings (organisation_id, created_at DESC);

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE rankings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rankings FORCE  ROW LEVEL SECURITY;

CREATE POLICY rankings_tenant ON rankings
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON rankings TO silo_app;
