// render (the catalogue: server-side export rendering): a compiled plan's answer, for the
// caller now, as a document placed in Files. CSV is built; formats that need a library and
// a sandboxed renderer are not.

import { renderExport } from '../../contracts/render/render.contract.ts';
import { renderController } from '../../controllers/render/render.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';

export const service = defineService({
  name: 'render',
  // redis-data: idempotency keys (a render retried makes one file).
  needs: { redis: ['data'] },
  create(deps) {
    const c = renderController({ services: deps.services });
    return { routes: [route(renderExport, c.renderExport)] };
  },
});
