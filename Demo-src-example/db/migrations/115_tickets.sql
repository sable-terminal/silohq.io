/*
 * 115 — asking for help.
 *
 * ── THE PANEL HAS BEEN A DEAD END SINCE IT WAS DRAWN ──────────────────────
 *
 * The ticket panel offers five things to raise and the compose box takes a
 * message, and behind both there was nothing: `TICKETS_WIRED = false`, a
 * 450ms pause, and a screen admitting the message went nowhere. Saying so was
 * the right thing to do while it was true. This is the table that makes it
 * stop being true.
 *
 * ── THE FOUR KINDS ARE THE APP'S FOUR KINDS ───────────────────────────────
 *
 * `support`, `feature`, `security`, `partnership` — the keys of `RAISE` in
 * `ticket-panel.tsx`, which is the one table the panel and the compose box
 * already share. A fifth kind here that the app cannot raise, or a kind there
 * this CHECK refuses, is the same defect in two directions.
 *
 * ── THE STATUSES OUTLIVE ANYTHING THAT CAN SET THEM, DELIBERATELY ─────────
 *
 * The panel draws Open, In progress and Closed, and only `open` is ever
 * written from here: a ticket is moved along by whoever answers it, and there
 * is no endpoint for that because the person who raised it is not the person
 * who does it. Until the admin portal exists that is a hand on the database,
 * which is honest, and the column is where the answer will land either way.
 *
 * ── BOUNDED, AND NOT FOR THE OBVIOUS REASON ──────────────────────────────
 *
 * A ticket is correspondence rather than a customer's records, so the first
 * instinct is that the retention rule does not reach it. It does. The body is
 * free text typed by somebody in the middle of whatever went wrong, looking at
 * a screen full of their customers' data, and "the total on Acme's invoice 4021
 * is wrong" is the single most likely sentence in it. That is storage of
 * customer data by any reading, and the product's claim is that nothing is
 * stored permanently.
 *
 * What makes bounding it cheap rather than lossy is that this row is not the
 * record of the correspondence: the same words go to the support address by
 * email, and that inbox and its reply thread are where the conversation lives
 * and keeps its own retention. This copy is the working one — what the panel
 * lists and what the person can reopen — so it can expire.
 *
 * NINETY DAYS, NOT THIRTY, AND THE DIFFERENCE IS ARGUED. Thirty is right for a
 * notification and a conversation because both are read within days or not at
 * all. A ticket is answered by a person, over a week or a month, and a
 * partnership thread longer than that; thirty days from raising would delete
 * one mid-flight and the panel would lose a ticket somebody is still waiting
 * on. As a CHECK rather than a sweep's good intentions — the rule this
 * codebase settled on in 025 and has kept since.
 */

CREATE TABLE tickets (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /* §6.2's rule, as views, dashboards and notifications have it: a membership,
     not a user. The same person in two organisations raises two tickets, and
     each belongs to the organisation it was raised from. */
  raised_by_membership_id uuid        NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,

  /*
   * THE NUMBER SOMEBODY READS OUT. `bigserial` rather than the uuid, because
   * "SUP-2041" can be quoted over the telephone and a uuid cannot — and the
   * panel has shown a reference in that shape since it was drawn.
   *
   * ONE SERIES FOR EVERY KIND. The panel's own fixtures number a feature
   * request `SUP-2038`, which is the right instinct: the kind is already a
   * column, and a second copy of it inside a string is a second thing to keep
   * in step. The prefix is added where the row is mapped.
   */
  number                  bigserial   NOT NULL UNIQUE,

  kind                    text        NOT NULL CHECK (kind IN ('support', 'feature', 'security', 'partnership')),

  /*
   * TAKEN FROM THE FIRST LINE OF THE BODY, as a conversation's title is taken
   * from its first question. The compose box has one field on purpose — the
   * name and the address are the session's — so a subject asked for separately
   * would be a second field existing only to fill this column.
   */
  subject                 text        NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 120),
  body                    text        NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),

  status                  text        NOT NULL DEFAULT 'open'
                                      CHECK (status IN ('open', 'in_progress', 'closed')),

  created_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,

  CONSTRAINT tickets_retention CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '90 days'
  )
);

/* The panel's own query: mine, newest first. */
CREATE INDEX tickets_by_raiser ON tickets (raised_by_membership_id, created_at DESC);
CREATE INDEX tickets_expiring ON tickets (expires_at);

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE  ROW LEVEL SECURITY;
CREATE POLICY tickets_tenant ON tickets
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/*
 * NO UPDATE AND NO DELETE. Nothing in the app edits a ticket or takes one back:
 * a message sent for help is sent, and the expiry is what removes it. The
 * retention sweep runs as the migrator, not as this role.
 */
GRANT SELECT, INSERT ON tickets TO silo_app;
GRANT USAGE, SELECT ON SEQUENCE tickets_number_seq TO silo_app;
