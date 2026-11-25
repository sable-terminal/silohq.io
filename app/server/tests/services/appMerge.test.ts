// App definitions merged and compared by structure (D229): changes on either side kept, the same
// change once, a set's removals honoured, conflicts named by path and decided by a person.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareDefinitions, mergeDefinitions } from '../../src/services/studio/appMerge.service.ts';

const w = (id: string, text = id) => ({ id, kind: 'markdown', text });
const def = (pages: unknown[], extra: Record<string, unknown> = {}) => ({ schemaVersion: '1', ontologyVersion: 3, variables: {}, pages, events: [], functions: [], actions: [], ...extra });

test('changes on either side are both taken; the same change once', () => {
  const base = def([{ id: 'home', title: 'Home', widgets: [w('a'), w('b')] }], { functions: ['f1', 'f2'] });
  const main = def([{ id: 'home', title: 'Home', widgets: [w('a', 'A main'), w('b')] }], { functions: ['f1'] });
  const branch = def([{ id: 'home', title: 'Start', widgets: [w('a'), w('b'), w('c')] }, { id: 'more', title: 'More', widgets: [] }], { functions: ['f1', 'f2', 'f3'] });
  const { merged, conflicts } = mergeDefinitions(base, main, branch);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged['pages'], [{ id: 'home', title: 'Start', widgets: [w('a', 'A main'), w('b'), w('c')] }, { id: 'more', title: 'More', widgets: [] }]);
  assert.deepEqual(merged['functions'], ['f1', 'f3'], 'removed by main, added by the branch');
});

test('different changes to one widget conflict, named by path, decided by a person', () => {
  const base = def([{ id: 'home', title: 'Home', widgets: [w('a')] }]);
  const main = def([{ id: 'home', title: 'Home', widgets: [w('a', 'main')] }]);
  const branch = def([{ id: 'home', title: 'Home', widgets: [w('a', 'branch')] }]);
  const first = mergeDefinitions(base, main, branch);
  assert.deepEqual(first.conflicts.map((c) => c.path), ['pages.home.widgets.a']);
  const decided = mergeDefinitions(base, main, branch, new Map([['pages.home.widgets.a', 'branch']]));
  assert.deepEqual([decided.conflicts, (decided.merged['pages'] as { widgets: unknown[] }[])[0]!.widgets], [[], [w('a', 'branch')]]);
  // Removed on one side, changed on the other: a conflict too.
  const removed = mergeDefinitions(base, def([{ id: 'home', title: 'Home', widgets: [] }]), branch);
  assert.deepEqual(removed.conflicts.map((c) => [c.path, c.main, c.branch]), [['pages.home.widgets.a', undefined, w('a', 'branch')]]);
});

test('compare names each element added, removed or changed', () => {
  const from = def([{ id: 'home', title: 'Home', widgets: [w('a'), w('b')] }], { variables: { x: { kind: 'text' } } });
  const to = def([{ id: 'home', title: 'Start', widgets: [w('a', 'new'), w('c')] }], { actions: ['act'] });
  assert.deepEqual(compareDefinitions(from, to), [
    { path: 'variables.x', change: 'removed' }, { path: 'pages.home.title', change: 'changed' },
    { path: 'pages.home.widgets.a', change: 'changed' }, { path: 'pages.home.widgets.b', change: 'removed' }, { path: 'pages.home.widgets.c', change: 'added' },
    { path: 'actions.act', change: 'added' },
  ]);
});
