// Process analyses (D234; beyond the spec: the process mining of the Foundry-comparison features).
// A saved analysis reconstructs how cases actually moved through activities, from either source:
// events (an object set whose objects are events: a case, an activity and a time property), or a
// state property's captured changes (Capture's history: a case is an object, an activity a value it
// moved into). It is read for whoever opens it, as them: the process map (activities and the steps
// between them, how often and how long), the variants, case durations, rework and, against a
// reference model the owner writes, conformance. Nothing read is stored. Shared like a workbook;
// exported into Files as a PDF.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { fileView } from '../files/file.contract.ts';
import { shareGrantee } from './sharing.contract.ts';

const CALLERS = ['gateway'] as const;
const activity = z.string().min(1).max(200);

export const processSource = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('events'), objectSetId: z.uuid(), caseProperty: z.uuid(), activityProperty: z.uuid(), timeProperty: z.uuid(),
    limit: z.int().min(1).max(50_000).default(10_000),
  }),
  z.strictObject({
    kind: z.literal('changes'), objectTypeId: z.uuid(), propertyId: z.uuid(),
    from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(), limit: z.int().min(1).max(10_000).default(10_000),
  }),
]);
export type ProcessSource = z.infer<typeof processSource>;

/** The process as it should run: the steps allowed, where a case may start and where it may end. */
export const referenceModel = z.strictObject({
  transitions: z.array(z.tuple([activity, activity])).max(500), starts: z.array(activity).max(50), ends: z.array(activity).max(50),
});

export const processDocument = z.strictObject({ schemaVersion: z.literal('1'), source: processSource, reference: referenceModel.optional() });
export type ProcessDocument = z.infer<typeof processDocument>;

const access = z.enum(['owner', 'view', 'copy']);
export const processSummary = z.object({
  id: z.uuid(), name: z.string(), ownerMembershipId: z.uuid(), visibility: z.enum(['private', 'shared', 'org_visible']), access,
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(), lockVersion: z.int(),
});
export const processView = processSummary.extend({ document: processDocument });

const seconds = z.number().nullable();
export const processAnalysis = z.object({
  computedAt: z.string(),
  /** Why nothing was read for this person (a set they may not read, history not captured), or null. */
  refused: z.string().nullable(),
  /** Events read and used; those lacking a case, an activity or a readable time are skipped and counted. */
  events: z.int(), skipped: z.int(), cases: z.int(),
  /** More events than the limit: the analysis is over the first ones read. */
  truncated: z.boolean(),
  /** For captured changes: where Capture's history of the property begins. */
  capturedFrom: z.string().nullable(),
  activities: z.array(z.object({ name: z.string(), events: z.int(), cases: z.int(), starts: z.int(), ends: z.int() })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), count: z.int(), cases: z.int(), medianSeconds: seconds, p90Seconds: seconds })),
  variants: z.array(z.object({ path: z.array(z.string()), cases: z.int(), share: z.number(), medianSeconds: seconds })),
  caseDuration: z.object({ medianSeconds: seconds, p90Seconds: seconds, maxSeconds: seconds }),
  rework: z.array(z.object({ activity: z.string(), cases: z.int() })),
  conformance: z.object({
    fitting: z.int(), deviating: z.int(),
    deviations: z.array(z.object({ from: z.string(), to: z.string(), cases: z.int() })),
    badStarts: z.array(z.object({ activity: z.string(), cases: z.int() })),
    badEnds: z.array(z.object({ activity: z.string(), cases: z.int() })),
  }).nullable(),
});

export const processShareView = z.object({
  id: z.uuid(), processId: z.uuid(), grantee: shareGrantee, access: z.enum(['view', 'copy']), sharedBy: z.uuid(), sharedAt: z.string(),
  expiresAt: z.string().nullable(), revokedAt: z.string().nullable(), state: z.enum(['live', 'expired', 'revoked', 'suspended', 'forbidden_by_policy']),
});

const params = z.strictObject({ processId: z.uuid() });
const name = z.string().trim().min(1).max(200);

export const createProcess = defineContract({
  service: 'workspace', name: 'createProcess', method: 'POST', path: '/v1/processes', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', body: z.strictObject({ name, document: processDocument }), response: processView, status: 201,
});

export const listProcesses = defineContract({
  service: 'workspace', name: 'listProcesses', method: 'GET', path: '/v1/processes', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ filter: z.enum(['mine', 'shared', 'archived']).default('mine'), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ processes: z.array(processSummary) }),
});

export const getProcess = defineContract({
  service: 'workspace', name: 'getProcess', method: 'GET', path: '/v1/processes/:processId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: processView,
});

export const saveProcess = defineContract({
  service: 'workspace', name: 'saveProcess', method: 'PUT', path: '/v1/processes/:processId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ name: name.optional(), document: processDocument, lockVersion: z.int().min(1) }), response: processView,
});

/** The analysis computed now, from what this person may read. */
export const readProcessAnalysis = defineContract({
  service: 'workspace', name: 'readProcessAnalysis', method: 'GET', path: '/v1/processes/:processId/analysis', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: recordValue(processAnalysis),
});

export const copyProcess = defineContract({
  service: 'workspace', name: 'copyProcess', method: 'POST', path: '/v1/processes/:processId/copies', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params, body: z.strictObject({ name }), response: processView, status: 201,
});

export const archiveProcess = defineContract({
  service: 'workspace', name: 'archiveProcess', method: 'POST', path: '/v1/processes/:processId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: processView,
});

export const shareProcess = defineContract({
  service: 'workspace', name: 'shareProcess', method: 'POST', path: '/v1/processes/:processId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ grantee: shareGrantee, access: z.enum(['view', 'copy']), expiresAt: z.iso.datetime({ offset: true }).optional() }),
  response: processShareView, status: 201,
});

export const revokeProcessShare = defineContract({
  service: 'workspace', name: 'revokeProcessShare', method: 'POST', path: '/v1/processes/:processId/shares/:shareId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ processId: z.uuid(), shareId: z.uuid() }), response: processShareView,
});

export const listProcessShares = defineContract({
  service: 'workspace', name: 'listProcessShares', method: 'GET', path: '/v1/processes/:processId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: z.object({ shares: z.array(processShareView) }),
});

export const exportProcess = defineContract({
  service: 'workspace', name: 'exportProcess', method: 'POST', path: '/v1/processes/:processId/exports', callers: CALLERS,
  shed: 'export_render', context: 'organisation', idempotency: 'keyed', params, body: z.strictObject({ folderId: z.uuid().optional() }),
  response: z.object({ file: fileView }), status: 201,
});
