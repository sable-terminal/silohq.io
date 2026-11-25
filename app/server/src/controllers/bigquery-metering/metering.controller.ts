// The metering endpoint: an operator runs the pass for one organisation now.

import type { measureBigQuery } from '../../contracts/bigquery-metering/metering.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { measureOrganisation, type MeteringDeps } from '../../services/bigquery-metering/metering.service.ts';

export function meteringController(deps: MeteringDeps): { measureBigQuery: RouteHandlers<typeof measureBigQuery> } {
  return {
    measureBigQuery: {
      handle: async (_input, ctx) => ({ measurements: await measureOrganisation(deps, ctx.request.organisationId!, ctx.correlationId) }),
    },
  };
}
