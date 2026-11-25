// Ask (spec 36) end to end: real credential, policy, auth, workspace and ask processes on
// a harness database and Redis, with a fake query engine standing in for compile and the
// executor. Every turn is a finished outcome (an answer, a refusal or a clarification),
// keeps references only, and a retried question never compiles or charges twice.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  archiveThread, askQuestion, createThread, getThread, listThreads, renameThread, rerunTurn, widenThreadScope,
} from '../../src/contracts/ask/thread.contract.ts';
import { openView, saveView } from '../../src/contracts/workspace/view.contract.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { ToolSubject } from '../../src/contracts/ask/thread.contract.ts';
import { applyMarking, createMarking } from '../../src/contracts/policy/governance.contract.ts';
import { writeLineage } from '../../src/services/lineage/writer.service.ts';
import { startWorkspaceCell, web, type Signed, type WorkspaceCell } from './workspace.helper.ts';
import { readAskWebPolicy, setAskWebPolicy } from '../../src/contracts/ask/thread.contract.ts';
import { webQueryOf } from '../../src/services/ask/webQuery.service.ts';
import { withinDomains } from '../../src/services/ask/webPolicy.service.ts';
import { setAskWebScopePolicy } from '../../src/contracts/ask/thread.contract.ts';
import {
  archiveAiAgent, copyAiAgent, createAiAgent, getAiAgent, revokeAiAgentShare, shareAiAgent,
} from '../../src/contracts/workspace/aiAgent.contract.ts';

let cell: WorkspaceCell;
let alice: Signed;
let bob: Signed;

const keyed = () => ({ idempotencyKey: uuidv7() });
type ThreadBody = Parameters<typeof cell.call<typeof createThread>>[1]['body'];
const newThread = (who: Signed, body: ThreadBody = {}) => cell.call(createThread, { body }, who, keyed());
const ask = (who: Signed, threadId: string,
  body: { question: string; clarification?: { sequence: number; optionId: string }; rephrases?: { sequence: number }; advanced?: boolean },
  key = keyed()) => cell.call(askQuestion, { params: { threadId }, body }, who, key);

before(async () => {
  cell = await startWorkspaceCell();
  alice = await cell.join('alice@acme.example', 'Member');
  bob = await cell.join('bob@acme.example', 'Member');
});

after(async () => {
  await cell?.close();
});

describe('threads (spec 36.8)', () => {
  test('a thread is private, titled by its owner, scoped by reference', async () => {
    const thread = await newThread(alice, { scope: { kind: 'page', page: 'explorer' } });
    assert.equal(thread.title, 'New thread', 'never derived from a question');
    assert.deepEqual(thread.scope, { kind: 'page', page: 'explorer' });
    await assert.rejects(cell.call(getThread, { params: { threadId: thread.id } }, bob), { code: 'ask.thread_not_found' });
    await assert.rejects(newThread(alice, { scope: { kind: 'object_set', objectSetId: uuidv7() } }), { code: 'ask.scope_not_found' });

    const renamed = await cell.call(renameThread, { params: { threadId: thread.id }, body: { title: 'Pipeline questions' } }, alice);
    assert.equal(renamed.title, 'Pipeline questions');
    const found = await cell.call(listThreads, { query: { search: 'pipeline' } }, alice);
    assert.deepEqual(found.threads.map((t) => t.id), [thread.id]);
    assert.equal((await cell.call(listThreads, { query: {} }, bob)).threads.length, 0);

    const widened = await cell.call(widenThreadScope, { params: { threadId: thread.id }, body: { scope: null } }, alice);
    assert.equal(widened.scope, null);
    assert.ok((await cell.events('ask_scope_widened')).some((e) => e.resource?.id === thread.id && e.detail['from'] === 'page'));
  });

  test('an archived thread takes no new question', async () => {
    const thread = await newThread(alice);
    await cell.call(archiveThread, { params: { threadId: thread.id } }, alice);
    await assert.rejects(ask(alice, thread.id, { question: 'How many open deals?' }), { code: 'ask.thread_archived' });
    assert.ok((await cell.call(listThreads, { query: { archived: 'true' } }, alice)).threads.some((t) => t.id === thread.id));
    assert.ok((await cell.events('ask_thread_archived')).some((e) => e.resource?.id === thread.id));
  });
});

describe('turns (spec 36.2, 36.3, 36.10)', () => {
  test('an answer: compiled under the asker, run under the asker, references kept, the question kept only sealed', async () => {
    const thread = await newThread(alice, { scope: { kind: 'page', page: 'home' } });
    const first = await ask(alice, thread.id, { question: 'How many open deals by region?' });
    assert.equal(first.turn.outcome, 'answer');
    assert.equal(first.turn.sequence, 1);
    assert.equal(first.turn.tokensCharged, 1);
    assert.ok(first.turn.manifestId);
    assert.ok(first.turn.resultRef);
    assert.equal(first.turn.questionRetained, true, 'kept, sealed under the organisation\'s data key');
    assert.equal(first.thread.turnCount, 1);
    const compiled = cell.engine.compiles.at(-1)!;
    assert.equal(compiled.caller.request.membershipId, alice.membershipId);
    assert.deepEqual(compiled.request.scope, { kind: 'page', page: 'home' });
    assert.deepEqual(compiled.request.priorManifestIds, []);
    assert.equal(cell.engine.runs.at(-1)!.membershipId, alice.membershipId);

    const { rows } = await cell.migrate.query('select question, question_purged_at from workspace.ask_turns where id = $1', [first.turn.id]);
    assert.ok(Buffer.isBuffer(rows[0].question) && rows[0].question.length > 0);
    assert.ok(!rows[0].question.toString('latin1').includes('open deals'), 'never in the clear');
    assert.equal(rows[0].question_purged_at, null);

    const second = await ask(alice, thread.id, { question: 'And last quarter?' });
    assert.equal(second.turn.sequence, 2);
    const followUp = cell.engine.compiles.at(-1)!.request;
    assert.deepEqual(followUp.priorManifestIds, [first.turn.manifestId], 'a follow-up refines the earlier plan by reference');
    assert.equal(followUp.previousTurnId, first.turn.id, 'the previous turn, for the rephrase window');

    const event = (await cell.events('ask_question_compiled')).find((e) => e.detail['manifest_id'] === first.turn.manifestId);
    assert.equal(event?.detail['tokens_charged'], 1);
    assert.ok(!JSON.stringify((await cell.events()).filter((e) => e.event !== 'ask_web_context_added')).includes('open deals'),
      'no question in any audit event but the web call\'s, which records the query sent (decision 2026-11-14)');
  });

  test('when compile has run the plan already, Ask does not run it again', async () => {
    const thread = await newThread(alice);
    cell.engine.runsAtCompile = true;
    const runs = cell.engine.runs.length;
    const answered = await ask(alice, thread.id, { question: 'Open invoices' });
    cell.engine.runsAtCompile = false;
    assert.equal(cell.engine.runs.length, runs);
    assert.match(answered.turn.resultRef!, /^ran-at-compile-/);
  });

  test('a retried question replays its turn: no second compile, no second charge', async () => {
    const thread = await newThread(alice);
    const key = keyed();
    const first = await ask(alice, thread.id, { question: 'Top ten customers by revenue' }, key);
    const compiles = cell.engine.compiles.length;
    const again = await ask(alice, thread.id, { question: 'Top ten customers by revenue' }, key);
    assert.equal(again.turn.id, first.turn.id);
    assert.equal(cell.engine.compiles.length, compiles);
    assert.equal((await cell.call(getThread, { params: { threadId: thread.id } }, alice)).turns.length, 1);
    assert.match(cell.engine.compiles.at(-1)!.request.chargeKey, /^ask\.[0-9a-f]{48}$/, 'the charge is keyed by the question\'s retry key');
  });

  test('a clarification is free and offers candidates; choosing one compiles once', async () => {
    const thread = await newThread(alice);
    const options = [
      { id: 'a', kind: 'object_type' as const, elementId: uuidv7(), label: 'Deal', source: 'crm' },
      { id: 'b', kind: 'object_type' as const, elementId: uuidv7(), label: 'Opportunity', source: 'erp' },
    ];
    cell.engine.next = () => ({ outcome: 'clarification', options });
    const offered = await ask(alice, thread.id, { question: 'How many deals?' });
    assert.equal(offered.turn.outcome, 'clarification');
    assert.equal(offered.turn.tool, 'clarify');
    assert.equal(offered.turn.tokensCharged, 0);
    assert.deepEqual(offered.turn.clarificationOptions, options);
    cell.engine.next = () => 'plan';

    await assert.rejects(ask(alice, thread.id, { question: 'How many deals?', clarification: { sequence: 1, optionId: 'z' } }),
      { code: 'ask.clarification_unknown' });
    const chosen = await ask(alice, thread.id, { question: 'How many deals?', clarification: { sequence: 1, optionId: 'b' } });
    assert.equal(chosen.turn.outcome, 'answer');
    assert.equal(chosen.turn.tokensCharged, 1);
    assert.deepEqual(cell.engine.compiles.at(-1)!.request.chosen, options[1]);
    assert.deepEqual(cell.engine.compiles.at(-1)!.request.rejected, [options[0]], 'the candidate passed over goes to compile too');
    assert.ok((await cell.events('ask_clarification_offered')).some((e) => e.resource?.id === thread.id));
    assert.ok((await cell.events('ask_clarification_chosen')).some((e) => e.detail['element_id'] === options[1]!.elementId));
  });

  test('a rephrase the person marks names the earlier turn\'s plan, so the window can apply; the turn keeps its values under its id', async () => {
    const thread = await newThread(alice);
    const first = await ask(alice, thread.id, { question: 'How many open deals?' });
    const again = await ask(alice, thread.id, { question: 'How many deals are open?', rephrases: { sequence: first.turn.sequence } });
    const sent = cell.engine.compiles.at(-1)!.request;
    assert.equal(sent.rephraseOf, first.turn.manifestId);
    assert.equal(cell.engine.runs.at(-1)!.target && 'bindingId' in cell.engine.runs.at(-1)!.target ? (cell.engine.runs.at(-1)!.target as { bindingId?: string }).bindingId : undefined, again.turn.id);
    await assert.rejects(ask(alice, thread.id, { question: 'x', rephrases: { sequence: 99 } }), { code: 'ask.rephrase_unknown' });
  });

  test('refusals are free, finished replies: at compile, and when the engine refuses at execution', async () => {
    const thread = await newThread(alice);
    cell.engine.next = () => ({ outcome: 'refusal', reason: 'daily_limit', narrowing: null });
    const runs = cell.engine.runs.length;
    const limited = await ask(alice, thread.id, { question: 'Revenue by product' });
    assert.equal(limited.turn.outcome, 'refusal');
    assert.equal(limited.turn.refusalReason, 'daily_limit');
    assert.equal(limited.turn.tokensCharged, 0);
    assert.equal(cell.engine.runs.length, runs, 'a refusal runs nothing');

    cell.engine.next = () => ({ outcome: 'refusal', reason: 'unsupported', narrowing: 'ask about one object type at a time' });
    const unsupported = await ask(alice, thread.id, { question: 'Join deals to invoices by name' });
    assert.equal(unsupported.turn.narrowing, 'ask about one object type at a time');

    cell.engine.next = () => 'plan';
    cell.engine.runOutcome = () => ({ outcome: 'refused', reason: 'bound_exceeded', invalidSinceVersionId: null });
    const bounded = await ask(alice, thread.id, { question: 'Every line item ever' });
    assert.equal(bounded.turn.outcome, 'refusal');
    assert.equal(bounded.turn.refusalReason, 'bound_exceeded');
    assert.ok(bounded.turn.manifestId, 'the plan is kept for reference');
    cell.engine.runOutcome = () => undefined;
    const refused = (await cell.events('ask_refused')).filter((e) => e.resource?.id === thread.id).map((e) => e.detail['reason']);
    assert.deepEqual(refused, ['daily_limit', 'unsupported', 'bound_exceeded']);
  });

  test('an answered turn re-runs unmetered; a refusal does not re-run', async () => {
    const thread = await newThread(alice);
    const answered = await ask(alice, thread.id, { question: 'Open tickets' });
    const compiles = cell.engine.compiles.length;
    const rerun = await cell.call(rerunTurn, { params: { threadId: thread.id, sequence: 1 } }, alice);
    assert.ok(rerun.resultRef);
    assert.notEqual(rerun.resultRef, answered.turn.resultRef);
    assert.equal(cell.engine.compiles.length, compiles, 're-running compiles nothing');
    cell.engine.next = () => ({ outcome: 'refusal', reason: 'no_plan', narrowing: null });
    await ask(alice, thread.id, { question: 'Something unanswerable' });
    cell.engine.next = () => 'plan';
    await assert.rejects(cell.call(rerunTurn, { params: { threadId: thread.id, sequence: 2 } }, alice), { code: 'ask.turn_not_answer' });
    await assert.rejects(cell.call(rerunTurn, { params: { threadId: thread.id, sequence: 1 } }, bob), { code: 'ask.thread_not_found' });
  });

  test('an advanced compile needs query.advanced', async () => {
    const thread = await newThread(alice);
    await assert.rejects(ask(alice, thread.id, { question: 'Chain three analyses', advanced: true }), { code: 'ask.not_permitted' });
    const rootThread = await newThread(cell.root);
    cell.engine.next = () => 'advanced';
    const done = await ask(cell.root, rootThread.id, { question: 'Chain three analyses', advanced: true });
    assert.equal(done.turn.tokensCharged, 3);
    assert.equal(cell.engine.compiles.at(-1)!.request.advanced, true);
    cell.engine.next = () => 'plan';
  });
});

describe('proposing an Action (spec 36.4, 42.9)', () => {
  const intent = (over: Record<string, unknown> = {}) => ({
    objectTypeId: uuidv7(), operation: 'create' as const, set: { status: 'paid' }, clear: [], targetsPlanId: null,
    candidates: [{ actionTypeId: uuidv7(), actionTypeVersionId: uuidv7(), apiName: 'settle', displayName: 'Settle', parameters: { new_status: 'paid' } }],
    genericEdit: false, ...over,
  });
  const propose = (threadId: string, question: string) => cell.call(askQuestion, { params: { threadId }, body: { question, tool: 'propose_action' } }, alice, keyed());

  test('a change asked for is a draft, never executed: how it would be made kept as references, the values only in the reply', async () => {
    const thread = await newThread(alice);
    const asked = intent();
    cell.engine.next = () => ({ outcome: 'intent', intent: asked, compileClass: 'standard', tokensCharged: 1, rephraseUncharged: false });
    const runs = cell.engine.runs.length;
    const out = await propose(thread.id, 'Record a paid invoice');
    cell.engine.next = () => 'plan';
    assert.equal(cell.engine.compiles.at(-1)!.request.tool, 'propose_action');
    assert.deepEqual([out.turn.outcome, out.turn.tool, out.turn.tokensCharged], ['proposal', 'propose_action', 1]);
    assert.equal(cell.engine.runs.length, runs, 'nothing runs, nothing is written: a person submits the draft');
    assert.deepEqual(out.turn.proposal, {
      objectTypeId: asked.objectTypeId, operation: 'create', properties: ['status'], genericEdit: false,
      candidates: [{ actionTypeId: asked.candidates[0]!.actionTypeId, actionTypeVersionId: asked.candidates[0]!.actionTypeVersionId, displayName: 'Settle' }],
    });
    assert.deepEqual(out.turn.draft, { candidates: [{ actionTypeId: asked.candidates[0]!.actionTypeId, parameters: { new_status: 'paid' } }], edit: null });

    const kept = (await cell.call(getThread, { params: { threadId: thread.id } }, alice)).turns.at(-1)!;
    assert.deepEqual(kept.proposal, out.turn.proposal);
    assert.equal(kept.draft, undefined, 'the values are carried once, in the reply');
    const { rows } = await cell.migrate.query('select proposal from workspace.ask_turns where id = $1', [out.turn.id]);
    assert.ok(!JSON.stringify(rows[0].proposal).includes('paid'), 'references, never a value');
    const event = (await cell.events('ask_action_proposed')).at(-1)!;
    assert.deepEqual([event.detail['candidates'], event.detail['generic_edit'], event.detail['operation']], [1, false, 'create']);
    assert.ok(!JSON.stringify(event).includes('paid'));
  });

  test('where no Action type fits, the draft is the generic governed edit', async () => {
    const thread = await newThread(alice);
    const asked = intent({ candidates: [], genericEdit: true, set: { status: 'disputed' } });
    cell.engine.next = () => ({ outcome: 'intent', intent: asked, compileClass: 'standard', tokensCharged: 1, rephraseUncharged: false });
    const out = await propose(thread.id, 'Add a disputed invoice');
    cell.engine.next = () => 'plan';
    assert.equal(out.turn.proposal!.genericEdit, true);
    assert.deepEqual(out.turn.draft, { candidates: [], edit: { objectTypeId: asked.objectTypeId, operation: 'create', set: { status: 'disputed' }, clear: [] } });
  });
});

describe('explaining and opening (spec 36.4)', () => {
  type ToolBody = { question: string; tool: 'explain_lineage' | 'explain_finding' | 'open_clone' | 'answer'; subject?: ToolSubject };
  const tool = (threadId: string, body: ToolBody) => cell.call(askQuestion, { params: { threadId }, body }, alice, keyed());

  test('explain lineage: a property\'s sources under the asker, no model call, never charged; the subject kept, the graph only in the reply', async () => {
    const thread = await newThread(alice);
    const [property, field, connection] = [uuidv7(), uuidv7(), uuidv7()];
    await inTx(cell.app, { orgId: cell.org }, () => writeLineage(cell.app, { organisationId: cell.org, createdBy: { membershipId: cell.root.membershipId } }, {
      artefact: { kind: 'property', refId: property, version: 'v1' },
      inputs: [{ node: { kind: 'source_field', refId: field, version: 'm1' }, relation: 'maps_to' }, { node: { kind: 'connection', refId: connection, version: 'm1' }, relation: 'read_via' }],
    }));
    const compiles = cell.engine.compiles.length;
    const out = await tool(thread.id, { question: 'Where does this come from?', tool: 'explain_lineage', subject: { kind: 'property', propertyIdentityId: property } });
    assert.equal(cell.engine.compiles.length, compiles, 'no compile, no model call');
    assert.deepEqual([out.turn.outcome, out.turn.tool, out.turn.tokensCharged], ['answer', 'explain_lineage', 0]);
    assert.deepEqual(out.turn.subject, { kind: 'property', propertyIdentityId: property });
    assert.equal(out.turn.explanation?.kind, 'lineage');
    if (out.turn.explanation?.kind === 'lineage') {
      assert.deepEqual(out.turn.explanation.graph.nodes.map((n) => n.kind).sort(), ['connection', 'property', 'source_field']);
    }
    const kept = (await cell.call(getThread, { params: { threadId: thread.id } }, alice)).turns.at(-1)!;
    assert.deepEqual([kept.subject, kept.explanation], [out.turn.subject, undefined], 'the subject is kept; the explanation is read again when asked');
    await assert.rejects(tool(thread.id, { question: 'And that one?', tool: 'explain_lineage', subject: { kind: 'turn', sequence: 99 } }), { code: 'ask.subject_not_found' });
  });

  test('open a clone: navigation only, where the asker may see the type; a subject goes with its tool, and only with it', async () => {
    const thread = await newThread(alice);
    const [objectTypeId, hidden, objectId] = [uuidv7(), uuidv7(), uuidv7()];
    for (const [id, name] of [[objectTypeId, 'site'], [hidden, 'vault']] as const) {
      await cell.migrate.query('insert into ontology.object_types (id, organisation_id, api_name, created_by_membership_id) values ($1, $2, $3, $4)',
        [id, cell.org, name, cell.root.membershipId]);
    }
    const out = await tool(thread.id, { question: 'Show me it', tool: 'open_clone', subject: { kind: 'object', objectTypeId, objectId } });
    assert.deepEqual(out.turn.explanation, { kind: 'navigation', target: { kind: 'object_view', objectTypeId, objectId } });
    const canvas = await tool(thread.id, { question: 'The whole site', tool: 'open_clone', subject: { kind: 'clone_canvas', objectTypeId } });
    assert.deepEqual(canvas.turn.explanation, { kind: 'navigation', target: { kind: 'clone_canvas', objectTypeId } });

    const marking = await cell.call(createMarking, { body: { name: 'Vault', kind: 'compartment' } }, cell.root);
    await cell.call(applyMarking, { body: { markingId: marking.id, resource: { type: 'object_type', id: hidden } } }, cell.root);
    await assert.rejects(tool(thread.id, { question: 'Open the vault', tool: 'open_clone', subject: { kind: 'clone_canvas', objectTypeId: hidden } }),
      { code: 'ask.subject_not_found' }, 'not visible and not there are one answer');
    await assert.rejects(tool(thread.id, { question: 'Hello', tool: 'answer', subject: { kind: 'clone_canvas', objectTypeId } }), { category: 'validation' });
    await assert.rejects(tool(thread.id, { question: 'Why?', tool: 'explain_finding', subject: { kind: 'clone_canvas', objectTypeId } }), { category: 'validation' });
  });
});

describe('proposing a Cron (spec 36.4, 40)', () => {
  test('the Cron editor pre-filled on the thread\'s latest answer, its schedule as compile wrote it; never saved here', async () => {
    const thread = await newThread(alice);
    const cron = (question: string) => cell.call(askQuestion, { params: { threadId: thread.id }, body: { question, tool: 'propose_cron' } }, alice, keyed());
    await assert.rejects(cron('Every Monday at 9'), { code: 'ask.cron_needs_question' }, 'a Cron re-runs a question');
    const first = await ask(alice, thread.id, { question: 'Which invoices are overdue?' });
    const asWritten = 'every Monday at 9 if any';
    cell.engine.next = () => ({
      outcome: 'schedule', schedule: { schedule: '0 9 * * 1', condition: { kind: 'result', operator: 'returned_rows' }, action: 'notify', asWritten },
      compileClass: 'standard', tokensCharged: 1, rephraseUncharged: false,
    });
    const out = await cron('Check that every Monday at 9 and tell me if any');
    cell.engine.next = () => 'plan';
    assert.deepEqual([out.turn.outcome, out.turn.tool, out.turn.proposal, out.turn.tokensCharged], ['proposal', 'propose_cron', null, 1]);
    assert.deepEqual(out.turn.cron, {
      subject: { fromTurn: first.turn.sequence }, trigger: { schedule: '0 9 * * 1' }, condition: { kind: 'result', operator: 'returned_rows' },
      actions: [{ kind: 'notify', recipients: [] }], asWritten,
    });
    assert.equal(out.turn.manifestId, first.turn.manifestId, 'the plan the Cron would re-run');
    const kept = (await cell.call(getThread, { params: { threadId: thread.id } }, alice)).turns.at(-1)!;
    assert.deepEqual(kept.cron, out.turn.cron);
    const event = (await cell.events('ask_cron_proposed')).at(-1)!;
    assert.deepEqual([event.detail['schedule'], event.detail['condition'], event.detail['subject']], ['0 9 * * 1', 'returned_rows', 'turn']);
  });
});

describe('starting a scenario (spec 36.4, 39.4)', () => {
  // The scenario saved end to end, with a real ontology and compile, is in query.test.ts.
  test('a question stating no failure is a finished refusal; saving a scenario is simulation.run', async () => {
    const thread = await newThread(alice);
    const subject = { kind: 'object' as const, objectTypeId: uuidv7(), objectId: uuidv7() };
    const start = (question: string) => cell.call(askQuestion, { params: { threadId: thread.id }, body: { question, tool: 'start_scenario', subject } }, alice, keyed());
    cell.engine.nextFailure = () => ({ outcome: 'refusal', reason: 'no_plan', narrowing: 'say how the objects fail, and for how long' });
    const refused = await start('What about this depot?');
    assert.deepEqual([refused.turn.outcome, refused.turn.tool, refused.turn.scenarioId, refused.turn.narrowing],
      ['refusal', 'start_scenario', null, 'say how the objects fail, and for how long']);
    assert.deepEqual(refused.turn.subject, subject);
    cell.engine.nextFailure = () => ({ outcome: 'failure', failure: { form: 'unavailable', asWritten: 'unavailable' }, tokensCharged: 1 });
    await assert.rejects(start('What if it fails?'), { category: 'forbidden' });
    assert.equal(cell.engine.failures.at(-1)!.objectTypeId, subject.objectTypeId);
  });
});

describe('saving an answer as a view (spec 36.11)', () => {
  test('the asker saves the answer\'s plan; nobody else can by its id', async () => {
    const thread = await newThread(alice);
    const answered = await ask(alice, thread.id, { question: 'Deals closing this month' });
    const view = await cell.call(saveView, { body: { kind: 'result', name: 'Closing this month', manifestId: answered.turn.manifestId! } }, alice, keyed());
    assert.equal(view.manifestId, answered.turn.manifestId);
    assert.equal((await cell.call(openView, { params: { viewId: view.id } }, alice)).view.access, 'owner');
    await assert.rejects(cell.call(saveView, { body: { kind: 'result', name: 'Not mine', manifestId: answered.turn.manifestId! } }, bob, keyed()),
      { code: 'workspace.plan_not_found' });
  });
});

describe('outside context (spec 36.7; decision 2026-11-14)', () => {
  test('the web query is the question\'s wording without its literals', () => {
    assert.equal(webQueryOf('Why are orders for ada@acme.example over 5000 late at "Pier 7" since 2026-10-01?'), 'Why are orders for over late at since');
    assert.equal(webQueryOf('ORD-1234 status'), null, 'one word left is no query');
  });

  test('after an answer only: cited results in their own block, the query shown as sent; nothing in the audit but counts', async () => {
    const thread = await newThread(alice);
    const before = web.queries.length;
    const answered = await ask(alice, thread.id, { question: 'Which suppliers ship through Felixstowe for order 88812?' });
    assert.equal(answered.turn.outcome, 'answer');
    assert.equal(answered.turn.outsideContext?.status, 'ok');
    assert.equal(answered.turn.outsideContext?.query, 'Which suppliers ship through Felixstowe for order');
    assert.deepEqual(answered.turn.outsideContext?.results.map((r) => r.url), ['https://news.example/strike']);
    assert.ok(!web.queries.slice(before).some((q) => /\d/.test(q)), 'no literal ever leaves');
    const event = (await cell.events('ask_web_context_added')).at(-1)!;
    assert.deepEqual([event.detail['status'], event.detail['results'], event.detail['query'], event.detail['scope_id']],
      ['ok', 1, 'Which suppliers ship through Felixstowe for order', 'organisation'], 'every web call audited with its scope and query');
    const sent = (await cell.events('web_search_sent')).at(-1)!;
    assert.deepEqual([sent.detail['status'], sent.detail['results'], 'query' in sent.detail], ['ok', 1, false], 'the search leaving the cell, by count');
  });

  test('a failed search says outside context was unavailable; the organisation may turn it off', async () => {
    const thread = await newThread(alice);
    web.fail = true;
    try {
      const failed = await ask(alice, thread.id, { question: 'Which suppliers ship through Felixstowe?' });
      assert.deepEqual([failed.turn.outcome, failed.turn.outsideContext?.status, failed.turn.outsideContext?.results], ['answer', 'unavailable', []]);
    } finally {
      web.fail = false;
    }
    await assert.rejects(cell.call(setAskWebPolicy, { body: { enabled: false } }, alice), { category: 'forbidden' });
    assert.deepEqual(await cell.call(setAskWebPolicy, { body: { enabled: false } }, cell.root), { enabled: false, available: true });
    const before = web.queries.length;
    const off = await ask(alice, thread.id, { question: 'Which suppliers ship through Felixstowe now?' });
    assert.equal(off.turn.outsideContext, null);
    assert.equal(web.queries.length, before, 'no query is sent');
    await cell.call(setAskWebPolicy, { body: { enabled: true } }, cell.root);
  });
});

describe('web context per scope (decision 2026-11-14)', () => {
  test('domain lists: an allowlist keeps only its domains; a blocklist drops its own and their subdomains', () => {
    const results = [{ title: 'a', url: 'https://news.example/x', snippet: '' }, { title: 'b', url: 'https://ads.spam.example/y', snippet: '' },
      { title: 'c', url: 'https://gov.uk/z', snippet: '' }];
    assert.deepEqual(withinDomains(results, { allowedDomains: [], blockedDomains: ['spam.example'] }).map((r) => r.title), ['a', 'c']);
    assert.deepEqual(withinDomains(results, { allowedDomains: ['gov.uk'], blockedDomains: [] }).map((r) => r.title), ['c']);
  });

  test('an admin turns it off for a scope: no query is sent for its members; on again with a blocklist, results are filtered', async () => {
    const scope = await cell.scope('Operations');
    const dana = await cell.join('dana@acme.example', 'Member', scope);
    await assert.rejects(cell.call(setAskWebScopePolicy, { params: { scopeId: scope }, body: { enabled: false } }, alice), { category: 'forbidden' });
    await cell.call(setAskWebScopePolicy, { params: { scopeId: scope }, body: { enabled: false } }, cell.root);
    const thread = await newThread(dana);
    const before = web.queries.length;
    assert.equal((await ask(dana, thread.id, { question: 'Which suppliers ship through Felixstowe today?' })).turn.outsideContext, null);
    assert.equal(web.queries.length, before, 'off in the scope: nothing sent');
    const elsewhere = await ask(alice, (await newThread(alice)).id, { question: 'Which suppliers ship through Felixstowe today?' });
    assert.equal(elsewhere.turn.outsideContext?.status, 'ok', 'a member outside the scope is unaffected');
    await cell.call(setAskWebScopePolicy, { params: { scopeId: scope }, body: { enabled: true, blockedDomains: ['news.example'] } }, cell.root);
    const filtered = await ask(dana, thread.id, { question: 'Which suppliers ship through Felixstowe this week?' });
    assert.deepEqual([filtered.turn.outsideContext?.status, filtered.turn.outsideContext?.results.length], ['ok', 0], 'the one result was on a blocked domain');
    const event = (await cell.events('ask_web_context_added')).at(-1)!;
    assert.equal(event.detail['scope_id'], scope, 'audited with the scope');
    const read = await cell.call(readAskWebPolicy, {}, cell.root);
    assert.deepEqual([read.enabled, read.available], [true, true]);
    const here = read.scopes.find((s) => s.scopeId === scope)!;
    assert.deepEqual([here.enabled, here.allowedDomains, here.blockedDomains, here.markedData, here.coveredMarkings, here.updatedBy],
      [true, [], ['news.example'], false, 0, cell.root.membershipId]);
    assert.deepEqual(await cell.call(readAskWebPolicy, {}, dana), { enabled: true, available: true, scopes: [] }, 'a member reads the switch, not the scopes');
  });
});

describe('AI agents (D236)', () => {
  test('a thread made with an AI agent compiles each question with its brief, uses only its tools, and stops when it is no longer the asker\'s', async () => {
    const agent = await cell.call(createAiAgent, {
      body: { name: 'Pipeline coach', description: 'Questions about the sales pipeline', brief: 'A deal is open until it is won or lost.', tools: ['answer', 'find_objects'] },
    }, alice, keyed());
    assert.deepEqual([agent.access, agent.tools, agent.objectTypeIds], ['owner', ['answer', 'find_objects'], []]);
    await assert.rejects(cell.call(createAiAgent, { body: { name: 'Leaky', brief: 'Escalate to sam@acme.example', tools: ['answer'] } }, alice, keyed()),
      { code: 'workspace.ai_agent_value_pattern' });

    const thread = await newThread(alice, { aiAgentId: agent.id });
    assert.deepEqual([thread.aiAgentId, thread.title], [agent.id, 'Pipeline coach'], 'titled by the agent unless the person names it');
    await assert.rejects(newThread(bob, { aiAgentId: agent.id }), { code: 'ask.ai_agent_not_found' }, 'not shared: not there');

    const first = await ask(alice, thread.id, { question: 'How many open deals?' });
    assert.equal(first.turn.outcome, 'answer');
    const sent = cell.engine.compiles.at(-1)!.request;
    assert.deepEqual(sent.aiAgent, { id: agent.id, name: 'Pipeline coach', brief: 'A deal is open until it is won or lost.', objectTypeIds: [], tools: ['answer', 'find_objects'] });
    const compiled = (await cell.events('ask_question_compiled')).at(-1)!;
    assert.deepEqual([compiled.detail['ai_agent_id'], compiled.detail['ai_agent_version']], [agent.id, 1], 'which agent, at which version, shaped the plan');
    const compiles = cell.engine.compiles.length;
    await assert.rejects(cell.call(askQuestion, { params: { threadId: thread.id }, body: { question: 'Tell me every Monday', tool: 'propose_cron' } }, alice, keyed()),
      { code: 'ask.ai_agent_tool' });
    assert.equal(cell.engine.compiles.length, compiles, 'refused before compile');

    // Shared to ask: bob makes his own thread with it, asked under his own access.
    const share = await cell.call(shareAiAgent, { params: { aiAgentId: agent.id }, body: { grantee: { kind: 'membership', membershipId: bob.membershipId }, access: 'view' } }, alice);
    const his = await newThread(bob, { aiAgentId: agent.id });
    await ask(bob, his.id, { question: 'How many open deals?' });
    assert.equal(cell.engine.compiles.at(-1)!.caller.request.membershipId, bob.membershipId);
    assert.equal((await cell.call(getAiAgent, { params: { aiAgentId: agent.id } }, bob)).brief, agent.brief, 'what shapes an answer is never hidden from the asker');
    await assert.rejects(cell.call(copyAiAgent, { params: { aiAgentId: agent.id }, body: { name: 'Mine' } }, bob, keyed()), { code: 'workspace.ai_agent_copy_not_shared' });
    await cell.call(revokeAiAgentShare, { params: { aiAgentId: agent.id, shareId: share.id } }, alice);
    await assert.rejects(ask(bob, his.id, { question: 'How many open deals?' }), { code: 'ask.ai_agent_unavailable' });

    await cell.call(archiveAiAgent, { params: { aiAgentId: agent.id } }, alice);
    await assert.rejects(ask(alice, thread.id, { question: 'How many open deals?' }), { code: 'ask.ai_agent_archived' });
    assert.equal((await cell.call(getThread, { params: { threadId: thread.id } }, alice)).turns.length, 1, 'its turns are kept');
    assert.ok((await cell.events('ai_agent_shared')).some((e) => e.resource?.id === agent.id && e.subjectMembershipId === bob.membershipId));
  });
});
