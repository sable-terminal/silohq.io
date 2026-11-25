ALTER TABLE silo_holdings
  DROP CONSTRAINT silo_holdings_marker_shape,
  DROP COLUMN changed_evidence,
  DROP COLUMN changed_field;
