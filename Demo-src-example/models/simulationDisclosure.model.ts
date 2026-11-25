/**
 * Simulation §11 — the honest constraint.
 *
 * "Simulation is only as good as the graph, and the graph is supplied by the
 * customer. Derivation proposes, history sharpens, but the assertion that one
 * thing waits on another is theirs. A customer unwilling to spend an afternoon
 * confirming edges will get a simulation that stops at the first unconfirmed
 * hop, and that is the correct behaviour rather than a failure.
 *
 * This should be said in the product at the point someone enables it, not
 * discovered after they run the first scenario."
 *
 * ── WHY IT IS A CONSTANT AND NOT A PARAGRAPH IN A CLIENT ──────────────────
 *
 * Because the sentence it is making is a commitment about how the product
 * behaves, and it has to stay true to the code beside it. The storage
 * disclosure is kept this way for the same reason and a standing test compares
 * it against the number the schema enforces. Text that lives only in a front
 * end drifts the first time the engine changes and nobody notices, because
 * nothing in either codebase fails when a claim stops being true.
 *
 * ── IT IS SHOWN WHERE THE WORK STARTS ─────────────────────────────────────
 *
 * §11 says "at the point someone enables it". There is no enable switch: the
 * thing that makes simulation work is somebody sitting down with the edge list,
 * so the edge list is the point, and it arrives with this attached.
 */

export const SIMULATION_DISCLOSURE: readonly string[] = [
  'Simulation is only as good as this graph, and the graph is yours to supply. Silo proposes ' +
    'edges from your ontology and sharpens the timings from your own history, but the ' +
    'assertion that one thing waits on another is a judgement about your operation that only ' +
    'your people can make.',

  'Confirming an edge means saying whether the dependency is hard, soft or a shared resource, ' +
    'and how long it takes. That is an afternoon of work with somebody who knows the ' +
    'operation, and there is no way to skip it that does not amount to guessing on your ' +
    'behalf.',

  'Until it is done, a simulation stops at the first edge nobody has confirmed and tells you ' +
    'where it stopped. That is the correct behaviour rather than a failure: routing around an ' +
    'unconfirmed edge would give you a shorter answer that looks complete.',

  'Every result says what it rested on — which edges were measured from your history and over ' +
    'how many instances, and which were numbers somebody typed. A simulation resting on ' +
    'stated lead times is a different claim from one resting on four hundred observations, ' +
    'and you should be able to tell them apart without asking us.',
];
