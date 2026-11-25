// Seats in the product (spec 72): who holds which seat, assigning and unassigning, releasing,
// and the pools scopes hold. Auth decides where each seat may come from (a scope's pool for
// an admin of that scope, the organisation's for a holder organisation-wide); the gateway's
// permission is the first gate.

import * as s from '../auth/seats.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

export const listSeats = definePublicRoute({
    name: 'listSeats', method: 'GET', path: '/seats', session: 'complete',
    decidedByService: 'auth shows seats to a holder of seat.allocate or billing.view, at any scope',
    response: s.listSeats.response, forwards: s.listSeats, call: () => ({}), reply: (o) => o,
  });

export const assignSeat = definePublicRoute({
    name: 'assignSeat', method: 'POST', path: '/seats/assignments', session: 'complete', permission: {
      permission: 'seat.allocate', scopeId: (input) => input.body.scopeId,
    },
    body: s.assignSeat.body, response: s.assignSeat.response, status: 201, forwards: s.assignSeat, call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const unassignSeat = definePublicRoute({
    name: 'unassignSeat', method: 'POST', path: '/seats/:seatId/unassign', session: 'complete',
    decidedByService: 'auth allows seat.allocate where the seat\'s pool is, or organisation-wide for the organisation\'s seats',
    params: s.unassignSeat.params, response: s.unassignSeat.response, forwards: s.unassignSeat, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const releaseSeat = definePublicRoute({
    name: 'releaseSeat', method: 'POST', path: '/seats/:seatId/release', session: 'complete', permission: { permission: 'seat.release' },
    params: s.releaseSeat.params, response: s.releaseSeat.response, forwards: s.releaseSeat, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const allocateSeatPool = definePublicRoute({
    name: 'allocateSeatPool', method: 'POST', path: '/seats/pools', session: 'complete',
    decidedByService: 'auth allows seat.allocate at the scope\'s parent, whose pool the seats come from',
    body: s.allocateSeatPool.body, response: s.allocateSeatPool.response, forwards: s.allocateSeatPool, call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const SEAT_ROUTES = [
  listSeats,
  assignSeat,
  unassignSeat,
  releaseSeat,
  allocateSeatPool,
] as const;
