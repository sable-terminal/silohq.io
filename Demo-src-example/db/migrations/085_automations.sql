/*
 * 085 — a saved question, a schedule, a condition, and something done about it.
 *
 * ── §1: "An automation removes the need to remember, not the need to approve" ─
 *
 * Everything an automation can do, a person can already do by hand, and nothing
 * it does is exempt from the governance that applies when a person does it.
 * This migration builds the half with no governance in it at all: a schedule, a
 * condition over a result, and a notification. Nothing here can write.
 *
 * ── THE MUTATE PATH IS ABSENT ON PURPOSE ───────────────────────────────────
 *
 * §14's build order ends at execute-within-bounds "because it is the only
 * unattended write in the product", and `automation_authorisations` is its
 * table. It is not created here. An empty table for a capability nobody can
 * reach yet is an invitation to wire it before the steps in front of it are
 * trusted.
 *
 * ── §7: the timezone is the organisation's ────────────────────────────────
 *
 * Stored per automation rather than read from the organisation at run time, so
 * that moving the organisation's calendar does not silently move every existing
 * schedule. A daily 9am means their 9am on the day it was written.
 */

CREATE TABLE automations (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /* §9 — owned by a membership, private by default. */
  owner_membership_id uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  name                text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),

  /*
   * §2 — the question half. RESTRICT rather than CASCADE: deleting a view that
   * something is scheduled on should say what it would break, not silently stop
   * a check somebody relies on.
   */
  saved_view_id       uuid        NOT NULL REFERENCES saved_views(id) ON DELETE RESTRICT,

  /* §7 — five fields, and the zone they are read in. */
  schedule            text        NOT NULL CHECK (length(trim(schedule)) BETWEEN 9 AND 128),
  time_zone           text        NOT NULL,

  /*
   * §9 — "Suspension pauses automations. Cancellation stops them. Neither
   * deletes them." So `paused` is a state rather than a deletion, and the
   * reason is kept: an owner who paused it themselves and one paused by a
   * halted connection need different things to happen next.
   */
  status              text        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'paused')),
  paused_reason       text        CHECK (paused_reason IN ('owner', 'failures', 'halted', 'owner_removed')),
  paused_at           timestamptz,

  /* §8 — chosen at creation, because a failing automation that silently keeps
     failing is worse than one that stops. */
  failure_policy      text        NOT NULL DEFAULT 'notify_and_continue'
                                  CHECK (failure_policy IN ('notify_and_continue', 'pause_after_failures')),
  pause_after         integer     CHECK (pause_after BETWEEN 1 AND 100),
  consecutive_failures integer    NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),

  /*
   * §7 — "Overlap is prevented. A run still in progress when the next is due
   * skips rather than queues." The claim is held here rather than in the
   * runner, so two processes racing cannot both decide they are the only one.
   */
  running_since       timestamptz,

  /* §7 — "Missed runs are not backfilled", so the runner needs to know where it
     got to, and a gap is reported rather than replayed. */
  last_run_at         timestamptz,
  next_run_at         timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT automations_paused_has_reason CHECK (
    (status = 'active' AND paused_reason IS NULL AND paused_at IS NULL) OR
    (status = 'paused' AND paused_reason IS NOT NULL AND paused_at IS NOT NULL)
  ),
  CONSTRAINT automations_pause_after_set CHECK (
    failure_policy <> 'pause_after_failures' OR pause_after IS NOT NULL
  ),

  UNIQUE (owner_membership_id, name)
);

/* What the scheduler sweeps: due, active, and not already running. */
CREATE INDEX automations_due ON automations (next_run_at)
  WHERE status = 'active' AND running_since IS NULL;
CREATE INDEX automations_by_owner ON automations (owner_membership_id);
CREATE INDEX automations_by_view ON automations (saved_view_id);

/*
 * §3 — three kinds of condition, evaluated against three different things.
 *
 * ONE TABLE, BECAUSE THEY COMBINE. §3 says conditions combine with AND and OR
 * at a bounded depth; three tables would make an ordered mixed list of them a
 * union query, and the combinator would have nowhere to live.
 *
 * `value` IS jsonb AND THAT IS NOT LAZINESS. A threshold is a number, a
 * detector condition names a detector and a concept, and "differs from the
 * previous run" takes no operand at all. A text column would be three types
 * pretending to be one.
 */
CREATE TABLE automation_conditions (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  automation_id   uuid        NOT NULL REFERENCES automations(id) ON DELETE CASCADE,

  kind            text        NOT NULL CHECK (kind IN ('result', 'finding', 'value')),
  /* Which figure or which detector, where the kind needs one. */
  target          text,
  operator        text        NOT NULL,
  value           jsonb,

  /* §3 — "bounded at a small depth. Anything deeper is a question." */
  combinator      text        NOT NULL DEFAULT 'and' CHECK (combinator IN ('and', 'or')),
  sequence        integer     NOT NULL CHECK (sequence BETWEEN 0 AND 9),

  UNIQUE (automation_id, sequence)
);

/*
 * §4 — what is done when the condition holds.
 *
 * NOTIFY IS THE ONLY KIND THIS MIGRATION ADMITS. The check constraint lists it
 * alone, so a report, escalate or mutate action cannot be inserted before the
 * code that governs it exists — a row nobody can execute is worse than a column
 * nobody has added yet.
 */
CREATE TABLE automation_actions (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  automation_id   uuid        NOT NULL REFERENCES automations(id) ON DELETE CASCADE,

  kind            text        NOT NULL CHECK (kind IN ('notify')),
  configuration   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  sequence        integer     NOT NULL CHECK (sequence BETWEEN 0 AND 9),

  UNIQUE (automation_id, sequence)
);

/*
 * §11 — "Every run is visible, including the ones where the condition did not
 * hold. An automation that has not fired in three months is either working or
 * broken, and the run history is the only way to tell."
 */
CREATE TABLE automation_runs (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  automation_id     uuid        NOT NULL REFERENCES automations(id) ON DELETE CASCADE,

  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,

  /* Null while running. `met` and `not_met` are both successful runs. */
  condition_outcome text        CHECK (condition_outcome IN ('met', 'not_met')),
  actions_taken     jsonb       NOT NULL DEFAULT '[]'::jsonb,

  error             text,
  /* §7 — overlap, and the gap an outage left. Both are reported, not hidden. */
  skipped_reason    text        CHECK (skipped_reason IN ('already_running', 'missed_window'))
);

CREATE INDEX automation_runs_by_automation ON automation_runs (automation_id, started_at DESC);

/*
 * §3 — "The result differs from the previous run... it needs the previous
 * result retained. Not the rows, a hash plus the count, which holds the
 * no-values line."
 *
 * NEVER ROWS, AND THE TABLE SAYS SO IN ITS COLUMNS. A digest and two numbers
 * can answer "did this change" without holding a single customer value, which
 * is what lets change detection exist in a product that stores nothing by
 * default.
 */
CREATE TABLE automation_run_state (
  automation_id       uuid        PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  previous_result_hash text,
  previous_row_count   integer    CHECK (previous_row_count >= 0),
  /*
   * §3's value condition is "evaluated against a single FIGURE the question
   * returns", and `figure` is that word rather than `value` on purpose: the
   * Silo egress check reserves the generic value column names for what a
   * customer record actually said, and keeping them reserved is worth more
   * than matching the table sketch in §12 word for word.
   */
  previous_figure      numeric,

  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations FORCE  ROW LEVEL SECURITY;
CREATE POLICY automations_tenant ON automations
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

ALTER TABLE automation_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_conditions FORCE  ROW LEVEL SECURITY;
CREATE POLICY automation_conditions_tenant ON automation_conditions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

ALTER TABLE automation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_actions FORCE  ROW LEVEL SECURITY;
CREATE POLICY automation_actions_tenant ON automation_actions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs FORCE  ROW LEVEL SECURITY;
CREATE POLICY automation_runs_tenant ON automation_runs
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

ALTER TABLE automation_run_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_run_state FORCE  ROW LEVEL SECURITY;
CREATE POLICY automation_run_state_tenant ON automation_run_state
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON automations TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_conditions TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_actions TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_runs TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_run_state TO silo_app;

/*
 * §10 — `automation.create` covers a notify or report action, and it is the
 * only one this stage can honour. `automation.mutate` and `automation.execute`
 * arrive with the code that enforces them: a permission catalogued before its
 * enforcement exists is a grant somebody can hold and nothing can check.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('automation.create', 'automation', 'Create a scheduled check that notifies', false),
  ('automation.manage', 'automation', 'Pause, resume or delete automations owned by others', true);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'automation.create'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin', 'Member')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'automation.manage'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin')
ON CONFLICT DO NOTHING;
