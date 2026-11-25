-- 005_root_scope_names — closing the hole NULL leaves in a unique constraint.
--
-- `UNIQUE (organisation_id, parent_id, name)` DOES NOT CONSTRAIN ROOT SCOPES.
-- SQL treats two NULLs as distinct rather than equal, so a unique constraint
-- containing a nullable column simply does not apply to the rows where that
-- column is null. Every root scope has `parent_id IS NULL`, which means the
-- constraint that was supposed to stop two siblings sharing a name stopped it
-- everywhere except at the top of the tree.
--
-- FOUND BY TRYING IT, NOT BY READING IT. The constraint reads correctly; the
-- second `Operations` at the root was accepted with a 201. Two roots with the
-- same name are not a cosmetic problem: the scope picker shows two identical
-- entries, an administrator grants at the wrong one, and the grant is invisible
-- at the scope they meant.
--
-- A PARTIAL UNIQUE INDEX RATHER THAN `UNIQUE NULLS NOT DISTINCT`. The latter
-- says exactly this and arrived in Postgres 15 — production is 16, but every
-- development machine here is 14, and a schema that only constrains correctly in
-- production is one where this class of bug is found by customers. The partial
-- index behaves identically on both.

CREATE UNIQUE INDEX scopes_unique_root_name
  ON scopes (organisation_id, name)
  WHERE parent_id IS NULL;

-- The same reasoning, one table over: `scope_types` is already
-- `UNIQUE (organisation_id, name)` with both columns NOT NULL, so it is sound.
-- Recorded here so the next reader does not have to check.
