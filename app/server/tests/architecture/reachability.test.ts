// Invariant 12 (spec 3, 7, 79.1): a capability with no caller is not a capability, and
// reachability is checked in the build. Every service endpoint is called by some service
// (a services.call of its contract) or forwarded by a public gateway route.
//
// The endpoints below have no caller yet, each with why. The list is exact: wiring one up
// fails this test until it is removed here, and a new endpoint with no caller fails it too.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PUBLIC_ROUTES } from '../../src/contracts/gateway/routeTable.contract.ts';
import { all, SRC } from './source.helper.ts';

const NOT_WIRED = 'its intended caller does not call it yet';

export const KNOWN_UNREACHABLE: Readonly<Record<string, string>> = {
  // The PNG renderer (headless Chromium drawing the web client's components) is deferred until the web client exists (D88).
  'expression-evaluator.evaluateExpression': 'its callers evaluate in process today',
  'expression-evaluator.validateExpression': 'its callers validate in process today',
};

interface ContractLike { id: string; service: string; callers: readonly string[]; path: string }
const isContract = (v: unknown): v is ContractLike => typeof v === 'object' && v !== null && typeof (v as ContractLike).id === 'string'
  && Array.isArray((v as ContractLike).callers) && typeof (v as ContractLike).path === 'string';

test('every service endpoint is called by a service or forwarded by a public route (invariant 12)', async () => {
  const contracts = new Map<string, string>();
  for (const { file } of all.filter((f) => f.file.startsWith('contracts/'))) {
    const mod = await import(`${SRC}/${file}`) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) if (isContract(value)) contracts.set(`${value.service}.${name}`, value.id);
  }
  const forwarded = new Set(PUBLIC_ROUTES.map((r) => (r as unknown as { forwards?: { id: string } }).forwards?.id));
  const called = new Set<string>();
  for (const { file } of all.filter((f) => !f.file.startsWith('contracts/'))) {
    const source = readFileSync(`${SRC}/${file}`, 'utf8');
    const alias = new Map<string, string>();
    for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const a = /(\w+)\s+as\s+(\w+)/.exec(part.trim());
        if (a) alias.set(a[2]!, a[1]!);
      }
    }
    for (const m of source.matchAll(/\.call\(\s*(?:\w+\.)?(\w+)/g)) called.add(alias.get(m[1]!) ?? m[1]!);
  }
  const unreachable = [...contracts.entries()]
    .filter(([key, id]) => !forwarded.has(id) && !called.has(key.slice(key.indexOf('.') + 1)))
    .map(([key]) => key).sort();
  assert.deepEqual(unreachable, Object.keys(KNOWN_UNREACHABLE).sort(),
    'an endpoint gained or lost its caller: wire it, or update KNOWN_UNREACHABLE with why');
});

test('no path from simulation reaches mutation execution (spec 39.8: a staged Action has no execution path)', async () => {
  const EXECUTION = new Set([
    'actions.executeMutation', 'actions.confirmCanary', 'actions.proposeCronMutation', 'approvals.decideApproval', 'revert.requestRevert',
    'revert.decideRevertConflicts', 'connect-runtime.writeRecords',
  ]);
  const callable = new Map<string, readonly string[]>();
  for (const { file } of all.filter((f) => f.file.startsWith('contracts/'))) {
    const mod = await import(`${SRC}/${file}`) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) if (isContract(value)) callable.set(`${value.service}.${name}`, value.callers);
  }
  const bySimulation = [...callable.entries()].filter(([, callers]) => callers.includes('simulation')).map(([key]) => key);
  assert.deepEqual(bySimulation.filter((key) => EXECUTION.has(key)), [], 'simulation may call no execution path');
  // Into write-back, simulation only checks, lists recent writes and proposes.
  assert.deepEqual(bySimulation.filter((key) => /^(actions|approvals|revert)\./.test(key)).sort(),
    ['actions.checkMutation', 'actions.listRecentWrites', 'actions.proposeMutation']);
  // A proposal never executes: it requests approval, and a promotion is never approved at request.
  const propose = readFileSync(`${SRC}/services/actions/propose.service.ts`, 'utf8');
  assert.ok(!/executeMutation|writeRecords|decideApproval/.test(propose));
  assert.ok(readFileSync(`${SRC}/services/approvals/chains.service.ts`, 'utf8').includes('approval.promotion_unapproved'));
  for (const { file, source } of all.filter((f) => f.file.startsWith('services/simulation/'))) {
    assert.ok(!/executeMutation|writeRecords|decideApproval|requestRevert|confirmCanary/.test(source), `${file} names an execution path`);
  }
});
