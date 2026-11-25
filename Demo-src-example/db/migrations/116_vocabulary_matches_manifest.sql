/*
 * 116 — the vocabulary said in the words a manifest actually uses.
 *
 * ── THE TABLES ARE WHAT THE BUILDER'S DROPDOWNS WRITE ─────────────────────
 *
 * 012 calls these closed sets "because each one is a branch in the engine", and
 * three pagination rows and two envelope rows named no branch at all. The
 * engine's own names are `cursor`, `body_token` and `scroll` — in the manifest
 * schema's discriminated union and in `http.transport`'s switch — while this
 * table said `opaque_cursor`, `body_continuation` and `scroll_keepalive`, which
 * are the words CONNECTORS.md §4 uses in prose.
 *
 * NOTHING WAS BROKEN UNTIL SOMETHING READ THEM. The vocabulary endpoint exists
 * to fill the builder's dropdowns, and a dropdown offering `opaque_cursor`
 * writes a document the manifest schema rejects with "invalid discriminator" —
 * an error about a value the person never typed, on a field they cannot see. The
 * strategy is the code name; the prose stays in `description`, which is what a
 * person reads.
 *
 * ── `nested` GOES, BECAUSE IT CANNOT BE BUILT ─────────────────────────────
 *
 * §4 lists a nested shape flattened by an expression, and `response.shape` has
 * no such value: the only way to reshape a body is `response.transform`, which
 * `http.transport` refuses outright with `refusal.transform_unsupported`. An
 * option that cannot produce a working connector is worse than a missing one,
 * because somebody picks it, publishes, and finds out at the first query. It
 * comes back the day a transform can be applied.
 */

UPDATE pagination_strategies SET strategy = 'cursor'     WHERE strategy = 'opaque_cursor';
UPDATE pagination_strategies SET strategy = 'body_token' WHERE strategy = 'body_continuation';
UPDATE pagination_strategies SET strategy = 'scroll'     WHERE strategy = 'scroll_keepalive';

UPDATE response_envelopes SET envelope = 'array'   WHERE envelope = 'plain_array';
UPDATE response_envelopes SET envelope = 'jsonapi' WHERE envelope = 'json_api';

DELETE FROM response_envelopes WHERE envelope = 'nested';
