// The organisation export's endpoints: thin, over services/org-export. The organisation and
// the requester come from the request context.

import type { downloadOrgExport, getOrgExport, listOrgExports, requestOrgExport } from '../../contracts/org-export/export.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Exports } from '../../services/org-export/exports.service.ts';

export function exportController(exports: Exports): {
  request: RouteHandlers<typeof requestOrgExport>;
  list: RouteHandlers<typeof listOrgExports>;
  get: RouteHandlers<typeof getOrgExport>;
  download: RouteHandlers<typeof downloadOrgExport>;
} {
  return {
    request: { handle: (_input, ctx) => exports.request(ctx) },
    list: { handle: (_input, ctx) => exports.list(ctx) },
    get: { handle: (input, ctx) => exports.get(ctx, input.params.exportId) },
    download: { handle: (input, ctx) => exports.download(ctx, input.params.exportId, input.query) },
  };
}
