// The pushdown compiler's endpoint.

import type { explainPushdown } from '../../contracts/pushdown-compiler/pushdown.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { explainPushdown as explain, type ExplainDeps } from '../../services/pushdown-compiler/explain.service.ts';

export function pushdownController(deps: ExplainDeps): RouteHandlers<typeof explainPushdown> {
  return { handle: ({ body }, ctx) => explain(deps, ctx, body) };
}
