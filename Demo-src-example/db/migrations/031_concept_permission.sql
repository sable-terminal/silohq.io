-- 031_concept_permission — `concept.confirm`.
--
-- CONFIRMING A CONCEPT IS AN ONTOLOGY DECISION, not an administrative one. §2.4
-- says confirmation is what creates the concept, and from that moment every
-- answer that resolves an entity across systems depends on the match keys
-- somebody agreed to. A wrong confirmation does not fail loudly — it merges two
-- customers, and every figure downstream is quietly wrong.
--
-- `scopeable = true`, UNLIKE DISCOVERY. A concept is built out of specific
-- connections, and someone administering a subtree with its own systems has
-- every business naming what those systems mean to them. The blast radius is
-- bounded by the connections they can already reach; discovery's was not.

INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('concept.confirm', 'ontology', 'Confirm what an object means and how it matches across systems', true);
