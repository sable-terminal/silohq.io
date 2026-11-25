/*
 * 113 — something happened that you did not do.
 *
 * ── THE BELL HAS BEEN EMPTY SINCE IT WAS DRAWN ────────────────────────────
 *
 * The panel exists, says honestly that there is no endpoint behind it, and
 * shows an empty state rather than invented rows. This is the endpoint's table.
 *
 * ── ONLY WHERE THERE IS ONE PERSON TO TELL ────────────────────────────────
 *
 * A notification is addressed to a membership, never broadcast: a share names
 * its recipient, a cron has an owner, an upload has an uploader. Where an event
 * concerns everybody — a system halting, say — the place for it is Home, which
 * already says so to whoever opens it, rather than a row per member written at
 * the moment of the failure.
 *
 * ── THE WORDS ARE COMPOSED WHEN IT HAPPENS, NOT WHEN IT IS READ ───────────
 *
 * A notification says what was true at the time, which is why the title is text
 * rather than a template resolved later: "Ada shared Overdue invoices with you"
 * stays true after Ada leaves and the view is renamed, and re-resolving it then
 * would either change the sentence or fail to build it at all.
 *
 * ── AND THEREFORE BOUNDED ─────────────────────────────────────────────────
 *
 * Those words can name a customer's records, so this is storage of customer
 * data and the product's claim is that nothing is stored permanently. Thirty
 * days from when it happened, as a CHECK rather than a sweep's good intentions
 * — the rule this codebase settled on in 025 and has kept since.
 */

CREATE TABLE notifications (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /* Who is being told. §6.2's rule: a membership, not a user. */
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,

  /* What kind of thing, so a glance sorts them before a word is read. */
  kind            text        NOT NULL CHECK (kind IN ('change', 'cron', 'view', 'import', 'connection', 'people', 'security', 'billing')),

  title           text        NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  body            text        CHECK (body IS NULL OR length(body) <= 500),

  /*
   * WHERE IT HAPPENED. Every notification goes somewhere: a line of text that
   * cannot be acted on is not worth the interruption, and the point of it is
   * the thing it happened to.
   */
  href            text        NOT NULL CHECK (length(href) BETWEEN 1 AND 512),

  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,
  expires_at      timestamptz NOT NULL,

  CONSTRAINT notifications_retention CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '30 days'
  )
);

/* The panel's own query: mine, newest first, unread included. */
CREATE INDEX notifications_by_member ON notifications (membership_id, created_at DESC);
CREATE INDEX notifications_expiring ON notifications (expires_at);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE  ROW LEVEL SECURITY;
CREATE POLICY notifications_tenant ON notifications
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO silo_app;
