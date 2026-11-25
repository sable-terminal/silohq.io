/*
 * WHAT IS IN THIS CONNECTION, IN SOMEBODY'S OWN WORDS.
 *
 * A manifest says how to read Salesforce. It cannot say that THIS Salesforce
 * holds the UK book and the other one holds EMEA — that is a fact about the
 * instance, known only to whoever set it up, and it is the fact that decides
 * which connection a question should go to.
 *
 * THE AUDIENCE IS THE QUERY COMPILER AS MUCH AS A PERSON. Choosing between two
 * connections to the same system is otherwise guesswork over two identical
 * manifests; a sentence per connection is the cheapest thing that makes it
 * answerable, and it is written at the moment somebody knows the answer —
 * connecting it from the library, or building it.
 *
 * NULLABLE, AND NOT BACKFILLED. An invented description is worse than none: it
 * would be indistinguishable from one somebody wrote and meant.
 */
ALTER TABLE connections
  ADD COLUMN notes text
    CHECK (notes IS NULL OR length(trim(notes)) BETWEEN 1 AND 2000);

COMMENT ON COLUMN connections.notes IS
  'What this instance holds, written by whoever connected it. Read by the query compiler when choosing between connections to the same system.';
