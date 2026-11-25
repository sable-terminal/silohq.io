// The SOAP engine's own manifest checks: parameter names are unique, constants are for
// declared parameters, a field is read by its path of element names (a computed JSONata
// value has no element to read). Writes name their operations (checked by the manifest).

import type { Manifest } from '../../../../contracts/connect/manifest.contract.ts';
import type { ProtocolIssue } from '../checks.protocol.ts';

const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function soapChecks(manifest: Manifest): ProtocolIssue[] {
  if (manifest.protocol.kind !== 'soap') return [];
  const issues: ProtocolIssue[] = [];
  manifest.objects.forEach((o, i) => {
    if (o.source.kind !== 'soap') return;
    const source = o.source;
    const declared = new Set(source.parameters.map((p) => p.name));
    if (declared.size !== source.parameters.length) {
      issues.push({ path: `objects.${i}.source.parameters`, code: 'manifest.soap_parameter_repeated', message: 'parameter names are unique' });
    }
    for (const name of Object.keys(source.constants)) {
      if (!declared.has(name)) issues.push({ path: `objects.${i}.source.constants.${name}`, code: 'manifest.soap_parameter_undeclared', message: 'a constant is for a declared parameter' });
    }
    o.fields.forEach((f, j) => {
      if (f.value !== undefined) {
        issues.push({ path: `objects.${i}.fields.${j}.value`, code: 'manifest.soap_field_computed', message: 'a SOAP field is read by its path' });
      }
      if (!(f.path ?? f.name).split('.').every((s) => NAME.test(s))) {
        issues.push({ path: `objects.${i}.fields.${j}.path`, code: 'manifest.soap_path_invalid', message: 'a SOAP field path is a dot path of element names' });
      }
    });
    // Writes name their operations (the manifest's own check); nothing more for the engine to refuse.
  });
  return issues;
}
