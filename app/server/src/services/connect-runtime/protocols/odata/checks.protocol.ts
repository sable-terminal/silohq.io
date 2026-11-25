// The OData engine's checks at save (spec 14.4): what the schema cannot say.
// - An OData connector names its base URL and is reached from the cell (an agent sends
//   webhooks, not reads, in this release).
// - The filters an object declares are ones the engine writes for the property's type:
//   contains and starts_with on strings, comparisons on ordered types.
// - A composite key's parts are fields with types (a key literal is typed).

import type { EdmType, Manifest } from '../../../../contracts/connect/manifest.contract.ts';
import type { ProtocolIssue } from '../checks.protocol.ts';

const ORDERED: ReadonlySet<EdmType> = new Set(['Edm.Byte', 'Edm.SByte', 'Edm.Int16', 'Edm.Int32', 'Edm.Int64', 'Edm.Decimal', 'Edm.Double', 'Edm.Single', 'Edm.Date', 'Edm.DateTime', 'Edm.DateTimeOffset', 'Edm.String']);

export function odataChecks(manifest: Manifest): ProtocolIssue[] {
  const issues: ProtocolIssue[] = [];
  if (manifest.transport.baseUrl === undefined) issues.push({ path: 'transport.baseUrl', code: 'odata.base_url_missing', message: 'an OData connector names its base URL' });
  if (manifest.transport.viaAgent) issues.push({ path: 'transport.viaAgent', code: 'odata.agent_unsupported', message: 'OData is read from the cell in this release' });
  manifest.objects.forEach((o, i) => {
    if (o.source.kind !== 'odata') return;
    const source = o.source;
    const typeOf = (field: string): EdmType => {
      const f = o.fields.find((x) => x.name === field);
      return source.types[f?.path ?? field] ?? 'Edm.String';
    };
    o.pushdown.filters.forEach((f, j) => {
      const type = typeOf(f.field);
      for (const op of f.ops) {
        const text = op === 'contains' || op === 'starts_with';
        if ((text && type !== 'Edm.String') || ((op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte') && !ORDERED.has(type))) {
          issues.push({ path: `objects.${i}.pushdown.filters.${j}`, code: 'odata.filter_type', message: `${op} does not apply to ${f.field} (${type})` });
        }
      }
    });
    if (o.writes?.upsert !== undefined && manifest.protocol.kind === 'odata' && manifest.protocol.version === '2.0') {
      issues.push({ path: `objects.${i}.writes.upsert`, code: 'odata.upsert_unsupported', message: 'OData 2.0 has no upsert' });
    }
  });
  return issues;
}
