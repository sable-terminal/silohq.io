// Fleet's events about a single-tenant cell, in its customers' audit logs (spec 11.6: "Events
// affecting a single-tenant install are also written to its audit log"; D199). The cell's Fleet
// agent reads them from fleet-control (listCellEvents) and hands them to audit here, which writes
// each into every customer organisation's log, once by its sequence in Fleet's log whatever the
// agent retries. A freeze is already the customer's own event, raised in their cell; the release's
// build and signature are not about the cell. References only: a release, a rollout, a channel.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { fleetEventView } from '../fleet-control/events.contract.ts';

/** What a single-tenant cell's customers see of Fleet's work in their cell. */
export const COPIED_FLEET_EVENTS = [
  'release_promoted', 'release_expedited', 'rollout_started', 'rollout_gate_failed', 'rollout_rolled_back', 'rollout_completed', 'migration_applied',
  // An air-gapped install's bundles, loaded or refused (spec 11.4: "Results go to the local audit log"; D201).
  'bundle_verified', 'bundle_refused',
  // The single-tenant cell itself (spec 6.7; D207): its creation and its placement closing.
  'cell_created', 'cell_placement_closed',
] as const;

export const recordFleetEvents = defineContract({
  service: 'audit', name: 'recordFleetEvents', method: 'POST', path: '/v1/fleet-events', callers: ['fleet-control'],
  // Each event is copied once by its sequence: sending it again copies nothing.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ events: z.array(fleetEventView).max(100) }),
  response: z.object({ copied: z.int().min(0), skipped: z.int().min(0) }),
  maxBodyBytes: 256 * 1024,
});

/**
 * Status page incidents naming this shared cell (spec 13.2, 13.5; D209): the cell's Fleet agent
 * reads them from the status service and hands them here; each declaration and resolution goes
 * into every customer organisation's audit log once. The title and updates stay on the status
 * page; the log carries the notice, its severity and the components.
 */
export const INCIDENT_EVENTS = ['incident_declared', 'incident_resolved'] as const;
export const recordIncidentEvents = defineContract({
  service: 'audit', name: 'recordIncidentEvents', method: 'POST', path: '/v1/incident-events', callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    events: z.array(z.strictObject({
      noticeId: z.uuid(), event: z.enum(INCIDENT_EVENTS), occurredAt: z.string(), severity: z.string().regex(/^[a-z0-9_]{1,20}$/).nullable(),
      components: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/)).max(20),
    })).max(100),
  }),
  response: z.object({ copied: z.int().min(0), skipped: z.int().min(0) }),
});

/**
 * Log lines a value pattern was redacted from, by the organisation each named (spec 13.1, 13.5;
 * D209): the cell's Fleet agent hands audit what each process counted since it last looked;
 * each becomes redaction_violation_detected in that organisation's log. The on-call page is
 * the metric's; this is the customer's record that it happened.
 */
export const recordRedactionViolations = defineContract({
  service: 'audit', name: 'recordRedactionViolations', method: 'POST', path: '/v1/redaction-violations', callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    violations: z.array(z.strictObject({
      organisationId: z.uuid(), services: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/)).min(1).max(70), lines: z.int().min(1),
      kinds: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(10),
    })).max(100),
  }),
  response: z.object({ recorded: z.int().min(0) }),
});
