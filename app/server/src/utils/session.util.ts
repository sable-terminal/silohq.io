// Session lifetimes (spec 60; decisions 2026-10-29). Opaque server-side sessions expire at
// whichever comes first: idleMinutes after the last activity, or absoluteMinutes after
// issue. The cell sets both; an organisation may shorten either, never lengthen it.
//
// Only what a person does counts as activity. Live WebSocket deltas and heartbeats are
// the server talking, so an open Clone Canvas cannot keep a session alive forever.

export interface SessionTimeouts {
  idleMinutes: number;
  absoluteMinutes: number;
}

// The organisation's columns on iam.organisations; null uses the cell's value.
export interface OrganisationSessionPolicy {
  sessionIdleMinutes: number | null;
  sessionAbsoluteMinutes: number | null;
}

export function effectiveSessionTimeouts(cell: SessionTimeouts, organisation?: OrganisationSessionPolicy): SessionTimeouts {
  const shorter = (cellValue: number, orgValue: number | null | undefined): number =>
    orgValue === null || orgValue === undefined ? cellValue : Math.min(cellValue, orgValue);
  return {
    idleMinutes: shorter(cell.idleMinutes, organisation?.sessionIdleMinutes),
    absoluteMinutes: shorter(cell.absoluteMinutes, organisation?.sessionAbsoluteMinutes),
  };
}

export const SESSION_ACTIVITY = {
  /** A request the person's client made. */
  http_request: true,
  /** A message the person's client sent on its WebSocket: subscribe, unsubscribe, an action. */
  websocket_client_message: true,
  /** A live delta pushed to the client. Not the person's doing. */
  websocket_delta: false,
  /** Keep-alive traffic in either direction. */
  websocket_heartbeat: false,
} as const;

export type SessionEvent = keyof typeof SESSION_ACTIVITY;

export function countsAsActivity(event: SessionEvent): boolean {
  return SESSION_ACTIVITY[event];
}

// When the session ends if nothing more happens: the earlier of idle and absolute expiry.
export function sessionExpiresAt(issuedAt: string, lastActivityAt: string, timeouts: SessionTimeouts): string {
  const absolute = Date.parse(issuedAt) + timeouts.absoluteMinutes * 60_000;
  const idle = Date.parse(lastActivityAt) + timeouts.idleMinutes * 60_000;
  return new Date(Math.min(absolute, idle)).toISOString();
}
