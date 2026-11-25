// The organisation calendar's endpoints (spec 26.6).

import type { getOrganisationCalendar, setOrganisationCalendar } from '../../contracts/compile/calendar.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { getCalendar, setCalendar } from '../../services/compile/calendar.service.ts';
import type { CompileDeps } from '../../services/compile/compile.service.ts';

export function calendarController(deps: Pick<CompileDeps, 'databases' | 'services'>) {
  return {
    get: { handle: (_input, ctx) => getCalendar(deps, ctx) } satisfies RouteHandlers<typeof getOrganisationCalendar>,
    set: { handle: ({ body }, ctx) => setCalendar(deps, ctx, body) } satisfies RouteHandlers<typeof setOrganisationCalendar>,
  };
}
