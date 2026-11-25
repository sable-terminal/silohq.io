ALTER TABLE unresolved_pairs DROP CONSTRAINT IF EXISTS unresolved_pairs_ref_a_named;
ALTER TABLE unresolved_pairs DROP CONSTRAINT IF EXISTS unresolved_pairs_canonical;
ALTER TABLE unresolved_pairs DROP CONSTRAINT IF EXISTS unresolved_pairs_ref_b_bounded;
ALTER TABLE unresolved_pairs
  ADD CONSTRAINT unresolved_pairs_value_ref_b_check
    CHECK (length(trim(value_ref_b)) BETWEEN 1 AND 512);
ALTER TABLE unresolved_pairs
  ADD CONSTRAINT unresolved_pairs_canonical CHECK (connection_a < connection_b);
