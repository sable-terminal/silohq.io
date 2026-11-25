-- 040_marking_permission — `marking.apply`.
--
-- RESTRICTING A THING AND CLEARING A PERSON ARE DIFFERENT ACTS. 004 gave us
-- `clearance.grant`, which is "let this person past a restriction". Nothing
-- expressed "put a restriction on this thing", so `resource_markings` had no
-- authorised writer and, in practice, no writer at all.
--
-- §2.5: a concept carries markings because resolving one across a restricted and
-- an unrestricted system reveals that a restricted record exists — the count
-- changes, the join succeeds, the entity appears. Marking the concept is the
-- defence, and somebody has to be permitted to apply it.
--
-- NOT SCOPEABLE, on the same reasoning as `clearance.grant` and
-- `outcome.designate`. A marking is an organisation-wide statement about what is
-- sensitive; a subtree admin applying one to a concept spanning systems outside
-- their subtree is the wrong blast radius, and REMOVING one is how a
-- compartment quietly stops being a compartment.

INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('marking.apply', 'clearance', 'Apply or remove a marking on a concept, connection or field', false);
