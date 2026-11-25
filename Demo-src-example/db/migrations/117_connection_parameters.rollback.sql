ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_parameters_are_strings;
ALTER TABLE connections DROP COLUMN IF EXISTS parameters;
