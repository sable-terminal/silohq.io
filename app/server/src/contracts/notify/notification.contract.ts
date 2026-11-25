// In-product notification items (spec 7.5; design: workspace.notifications). An item holds
// references only: what it is about (a Cron run action, an approval chain, a finding or a
// simulation run) and its delivery and read state. Its text is rendered on read from the
// source row, never stored.
//
// Raising is for the services that own the sources. One item per recipient, kind, channel
// and source: raising it again returns the first. Only the in-product channel is built;
// email and push follow (see the service).

import { z } from 'zod';
import { notificationSchema } from '../../schemas/workspace/notification.schema.ts';
import { defineContract } from '../endpoint.contract.ts';

export const NOTIFICATION_KINDS = [
  'cron_notify', 'cron_escalate', 'approval_waiting', 'finding_new', 'scenario_run_complete',
  // Break-glass (spec 13.3, 63.6): a session waits for the customer's approval; an emergency session was approved without it.
  'operator_access_waiting', 'operator_access_emergency',
  // An Action's notification side effect (spec 42.6): it ran, and its receipt says how.
  'action_completed',
  // An outbound Action event subscription stopped after its deliveries kept failing (spec 48.3); raised by notify itself.
  'action_event_dead_lettered',
  // A custom object view layout an ontology change invalidated (spec 34.6); its author is told, by studio.
  'object_view_layout_invalidated',
  // An ontology element a dependant uses is deprecated, or retires in seven days (spec 25.7); raised by ontology.
  'element_deprecated', 'element_retiring',
  // A scheduled pipeline run failed (D241); its owner is told, by workspace.
  'pipeline_run_failed',
  // Silo support replied on a ticket (U4, D254); its raiser is told, by admin-portal.
  'support_replied',
] as const;

export const notificationView = notificationSchema;
export type NotificationView = z.infer<typeof notificationView>;

/** Exactly one source, and the one the kind requires. */
const source = z.union([
  z.strictObject({ automationRunActionId: z.uuid() }),
  z.strictObject({ approvalChainId: z.uuid() }),
  z.strictObject({ findingId: z.uuid() }),
  z.strictObject({ simulationRunId: z.uuid() }),
  z.strictObject({ operatorAccessSessionId: z.uuid() }),
  z.strictObject({ receiptId: z.uuid() }),
  z.strictObject({ actionEventSubscriptionId: z.uuid() }),
  z.strictObject({ objectViewLayoutId: z.uuid() }),
  z.strictObject({ ontologyElementId: z.uuid() }),
  z.strictObject({ pipelineRunId: z.uuid() }),
  // The reply is the source (each reply told once); its ticket rides beside it for the link.
  z.strictObject({ supportTicketMessageId: z.uuid(), supportTicketId: z.uuid() }),
]);

export const raiseNotification = defineContract({
  service: 'notify', name: 'raiseNotification', method: 'POST', path: '/v1/notifications',
  callers: ['scheduler', 'approvals', 'recognition', 'simulation', 'actions', 'admin-portal', 'studio', 'ontology', 'workspace'],
  // One item per recipient, kind, channel and source (unique in the table): a repeat returns it.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    recipientMembershipId: z.uuid(),
    kind: z.enum(NOTIFICATION_KINDS),
    source,
    /** Escalations only: when the recipient must acknowledge by. */
    acknowledgeDueAt: z.iso.datetime({ offset: true }).optional(),
    /**
     * Where it goes: the product (Home), by email to the member's address, and by mobile push to
     * their devices (a count and a link only), one item each. Default the product.
     */
    channels: z.array(z.enum(['in_app', 'email', 'mobile_push'])).min(1).max(3).optional(),
  }),
  response: z.object({ notification: notificationView, created: z.boolean() }),
  status: 201,
  maxBodyBytes: 2048,
});

const cursor = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);

export const listNotifications = defineContract({
  service: 'notify', name: 'listNotifications', method: 'GET', path: '/v1/notifications', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    unread: z.stringbool().optional(),
    cursor: cursor.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({ notifications: z.array(notificationView), nextCursor: cursor.nullable() }),
});

const byId = z.strictObject({ notificationId: z.uuid() });

/** One of the member's own items: the page an emailed or pushed link opens reads it, then goes where it is dealt with. */
export const readNotification = defineContract({
  service: 'notify', name: 'readNotification', method: 'GET', path: '/v1/notifications/:notificationId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: byId,
  response: z.object({ notification: notificationView }),
});

export const markNotificationRead = defineContract({
  service: 'notify', name: 'markNotificationRead', method: 'POST', path: '/v1/notifications/:notificationId/read', callers: ['gateway'],
  // Sets read_at once; a repeat leaves the first time.
  context: 'organisation', idempotency: 'none',
  params: byId,
  response: z.object({ notification: notificationView }),
});

export const acknowledgeNotification = defineContract({
  service: 'notify', name: 'acknowledgeNotification', method: 'POST', path: '/v1/notifications/:notificationId/acknowledgement',
  callers: ['gateway'],
  // Sets acknowledged_at (and read_at) once; a repeat leaves the first times.
  context: 'organisation', idempotency: 'none',
  params: byId,
  response: z.object({ notification: notificationView }),
});

// ----------------------------------------------------------------------------- push devices (decision 2026-11-14)

export const pushDeviceView = z.object({
  id: z.uuid(), platform: z.enum(['fcm', 'apns']), registeredAt: z.string(), lastSentAt: z.string().nullable(),
});

/** The member registers their device's push token: their own record. */
export const registerPushDevice = defineContract({
  service: 'notify', name: 'registerPushDevice', method: 'POST', path: '/v1/push-devices', callers: ['gateway'],
  // Registering a live token again returns its device.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ platform: z.enum(['fcm', 'apns']), token: z.string().min(16).max(4096) }),
  response: pushDeviceView, status: 201, maxBodyBytes: 8192,
});

export const listPushDevices = defineContract({
  service: 'notify', name: 'listPushDevices', method: 'GET', path: '/v1/push-devices', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ devices: z.array(pushDeviceView) }),
});

export const removePushDevice = defineContract({
  service: 'notify', name: 'removePushDevice', method: 'DELETE', path: '/v1/push-devices/:deviceId', callers: ['gateway'],
  // Removing a removed device changes nothing.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ deviceId: z.uuid() }),
  response: z.undefined(),
});
