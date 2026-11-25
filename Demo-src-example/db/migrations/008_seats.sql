-- 008_seats — the licences an organisation holds, and who is sitting in them.
--
-- ONE ROW PER SEAT, NOT A COUNT ON THE ORGANISATION. A counter is smaller and
-- answers "how many" and nothing else. The questions that actually get asked are
-- "who is using our licences", "who gave this person one", and "when did we go
-- from nineteen to twenty" — and a counter answers all three with a shrug. A row
-- per seat also gives `invitations.seat_id`, which already exists, something to
-- point at.
--
-- ── The three states, and why removal is not one of them ────────────────────
--
--   free       nobody holds it and no invitation is waiting on it
--   reserved   an invitation is outstanding and this seat is spoken for
--   held       a membership occupies it
--
-- A SEAT IS NOT RELEASED BY OFFBOARDING, and `member.service` already says so:
-- a person leaving and a company reducing its licence count are different
-- decisions, taken by different people, needing different permissions. So
-- removing a member leaves the seat held by that membership until somebody
-- reclaims it deliberately. That is not an oversight to tidy up later — it is
-- what stops an offboarding quietly shrinking capacity the organisation is
-- about to need, and what keeps "how many licences are we paying for" a
-- question with a stable answer.
--
-- `retired_at` IS GIVING THE LICENCE UP, which is the `seat.release` permission
-- and a billing event. Distinct from reclaiming, which is `seat.allocate` and
-- merely makes a seat free again.

CREATE TABLE seats (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /*
   * Which membership is sitting in it. Null means nobody — including after that
   * person is removed, once a seat has been reclaimed.
   */
  held_by         uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  held_since      timestamptz,

  /*
   * An outstanding invitation holds the seat so two admins cannot invite the
   * last free one twice. Released when the invitation is revoked or expires.
   */
  reserved_for    uuid        REFERENCES invitations(id) ON DELETE RESTRICT,
  reserved_at     timestamptz,

  allocated_by    uuid        REFERENCES memberships(id) ON DELETE RESTRICT,

  /** The licence was given up. A billing event, not an offboarding. */
  retired_at      timestamptz,
  retired_by      uuid        REFERENCES memberships(id) ON DELETE RESTRICT,

  created_at      timestamptz NOT NULL DEFAULT now(),

  /*
   * A SEAT CANNOT BE BOTH RESERVED AND HELD. Without this the two allocation
   * paths — invite-then-accept, and allocate-directly — can each claim the same
   * row, and the organisation quietly seats two people on one licence.
   */
  CONSTRAINT seats_not_both CHECK (NOT (held_by IS NOT NULL AND reserved_for IS NOT NULL)),

  -- The timestamps travel with the thing they date, or they are decoration.
  CONSTRAINT seats_held_dated     CHECK ((held_by IS NULL)      = (held_since IS NULL)),
  CONSTRAINT seats_reserved_dated CHECK ((reserved_for IS NULL) = (reserved_at IS NULL)),
  CONSTRAINT seats_retired_dated  CHECK ((retired_at IS NULL)   = (retired_by IS NULL)),

  /*
   * A RETIRED SEAT CANNOT BE OCCUPIED. Giving up a licence somebody is sitting
   * in is a billing change that silently removes their access, which is a
   * support ticket rather than an intention.
   */
  CONSTRAINT seats_retired_empty CHECK (
    retired_at IS NULL OR (held_by IS NULL AND reserved_for IS NULL)
  )
);

CREATE INDEX seats_by_org ON seats (organisation_id) WHERE retired_at IS NULL;

/*
 * ONE SEAT PER MEMBERSHIP, ONE PER INVITATION. Partial unique indexes rather
 * than constraints, because the columns are nullable and most rows are free —
 * a plain UNIQUE would treat every free seat's NULL as distinct, which is true
 * and useless, while these say the thing that matters: nobody sits twice.
 */
CREATE UNIQUE INDEX seats_one_per_member     ON seats (held_by)      WHERE held_by IS NOT NULL;
CREATE UNIQUE INDEX seats_one_per_invitation ON seats (reserved_for) WHERE reserved_for IS NOT NULL;

ALTER TABLE seats ENABLE ROW LEVEL SECURITY;
ALTER TABLE seats FORCE  ROW LEVEL SECURITY;

CREATE POLICY seats_tenant ON seats
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON seats TO silo_app;

/*
 * Now `invitations.seat_id` can point at something. It was a bare uuid with no
 * reference, because the table it meant did not exist.
 *
 * NOT VALID + VALIDATE would matter on a live table; this one is empty
 * everywhere, so the constraint is added outright.
 */
ALTER TABLE invitations
  ADD CONSTRAINT invitations_seat_fk FOREIGN KEY (seat_id) REFERENCES seats(id) ON DELETE RESTRICT;
