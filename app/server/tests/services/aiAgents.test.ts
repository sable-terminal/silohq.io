// AI agents (D236): a brief, the object types it works with and the Ask tools it may use. Saved by
// its owner with the name and brief screened for record values and each type the ontology's;
// shared to ask or to copy within the sharing policy; archived, it is shared no more. Asking one
// is ask.test.ts's; what compile does with one is query.test.ts's. Real processes: the files cell.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  archiveAiAgent, copyAiAgent, createAiAgent, getAiAgent, listAiAgents, listAiAgentShares, saveAiAgent, shareAiAgent,
} from '../../src/contracts/workspace/aiAgent.contract.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { createFilesCell, invoiceType, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;

before(async () => {
  f = await createFilesCell();
});

after(async () => {
  await f?.close();
});

describe('AI agents (D236)', () => {
  test('made over the ontology\'s types; an unknown type, a value in the name or brief, or a stale save refused; only the owner edits', async () => {
    const invoices = invoiceType(f.manifest);
    const body = { name: 'Receivables helper', brief: 'Open means sent and not yet paid.', objectTypeIds: [invoices], tools: ['answer', 'propose_action'] as ('answer' | 'propose_action')[] };
    await assert.rejects(f.gateway.call(createAiAgent, { body: { ...body, objectTypeIds: [uuidv7()] } }, f.keyed(f.member)), { code: 'workspace.ai_agent_type_unknown' });
    await assert.rejects(f.gateway.call(createAiAgent, { body: { ...body, name: 'Card 4111 1111 1111 1111' } }, f.keyed(f.member)), { code: 'workspace.ai_agent_value_pattern' });
    await assert.rejects(f.gateway.call(createAiAgent, { body: { ...body, tools: ['answer', 'answer'] as never } }, f.keyed(f.member)));
    const made = await f.gateway.call(createAiAgent, { body }, f.keyed(f.member));
    assert.deepEqual([made.objectTypeIds, made.tools, made.description, made.lockVersion], [[invoices], ['answer', 'propose_action'], '', 1]);

    const saved = await f.gateway.call(saveAiAgent, {
      params: { aiAgentId: made.id }, body: { ...body, brief: 'Open means sent and not yet paid. Overdue means past its due date.', lockVersion: 1 },
    }, f.cell.as(f.member));
    assert.equal(saved.lockVersion, 2);
    await assert.rejects(f.gateway.call(saveAiAgent, { params: { aiAgentId: made.id }, body: { ...body, lockVersion: 1 } }, f.cell.as(f.member)), { code: 'workspace.ai_agent_stale' });
    await assert.rejects(f.gateway.call(saveAiAgent, { params: { aiAgentId: made.id }, body: { ...body, lockVersion: 2 } }, f.cell.as(f.outsider)), { code: 'workspace.ai_agent_not_found' });
    await assert.rejects(f.gateway.call(getAiAgent, { params: { aiAgentId: made.id } }, f.cell.as(f.outsider)), { code: 'workspace.ai_agent_not_found' });
    assert.deepEqual((await f.gateway.call(listAiAgents, { query: {} }, f.cell.as(f.member))).aiAgents.map((a) => a.id), [made.id]);
  });

  test('shared to ask, then to copy: the copy is the recipient\'s own; archived, it leaves their list and is shared no more', async () => {
    const made = await f.gateway.call(createAiAgent, { body: { name: 'Dunning coach', brief: 'Chase the oldest first.', tools: ['answer'] } }, f.keyed(f.member));
    const grantee = { kind: 'membership' as const, membershipId: f.outsider.membershipId };
    await f.gateway.call(shareAiAgent, { params: { aiAgentId: made.id }, body: { grantee, access: 'view' } }, f.cell.as(f.member));
    const theirs = await f.gateway.call(listAiAgents, { query: { filter: 'shared' } }, f.cell.as(f.outsider));
    assert.deepEqual(theirs.aiAgents.map((a) => [a.id, a.access]), [[made.id, 'view']]);
    await assert.rejects(f.gateway.call(copyAiAgent, { params: { aiAgentId: made.id }, body: { name: 'Mine' } }, f.keyed(f.outsider)), { code: 'workspace.ai_agent_copy_not_shared' });

    await f.gateway.call(shareAiAgent, { params: { aiAgentId: made.id }, body: { grantee, access: 'copy' } }, f.cell.as(f.member));
    assert.equal((await f.gateway.call(listAiAgentShares, { params: { aiAgentId: made.id } }, f.cell.as(f.member))).shares.length, 1, 'one share per grantee, updated');
    const copied = await f.gateway.call(copyAiAgent, { params: { aiAgentId: made.id }, body: { name: 'My dunning coach' } }, f.keyed(f.outsider));
    assert.deepEqual([copied.access, copied.ownerMembershipId, copied.brief], ['owner', f.outsider.membershipId, 'Chase the oldest first.']);

    await f.gateway.call(archiveAiAgent, { params: { aiAgentId: made.id } }, f.cell.as(f.member));
    assert.equal((await f.gateway.call(listAiAgents, { query: { filter: 'shared' } }, f.cell.as(f.outsider))).aiAgents.length, 0);
    await assert.rejects(f.gateway.call(shareAiAgent, { params: { aiAgentId: made.id }, body: { grantee, access: 'view' } }, f.cell.as(f.member)),
      { code: 'workspace.ai_agent_archived' });
    assert.deepEqual((await f.gateway.call(listAiAgents, { query: { filter: 'archived' } }, f.cell.as(f.member))).aiAgents.map((a) => a.id), [made.id]);
  });
});
