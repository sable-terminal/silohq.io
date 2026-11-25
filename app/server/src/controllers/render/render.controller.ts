// Thin handlers: the contract to its function in services/render.

import type { renderExport } from '../../contracts/render/render.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { render, rendered, type RenderDeps } from '../../services/render/render.service.ts';

export function renderController(deps: RenderDeps): { renderExport: RouteHandlers<typeof renderExport> } {
  return {
    renderExport: {
      handle: ({ body }, ctx) => render(deps, ctx, body),
      // A refusal stored nothing: a retry renders again.
      resultRef: (out) => (out.outcome === 'exported' ? `${out.file.id}.${out.rows}` : ''),
      replay: (ref, ctx) => rendered(deps, ctx, ref),
    },
  };
}
