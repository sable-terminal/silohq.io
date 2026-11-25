// A notebook's question cell asked (D239), over the workspace cell's recording engine: compiled as
// finding objects (a notebook never proposes a change), its values bound under a fresh binding each
// time, the plan saved into the cell and the compile audited with what it charged; a
// clarification offered and answered by asking again with the candidate chosen; a refusal saying
// what would work. Only the owner asks, and only in a saved question cell.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { askNotebookQuestion, createNotebook, saveNotebook, shareNotebook } from '../../src/contracts/workspace/notebook.contract.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { startWorkspaceCell, type Signed, type WorkspaceCell } from './workspace.helper.ts';

let cell: WorkspaceCell;
let alice: Signed;
let bob: Signed;
const keyed = () => ({ idempotencyKey: uuidv7() });

before(async () => {
  cell = await startWorkspaceCell();
  alice = await cell.join('alice@acme.example', 'Member');
  bob = await cell.join('bob@acme.example', 'Member');
});

after(async () => {
  await cell?.close();
});

describe('a notebook\'s question cell (D239)', () => {
  test('asked by its owner: compiled as finding objects, bound afresh each time, the plan saved, the compile audited', async () => {
    const made = await cell.call(createNotebook, { body: { name: 'Pipeline' } }, alice, keyed());
    const saved = await cell.call(saveNotebook, {
      params: { notebookId: made.id },
      body: { document: { schemaVersion: '1', cells: [{ id: 'q', kind: 'question', name: 'deals', label: 'Open deals', planId: null, bindingId: uuidv7() }] }, lockVersion: made.lockVersion },
    }, alice);
    const first = await cell.call(askNotebookQuestion, { params: { notebookId: made.id }, body: { cellId: 'q', question: 'How many open deals by region?', lockVersion: saved.lockVersion } }, alice, keyed());
    assert.equal(first.outcome, 'plan');
    if (first.outcome !== 'plan') return;
    const sent = cell.engine.compiles.at(-1)!.request;
    assert.equal(sent.tool, 'find_objects', 'a notebook never proposes a change');
    const q = first.notebook.document.cells[0]!;
    assert.ok(q.kind === 'question' && q.planId !== null && q.bindingId === sent.turnId, 'the values bound under the cell\'s binding');
    assert.ok(!JSON.stringify(first.notebook.document).includes('open deals by region'), 'the question\'s words are never kept');
    const event = (await cell.events('notebook_question_compiled')).at(-1)!;
    assert.deepEqual([event.detail['cell_id'], event.detail['manifest_id'], event.detail['tokens_charged']], ['q', q.kind === 'question' ? q.planId : null, 1]);

    const again = await cell.call(askNotebookQuestion, { params: { notebookId: made.id }, body: { cellId: 'q', question: 'How many deals by region?', lockVersion: first.notebook.lockVersion } }, alice, keyed());
    if (again.outcome === 'plan') {
      const r = again.notebook.document.cells[0]!;
      assert.ok(r.kind === 'question' && q.kind === 'question' && r.bindingId !== q.bindingId, 'a fresh binding each time');
    } else assert.fail(again.outcome);

    await cell.call(shareNotebook, { params: { notebookId: made.id }, body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'view' } }, alice);
    await assert.rejects(cell.call(askNotebookQuestion, { params: { notebookId: made.id }, body: { cellId: 'q', question: 'How many deals?', lockVersion: 3 } }, bob, keyed()),
      { code: 'workspace.notebook_not_found' });
  });

  test('a clarification offered, answered by asking again with the candidate chosen; a refusal says what would work', async () => {
    const made = await cell.call(createNotebook, { body: { name: 'Choices' } }, alice, keyed());
    const saved = await cell.call(saveNotebook, {
      params: { notebookId: made.id },
      body: { document: { schemaVersion: '1', cells: [{ id: 'q', kind: 'question', name: 'answer', label: 'Accounts', planId: null, bindingId: uuidv7() }] }, lockVersion: made.lockVersion },
    }, alice);
    const options = [
      { id: 'o1', kind: 'object_type', elementId: uuidv7(), label: 'Account', source: null },
      { id: 'o2', kind: 'object_type', elementId: uuidv7(), label: 'Customer', source: null },
    ];
    cell.engine.next = () => ({ outcome: 'clarification', options: options as never });
    const offered = await cell.call(askNotebookQuestion, { params: { notebookId: made.id }, body: { cellId: 'q', question: 'How many accounts?', lockVersion: saved.lockVersion } }, alice, keyed());
    assert.deepEqual(offered.outcome === 'clarification' ? offered.options.map((o) => o.label) : [], ['Account', 'Customer']);
    cell.engine.next = () => 'plan';
    const chosen = await cell.call(askNotebookQuestion, {
      params: { notebookId: made.id }, body: { cellId: 'q', question: 'How many accounts?', lockVersion: saved.lockVersion, chosen: { option: options[0]!, rejected: [options[1]!] } },
    }, alice, keyed());
    assert.equal(chosen.outcome, 'plan');
    assert.deepEqual([cell.engine.compiles.at(-1)!.request.chosen?.elementId, cell.engine.compiles.at(-1)!.request.rejected?.map((r) => r.label)], [options[0]!.elementId, ['Customer']]);
    cell.engine.next = () => ({ outcome: 'refusal', reason: 'no_plan', narrowing: 'name the type you mean' });
    const refused = await cell.call(askNotebookQuestion, { params: { notebookId: made.id }, body: { cellId: 'q', question: 'How?', lockVersion: chosen.outcome === 'plan' ? chosen.notebook.lockVersion : 0 } }, alice, keyed());
    assert.deepEqual(refused, { outcome: 'refusal', reason: 'no_plan', narrowing: 'name the type you mean' });
    cell.engine.next = () => 'plan';
  });
});
