// Fleet's own events (spec 11.6), kept by fleet-control in fleet.events: appended in the
// transaction that made the change, hash-chained, never changed (services/fleet-control/
// events.service.ts).
//
// listFleetEvents: staff read them, newest last, from a sequence, for a release or a cell.
// verifyFleetEvents: the whole chain checked; where it breaks, if it does.
// listCellEvents: a dedicated cell's Fleet agent reads the events about its cell (its own
//   rollouts, migrations applied in it, its customer's freezes), to write into the customer's
//   audit log ("Events affecting a single-tenant install are also written to its audit log").
// reportMigrationApplied: the agent says a migration of the release it runs has been applied
//   in its cell (spec 11.3), recorded once as migration_applied.

import { z } from 'zod';
import { cellIdSchema } from '../directory/registration.contract.ts';
import { defineContract } from '../endpoint.contract.ts';
import { digest, releaseIdSchema, timestamp } from './release.contract.ts';

export const FLEET_EVENTS = [
  'release_built', 'release_signed', 'release_promoted', 'release_expedited', 'rollout_started', 'rollout_gate_failed',
  'rollout_rolled_back', 'rollout_completed', 'migration_applied', 'bundle_verified', 'bundle_refused',
  'sovereign_release_countersigned', 'change_freeze_set',
  // Spec 6.3 (D203): every open shared cell of a residency at 75% of a limit; a cell's tenants grown past 110% of one.
  'cell_provisioning_needed', 'cell_rebalancing_needed',
  // Spec 6.7 (D207): a cell first seen in service; a cell whose placement closed (its status, or a limit reached).
  'cell_created', 'cell_placement_closed',
  // Spec 22.7 (D210): a concept template reviewed by a second person, or withdrawn.
  'template_reviewed', 'template_withdrawn',
] as const;
export type FleetEventName = (typeof FLEET_EVENTS)[number];

const sequence = z.string().regex(/^[0-9]{1,15}$/, 'a sequence number');

export const fleetEventView = z.object({
  seq: z.int().min(1),
  event: z.enum(FLEET_EVENTS),
  occurredAt: timestamp,
  releaseId: z.string().nullable(),
  rolloutId: z.uuid().nullable(),
  cellId: z.string().nullable(),
  channel: z.string().nullable(),
  operatorId: z.uuid().nullable(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  /** This event's hash, hex: SHA-256 over the one before and this one's content. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

const page = z.object({ events: z.array(fleetEventView), next: z.int().min(1).nullable() });

export const listFleetEvents = defineContract({
  service: 'fleet-control', name: 'listFleetEvents', method: 'GET', path: '/v1/events', callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  query: z.strictObject({
    after: sequence.optional(), releaseId: releaseIdSchema.optional(), cellId: cellIdSchema.optional(),
    limit: z.string().regex(/^[0-9]{1,4}$/).optional(),
  }),
  response: page,
});

export const verifyFleetEvents = defineContract({
  service: 'fleet-control', name: 'verifyFleetEvents', method: 'GET', path: '/v1/events/verification', callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  response: z.object({ events: z.int().min(0), intact: z.boolean(), brokenAt: z.int().min(1).nullable(), headHash: z.string().nullable() }),
});

export const listCellEvents = defineContract({
  service: 'fleet-control', name: 'listCellEvents', method: 'GET', path: '/v1/cells/:cellId/events', callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ cellId: cellIdSchema }),
  query: z.strictObject({ after: sequence.optional() }),
  response: page,
});

export const reportMigrationApplied = defineContract({
  service: 'fleet-control', name: 'reportMigrationApplied', method: 'PUT',
  path: '/v1/cells/:cellId/releases/:releaseId/migrations/:database/:version', callers: ['fleet-control'],
  // Recorded once per cell, release and migration; reporting it again changes nothing.
  context: 'none', idempotency: 'none',
  params: z.strictObject({
    cellId: cellIdSchema, releaseId: releaseIdSchema, database: z.enum(['cell', 'directory']), version: z.string().regex(/^[0-9]{4}$/),
  }),
  body: z.strictObject({ name: z.string().regex(/^[A-Z][A-Za-z0-9]{0,99}$/), digest, appliedAt: timestamp }),
  response: z.object({ recorded: z.boolean() }),
  maxBodyBytes: 1024,
});
