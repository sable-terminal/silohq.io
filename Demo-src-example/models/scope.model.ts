import { MAX_SCOPE_DEPTH } from '../config/constants.config';

/**
 * A node in the organisation's own tree.
 *
 * THE TYPE IS A LABEL, THE TREE IS THE STRUCTURE. A Project under a Department is
 * legal, and so is a Team under a Project — the organisation decides what its
 * nodes mean, and enforcing a hierarchy of types would fit the first customer and
 * no others.
 */

export interface ScopeType {
  id: string;
  organisationId: string;
  name: string;
  icon: string | null;
  colour: string | null;
  createdAt: Date;
}

export interface Scope {
  id: string;
  organisationId: string;
  scopeTypeId: string;
  name: string;
  parentId: string | null;
  /** Maintained by the database. Never written by the application. */
  path: string;
  depth: number;
  archivedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface ScopeMembership {
  id: string;
  membershipId: string;
  scopeId: string;
  /** Display and default routing only. Never authorisation. */
  isPrimary: boolean;
  addedBy: string | null;
  addedAt: Date;
}

export function isActive(scope: Pick<Scope, 'archivedAt'>): boolean {
  return scope.archivedAt === null;
}

export function canNest(parentDepth: number): boolean {
  return parentDepth < MAX_SCOPE_DEPTH;
}

/**
 * A tree, from a flat list.
 *
 * BUILT FROM THE PATH, NOT BY RECURSING ON `parentId`. The rows arrive sorted by
 * path, so a single pass produces the tree — and the ordering is the tree's own
 * ordering rather than insertion order.
 */
export interface ScopeNode extends Scope {
  children: ScopeNode[];
}

export function toTree(scopes: readonly Scope[]): ScopeNode[] {
  const byId = new Map<string, ScopeNode>();
  for (const scope of scopes) byId.set(scope.id, { ...scope, children: [] });

  const roots: ScopeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    /*
     * A NODE WHOSE PARENT IS NOT IN THE LIST BECOMES A ROOT. That happens when
     * the caller is an admin who can see a subtree but not its ancestors — their
     * view of the tree legitimately starts partway down. Dropping it instead
     * would hide scopes they administer.
     */
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (nodes: ScopeNode[]): ScopeNode[] => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const node of nodes) sort(node.children);
    return nodes;
  };

  return sort(roots);
}
