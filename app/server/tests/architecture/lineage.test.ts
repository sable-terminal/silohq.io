// Spec 59.6: the build fails on an artefact-producing service that does not write lineage.
// Spec 59.3: "Every artefact-producing service writes the artefact's node and input edges,
// and its inherited markings, in the transaction that creates it. An artefact cannot exist
// without its lineage."
//
// The rule: a service file that inserts an artefact row listed below must also call
// writeLineage (services/lineage/writer.service.ts). The artefacts are the node kinds of
// spec 59.2 whose rows exist today, by the repo call that creates them; a service that
// starts producing another kind adds its insert here when it is built. An export's file
// row shares its insert with uploads, which are not artefacts, so exports are held by
// their own test (files.test: the export's lineage) rather than by this rule.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { all } from './source.helper.ts';

/** The repo call that creates each artefact row, and the lineage node kind it is. */
export const ARTEFACT_INSERTS: Readonly<Record<string, string>> = {
  'compiledManifestRepo.insert(': 'ask_prompt (a compiled plan)',
  'savedViewRepo.insert(': 'view',
  'receiptRepo.insert(': 'action and receipt',
  'objectSetRepo.insert(': 'object_set',
  'objectTypeVersionRepo.insert(': 'object_type_version (with its properties and source fields)',
  'appVersionRepo.insert(': 'app_version',
  'simulationResultRepo.insert(': 'simulation_result',
  'findingRepo.insert(': 'finding',
};

const WRITER = /\bwriteLineage\s*\(/;

/** Source with comments removed, so a mention in a comment neither satisfies nor trips the rule. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

export function lineageViolations(files: readonly { file: string; source: string }[]): string[] {
  const out: string[] = [];
  for (const { file, source } of files) {
    if (!file.startsWith('services/') || file.startsWith('services/lineage/')) continue;
    const text = code(source);
    for (const [call, kind] of Object.entries(ARTEFACT_INSERTS)) {
      if (text.includes(call) && !WRITER.test(text)) out.push(`${file}: creates ${kind} (${call.slice(0, -1)}) without writeLineage`);
    }
  }
  return out;
}

describe('lineage is written by every artefact producer (spec 59.3, 59.6)', () => {
  test('the rule catches a producer that does not write lineage, and passes one that does', () => {
    assert.deepEqual(lineageViolations([
      { file: 'services/example/views.service.ts', source: 'await savedViewRepo.insert(db, row);' },
      { file: 'services/example/plans.service.ts', source: 'await compiledManifestRepo.insert(db, row);\n// writeLineage(db, ...) in a comment does not count' },
      { file: 'services/example/good.service.ts', source: 'await receiptRepo.insert(db, row);\nawait writeLineage(db, actor, input);' },
      { file: 'repos/workspace/savedView.repo.ts', source: 'savedViewRepo.insert(' },
    ]), [
      'services/example/views.service.ts: creates view (savedViewRepo.insert) without writeLineage',
      'services/example/plans.service.ts: creates ask_prompt (a compiled plan) (compiledManifestRepo.insert) without writeLineage',
    ]);
  });

  test('every service that creates an artefact writes its lineage', () => {
    assert.deepEqual(lineageViolations(all), []);
  });
});
