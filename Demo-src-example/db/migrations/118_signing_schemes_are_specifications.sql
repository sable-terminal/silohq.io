/*
 * 118 — the signing schemes the builder offers are the ones that run.
 *
 * 012 listed signing schemes by company — four providers and one
 * specification — and the engine executed none of them: every request that
 * needed one was refused. A connector engine that names providers is one with a
 * branch per provider waiting to be written, which is the model this product
 * exists to replace.
 *
 * In v2 a signature is what to sign, as an expression, with the algorithm and
 * key applied by the transport; SigV4 and OAuth 1.0a are the specifications
 * written as code. The v1 builder form still reads this table, so it keeps the
 * one row a v1 document can compile — RFC 9421 — and loses the rest.
 */
DELETE FROM hmac_canonicalisations WHERE name <> 'rfc9421';
