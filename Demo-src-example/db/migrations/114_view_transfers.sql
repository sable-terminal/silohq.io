/*
 * 114 — a saved view inherited when its owner leaves.
 *
 * ── AN INHERITANCE IS NOT A GIFT ──────────────────────────────────────────
 *
 * AUTH rev 7: "On removal, every view owned by that membership transfers to
 * the admin above them… Transferred views arrive FLAGGED, not shared." 111
 * built the act of sharing; this builds what happens to a share when the
 * person who made it is gone. The admin receives a queue of views they did not
 * ask for and did not write, and the flag is the record that they have not yet
 * decided what any of them is for.
 *
 * ── SUSPENDED, WHICH IS NOT REVOKED, AND THAT IS THE WHOLE COLUMN ─────────
 *
 * rev 7: "Until reviewed, the view is visible to the receiving admin alone and
 * its existing shares are suspended." Not revoked — "A view the removed person
 * had shared with three colleagues keeps working only if the admin decides it
 * should. Otherwise a departure silently leaves shared access in place with an
 * owner who no longer exists, and nobody is accountable for it."
 *
 * So `suspended_at` sits beside `revoked_at` rather than reusing it. Revocation
 * is somebody taking a share back and is final; suspension is the system
 * holding three colleagues' access still until a person decides, and it has to
 * be undoable in one statement — because "share onward" is exactly the decision
 * that undoes it. Reusing `revoked_at` would make restoring a share
 * indistinguishable from re-granting one somebody had deliberately withdrawn.
 *
 * ── A FLAG CANNOT BE DELETED, WHICH IS A GRANT AND NOT A HOPE ─────────────
 *
 * rev 7's last constraint: "Transfer flags cannot be deleted, only resolved, so
 * an unreviewed inheritance stays visible." The application role holds SELECT,
 * INSERT and UPDATE on this table and no DELETE, the same way `auth_events` is
 * append-only by grant. A rule the application enforces is a rule the next
 * `DELETE FROM` walks past; a missing grant is checkable by whoever asks.
 *
 * ── WHAT IS NOT HERE ──────────────────────────────────────────────────────
 *
 * rev 7 also lists `transferred_from` and `transferred_at` on `saved_views`.
 * They are not added, for 111's reason for leaving `visibility` out: this table
 * already says who a view came from and when, it is the row that cannot be
 * deleted, and a second copy on the view would be the one that disagrees the
 * first time a view is inherited twice. The latest flag for a view IS its
 * provenance.
 */

CREATE TABLE view_transfer_flags (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /*
   * RESTRICT, WHERE `view_shares` AND EVERY OTHER CHILD OF A VIEW CASCADE.
   *
   * A cascade here would be the deletion rev 7 forbids, taken by a different
   * route: delete the view and the flag saying you inherited it goes with it. So
   * a view carrying a flag cannot be deleted at all, which is exactly what
   * `archived` is one of the three answers FOR — the service refuses the delete
   * in words and points at archiving, rather than letting this constraint
   * surface as a foreign key error.
   */
  view_id           uuid        NOT NULL REFERENCES saved_views(id) ON DELETE RESTRICT,

  /*
   * BOTH SIDES ARE RESTRICT, and the one that matters is `transferred_from`: it
   * names a membership that has just been removed, and removal is a status
   * change rather than a delete precisely so the trail keeps pointing at
   * somebody. A cascade here would let the evidence of an inheritance be
   * destroyed by tidying up the person it came from.
   */
  transferred_to    uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  transferred_from  uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  /* rev 7's three. `scope_archived` is listed there and has no caller yet;
     it is in the CHECK because the reason a view moved is the reason it moved,
     and adding a value to a constraint later is a migration nobody plans. */
  reason            text        NOT NULL
                                CHECK (reason IN ('member_removed', 'member_suspended', 'scope_archived')),

  reviewed_at       timestamptz,

  /*
   * rev 7 — "Each one they may share onward, retain privately, or archive."
   *
   * NULL UNTIL REVIEWED, AND THE TWO MOVE TOGETHER. A decision with no time on
   * it cannot be placed against the removal it followed, and a review with no
   * decision is a queue item that has left the queue without answering it.
   */
  decision          text        CHECK (decision IN ('shared', 'retained', 'archived')),

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT view_transfer_flags_reviewed_together CHECK (
    (reviewed_at IS NULL AND decision IS NULL) OR
    (reviewed_at IS NOT NULL AND decision IS NOT NULL)
  )
);

/*
 * ONE OUTSTANDING FLAG PER VIEW. A view whose new owner is removed before they
 * review it transfers again — and it must, or the second departure leaves it
 * with a dead owner — so a view may hold many flags over its life. What it may
 * not hold is two unanswered ones, which would put the same view in two
 * people's queues and let the second decision silently overwrite the first.
 */
CREATE UNIQUE INDEX view_transfer_flags_one_outstanding
  ON view_transfer_flags (view_id)
  WHERE reviewed_at IS NULL;

/* The queue's own query: what this admin has not yet answered, oldest first. */
CREATE INDEX view_transfer_flags_queue
  ON view_transfer_flags (transferred_to, created_at)
  WHERE reviewed_at IS NULL;

ALTER TABLE view_transfer_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE view_transfer_flags FORCE  ROW LEVEL SECURITY;
CREATE POLICY view_transfer_flags_tenant ON view_transfer_flags
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* No DELETE. See the header: resolved, never deleted. */
GRANT SELECT, INSERT, UPDATE ON view_transfer_flags TO silo_app;

/*
 * A share held still rather than taken back.
 *
 * READ AS DEAD EVERYWHERE A SHARE IS READ, restored by clearing one column.
 * The repo's `LIVE` predicate gains it beside `revoked_at`, so a suspended
 * share stops answering `accessFor`, stops appearing in "shared with you", and
 * comes back exactly as it was when the admin says it should.
 */
ALTER TABLE view_shares
  ADD COLUMN suspended_at timestamptz;

/*
 * A view put away rather than deleted.
 *
 * ARCHIVING IS ONE OF THE THREE DECISIONS AND DELETION IS NOT AVAILABLE TO IT.
 * A flag holds its view with RESTRICT, so an inherited view cannot be deleted at
 * all — the record of the inheritance has to keep pointing at something.
 * Archived views drop out of their owner's list and stay where the trail can
 * still find them.
 */
ALTER TABLE saved_views
  ADD COLUMN archived_at timestamptz;
