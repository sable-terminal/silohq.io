// The GraphQL engine's own manifest checks: variable types parse as GraphQL type
// references, constants and the fields' paths name only GraphQL names, a field is selected
// by its path (a computed JSONata value has no selection to build), and a write's mutation
// declares each variable once with a type that parses.

import { parseType } from 'graphql';
import type { Manifest } from '../../../../contracts/connect/manifest.contract.ts';
import type { ProtocolIssue } from '../checks.protocol.ts';

const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

export function graphqlChecks(manifest: Manifest): ProtocolIssue[] {
  if (manifest.protocol.kind !== 'graphql') return [];
  const issues: ProtocolIssue[] = [];
  manifest.objects.forEach((o, i) => {
    if (o.source.kind !== 'graphql') return;
    const source = o.source;
    const declared = new Set(source.variables.map((v) => v.name));
    source.variables.forEach((v, j) => {
      try {
        parseType(v.type);
      } catch {
        issues.push({ path: `objects.${i}.source.variables.${j}.type`, code: 'manifest.graphql_type_invalid', message: 'not a GraphQL type reference' });
      }
    });
    if (declared.size !== source.variables.length) {
      issues.push({ path: `objects.${i}.source.variables`, code: 'manifest.graphql_variable_repeated', message: 'variable names are unique' });
    }
    for (const name of Object.keys(source.constants)) {
      if (!declared.has(name)) issues.push({ path: `objects.${i}.source.constants.${name}`, code: 'manifest.graphql_variable_undeclared', message: 'a constant is for a declared variable' });
    }
    o.fields.forEach((f, j) => {
      if (f.value !== undefined) {
        issues.push({ path: `objects.${i}.fields.${j}.value`, code: 'manifest.graphql_field_computed', message: 'a GraphQL field is selected by its path' });
      }
      if (!(f.path ?? f.name).split('.').every((s) => NAME.test(s))) {
        issues.push({ path: `objects.${i}.fields.${j}.path`, code: 'manifest.graphql_path_invalid', message: 'a GraphQL field path is a dot path of GraphQL names' });
      }
    });
    for (const op of ['create', 'update', 'updateFull', 'delete', 'upsert'] as const) {
      const mutation = o.writes?.[op]?.mutation;
      if (mutation === undefined) continue;
      mutation.variables.forEach((v, j) => {
        try {
          parseType(v.type);
        } catch {
          issues.push({ path: `objects.${i}.writes.${op}.mutation.variables.${j}.type`, code: 'manifest.graphql_type_invalid', message: 'not a GraphQL type reference' });
        }
      });
      if (new Set(mutation.variables.map((v) => v.name)).size !== mutation.variables.length) {
        issues.push({ path: `objects.${i}.writes.${op}.mutation.variables`, code: 'manifest.graphql_variable_repeated', message: 'variable names are unique' });
      }
    }
  });
  return issues;
}
