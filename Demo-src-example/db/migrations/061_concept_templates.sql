/*
 * §2.8 — concept shapes that recur, kept so a first proposal is not a cold
 * start.
 *
 * ── WHAT THIS IS EMPHATICALLY NOT ──────────────────────────────────────────
 *
 * §6.5: a map never leaves its organisation, and there is no anonymised layer
 * and no aggregate improvement across customers. That stands and this does not
 * touch it. Nothing here is derived from a customer's records: a template is a
 * SHAPE — a name and a set of field names that tend to appear together — and
 * the only cross-tenant mechanism §2.8 permits.
 *
 * WRITTEN BY SILO, NEVER BY A TENANT. There is no organisation_id because a
 * template belongs to nobody, and no route writes one. It is reviewed and
 * inserted deliberately, the same shape as connector trust tiers.
 *
 * NEVER APPLIED AUTOMATICALLY. §2.4 — confirmation is what creates a concept,
 * and a template only changes what a PROPOSAL is called and which fields it
 * suggests. A person still confirms, corrects or renames.
 */
CREATE TABLE concept_templates (
  id            uuid        PRIMARY KEY,

  /** What a shape like this is usually called. A hint, per §2.3. */
  name          text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),
  description   text,

  /*
   * The field names that tend to appear together in this shape.
   *
   * NAMES, NOT VALUES, AND NOT A SCHEMA. `{email, first_name, last_name,
   * company}` says a shape carrying these is usually called a person. It
   * constrains nothing and matches nothing — §2.3 is explicit that a naming
   * hint has no effect on matching.
   */
  field_names   text[]      NOT NULL CHECK (cardinality(field_names) BETWEEN 1 AND 64),

  /** How many distinct tenants a shape like this was seen in, recorded by a
      person reviewing it — never counted automatically from customer data. */
  seen_in       integer     NOT NULL DEFAULT 0 CHECK (seen_in >= 0),

  retired_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT concept_templates_name_unique UNIQUE (name)
);

CREATE INDEX concept_templates_live ON concept_templates (name) WHERE retired_at IS NULL;

/*
 * NO ROW LEVEL SECURITY, AND THAT IS THE ONE CASE IT IS RIGHT. A template
 * belongs to no organisation, holds nothing of anybody's, and is readable by
 * every tenant precisely because there is nothing in it to leak. The app may
 * READ and nothing more — writing is a deliberate act by Silo, outside the
 * application role.
 */
GRANT SELECT ON concept_templates TO silo_app;
