// connect-runtime's read endpoint.

import type { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { readObject as read, type RuntimeDeps } from '../../services/connect-runtime/read.service.ts';
import { AppError } from '../../utils/errors.util.ts';

export function readController(deps: RuntimeDeps): RouteHandlers<typeof readObject> {
  return {
    async handle({ body }, ctx) {
      if (body.invalidCredentials === true && (ctx.caller !== 'conformance' || body.reason !== 'probe')) {
        throw new AppError('forbidden', 'only a conformance probe sends wrong credentials', { code: 'read.invalid_credentials_refused' });
      }
      if (body.declaredPushdown === true && ctx.caller !== 'conformance') {
        throw new AppError('forbidden', 'only conformance pushes down what failed conformance', { code: 'read.declared_pushdown_refused' });
      }
      if (body.manifestId !== undefined && (ctx.caller !== 'conformance' || body.reason !== 'probe')) {
        throw new AppError('forbidden', 'only a conformance probe reads through a version not yet applied', { code: 'read.sandbox_manifest_refused' });
      }
      const out = await read(deps, { request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal }, body);
      return { rows: out.rows as never, pushdown: out.pushdown, stats: out.stats, siloId: out.siloId };
    },
  };
}
