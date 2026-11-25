// The engine over the compile and executor contracts (contractEngine.service.ts): what it
// sends, and how each outcome maps onto Ask's turns and the workspace's runs. A stub
// service client stands in for the two services; their own tests cover them.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { askRefusalOf, createContractEngine, runRefusalOf } from '../../src/services/workspace/contractEngine.service.ts';
import { uuidv7 } from '../db/harness.helper.ts';

interface Sent { name: string; input: any; options: any }

function stub(replies: Record<string, unknown>): { client: ServiceClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    async call(contract: { name: string }, input: unknown, options: unknown) {
      sent.push({ name: contract.name, input, options });
      return replies[contract.name];
    },
    close() {},
  } as unknown as ServiceClient;
  return { client, sent };
}

const caller = { request: { organisationId: uuidv7(), membershipId: uuidv7(), sessionId: uuidv7() }, correlationId: uuidv7() };
const request = (extra = {}) => ({
  question: 'How many open deals?', tool: 'answer' as const, scope: null, priorManifestIds: [uuidv7()], advanced: false,
  turnId: uuidv7(), chargeKey: 'ask.abc', ...extra,
});

describe('the contract engine', () => {
  test('an answer: compiled, charged and run in one keyed call, never run twice', async () => {
    const planId = uuidv7();
    const queryId = uuidv7();
    const { client, sent } = stub({
      compileQuestion: {
        outcome: 'answer', planId, compileClass: 'standard', charge: { charged: true, transactionId: '9', weight: '1' },
        result: { queryId, computedAt: '2026-11-02T10:00:00.000Z', reduced: false },
      },
    });
    const turnId = uuidv7();
    const out = await createContractEngine(client).compile(request({ turnId }), caller);
    assert.deepEqual(out, {
      outcome: 'plan', manifestId: planId, compileClass: 'standard', tokensCharged: 1, rephraseUncharged: false,
      ran: { outcome: 'result', resultRef: queryId, ranAt: '2026-11-02T10:00:00.000Z', reduced: false, incompleteSources: [] },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.options.idempotencyKey, 'ask.abc', 'keyed by the question\'s retry key');
    assert.equal(sent[0]!.input.body.execute, true);
    assert.equal(sent[0]!.input.body.bindingId, turnId, 'the values bound at compile are kept under the turn');
    assert.equal(sent[0]!.options.request.membershipId, caller.request.membershipId);
  });

  test('a thread\'s AI agent goes to compile as it is (D236)', async () => {
    const { client, sent } = stub({ compileQuestion: { outcome: 'plan', planId: uuidv7(), compileClass: 'standard', charge: { charged: true, transactionId: '1', weight: '1' } } });
    const aiAgent = { id: uuidv7(), name: 'Pipeline coach', brief: 'A deal is open until it is won or lost.', objectTypeIds: [uuidv7()], tools: ['answer', 'propose_cron'] as const };
    await createContractEngine(client).compile(request({ aiAgent: { ...aiAgent, tools: [...aiAgent.tools] } }), caller);
    assert.deepEqual(sent[0]!.input.body.aiAgent, { ...aiAgent, tools: [...aiAgent.tools] });
    assert.equal(sent[0]!.input.body.intents, true, 'it may propose a Cron');
    await createContractEngine(client).compile(request({ aiAgent: { ...aiAgent, tools: ['answer'] } }), caller);
    assert.equal(sent[1]!.input.body.intents, false, 'one that proposes nothing is not offered changes or Crons');
    await createContractEngine(client).compile(request(), caller);
    assert.equal('aiAgent' in sent[2]!.input.body, false, 'absent without one');
  });

  test('the thread\'s scope, a clarification answered and a rephrase go to compile', async () => {
    const { client, sent } = stub({ compileQuestion: { outcome: 'plan', planId: uuidv7(), compileClass: 'standard', charge: { charged: false, reason: 'rephrase_window' } } });
    const typeId = uuidv7();
    const other = uuidv7();
    const earlier = uuidv7();
    await createContractEngine(client).compile(request({
      scope: { kind: 'object', objectTypeId: typeId, objectRef: uuidv7() },
      chosen: { id: 'a', kind: 'object_type', elementId: typeId, label: 'Deal', source: null },
      rejected: [{ id: 'b', kind: 'object_type', elementId: other, label: 'Lead', source: null }],
      rephraseOf: earlier,
    }), caller);
    const body = sent[0]!.input.body;
    assert.deepEqual(body.focus, { objectTypeId: typeId });
    assert.deepEqual(body.chosen, { about: 'object_type', elementId: typeId, rejectedIds: [other] });
    assert.equal(body.rephraseOf, earlier);
  });

  test('a charge skipped inside the rephrase window is reported as such', async () => {
    const { client } = stub({
      compileQuestion: { outcome: 'plan', planId: uuidv7(), compileClass: 'advanced', charge: { charged: false, reason: 'rephrase_window' } },
    });
    const out = await createContractEngine(client).compile(request(), caller);
    assert.equal(out.outcome === 'plan' && out.tokensCharged, 0);
    assert.equal(out.outcome === 'plan' && out.rephraseUncharged, true);
  });

  test('refusals and clarifications map onto Ask\'s closed sets', async () => {
    const optionId = uuidv7();
    const { client } = stub({
      compileQuestion: { outcome: 'clarification', clarification: { about: 'route', question: 'Which route?', options: [{ id: optionId, name: 'Owner' }, { id: uuidv7(), name: 'Account' }] } },
    });
    const out = await createContractEngine(client).compile(request(), caller);
    assert.equal(out.outcome, 'clarification');
    assert.deepEqual(out.outcome === 'clarification' && out.options[0], { id: optionId, kind: 'route', elementId: optionId, label: 'Owner', source: null });

    assert.equal(askRefusalOf({ code: 'metering.daily_limit_reached', reason: 'x' }), 'daily_limit');
    assert.equal(askRefusalOf({ code: 'query.bound_rows_per_source', reason: 'x' }), 'bound_exceeded');
    assert.equal(askRefusalOf({ code: 'compile.could_not_compile', reason: 'x' }), 'no_plan');
    assert.equal(runRefusalOf({ code: 'plan.manifest_mismatch', reason: 'x' }), 'invalid_manifest');
    assert.equal(runRefusalOf({ code: 'query.source_unavailable', reason: 'x' }), 'unavailable');
  });

  test('a stored plan re-runs with its bound values as a saved view run, under the caller, never metered', async () => {
    const planId = uuidv7();
    const bindingId = uuidv7();
    const { client, sent } = stub({
      runCompiledPlan: { outcome: 'answer', result: { queryId: uuidv7(), computedAt: '2026-11-02T10:00:00.000Z', reduced: true } },
      runObjectSet: { outcome: 'answer', result: { queryId: uuidv7(), computedAt: '2026-11-02T10:00:00.000Z', reduced: false } },
    });
    const out = await createContractEngine(client).run({ manifestId: planId, bindingId }, caller);
    assert.equal(out.outcome, 'result');
    assert.equal(out.outcome === 'result' && out.reduced, true, 'the executor said a field policy shaped it');
    assert.deepEqual(sent.map((s) => s.name), ['runCompiledPlan']);
    assert.deepEqual(sent[0]!.input, { params: { planId }, body: { trigger: 'saved_view_run', bindingId } });
    assert.equal(sent[0]!.options.request.membershipId, caller.request.membershipId);

    const setId = uuidv7();
    const objectSet = await createContractEngine(client).run({ objectSetId: setId }, caller);
    assert.equal(objectSet.outcome, 'result');
    assert.deepEqual(sent[1]!.input.body, { objectSetId: setId, trigger: 'saved_view_run' });
  });
});
