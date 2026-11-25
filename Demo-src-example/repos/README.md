# repos

SQL, and the mapping between a row and a model. Nothing else.

**A repo never decides anything.** No permission check, no business rule, no
"if this then that". Those live in `services/`, and a rule implemented in a repo
is a rule that applies only to callers who happen to use that repo. If a
condition is in a `WHERE` clause it must be there because the query would
otherwise be wrong, never because a caller should not see the row — that is what
row level security and the service layer are for.

**Every repo takes an `Executor`.** The pool is not exported from `infra/db`;
callers pass the client from `withTransaction` so several repo calls share one
transaction and one tenant context. A repo that reached for a connection itself
would silently start its own transaction, and two writes that were meant to be
atomic would not be.

**Column names are snake_case and model fields are camelCase.** The mapping is
written once per table, in the repo, in a `map` function. Doing it at call sites
means two places disagree about whether it is `mfa_satisfied_at` or
`mfaSatisfiedAt`, and the one that is wrong returns `undefined` rather than
failing.

**Nothing here catches an error.** A constraint violation is information: a
duplicate email means somebody has already registered, and the service layer
turns that into a message. A repo swallowing it produces a null the caller reads
as "not found".
