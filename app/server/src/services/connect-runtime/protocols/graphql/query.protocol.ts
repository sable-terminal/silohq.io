// The GraphQL engine's query, built from the plan (docs/siloServiceCatalogue.doc.md: query
// building from the plan). The document is an AST printed by graphql-js, never text pasted
// together: names come from the manifest (checked as GraphQL names at save), and every
// value a plan, a pushdown or paging supplies travels in a declared, typed variable. The
// query text holds no value, as a generated SQL statement holds none.

import { Kind, OperationTypeNode, parseType, print, type FieldNode, type SelectionSetNode } from 'graphql';
import type { GraphqlSource, ManifestField } from '../../../../contracts/connect/manifest.contract.ts';
import { AppError } from '../../../../utils/errors.util.ts';

interface Tree { children: Map<string, Tree> }

const nameNode = (value: string) => ({ kind: Kind.NAME, value }) as const;

function insert(tree: Tree, path: readonly string[]): void {
  let at = tree;
  for (const segment of path) {
    let next = at.children.get(segment);
    if (next === undefined) {
      next = { children: new Map() };
      at.children.set(segment, next);
    }
    at = next;
  }
}

function selectionOf(tree: Tree): SelectionSetNode {
  return {
    kind: Kind.SELECTION_SET,
    selections: [...tree.children].map(([name, child]): FieldNode => ({
      kind: Kind.FIELD, name: nameNode(name), ...(child.children.size > 0 ? { selectionSet: selectionOf(child) } : {}),
    })),
  };
}

const segments = (path: string | undefined): string[] => (path === undefined || path === '' ? [] : path.split('.'));

/** The query for one read: the root field with its declared variables, selecting the fields asked for and what paging reads. */
export function buildQuery(source: GraphqlSource, fields: readonly ManifestField[]): string {
  const tree: Tree = { children: new Map() };
  const base = segments(source.recordPath);
  for (const field of fields) insert(tree, [...base, ...segments(field.path ?? field.name)]);
  for (const extra of source.select) insert(tree, segments(extra));
  let variableDefinitions;
  try {
    variableDefinitions = source.variables.map((v) => ({
      kind: Kind.VARIABLE_DEFINITION, variable: { kind: Kind.VARIABLE, name: nameNode(v.name) }, type: parseType(v.type),
    }) as const);
  } catch {
    throw new AppError('integrity', 'a variable type in the manifest does not parse', { code: 'graphql.variable_type_invalid' });
  }
  return print({
    kind: Kind.DOCUMENT,
    definitions: [{
      kind: Kind.OPERATION_DEFINITION, operation: OperationTypeNode.QUERY, name: nameNode('SiloRead'), variableDefinitions,
      selectionSet: {
        kind: Kind.SELECTION_SET,
        selections: [{
          kind: Kind.FIELD, name: nameNode(source.root),
          arguments: source.variables.map((v) => ({ kind: Kind.ARGUMENT, name: nameNode(v.name), value: { kind: Kind.VARIABLE, name: nameNode(v.name) } })),
          ...(tree.children.size > 0 ? { selectionSet: selectionOf(tree) } : {}),
        }],
      },
    }],
  } as never);
}

/** A write's mutation: its root field with its declared, typed variables as arguments, selecting the paths it names (pure). */
export function buildMutation(mutation: { field: string; variables: readonly { name: string; type: string }[]; select: readonly string[] }): string {
  const tree: Tree = { children: new Map() };
  for (const path of mutation.select) insert(tree, segments(path));
  let variableDefinitions;
  try {
    variableDefinitions = mutation.variables.map((v) => ({
      kind: Kind.VARIABLE_DEFINITION, variable: { kind: Kind.VARIABLE, name: nameNode(v.name) }, type: parseType(v.type),
    }) as const);
  } catch {
    throw new AppError('integrity', 'a variable type in the manifest does not parse', { code: 'graphql.variable_type_invalid' });
  }
  return print({
    kind: Kind.DOCUMENT,
    definitions: [{
      kind: Kind.OPERATION_DEFINITION, operation: OperationTypeNode.MUTATION, name: nameNode('SiloWrite'), variableDefinitions,
      selectionSet: {
        kind: Kind.SELECTION_SET,
        selections: [{
          kind: Kind.FIELD, name: nameNode(mutation.field),
          arguments: mutation.variables.map((v) => ({ kind: Kind.ARGUMENT, name: nameNode(v.name), value: { kind: Kind.VARIABLE, name: nameNode(v.name) } })),
          ...(tree.children.size > 0 ? { selectionSet: selectionOf(tree) } : {}),
        }],
      },
    }],
  } as never);
}

/** The records at a dot path, mapped over lists (edges.node). */
export function recordsAt(result: unknown, path: string | undefined): unknown[] {
  let values: unknown[] = [result];
  for (const segment of segments(path)) {
    values = values.flatMap((v) => (Array.isArray(v) ? v : [v]))
      .map((v) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[segment] : undefined));
  }
  return values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v !== null && v !== undefined);
}
