DROP TABLE prior_states;
DROP TABLE mutation_targets;

DROP TRIGGER mutations_describe_once ON mutations;
DROP FUNCTION mutations_describe_once();

DROP TABLE mutations;
