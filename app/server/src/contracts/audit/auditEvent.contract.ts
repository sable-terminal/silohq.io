// Product, governance, platform and operator audit events (spec 8.1, 63.1, 63.3; design:
// audit.audit_events), as they cross from the producing service to the audit ledger:
// written to platform.outbox in the transaction that made the change, published on
// bus-durable topic audit.events by the outbox relay, and chained into audit.audit_events
// by the audit service. References and counts only, never a value.
//
// The event catalogue (spec chapter 77) lists every event a service may raise and its
// retention class: standard (seven years) or high_volume (400 days: query events,
// host_probed and any event marked high volume). The audit service refuses an event
// that is not listed, so a service adds its events here when it starts raising them.

import { z } from 'zod';
import { SERVICES } from '../../config/service.config.ts';
import { ACTION_EVENTS } from '../actions/events.contract.ts';
import { BILLING_EVENTS } from '../billing/billingEvent.contract.ts';
import { CONNECT_EVENTS } from '../connect/connectEvent.contract.ts';
import { COMPILE_EVENTS, QUERY_EVENTS } from '../executor/events.contract.ts';
import { CHANGE_STREAM_EVENTS, STATE_PLANE_EVENTS, STATE_PLANE_HIGH_VOLUME_EVENTS } from '../change-stream/events.contract.ts';
import { POLICY_EVENTS, POLICY_HIGH_VOLUME_EVENTS } from '../policy/events.contract.ts';
import { COPIED_FLEET_EVENTS } from './fleetEvents.contract.ts';
import { ONTOLOGY_EVENTS } from '../ontology/events.contract.ts';
import { RESOLUTION_EVENTS } from '../resolution/events.contract.ts';
import { LINEAGE_EVENTS, LINEAGE_HIGH_VOLUME_EVENTS } from '../lineage/events.contract.ts';
import { SEARCH_HIGH_VOLUME_EVENTS } from '../search/events.contract.ts';
import { ASK_EVENTS } from '../ask/events.contract.ts';
import { WORKSPACE_EVENTS, WORKSPACE_HIGH_VOLUME_EVENTS } from '../workspace/events.contract.ts';
import { AUTOMATION_EVENTS } from '../scheduler/events.contract.ts';
import { FILE_EVENTS } from '../files/events.contract.ts';
import { CLONE_EVENTS, CLONE_HIGH_VOLUME_EVENTS } from '../canvas-layout/events.contract.ts';
import { STUDIO_EVENTS, STUDIO_HIGH_VOLUME_EVENTS } from '../studio/events.contract.ts';
import { RECOGNITION_EVENTS } from '../recognition/events.contract.ts';
import { SIMULATION_EVENTS } from '../simulation/events.contract.ts';
import { SEAT_EVENTS } from '../auth/seats.contract.ts';
import { INDEX_EVENTS } from '../index-builder/index.contract.ts';
import { SILO_EVENTS } from '../siloes/events.contract.ts';
import { WAREHOUSE_EVENTS } from '../warehouse/warehouse.contract.ts';
import { MAINTENANCE_EVENTS } from '../connector-maintenance/events.contract.ts';
import { DISCOVERY_EVENTS } from '../discovery/events.contract.ts';
import { FDE_EVENTS } from '../fde-orchestrator/events.contract.ts';

export type RetentionClass = 'standard' | 'high_volume';

const standard = (...names: string[]): [string, RetentionClass][] => names.map((name) => [name, 'standard']);
const highVolume = (...names: string[]): [string, RetentionClass][] => names.map((name) => [name, 'high_volume']);

/** Every product audit event and its retention class. */
export const AUDIT_EVENT_CATALOGUE: ReadonlyMap<string, RetentionClass> = new Map([
  // Tenancy (spec 6.7)
  ...standard('tenant_placed', 'tenant_migration_requested', 'tenant_migration_approved', 'tenant_migration_started',
    'tenant_migration_completed', 'tenant_migration_aborted', 'tenant_source_purged', 'directory_entry_changed'),
  // Support tickets (U4, D254): raised, replied to by the member or by Silo staff, and its state changed.
  ...standard('support_ticket_raised', 'support_ticket_replied', 'support_ticket_updated'),
  // Operator access (spec 13.5, 63.6)
  ...standard('operator_access_requested', 'operator_access_approved', 'operator_access_denied', 'operator_access_started',
    'operator_access_resource_touched', 'operator_access_ended', 'operator_access_expired', 'operator_access_emergency',
    // 63.6's lifecycle: the session's first use (D207); each resource touched is 13.5's event.
    'operator_access_used',
    // Not in chapter 77: the customer changing whether every session needs their approval (org.operator_access.policy).
    'operator_access_policy_changed'),
  // Key rotation (spec 61.9): cell-wide, written to every organisation's log, since each one's secrets are re-wrapped.
  ...standard('key_rotation_started', 'key_rotation_completed', 'key_version_retired'),
  // Fleet's events about a single-tenant cell (spec 11.6), copied into its customers' logs by its Fleet agent (D199).
  ...standard(...COPIED_FLEET_EVENTS),
  // Platform integrity (spec 13.5)
  ...standard('redaction_violation_detected', 'incident_declared', 'incident_resolved', 'audit_chain_head_published'),
  // Organisation export (spec 2.6)
  ...standard('org_export_requested', 'org_export_completed'),
  // Model calls (spec 62.8)
  ...standard('model_call_refused', 'extraction_carveout_used'),
  // A web search left the cell (62.8): which provider was asked and what came back, by count; the query is on Ask's ask_web_context_added.
  ...highVolume('web_search_sent'),
  ...highVolume('model_call_made'),
  // Queries and discovery (spec 63.4: the high-volume class)
  ...highVolume('query_executed', 'host_probed'),
  // Connector maintenance: heal proposals (spec 17.5)
  ...standard(...MAINTENANCE_EVENTS),
  // Agent discovery (spec 19.7); host_probed is high volume, above
  ...standard(...DISCOVERY_EVENTS),
  // Compile and the engine (spec 26.14, 27.12): query events
  ...highVolume(...QUERY_EVENTS),
  ...standard(...COMPILE_EVENTS),
  // Connect (spec 14.10, 15.6, 61.9)
  ...standard(...CONNECT_EVENTS),
  // Administration, authorisation and governance (spec 55.8, 56.12, 57.11, 58.11, 60.8)
  ...standard(...POLICY_EVENTS),
  ...highVolume(...POLICY_HIGH_VOLUME_EVENTS),
  // Ontology (spec 21.17, 22.9, 24.4, 25.10)
  ...standard(...ONTOLOGY_EVENTS),
  // Entity resolution and field authority (spec 23, 24.8)
  ...standard(...RESOLUTION_EVENTS),
  // Lineage and marking propagation (spec 59.7, 58.11, 34.6)
  ...standard(...LINEAGE_EVENTS),
  ...highVolume(...LINEAGE_HIGH_VOLUME_EVENTS),
  // Search (spec 34.6)
  ...highVolume(...SEARCH_HIGH_VOLUME_EVENTS),
  // Tokens, simulations, billing and payouts (spec 72.7, 73.9, 74.8, 75.5)
  ...standard(...BILLING_EVENTS),
  // Write-back: Action types, mutations, approval, execution, receipts and revert (spec 42 to 46)
  ...standard(...ACTION_EVENTS),
  // Change streams and live state (spec 18.10, 24.9)
  ...standard(...CHANGE_STREAM_EVENTS),
  ...standard(...STATE_PLANE_EVENTS),
  ...highVolume(...STATE_PLANE_HIGH_VOLUME_EVENTS),
  // Workspace, saved views and sharing (spec 33.11, 37.12); Ask (spec 36.13)
  ...standard(...WORKSPACE_EVENTS),
  ...highVolume(...WORKSPACE_HIGH_VOLUME_EVENTS),
  // Crons and Files (spec 40.11, 41.8)
  ...standard(...AUTOMATION_EVENTS),
  ...standard(...FILE_EVENTS),
  ...standard(...ASK_EVENTS),
  // Recognition (spec 38.13) and simulation (spec 39.12)
  ...standard(...RECOGNITION_EVENTS),
  ...standard(...SIMULATION_EVENTS),
  // The Warehouse (spec 69.22)
  ...standard(...WAREHOUSE_EVENTS),
  // Siloes (spec 66 to 70) and the Object Index (69.10)
  ...standard(...SILO_EVENTS),
  ...standard(...INDEX_EVENTS),
  // Seats (spec 72.7)
  ...standard(...SEAT_EVENTS),
  // Clone Canvas, layouts, state rules, the Estate map and the render record (spec 31.9, 32.7)
  ...standard(...CLONE_EVENTS),
  ...highVolume(...CLONE_HIGH_VOLUME_EVENTS),
  // Studio (spec 35.13)
  ...standard(...STUDIO_EVENTS),
  ...highVolume(...STUDIO_HIGH_VOLUME_EVENTS),
  // The AI FDE's engagement log (spec 52.8)
  ...standard(...FDE_EVENTS),
]);

const snake = z.string().regex(/^[a-z][a-z0-9_]*$/).max(63);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** Who acted: exactly one actor arm of audit.audit_events. */
export const auditActor = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('membership'), membershipId: z.uuid() }),
  z.strictObject({ kind: z.literal('service_principal'), servicePrincipalId: z.uuid() }),
  /** Silo staff under break-glass (spec 13.3): the session is required. */
  z.strictObject({ kind: z.literal('operator'), operatorId: z.uuid(), operatorAccessSessionId: z.uuid() }),
  /** A service acting on its own: expiry sweeps, schedulers, retention. */
  z.strictObject({ kind: z.literal('service'), service: z.enum(SERVICES) }),
]);
export type AuditActor = z.infer<typeof auditActor>;

export const auditEventMessage = {
  topic: 'audit.events',
  name: 'audit_event',
  version: 1,
  schema: z.strictObject({
    event: snake.refine((name) => AUDIT_EVENT_CATALOGUE.has(name), 'must be an event of the audit catalogue'),
    actor: auditActor,
    /** The membership acted upon, where the event has one. */
    subjectMembershipId: z.uuid().nullable(),
    /** The scope the event concerns: scope admins read their subtree (spec 63.5). */
    scopeId: z.uuid().nullable(),
    resource: z.strictObject({ type: snake, id: z.uuid() }).nullable(),
    purposeSessionId: z.uuid().nullable(),
    /** A request made under break-glass carries its session, whoever the actor. */
    operatorAccessSessionId: z.uuid().nullable(),
    /** Keyed hash of the client address, hex. */
    ipHash: hex64.nullable(),
    /** References and counts only: identifiers, closed-set names, numbers, flags. */
    detail: z.record(snake, z.union([z.string().max(200), z.number(), z.boolean(), z.null(), z.array(z.uuid()).max(100)])),
  }),
} as const;

export type AuditEventPayload = z.infer<typeof auditEventMessage.schema>;
