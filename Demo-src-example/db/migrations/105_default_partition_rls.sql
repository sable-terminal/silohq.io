/*
 * 105 — the one tenant table nothing was protecting.
 *
 * ── HOW IT HAPPENED ────────────────────────────────────────────────────────
 *
 * 063 created `transitions` partitioned by month, enabled and forced row level
 * security on the parent, and created `transitions_default` as the catch-all.
 * 065's `silo_ensure_transition_partitions` hardens every DATED partition it
 * creates — two `ALTER TABLE` lines right after the `CREATE TABLE` — because
 * whoever wrote it knew a partition is a table of its own and inherits none of
 * the parent's protection.
 *
 * The default partition was created by hand in 063 and never got those two
 * lines. So every month's partition was hardened and the one holding anything
 * that did not fit a month was not.
 *
 * ── IT WAS NOT A LEAK, AND THAT IS NOT A REASON TO LEAVE IT ───────────────
 *
 * `silo_app` holds no grant on any partition — it reads `transitions` and
 * Postgres routes it — so nothing could reach the default partition to read
 * past the policy. The hole needed a second mistake to become one: a grant on
 * partitions, added by somebody who checked that the dated ones are all
 * protected and reasoned that the set was uniform.
 *
 * That is the shape of failure this schema keeps closing in advance: `FORCE`
 * alongside `ENABLE` everywhere, `NOBYPASSRLS` on the application role, tenant
 * policies on tables the application cannot currently reach either. One
 * exception makes the rule unreliable, which costs more than two statements.
 *
 * ── AND NO POLICY, MATCHING THE DATED PARTITIONS ──────────────────────────
 *
 * The first version of this migration added a tenant policy here. That was
 * wrong, and the standing test said so: the dated partitions carry ENABLE and
 * FORCE and no policy at all, which DENIES EVERY ROW on a direct read. A
 * partition is reached through its parent, where the parent's policy filters
 * it; a policy of its own would make the default partition the one place a
 * direct read returned rows, which is more permissive than the thing it was
 * being made consistent with.
 *
 * Fail closed, uniformly, is the arrangement worth having.
 */

ALTER TABLE transitions_default ENABLE ROW LEVEL SECURITY;
ALTER TABLE transitions_default FORCE  ROW LEVEL SECURITY;
