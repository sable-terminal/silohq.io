/*
 * 065 — Siloes. Capture: what the first audit of 063 found.
 *
 * Each block below repairs one defect that was reproduced against a live
 * database rather than reasoned about. Nothing here is a new feature except
 * bytes scanned, which §10 asked for "from day one" and 063 did not deliver.
 */

/* ── 1. A baseline belongs to one connection ─────────────────────────────── */

/*
 * THE CONFLICT KEY HAD NO CONNECTION IN IT. Two systems that happen to use the
 * same identifier for a record — which is the ordinary case for invoice numbers,
 * order numbers, anything a person typed — shared one baseline. Every query then
 * compared system A's value against system B's, and a disagreement between them
 * (the thing this product exists to detect) was written as a transition on every
 * single answer, for ever.
 *
 * THE EXISTING ROWS GO. A baseline is a cache of the last value seen and it
 * cannot be assigned to a connection after the fact. Losing it costs one
 * sighting per entity — the next answer is a first sighting again, and no
 * transition is lost that was not already wrong.
 */
DELETE FROM silo_baselines;

ALTER TABLE silo_baselines ADD COLUMN connection_id uuid NOT NULL;
ALTER TABLE silo_baselines DROP CONSTRAINT silo_baselines_unique;
ALTER TABLE silo_baselines ADD CONSTRAINT silo_baselines_unique
  UNIQUE (silo_id, concept_id, connection_id, entity_ref, field_path);

/*
 * THE LAST VALUE IS A CUSTOMER VALUE, AND IT WAS KEPT FOR EVER. §6 says the two
 * transition columns are the one place the architecture holds values; the
 * baseline is a third column holding exactly that, and no retention window
 * reached it. The sweep now deletes a baseline not seen within its Silo's
 * window, and this index is what lets it.
 */
CREATE INDEX silo_baselines_by_age ON silo_baselines (silo_id, last_seen_at);

/* A value is bounded in the schema, not only in the service that should have
   refused it: a whole spreadsheet cell pasted into a text field is a row the
   queue holds in memory and the disclosure has to account for. */
ALTER TABLE silo_baselines ADD CONSTRAINT silo_baselines_value_bounded
  CHECK (last_value IS NULL OR char_length(last_value) <= 4096);

/* ── 2. Transitions ──────────────────────────────────────────────────────── */

ALTER TABLE transitions ADD CONSTRAINT transitions_values_bounded
  CHECK ((previous_value IS NULL OR char_length(previous_value) <= 4096)
     AND (new_value      IS NULL OR char_length(new_value)      <= 4096));

/*
 * THE SWEEP HAD NO INDEX. Every retention run scanned every transition in the
 * cell and spilled each deleted row to temp. Per Silo, by age, is the exact
 * shape of both the sweep's predicate and the detector's newest-first read.
 */
CREATE INDEX transitions_by_silo_and_age ON transitions (silo_id, observed_at);

/*
 * ── Partitions that exist ───────────────────────────────────────────────────
 *
 * 063 declared transitions PARTITION BY RANGE (observed_at) and created only
 * the DEFAULT partition, with a comment promising the sweep would create dated
 * ones ahead of time. Nothing did. And once the default holds a row in a range,
 * Postgres refuses to create a partition covering that range — so the longer it
 * went unbuilt, the less buildable it became.
 *
 * THIS CREATES A PARTITION PER MONTH, AND RESCUES WHAT IS IN THE DEFAULT FIRST.
 * Rows sitting in the default for a month are moved out, the partition is
 * created, and they are put back through the parent so they land in it. Called
 * here and by the retention sweep on every run, so partitions always exist
 * ahead of the data and the default stays a safety net rather than the table.
 *
 * MONTHS IN UTC. A partition bound rendered in whatever timezone the calling
 * session happened to have would put the same instant in different partitions
 * depending on who ran the sweep.
 *
 * NOT SECURITY DEFINER, AND NOT EXECUTABLE BY THE APPLICATION. It creates
 * tables, which only the migrator may do; the sweep runs as the migrator.
 *
 * ── Why retention is still a DELETE, and what the drop is for ──────────────
 *
 * §7 says partitioned so that retention is a partition drop rather than a
 * delete. That holds for ONE window. Each Silo sets its own, so a month can hold
 * rows one Silo must keep for two years and another had to lose after thirty
 * days — no partition boundary separates those. The per-Silo window is enforced
 * by a delete, which is audited per organisation; the partition is dropped once
 * the delete has emptied it, which is where the space comes back.
 *
 * Organisation is in the primary key and in every policy rather than being a
 * partition level. A list partition per tenant multiplied by a range partition
 * per month is a table count that grows with customers, and row level security
 * with FORCE already separates them.
 */
CREATE OR REPLACE FUNCTION silo_ensure_transition_partitions(months_ahead integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  current_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  first_month   date;
  last_month    date;
  part_month    date;
  part_name     text;
  lower_bound   timestamptz;
  upper_bound   timestamptz;
  created       integer := 0;
BEGIN
  last_month := (current_month + make_interval(months => months_ahead))::date;

  SELECT date_trunc('month', min(observed_at) AT TIME ZONE 'UTC')::date
    INTO first_month
    FROM transitions_default;

  first_month := LEAST(COALESCE(first_month, current_month), current_month);
  part_month  := first_month;

  CREATE TEMP TABLE IF NOT EXISTS silo_rescued (LIKE transitions) ON COMMIT DROP;

  WHILE part_month <= last_month LOOP
    part_name   := format('transitions_y%sm%s', to_char(part_month, 'YYYY'), to_char(part_month, 'MM'));
    lower_bound := part_month::timestamp AT TIME ZONE 'UTC';
    upper_bound := (part_month + interval '1 month')::timestamp AT TIME ZONE 'UTC';

    IF to_regclass(part_name) IS NULL THEN
      TRUNCATE silo_rescued;

      WITH moved AS (
        DELETE FROM transitions_default
         WHERE observed_at >= lower_bound AND observed_at < upper_bound
        RETURNING *
      )
      INSERT INTO silo_rescued SELECT * FROM moved;

      EXECUTE format(
        'CREATE TABLE %I PARTITION OF transitions FOR VALUES FROM (%L) TO (%L)',
        part_name, lower_bound, upper_bound
      );
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part_name);

      INSERT INTO transitions SELECT * FROM silo_rescued;
      created := created + 1;
    END IF;

    part_month := (part_month + interval '1 month')::date;
  END LOOP;

  RETURN created;
END;
$$;

/*
 * Drop a month once the per-Silo deletes have emptied it.
 *
 * ONLY EMPTY, ONLY PAST. A partition that still holds a row is holding somebody's
 * data inside their window, and dropping it would be an unaudited deletion of
 * exactly the kind §8 forbids. The current month is never dropped even when
 * empty, because the next capture is about to need it.
 */
CREATE OR REPLACE FUNCTION silo_drop_empty_transition_partitions()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  current_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  part          record;
  part_month    date;
  holds_rows    boolean;
  dropped       integer := 0;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'transitions'::regclass
       AND c.relname ~ '^transitions_y[0-9]{4}m[0-9]{2}$'
  LOOP
    part_month := to_date(substr(part.relname, 14, 4) || substr(part.relname, 19, 2), 'YYYYMM');
    CONTINUE WHEN part_month >= current_month;

    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', part.relname) INTO holds_rows;
    CONTINUE WHEN holds_rows;

    EXECUTE format('DROP TABLE %I', part.relname);
    dropped := dropped + 1;
  END LOOP;

  RETURN dropped;
END;
$$;

REVOKE ALL ON FUNCTION silo_ensure_transition_partitions(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION silo_drop_empty_transition_partitions() FROM PUBLIC;

SELECT silo_ensure_transition_partitions(3);

/* ── 3. A receipt says exactly what was named ────────────────────────────── */

/*
 * `target` WAS ONE COLUMN FOR TWO THINGS, and the service filled it with
 * `conceptId ?? entityRef`. So an entity purge that named a concept recorded the
 * concept as the entity it deleted, and a whole-Silo purge carrying a concept id
 * recorded a whole-Silo wipe of one concept. A receipt is the proof; a proof
 * that can say the wrong thing is worse than none.
 *
 * AN ENTITY IS ALWAYS WITHIN A CONCEPT. `entity_ref` is a source identifier, and
 * the same identifier in two concepts is two different records — purging
 * customer 1042 must not also purge invoice 1042.
 */
ALTER TABLE purge_receipts ADD COLUMN concept_id uuid;
ALTER TABLE purge_receipts ADD COLUMN entity_ref text;
/* §9 — "Disable and purge". Said on the receipt, not left to be discovered. */
ALTER TABLE purge_receipts ADD COLUMN silo_disabled boolean NOT NULL DEFAULT false;

UPDATE purge_receipts SET concept_id = target::uuid WHERE scope = 'concept';
UPDATE purge_receipts SET entity_ref = target, silo_disabled = false WHERE scope = 'entity';
UPDATE purge_receipts SET silo_disabled = true WHERE scope = 'silo';

ALTER TABLE purge_receipts DROP COLUMN target;

/*
 * NOT VALID, deliberately: an entity receipt written before this carries no
 * concept and cannot be given one. The rule binds every receipt from here on,
 * and the old ones stay exactly as they were written — a receipt is not edited.
 */
ALTER TABLE purge_receipts ADD CONSTRAINT purge_receipts_scope_shape CHECK (
     (scope = 'silo'    AND concept_id IS NULL     AND entity_ref IS NULL)
  OR (scope = 'concept' AND concept_id IS NOT NULL AND entity_ref IS NULL)
  OR (scope = 'entity'  AND concept_id IS NOT NULL AND entity_ref IS NOT NULL)
) NOT VALID;

/* ── 4. One live Silo per concept ────────────────────────────────────────── */

/*
 * TWO LIVE SILOES COULD NOMINATE ONE CONCEPT, and `capturedFields` picked one
 * with LIMIT 1 and no order. So which Silo a concept was captured into was
 * arbitrary and could change between two queries, splitting its history across
 * both. One concept, one Silo: a second Silo wanting it is a decision to move
 * it, and that is a remove followed by an add, both audited.
 *
 * A disabled Silo releases what it held, so a concept in one can be nominated
 * again elsewhere. Where two live Siloes already share a concept the older
 * nomination is kept.
 */
UPDATE silo_concepts sc
   SET removed_at = now()
  FROM siloes s
 WHERE s.id = sc.silo_id AND s.disabled_at IS NOT NULL AND sc.removed_at IS NULL;

UPDATE silo_concepts sc
   SET removed_at = now()
 WHERE sc.removed_at IS NULL
   AND EXISTS (
     SELECT 1 FROM silo_concepts older
      WHERE older.concept_id = sc.concept_id
        AND older.removed_at IS NULL
        AND (older.added_at, older.id) < (sc.added_at, sc.id)
   );

DROP INDEX silo_concepts_one_live;
CREATE UNIQUE INDEX silo_concepts_one_silo_per_concept
  ON silo_concepts (concept_id) WHERE removed_at IS NULL;

/* ── 5. §10 — bytes scanned, per Silo ────────────────────────────────────── */

/*
 * "Bytes held and bytes scanned, per Silo, from day one." 063 counted neither
 * well and the second not at all. Import is the reason: adding metering after a
 * customer has a large Silo is the conversation §10 exists to avoid.
 */
ALTER TABLE siloes ADD COLUMN bytes_scanned bigint NOT NULL DEFAULT 0
  CHECK (bytes_scanned >= 0);

/* ── 6. §4 — silo.create and silo.manage are held by Admin ───────────────── */

/*
 * THE TABLE IN §4 SAYS SO, and 064 put both on Super admin only. `silo.enable`
 * is the one that is super admin only and never delegable; creating a Silo
 * inside a switched-on organisation and managing what it captures are ordinary
 * administration, bounded by the marking check at add time.
 */
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, g.permission_id
  FROM roles r
  JOIN (VALUES ('silo.create'), ('silo.manage')) AS g(permission_id) ON true
 WHERE r.system_role AND r.name = 'Admin'
ON CONFLICT DO NOTHING;
