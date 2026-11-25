/**
 * Materialised paths for the scope tree.
 *
 * A PATH IS THE ANCESTOR CHAIN, DOT-SEPARATED, ENDING IN THE NODE ITSELF. Postgres
 * `ltree` holds it and answers containment with one indexed operator, so "every
 * scope beneath Engineering" is a GiST index lookup rather than a recursive CTE
 * run on every authorisation decision.
 *
 * LABELS ARE THE NODE'S UUID WITH DASHES REMOVED AND AN `s` PREFIX. `ltree` labels
 * may only contain letters, digits and underscores, and may not begin with a
 * digit — a raw uuid fails both rules. Deriving the label from the id rather than
 * the name means renaming a scope does not rewrite the subtree, and two siblings
 * with the same name are still distinct.
 *
 * CONTAINMENT IS INCLUSIVE. An admin assigned to Engineering administers
 * Engineering. Every rule in the delegation model reads that way, and an
 * exclusive test would silently exclude the node the admin was actually given.
 */

/** ltree's own limit. Exceeding it is a database error, not a validation one. */
const MAX_LABEL_LENGTH = 255;

export function labelFor(scopeId: string): string {
  const compact = scopeId.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(compact)) {
    throw new Error(`labelFor expects a uuid, received: ${scopeId}`);
  }
  return `s${compact}`;
}

/**
 * The inverse of `labelFor`: a label back to the uuid it was made from.
 *
 * IT EXISTS BECAUSE ITS ABSENCE WAS FILLED IN BY HAND, WRONGLY. A presenter
 * needed to turn a path into ids for a client and did `label.slice(1)`, which
 * strips the prefix and leaves the dashes out — producing a 32-character string
 * that looks like a uuid, is accepted by nothing that wants one, and compares
 * unequal to the id it came from. It typechecks as a `string` all the way to the
 * client. Any encoding whose inverse is missing gets reinvented at the call site
 * eventually, and the reinvention is where the bug lives.
 */
export function scopeIdFor(label: string): string {
  const compact = label.startsWith('s') ? label.slice(1) : label;
  if (!/^[0-9a-f]{32}$/i.test(compact)) {
    throw new Error(`scopeIdFor expects a scope label, received: ${label}`);
  }
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
}

/** Every id along a path, root first, the node itself last. */
export function idsIn(path: string): string[] {
  return path.split('.').map(scopeIdFor);
}

/** The id of the node a path ends at. */
export function leafIdOf(path: string): string {
  return scopeIdFor(path.split('.').pop()!);
}

/** The path of a root scope. */
export function rootPath(scopeId: string): string {
  return labelFor(scopeId);
}

/** The path of a child, given its parent's path. */
export function childPath(parentPath: string, scopeId: string): string {
  const path = `${parentPath}.${labelFor(scopeId)}`;
  if (path.length > MAX_LABEL_LENGTH * 2) {
    throw new Error('Scope path is too long. Reduce nesting depth.');
  }
  return path;
}

export function depth(path: string): number {
  return path.split('.').length;
}

/** Every ancestor label, nearest last, excluding the node itself. */
export function ancestors(path: string): string[] {
  const parts = path.split('.');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.'));
}

export function parentOf(path: string): string | null {
  const parts = path.split('.');
  return parts.length <= 1 ? null : parts.slice(0, -1).join('.');
}

/**
 * Whether `descendant` is at or beneath `ancestor`.
 *
 * THE PREFIX TEST NEEDS THE DOT. `startsWith(ancestor)` alone would report that
 * `s1.s20` is beneath `s1.s2`, because the string does begin with it. Every
 * subtree containment check in the delegation model runs through here, so that
 * off-by-one would hand an admin authority over a sibling's tree.
 */
export function contains(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return descendant.startsWith(`${ancestor}.`);
}

/** Whether two paths are on different branches — neither contains the other. */
export function disjoint(a: string, b: string): boolean {
  return !contains(a, b) && !contains(b, a);
}

/**
 * Whether a move would place a node inside its own subtree.
 *
 * A CYCLE IN A MATERIALISED PATH IS NOT A LOOP, IT IS A DISCONNECTION. The rewrite
 * would produce paths that no longer descend from any root, so the subtree
 * silently stops matching every containment query — the scopes still exist and
 * nobody can administer them. Checked before the write, never after.
 */
export function wouldCycle(movingPath: string, targetParentPath: string): boolean {
  return contains(movingPath, targetParentPath);
}

/**
 * Rewrite a descendant's path when its ancestor moves.
 *
 * Applied to the moving node and every descendant in one transaction. Doing it
 * per row outside a transaction leaves the tree half-rewritten, and a half-
 * rewritten tree is one where some scopes are administered by nobody.
 */
export function rewrite(path: string, oldPrefix: string, newPrefix: string): string {
  if (!contains(oldPrefix, path)) {
    throw new Error(`${path} is not beneath ${oldPrefix}; refusing to rewrite it`);
  }
  return newPrefix + path.slice(oldPrefix.length);
}

/** The SQL fragment for a containment query, kept beside the logic it mirrors. */
export const CONTAINS_SQL = '$1::ltree @> path';
export const CONTAINED_BY_SQL = 'path <@ $1::ltree';
