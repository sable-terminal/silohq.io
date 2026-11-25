/*
 * 110 — a conversation, kept.
 *
 * ── WHAT THIS CHANGES, AND WHAT IT DOES NOT ───────────────────────────────
 *
 * PRODUCT §2.2 lists saved views "the way chat threads are listed: persistent,
 * returnable, renameable" — and the thread itself was the session's, held in
 * the page and lost on reload. Somebody who asked four questions to get to the
 * fifth lost the four. So the WORDS are kept, and the ANSWER IS NOT: a view
 * stores the question because the data is read fresh every time, and the same
 * rule holds here. Reopening a conversation shows what was asked and what was
 * said about it, and asking again is what produces figures.
 *
 * ── WHY A LINE OF THE ANSWER IS STORED AT ALL ─────────────────────────────
 *
 * A thread of questions with no answers is not a thread. What is kept is the
 * answer's first sentence — the prose the render layer composed, the refusal in
 * the model's words, or the intent of a change — which can carry a figure, and
 * that is the reason for the bound below rather than a reason to store nothing.
 *
 * ── BOUNDED BY THE SCHEMA, NOT BY A SWEEP ─────────────────────────────────
 *
 * The product claim is that nothing is stored permanently, and the rule this
 * codebase settled on is that the bound must be a CHECK rather than a job's
 * good intentions (migration 025, and 099 after it). A conversation expires
 * thirty days after it was last used, every read filters on that, and there is
 * no way to write an expiry further out than the ceiling. Using a conversation
 * moves it along; abandoning one lets it go.
 */

CREATE TABLE conversations (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /* §6.2's rule, as views and dashboards have it: a membership, not a user. */
  owner_membership_id uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  /* Taken from the first question, and renameable after — like a chat thread. */
  title               text        NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,

  /*
   * THIRTY DAYS FROM LAST USE, AND THE CEILING IS HERE. Measured from
   * `updated_at` rather than `created_at` so a conversation somebody keeps
   * returning to keeps living, while one nobody opens again does not.
   */
  CONSTRAINT conversations_retention CHECK (
    expires_at > updated_at AND expires_at <= updated_at + interval '30 days'
  )
);

CREATE INDEX conversations_by_owner ON conversations (owner_membership_id, updated_at DESC);
CREATE INDEX conversations_expiring ON conversations (expires_at);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE  ROW LEVEL SECURITY;
CREATE POLICY conversations_tenant ON conversations
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO silo_app;

/*
 * One exchange: what was asked, and the one line that came back.
 *
 * NO ROWS, NO READINGS, NO PLAN. Not a summary of the data, not the entities,
 * not the compiled query — a turn is two pieces of text and what kind of answer
 * it was. Storing the plan would make this a cache of somebody's data by a
 * slower route.
 *
 * IT CANNOT OUTLIVE ITS CONVERSATION: no expiry of its own, cascade on delete,
 * and every read reaches it through a conversation that is still in date.
 */
CREATE TABLE conversation_turns (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  conversation_id uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

  position        integer     NOT NULL CHECK (position >= 0),

  /* What the person typed. */
  asked           text        NOT NULL CHECK (length(trim(asked)) BETWEEN 1 AND 2000),

  /* The answer's first sentence, a refusal in the model's words, or a change's intent. */
  said            text        NOT NULL CHECK (length(said) <= 2000),

  /* Which of those it was, so a reopened thread reads as it did. */
  kind            text        NOT NULL CHECK (kind IN ('answered', 'refused', 'ambiguous', 'change', 'view')),

  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (conversation_id, position)
);

CREATE INDEX conversation_turns_by_conversation ON conversation_turns (conversation_id, position);

ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turns FORCE  ROW LEVEL SECURITY;
CREATE POLICY conversation_turns_tenant ON conversation_turns
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_turns TO silo_app;
