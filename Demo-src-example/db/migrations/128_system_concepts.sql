/*
 * 128 — a concept for each object a person has confirmed.
 *
 * ── THE CONSOLE WORKS FROM THE FIRST CONNECTION ───────────────────────────
 *
 * Questions are asked of concepts, and until now a concept had to span two
 * systems and be confirmed by hand — so somebody who connected one system could
 * ask nothing at all, and was sent to confirm "concepts" that derivation never
 * proposed, because derivation needs two systems. Asking is the product; the
 * ontology loop improves answers across systems, and must never stand between
 * a person and their own data.
 *
 * So Silo makes one concept per object of every confirmed connection: `system`,
 * because the person who confirmed the connection — who looked at its records
 * and said "looks right" — already made the only decision it needs. Concepts
 * that match things ACROSS systems are still proposed, confirmed and corrected
 * exactly as before, and still need two systems.
 */

ALTER TABLE concepts DROP CONSTRAINT concepts_origin_check;
ALTER TABLE concepts ADD CONSTRAINT concepts_origin_check CHECK (origin IN ('confirmed', 'corrected', 'manual', 'system'));
