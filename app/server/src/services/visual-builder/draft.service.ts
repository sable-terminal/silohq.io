// Checking a draft manifest (spec 14.2, 16.4): pure functions over a document a person is
// building, so a half-built draft shows its errors where they are.
//
// - fullIssues: the checks the registry makes at save, in its order (the schema, every
//   expression compiled for its block, the protocol engine's own checks, parameter
//   patterns), collected rather than thrown.
// - stepIssues: one block of a draft: the schema of that block alone, its expressions
//   compiled from the raw draft (so a records expression is checked while the fields are
//   still being written), and the cross-checks that block can already answer.
// - YAML: the raw view of the same document. Aliases are refused (no expansion bombs),
//   duplicate keys are errors, and every schema issue is placed at its line and column.

import { isMap, LineCounter, parseDocument, stringify, type Document } from 'yaml';
import { z } from 'zod';
import { manifestSchema, type ExpressionBlock, type Manifest } from '../../contracts/connect/manifest.contract.ts';
import type { BuildStep, DraftIssue } from '../../contracts/visual-builder/builder.contract.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { parameterIssues } from '../connect-registry/parameters.service.ts';
import { protocolIssues } from '../connect-runtime/protocols/checks.protocol.ts';
import { checkManifestExpressions, compileExpression } from '../expression-evaluator/evaluator.service.ts';

const MAX_ISSUES = 200;
type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);
const at = (v: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((cur, key) => (cur !== null && typeof cur === 'object' ? (cur as Record<string | number, unknown>)[key] : undefined), v);

function zodIssues(error: z.ZodError, prefix: string): DraftIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter((p) => p !== '').join('.'), code: issue.code, message: issue.message,
  }));
}

/** The registry's save-time checks, collected. The manifest when there are none. */
export function fullIssues(document: unknown): { manifest: Manifest | undefined; issues: DraftIssue[] } {
  const parsed = manifestSchema.safeParse(document);
  if (!parsed.success) return { manifest: undefined, issues: zodIssues(parsed.error, 'document') };
  const issues: DraftIssue[] = [
    ...checkManifestExpressions(parsed.data).map((i) => ({
      path: `document.${i.path}`, code: i.code, message: `the ${i.block} expression is refused: ${i.reason}`,
    })),
    ...protocolIssues(parsed.data).map((i) => ({ ...i, path: `document.${i.path}` })),
    ...parameterIssues(parsed.data),
  ];
  return { manifest: issues.length === 0 ? parsed.data : undefined, issues };
}

// ----------------------------------------------------------------------------- steps

interface RawExpression { block: ExpressionBlock; language: 'cel' | 'jsonata'; source: unknown; path: string }

/** The expressions of one raw object, wherever they sit, whether or not the rest parses. */
function objectExpressions(o: unknown, i: number): RawExpression[] {
  const p = `document.objects.${i}`;
  const out: RawExpression[] = [];
  const cel = (block: ExpressionBlock, source: unknown, path: string) => { if (source !== undefined) out.push({ block, language: 'cel', source, path }); };
  const jsonata = (block: ExpressionBlock, source: unknown, path: string) => { if (source !== undefined) out.push({ block, language: 'jsonata', source, path }); };
  jsonata('records', at(o, 'source', 'records', 'jsonata'), `${p}.source.records.jsonata`);
  cel('paging.next', at(o, 'source', 'paging', 'next', 'cel'), `${p}.source.paging.next.cel`);
  const fields = at(o, 'fields');
  if (Array.isArray(fields)) fields.forEach((f, j) => jsonata('field', at(f, 'value', 'jsonata'), `${p}.fields.${j}.value.jsonata`));
  const filters = at(o, 'pushdown', 'filters');
  if (Array.isArray(filters)) filters.forEach((f, j) => cel('pushdown.filter', at(f, 'patch', 'cel'), `${p}.pushdown.filters.${j}.patch.cel`));
  const sort = at(o, 'pushdown', 'sort');
  if (Array.isArray(sort)) sort.forEach((s, j) => cel('pushdown.sort', at(s, 'patch', 'cel'), `${p}.pushdown.sort.${j}.patch.cel`));
  cel('pushdown.limit', at(o, 'pushdown', 'limit', 'patch', 'cel'), `${p}.pushdown.limit.patch.cel`);
  return out;
}

function compileIssues(expressions: readonly RawExpression[]): DraftIssue[] {
  const issues: DraftIssue[] = [];
  for (const e of expressions) {
    if (typeof e.source !== 'string' || e.source.trim() === '') continue; // the schema reports a missing or empty one
    try {
      compileExpression(e.block, e.language, e.source);
    } catch (error) {
      if (!isAppError(error)) throw error;
      const reason = typeof error.details['reason'] === 'string' ? error.details['reason'] : error.code;
      issues.push({ path: e.path, code: error.code, message: `the ${e.block} expression is refused: ${reason}` });
    }
  }
  return issues;
}

const STEP_PARTS: Readonly<Record<Exclude<BuildStep, 'transport' | 'auth' | 'errors'>, { paths: readonly string[]; blocks: readonly ExpressionBlock[] }>> = {
  objects: { paths: [''], blocks: ['records', 'paging.next', 'field', 'pushdown.filter', 'pushdown.sort', 'pushdown.limit'] },
  records: { paths: ['name', 'source'], blocks: ['records'] },
  fields: { paths: ['fields', 'identifier'], blocks: ['field'] },
  paging: { paths: ['source.paging'], blocks: ['paging.next'] },
  pushdown: { paths: ['pushdown'], blocks: ['pushdown.filter', 'pushdown.sort', 'pushdown.limit'] },
};

const shape = manifestSchema.shape;
const objectSchema = shape.objects.element;

/** Cross-checks one object can answer on its own: identifiers and pushdown name declared fields; the source fits the protocol. */
function objectCrossIssues(o: Raw, i: number, protocol: unknown): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const p = `document.objects.${i}`;
  const fields = Array.isArray(o['fields']) ? new Set((o['fields'] as unknown[]).map((f) => at(f, 'name')).filter((n) => typeof n === 'string')) : new Set<unknown>();
  const identifier = o['identifier'];
  if (Array.isArray(identifier)) {
    identifier.forEach((id, j) => {
      if (!fields.has(id)) issues.push({ path: `${p}.identifier.${j}`, code: 'custom', message: `identifier ${String(id)} is not a field` });
    });
  }
  for (const kind of ['filters', 'sort'] as const) {
    const list = at(o, 'pushdown', kind);
    if (Array.isArray(list)) {
      list.forEach((entry, j) => {
        const field = at(entry, 'field');
        if (typeof field === 'string' && !fields.has(field)) issues.push({ path: `${p}.pushdown.${kind}.${j}.field`, code: 'custom', message: `${field} is not a field` });
      });
    }
  }
  const sourceKind = at(o, 'source', 'kind');
  const protocolKind = at(protocol, 'kind');
  if (typeof sourceKind === 'string' && typeof protocolKind === 'string' && sourceKind !== protocolKind) {
    issues.push({ path: `${p}.source.kind`, code: 'custom', message: `the source must be a ${protocolKind} source` });
  }
  return issues;
}

/** One step's issues: its block's schema, its expressions, and the cross-checks it can answer. */
export function stepIssues(document: Raw, step: BuildStep, objectName?: string): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const check = (schema: z.ZodType, value: unknown, prefix: string) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) issues.push(...zodIssues(parsed.error, prefix));
    return parsed.success ? parsed.data : undefined;
  };
  if (step === 'transport') {
    const transport = check(shape.transport, document['transport'], 'document.transport') as Manifest['transport'] | undefined;
    const protocol = check(shape.protocol, document['protocol'], 'document.protocol') as Manifest['protocol'] | undefined;
    const params = check(shape.params, document['params'] ?? [], 'document.params') as Manifest['params'] | undefined;
    if (transport !== undefined && protocol !== undefined) {
      if ((protocol.kind === 'rest' || protocol.kind === 'graphql' || protocol.kind === 'soap' || protocol.kind === 'odata') && transport.baseUrl === undefined) {
        issues.push({ path: 'document.transport.baseUrl', code: 'custom', message: `a ${protocol.kind} connector names its base URL` });
      }
      if (protocol.kind === 'sql' && !transport.viaAgent) {
        issues.push({ path: 'document.transport.viaAgent', code: 'custom', message: 'customer databases are reached through the Silo Agent' });
      }
    }
    if (params !== undefined) issues.push(...parameterIssues({ params } as Manifest));
    return issues.slice(0, MAX_ISSUES);
  }
  if (step === 'auth') {
    const auth = check(shape.auth, document['auth'], 'document.auth') as Manifest['auth'] | undefined;
    const protocol = shape.protocol.safeParse(document['protocol']);
    if (auth !== undefined && protocol.success) {
      issues.push(...protocolIssues({ protocol: protocol.data, auth, objects: [], transport: { viaAgent: false } } as unknown as Manifest)
        .filter((i) => i.path.startsWith('auth')).map((i) => ({ ...i, path: `document.${i.path}` })));
    }
    issues.push(...compileIssues([{ block: 'auth.sign', language: 'cel', source: at(document, 'auth', 'sign', 'cel'), path: 'document.auth.sign.cel' }]));
    return issues.slice(0, MAX_ISSUES);
  }
  if (step === 'errors') {
    check(shape.errors, document['errors'] ?? {}, 'document.errors');
    const rules = at(document, 'errors', 'classify');
    if (Array.isArray(rules)) {
      issues.push(...compileIssues(rules.flatMap((r, i): RawExpression[] => [
        { block: 'errors.when', language: 'cel', source: at(r, 'when', 'cel'), path: `document.errors.classify.${i}.when.cel` },
        { block: 'errors.retryAfter', language: 'cel', source: at(r, 'retryAfter', 'cel'), path: `document.errors.classify.${i}.retryAfter.cel` },
      ])));
    }
    return issues.slice(0, MAX_ISSUES);
  }

  const part = STEP_PARTS[step];
  const objects = document['objects'];
  if (!Array.isArray(objects) || objects.length === 0) {
    return [{ path: 'document.objects', code: 'custom', message: 'add an object first' }];
  }
  let found = false;
  objects.forEach((raw, i) => {
    if (!isObject(raw) || (objectName !== undefined && raw['name'] !== objectName)) return;
    found = true;
    const parsed = objectSchema.safeParse(raw);
    if (!parsed.success) {
      const prefix = `document.objects.${i}`;
      issues.push(...zodIssues(parsed.error, prefix).filter((issue) =>
        part.paths.some((sub) => sub === '' || issue.path === `${prefix}.${sub}` || issue.path.startsWith(`${prefix}.${sub}.`))));
    }
    issues.push(...compileIssues(objectExpressions(raw, i).filter((e) => part.blocks.includes(e.block))));
    if (step === 'objects' || step === 'fields' || step === 'pushdown' || step === 'records') {
      issues.push(...objectCrossIssues(raw, i, document['protocol']).filter((issue) =>
        part.paths.some((sub) => sub === '' || issue.path.includes(`.${sub.split('.')[0]}`))));
    }
  });
  if (!found) return [{ path: 'document.objects', code: 'custom', message: `no object named ${objectName ?? ''}`.trim() }];
  return issues.slice(0, MAX_ISSUES);
}

// ----------------------------------------------------------------------------- YAML

/** The document as YAML: the raw view of the same manifest. */
export function toYaml(document: Raw): string {
  return stringify(document, { lineWidth: 0, aliasDuplicateObjects: false });
}

function position(doc: Document, counter: LineCounter, path: readonly string[]): { line: number; column: number } | undefined {
  // The deepest node the path reaches: a missing key is placed at its parent.
  for (let depth = path.length; depth >= 0; depth -= 1) {
    const keys = path.slice(0, depth).map((k) => (/^\d+$/.test(k) ? Number(k) : k));
    const node = depth === 0 ? doc.contents : doc.getIn(keys, true);
    const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
    if (range !== undefined) {
      const { line, col } = counter.linePos(range[0]);
      return { line, column: col };
    }
  }
  return undefined;
}

/** YAML to the document, with parse errors and the full checks placed at their lines. */
export function fromYaml(text: string): { document: Raw | null; issues: DraftIssue[] } {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, uniqueKeys: true, merge: false, prettyErrors: false });
  const issues: DraftIssue[] = [];
  for (const error of [...doc.errors, ...doc.warnings].slice(0, MAX_ISSUES)) {
    const pos = counter.linePos(error.pos[0]);
    issues.push({
      path: 'yaml', code: `yaml.${error.code.toLowerCase()}`, message: error.message.split('\n')[0]!.slice(0, 300),
      line: pos.line, column: pos.col,
    });
  }
  if (doc.errors.length > 0) return { document: null, issues };
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    return { document: null, issues: [{ path: 'yaml', code: 'yaml.alias_refused', message: 'aliases are not allowed in a manifest' }] };
  }
  if (!isMap(doc.contents) || !isObject(value)) {
    return { document: null, issues: [{ path: 'yaml', code: 'yaml.not_a_mapping', message: 'a manifest is a mapping of its blocks' }] };
  }
  const document = JSON.parse(JSON.stringify(value)) as Raw;
  for (const issue of fullIssues(document).issues) {
    const path = issue.path.replace(/^document\.?/, '').split('.').filter((p) => p !== '');
    issues.push({ ...issue, ...position(doc, counter, path) });
  }
  return { document, issues: issues.slice(0, MAX_ISSUES) };
}
