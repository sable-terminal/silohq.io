// The status service (spec 7.2, 13.2): component state per cell, and incident and
// maintenance notices, published to the public status page on static hosting apart from
// every cell. "The status page reports each cell's components separately ... and names
// no customer; the sovereign cell has its own."
//
// Cells report through their Fleet agent, which runs as fleet-control inside the cell
// and already evaluates the health gates (spec 11.2). Each report is the whole state of
// the cell's components at one moment, so a lost or repeated report changes nothing a
// later one does not correct. Incident commanders write notices through admin-portal.
//
// The global tier has no organisation context, so no operation is keyed: reports carry
// their time, and notices and their updates are named by the caller.

import { z } from 'zod';
import { RESIDENCIES } from '../../config/cell.config.ts';
import { defineContract } from '../endpoint.contract.ts';
import { cellIdSchema } from '../directory/registration.contract.ts';

/** The components a customer sees, in product terms (spec 5): not the service catalogue. */
export const STATUS_COMPONENTS = [
  'app', 'login', 'questions', 'live_clones', 'actions', 'connections', 'files', 'notifications',
] as const;

export const COMPONENT_LABELS: Readonly<Record<(typeof STATUS_COMPONENTS)[number], string>> = {
  app: 'Web app and API',
  login: 'Sign-in and single sign-on',
  questions: 'Questions and Ask',
  live_clones: 'Live clones',
  actions: 'Actions and approvals',
  connections: 'Connections, webhooks and agents',
  files: 'Files and Siloes',
  notifications: 'Notifications',
};

export const COMPONENT_STATES = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'] as const;
export const NOTICE_KINDS = ['incident', 'maintenance'] as const;
export const SEVERITIES = ['sev1', 'sev2', 'sev3'] as const;
export const INCIDENT_STATES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export const MAINTENANCE_STATES = ['scheduled', 'in_progress', 'completed'] as const;

const component = z.enum(STATUS_COMPONENTS);
const timestamp = z.iso.datetime({ offset: true });
const unique = <T>(items: readonly T[]): boolean => new Set(items).size === items.length;

// ----------------------------------------------------------------------------- the public document

export const publishedNotice = z.object({
  id: z.uuid(),
  kind: z.enum(NOTICE_KINDS),
  severity: z.enum(SEVERITIES).nullable(),
  title: z.string(),
  cellIds: z.array(z.string()),
  components: z.array(component),
  state: z.enum([...INCIDENT_STATES, ...MAINTENANCE_STATES]),
  startedAt: timestamp,
  resolvedAt: timestamp.nullable(),
  window: z.object({ startsAt: timestamp, endsAt: timestamp }).nullable(),
  updates: z.array(z.object({
    id: z.uuid(),
    state: z.enum([...INCIDENT_STATES, ...MAINTENANCE_STATES]),
    message: z.string(),
    postedAt: timestamp,
  })),
});

/** status.json on the status host: what the page renders. */
export const publicStatusDocument = z.object({
  schema: z.literal('silo.status.v1'),
  generatedAt: timestamp,
  cells: z.array(z.object({
    id: z.string(),
    residency: z.enum(RESIDENCIES),
    /** The last report, or null if none has arrived. */
    reportedAt: timestamp.nullable(),
    /** No report within STATUS_STALE_AFTER_SECONDS: every component shows unknown. */
    stale: z.boolean(),
    components: z.array(z.object({
      component,
      label: z.string(),
      state: z.enum([...COMPONENT_STATES, 'unknown']),
      since: timestamp.nullable(),
    })),
  })),
  notices: z.array(publishedNotice),
});

export type PublicStatusDocument = z.infer<typeof publicStatusDocument>;
export type PublishedNotice = z.infer<typeof publishedNotice>;

// ----------------------------------------------------------------------------- endpoints

export const reportCellStatus = defineContract({
  service: 'status', name: 'reportCellStatus', method: 'PUT', path: '/v1/cells/:cellId/report',
  callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ cellId: cellIdSchema }),
  body: z.strictObject({
    reportedAt: timestamp,
    components: z.array(z.strictObject({ component, state: z.enum(COMPONENT_STATES) }))
      .max(STATUS_COMPONENTS.length)
      .refine((items) => unique(items.map((item) => item.component)), 'each component at most once'),
  }),
  /** accepted is false for a report older than one already taken. */
  response: z.object({ accepted: z.boolean() }),
  maxBodyBytes: 4096,
});

export const putNotice = defineContract({
  service: 'status', name: 'putNotice', method: 'PUT', path: '/v1/notices/:noticeId',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ noticeId: z.uuid() }),
  body: z.strictObject({
    kind: z.enum(NOTICE_KINDS),
    severity: z.enum(SEVERITIES).optional(),
    title: z.string().trim().min(1).max(120),
    cellIds: z.array(cellIdSchema).min(1).max(20).refine(unique, 'each cell once'),
    components: z.array(component).max(STATUS_COMPONENTS.length).refine(unique, 'each component once').default([]),
    window: z.strictObject({ startsAt: timestamp, endsAt: timestamp }).optional(),
    /** The incident commander, as admin-portal authenticated them. Not published. */
    postedBy: z.uuid(),
  }).superRefine((notice, ctx) => {
    if (notice.kind === 'incident' && notice.severity === undefined) ctx.addIssue({ code: 'custom', path: ['severity'], message: 'an incident has a severity' });
    if (notice.kind === 'maintenance' && notice.severity !== undefined) ctx.addIssue({ code: 'custom', path: ['severity'], message: 'maintenance has no severity' });
    if (notice.kind === 'maintenance' && notice.window === undefined) ctx.addIssue({ code: 'custom', path: ['window'], message: 'maintenance has a window' });
    if (notice.window && Date.parse(notice.window.endsAt) <= Date.parse(notice.window.startsAt)) {
      ctx.addIssue({ code: 'custom', path: ['window'], message: 'the window ends after it starts' });
    }
  }),
  response: publishedNotice,
  maxBodyBytes: 4096,
});

export const putNoticeUpdate = defineContract({
  service: 'status', name: 'putNoticeUpdate', method: 'PUT', path: '/v1/notices/:noticeId/updates/:updateId',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ noticeId: z.uuid(), updateId: z.uuid() }),
  body: z.strictObject({
    state: z.enum([...INCIDENT_STATES, ...MAINTENANCE_STATES]),
    message: z.string().trim().min(1).max(2000),
    postedBy: z.uuid(),
  }),
  response: publishedNotice,
  maxBodyBytes: 8192,
});

/** What the page shows now, for admin-portal's preview. */
export const readStatus = defineContract({
  service: 'status', name: 'readStatus', method: 'GET', path: '/v1/status',
  // fleet-control: a shared cell's Fleet agent copies the incidents naming its cell into its customers' logs (13.5; D209).
  callers: ['admin-portal', 'fleet-control'],
  context: 'none', idempotency: 'none',
  response: publicStatusDocument,
});
