import type { Manifest } from './schemas.util';

/**
 * Whether a well-formed manifest is a permitted one.
 *
 * SHAPE IS `schemas.manifest`; THIS IS EVERYTHING SHAPE CANNOT KNOW. A manifest
 * can be perfectly valid Zod and still reference a connection this tenant does
 * not have, a concept that does not exist, or a field a policy denies.
 *
 * IT RUNS BEFORE THE PLAN IS DISPATCHED, WHICH IS THE ENTIRE POINT. A denied
 * field checked after execution has already been fetched from the source system,
 * crossed the network and sat in memory. Checked here, it never enters the plan
 * and the source is never asked. This is the strongest security claim in the
 * product and it is one function call deep.
 */

export interface Catalogue {
  /** Connections this membership may read, already resolved through grants. */
  readableConnections: ReadonlySet<string>;
  /** Objects and fields each connection actually exposes. */
  fieldsByConnection: ReadonlyMap<string, ReadonlySet<string>>;
  objectsByConnection: ReadonlyMap<string, ReadonlySet<string>>;
  /** Concepts this membership may use, markings already applied. */
  permittedConcepts: ReadonlySet<string>;
  /** Field paths denied by policy, per connection. */
  deniedFields: ReadonlyMap<string, ReadonlySet<string>>;
}

export type ValidationProblem =
  | { kind: 'unknown-connection'; connectionId: string }
  | { kind: 'unreadable-connection'; connectionId: string }
  | { kind: 'unknown-object'; connectionId: string; object: string }
  | { kind: 'unknown-field'; connectionId: string; field: string }
  | { kind: 'denied-field'; connectionId: string; field: string }
  | { kind: 'unknown-concept'; conceptId: string }
  | { kind: 'concept-not-permitted'; conceptId: string }
  | { kind: 'join-participant-missing'; conceptId: string; connectionId: string };

export function validateManifest(
  manifest: Manifest,
  catalogue: Catalogue,
): { ok: boolean; problems: ValidationProblem[] } {
  const problems: ValidationProblem[] = [];

  for (const source of manifest.sources) {
    if (!catalogue.fieldsByConnection.has(source.connectionId)) {
      problems.push({ kind: 'unknown-connection', connectionId: source.connectionId });
      continue;
    }

    /*
     * READABILITY IS CHECKED SEPARATELY FROM EXISTENCE, and both answer the same
     * way to the caller. Telling somebody a connection exists but they may not
     * read it confirms its existence to a person who cannot see it.
     */
    if (!catalogue.readableConnections.has(source.connectionId)) {
      problems.push({ kind: 'unreadable-connection', connectionId: source.connectionId });
      continue;
    }

    const objects = catalogue.objectsByConnection.get(source.connectionId);
    if (objects && !objects.has(source.object)) {
      problems.push({ kind: 'unknown-object', connectionId: source.connectionId, object: source.object });
    }

    const known = catalogue.fieldsByConnection.get(source.connectionId)!;
    const denied = catalogue.deniedFields.get(source.connectionId) ?? new Set<string>();

    /*
     * EVERY FIELD THE MANIFEST TOUCHES, NOT JUST THE SELECTED ONES. A denied
     * field used only in a `WHERE` never appears in the output and still leaks
     * it: filtering on `salary > 100000` and counting the rows reveals the
     * salaries without ever selecting the column.
     */
    const touched = new Set<string>([
      ...source.fields,
      ...source.filters.map((f) => f.field),
      ...source.groupBy,
      ...source.orderBy.map((o) => o.field),
      ...source.aggregations.flatMap((a) => (a.field ? [a.field] : [])),
    ]);

    for (const field of touched) {
      if (denied.has(field)) {
        problems.push({ kind: 'denied-field', connectionId: source.connectionId, field });
      } else if (!known.has(field)) {
        problems.push({ kind: 'unknown-field', connectionId: source.connectionId, field });
      }
    }
  }

  const sourceIds = new Set(manifest.sources.map((s) => s.connectionId));

  for (const join of manifest.joins) {
    if (!catalogue.permittedConcepts.has(join.conceptId)) {
      /*
       * A CONCEPT WITHOUT CLEARANCE IS DROPPED FROM THE PLAN, NEVER RESOLVED AND
       * FILTERED. Resolving it would run the entity match against a source the
       * user cannot see, and the match succeeding is itself the disclosure — the
       * count changes and the restricted record's existence is revealed.
       */
      problems.push({ kind: 'concept-not-permitted', conceptId: join.conceptId });
      continue;
    }

    for (const participant of join.participants) {
      if (!sourceIds.has(participant.connectionId)) {
        problems.push({
          kind: 'join-participant-missing',
          conceptId: join.conceptId,
          connectionId: participant.connectionId,
        });
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * A message for the person, from problems written for the log.
 *
 * IT DOES NOT ENUMERATE WHAT THEY CANNOT SEE. "Three fields in this question are
 * restricted" is enough to act on; naming them tells somebody exactly which
 * columns are worth attacking and confirms their existence.
 */
export function explain(problems: readonly ValidationProblem[]): string {
  const denied = problems.filter((p) => p.kind === 'denied-field' || p.kind === 'concept-not-permitted');
  const unreadable = problems.filter((p) => p.kind === 'unreadable-connection' || p.kind === 'unknown-connection');
  const unknown = problems.filter((p) => p.kind === 'unknown-field' || p.kind === 'unknown-object');

  const parts: string[] = [];
  if (unreadable.length > 0) {
    parts.push(`${unreadable.length} system(s) in this question are not available to you.`);
  }
  if (denied.length > 0) {
    parts.push(`${denied.length} field(s) or concept(s) are restricted.`);
  }
  if (unknown.length > 0) {
    parts.push(`${unknown.length} field(s) could not be found in the connected systems.`);
  }
  return parts.join(' ') || 'The question could not be compiled.';
}
