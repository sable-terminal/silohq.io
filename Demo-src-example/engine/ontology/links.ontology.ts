import { absent, at, type Row } from '../detectors/shared.detector';
import type { ManifestObject } from '../../schemas/manifest.schema';

/**
 * The outbound references a row carries, as the source stated them.
 *
 * ── Raw, and every one of them ──────────────────────────────────────────────
 *
 * Two decisions, both of which look like extra work and are not.
 *
 * THE VALUE IS NOT RESOLVED HERE. Turning `ACME-001` into a concept entity is
 * the resolver's act, and it happens at READ time. Resolving at capture time
 * would couple detection to the resolver and — worse — would make the result
 * unrepairable: somebody confirms in September that two spellings are one
 * customer, and every finding written in March resolved to nothing with no way
 * back, because the value it came from was replaced by the answer.
 *
 * EVERY DECLARED LINK, NOT THE INTERESTING ONE. The row is in hand once, inside
 * a detector run that already paid to fetch it. Which link matters is decided
 * later by whatever question somebody asks, and fetching the rest afterwards is
 * exactly the re-read this exists to avoid.
 *
 * ── What may be taken from the row, and nothing else ───────────────────────
 *
 * Only fields the manifest declares as relationships. Every other column on
 * that row is a business value — a balance, a name, a date of birth — and the
 * fact that it is sitting right there is not an argument for keeping it. An
 * identifier is what §3.2 already permits; the rest is the line.
 */

export type OutboundLink = {
  connectionId: string;
  fromObject: string;
  field: string;
  /** Exactly as the source stated it: untrimmed, unfolded, unresolved. */
  value: string;
  targetObject: string;
  targetField: string;
};

/**
 * Read a row's declared foreign keys.
 *
 * ORDER IS THE MANIFEST'S, so two captures of the same row produce the same
 * list — the same determinism §3.3 asks of everything that reaches a finding.
 */
export function linksFrom(input: {
  connectionId: string;
  object: ManifestObject;
  row: Row;
}): OutboundLink[] {
  const links: OutboundLink[] = [];

  for (const relationship of input.object.relationships) {
    const value = at(input.row, relationship.field);

    /*
     * AN ABSENT REFERENCE IS NOT A LINK. A row with no supplier points at
     * nothing, which is the absence detector's business — and storing an empty
     * string here would create a link every unlinked row shares, joining them
     * all to each other at read time.
     */
    if (absent(value)) continue;

    const stated = String(value);
    /* The column bounds it at 512; a longer identifier is not one. */
    if (stated.length > 512) continue;

    links.push({
      connectionId: input.connectionId,
      fromObject: input.object.name,
      field: relationship.field,
      value: stated,
      targetObject: relationship.targetObject,
      targetField: relationship.targetField,
    });
  }

  return links;
}

/**
 * Which findings reach which, through the links both of them carried.
 *
 * ── Resolution happens here, at read time, and can be re-run ───────────────
 *
 * One finding's row pointed at `orders.id = ORD-77`. Another finding is ABOUT
 * an order whose identifier is `ORD-77`. Those two findings concern related
 * instances, and that is what association needs in order to say anything about
 * two concepts at once.
 *
 * MATCHED THE WAY THE RESOLVER MATCHES — trimmed and case-folded, §2.6's rule —
 * because a link stored raw and an entity reference stored raw will differ by
 * typography the customer never intended. Normalising at read time is what
 * makes that correctable: the stored values are untouched, so a change to this
 * rule reinterprets every finding ever written rather than only future ones.
 *
 * IT DOES NOT CONSULT CONFIRMED PAIRS. Those live in `confirmed_resolutions`
 * and resolve identity ACROSS systems; a foreign key is a statement inside one,
 * and the target it names is in the same connection. Bringing cross-system
 * aliases in here would relate an order in Netsuite to an invoice in Sage
 * through a key neither system ever declared.
 */
export function linkedFindings(input: {
  /** Every link captured, by the finding that carried it. */
  links: ReadonlyArray<OutboundLink & { findingId: string }>;
  /** Findings that could be pointed at: their object and their own reference. */
  targets: ReadonlyArray<{
    findingId: string;
    connectionId: string;
    objectName: string;
    entityRef: string;
  }>;
}): Array<{ fromFindingId: string; toFindingId: string; via: string }> {
  const key = (connectionId: string, object: string, ref: string) =>
    `${connectionId}\u0000${object}\u0000${ref.trim().toLowerCase()}`;

  const byTarget = new Map<string, string[]>();
  for (const target of input.targets) {
    const at = key(target.connectionId, target.objectName, target.entityRef);
    byTarget.set(at, [...(byTarget.get(at) ?? []), target.findingId]);
  }

  const edges: Array<{ fromFindingId: string; toFindingId: string; via: string }> = [];

  for (const link of input.links) {
    const reached = byTarget.get(key(link.connectionId, link.targetObject, link.value));
    if (!reached) continue;

    for (const toFindingId of reached) {
      /* A finding does not reach itself, however the keys happen to line up. */
      if (toFindingId === link.findingId) continue;
      edges.push({ fromFindingId: link.findingId, toFindingId, via: link.field });
    }
  }

  return edges.sort(
    (a, b) =>
      compare(a.fromFindingId, b.fromFindingId) ||
      compare(a.toFindingId, b.toFindingId) ||
      compare(a.via, b.via),
  );
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
