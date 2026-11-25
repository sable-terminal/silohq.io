/**
 * What else a change touches, worked out before it is shown.
 *
 * A PREVIEW THAT SHOWS ONLY THE ROWS NAMED IN THE PLAN IS NOT A PREVIEW. Setting
 * a supplier inactive may cascade to open purchase orders; changing a price may
 * be referenced by quotes already sent. The approver needs to know that before
 * approving, not discover it afterwards.
 *
 * IT WALKS DECLARED RELATIONSHIPS, NOT DATABASE FOREIGN KEYS. The systems being
 * written to are somebody else's, reached over an API, and their referential
 * structure is described by the connector rather than discoverable. An
 * undeclared relationship is invisible here, which is a limitation worth stating
 * plainly rather than papering over.
 */

export interface Relationship {
  fromConnectionId: string;
  fromObject: string;
  toConnectionId: string;
  toObject: string;
  /** What happens to the dependent when the referenced row changes. */
  onChange: 'cascade' | 'restrict' | 'orphan' | 'none';
}

export interface Impact {
  connectionId: string;
  object: string;
  estimatedRows: number;
  effect: Relationship['onChange'];
  /** How many hops from the change. Direct dependants are 1. */
  distance: number;
}

export interface BlastRadius {
  direct: number;
  impacts: Impact[];
  /** A `restrict` relationship means the write will be rejected by the source. */
  blocked: Impact[];
  /** True when traversal stopped at the depth limit rather than at the edges. */
  truncated: boolean;
}

const MAX_DEPTH = 4;

export function walk(
  origin: { connectionId: string; object: string; rows: number },
  relationships: readonly Relationship[],
  estimate: (connectionId: string, object: string) => number,
): BlastRadius {
  const impacts: Impact[] = [];
  const seen = new Set<string>([`${origin.connectionId}:${origin.object}`]);
  let frontier = [{ connectionId: origin.connectionId, object: origin.object, distance: 0 }];
  let truncated = false;

  while (frontier.length > 0) {
    const next: typeof frontier = [];

    for (const node of frontier) {
      if (node.distance >= MAX_DEPTH) {
        // Reported rather than silently stopped. A preview that says "and
        // possibly more" is honest; one that stops quietly is not.
        truncated = true;
        continue;
      }

      for (const rel of relationships) {
        if (rel.fromConnectionId !== node.connectionId || rel.fromObject !== node.object) continue;
        if (rel.onChange === 'none') continue;

        const key = `${rel.toConnectionId}:${rel.toObject}`;
        // Cycles are common in real schemas — orders reference customers which
        // reference orders. Visiting once keeps the walk finite.
        if (seen.has(key)) continue;
        seen.add(key);

        impacts.push({
          connectionId: rel.toConnectionId,
          object: rel.toObject,
          estimatedRows: estimate(rel.toConnectionId, rel.toObject),
          effect: rel.onChange,
          distance: node.distance + 1,
        });

        next.push({ connectionId: rel.toConnectionId, object: rel.toObject, distance: node.distance + 1 });
      }
    }

    frontier = next;
  }

  return {
    direct: origin.rows,
    impacts,
    blocked: impacts.filter((i) => i.effect === 'restrict'),
    truncated,
  };
}

/** One sentence for the preview panel. */
export function describe(radius: BlastRadius): string {
  if (radius.impacts.length === 0) return `${radius.direct} rows, nothing else affected.`;

  const total = radius.impacts.reduce((sum, i) => sum + i.estimatedRows, 0);
  const objects = radius.impacts.length;
  const tail = radius.truncated ? ', and possibly further' : '';

  if (radius.blocked.length > 0) {
    return `${radius.direct} rows. ${radius.blocked.length} related object(s) will refuse the change.`;
  }
  return `${radius.direct} rows, and approximately ${total} in ${objects} related object(s)${tail}.`;
}
