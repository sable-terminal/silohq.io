// The lineage service's endpoints: contracts to the read service. Writing lineage is not an
// endpoint (services/lineage/writer.service.ts).

import type {
  accessOverlay, explainMarkings, getLineage, queryDownstream, queryUpstream,
} from '../../contracts/lineage/lineage.contract.ts';
import type { exportLineage } from '../../contracts/lineage/export.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { exported, exportGraph, exportRef } from '../../services/lineage/export.service.ts';
import * as read from '../../services/lineage/read.service.ts';

export function lineageController(deps: read.LineageDeps): {
  getLineage: RouteHandlers<typeof getLineage>;
  queryUpstream: RouteHandlers<typeof queryUpstream>;
  queryDownstream: RouteHandlers<typeof queryDownstream>;
  explainMarkings: RouteHandlers<typeof explainMarkings>;
  accessOverlay: RouteHandlers<typeof accessOverlay>;
  exportLineage: RouteHandlers<typeof exportLineage>;
} {
  return {
    getLineage: { handle: (input, ctx) => read.lineageOf(deps, ctx, input.query) },
    queryUpstream: { handle: (input, ctx) => read.review(deps, ctx, input.query, 'upstream') },
    queryDownstream: { handle: (input, ctx) => read.review(deps, ctx, input.query, 'downstream') },
    explainMarkings: { handle: (input, ctx) => read.explain(deps, ctx, input.query) },
    accessOverlay: { handle: (input, ctx) => read.accessOverlay(deps, ctx, input.query) },
    exportLineage: {
      handle: (input, ctx) => exportGraph(deps, ctx, input.body),
      resultRef: exportRef,
      replay: (ref, ctx) => exported(deps, ctx, ref),
    },
  };
}
