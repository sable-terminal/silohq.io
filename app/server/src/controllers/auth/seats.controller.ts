// The seats endpoints: thin, over services/auth/seats.

import type { allocateSeatPool, assignSeat, listSeats, releaseSeat, unassignSeat } from '../../contracts/auth/seats.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { AuthDeps } from '../../services/auth/deps.service.ts';
import * as seats from '../../services/auth/seats.service.ts';

export function seatsController(deps: AuthDeps): {
  listSeats: RouteHandlers<typeof listSeats>;
  assignSeat: RouteHandlers<typeof assignSeat>;
  unassignSeat: RouteHandlers<typeof unassignSeat>;
  releaseSeat: RouteHandlers<typeof releaseSeat>;
  allocateSeatPool: RouteHandlers<typeof allocateSeatPool>;
} {
  return {
    listSeats: { handle: (_input, ctx) => seats.listSeats(deps, ctx) },
    assignSeat: { handle: (input, ctx) => seats.assignSeat(deps, ctx, input.body) },
    unassignSeat: { handle: (input, ctx) => seats.unassignSeat(deps, ctx, input.params.seatId) },
    releaseSeat: { handle: (input, ctx) => seats.releaseSeat(deps, ctx, input.params.seatId) },
    allocateSeatPool: { handle: (input, ctx) => seats.allocatePool(deps, ctx, input.body) },
  };
}
