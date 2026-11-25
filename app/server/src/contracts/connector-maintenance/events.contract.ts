// connector-maintenance's audit events (spec 17.5), as audit_event messages on the outbox.
// connection_halted is Connect's own event (contracts/connect/connectEvent.contract.ts).

export const MAINTENANCE_EVENTS = ['heal_proposed', 'heal_applied', 'heal_halted', 'heal_rejected'] as const;
export type MaintenanceEvent = (typeof MAINTENANCE_EVENTS)[number];
