/*
 * Renaming `discovery_findings` to `discovery_candidates`.
 *
 * ── Why a name is worth a migration ────────────────────────────────────────
 *
 * There are two completely unrelated things called a "finding" in this schema
 * and they belong to different halves of the product.
 *
 * §3's `findings` are the output of a detector: arithmetic over a customer's
 * own records, saying that two systems disagree about an invoice. They are the
 * thing this product exists to produce.
 *
 * `discovery_findings` are the output of a network sweep: a host answered on a
 * port and might be a system worth connecting to. Nobody has decided anything;
 * it is a lead, and the table's own columns say so — `decision`, `reviewed_at`,
 * `promoted_connection_id`.
 *
 * One word for both means every conversation about "findings" has to establish
 * which kind first, and every query written by somebody who guessed wrong reads
 * plausibly and returns the wrong table. `candidate` is what the rows actually
 * are: something offered for a person to accept or reject.
 *
 * ── Everything attached to it moves too ────────────────────────────────────
 *
 * A table renamed while its indexes, constraints and policy keep the old name
 * is the worst of both worlds: `\d` shows a mixture, and the next person cannot
 * tell which half was deliberate. Postgres renames the table's own dependants
 * silently only for the primary key, so the rest are listed here by name —
 * which is also the record of what existed at the time.
 *
 * THE POLICY IS RENAMED, NOT REDEFINED. Its USING clause is untouched, so row
 * level security is enforced identically before and after; a rename that
 * restated the predicate would be a security change wearing a rename's clothes.
 */

ALTER TABLE discovery_findings RENAME TO discovery_candidates;

/* Indexes. The primary key index follows its constraint, below. */
ALTER INDEX discovery_findings_by_run      RENAME TO discovery_candidates_by_run;
ALTER INDEX discovery_findings_unreviewed  RENAME TO discovery_candidates_unreviewed;

/* Constraints, including the two whose names never carried the table's. */
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_findings_pkey TO discovery_candidates_pkey;
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_findings_confidence_check TO discovery_candidates_confidence_check;
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_findings_decision_check TO discovery_candidates_decision_check;
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_findings_host_check TO discovery_candidates_host_check;
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_findings_method_check TO discovery_candidates_method_check;
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_findings_port_check TO discovery_candidates_port_check;
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_findings_promoted_connection_id_fkey
                 TO discovery_candidates_promoted_connection_id_fkey;
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_findings_proposed_transport_fkey
                 TO discovery_candidates_proposed_transport_fkey;
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_findings_reviewed_by_fkey
                 TO discovery_candidates_reviewed_by_fkey;
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_findings_run_id_fkey TO discovery_candidates_run_id_fkey;

/* These two already read correctly in the singular and only lose the plural. */
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_finding_promotion_accepted
                 TO discovery_candidate_promotion_accepted;
ALTER TABLE discovery_candidates
  RENAME CONSTRAINT discovery_finding_reviewed_pair TO discovery_candidate_reviewed_pair;

ALTER POLICY discovery_findings_tenant ON discovery_candidates
  RENAME TO discovery_candidates_tenant;

/*
 * GRANTS FOLLOW THE TABLE AND ARE NOT RESTATED. A rename preserves them because
 * they are recorded against the object rather than its name — and re-granting
 * here would quietly widen them if this migration and 019 ever disagreed.
 */
