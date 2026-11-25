// The admin portal's own API (spec 7 catalogue, 13): what the staff console calls, on the
// portal's listener under /staff/v1, apart from the customer gateway. Routes are data, as
// the gateway's are: each names who may call it, and its schemas.
//
// Access:
// - public: signing in, before there is a staff session;
// - signed_in: any member of staff;
// - a capability, or any of several; a route whose capability depends on its input names
//   it from the input (a tenant migration's signature role).
// Some routes check more in the service: break-glass use needs the requester's own running
// session at the level the route needs; approving an expedited promotion needs
// fleet.release.expedite; countersigning a sovereign bundle needs the sovereign access list.
//
// Operator identity is never in a body: the portal fills it from the staff session.

import { z } from 'zod';
import { listAuditEvents } from '../audit/read.contract.ts';
import { cellIdSchema } from '../directory/registration.contract.ts';
import { countersignBundle, signBundle } from '../fleet-control/bundle.contract.ts';
import { readRelease, registerRelease } from '../fleet-control/release.contract.ts';
import { putReleaseSbom, putReleaseVex, readReleaseFindings, syncAdvisories } from '../fleet-control/sbom.contract.ts';
import { readKeyRotation, startKeyRotation } from '../credential/keyRotation.contract.ts';
import { listFleetEvents, verifyFleetEvents } from '../fleet-control/events.contract.ts';
import { approvePromotion, haltRollout, readChannel, readPromotion, readRollout } from '../fleet-control/rollout.contract.ts';
import { CHANNELS, releaseIdSchema, releaseManifest } from '../fleet-control/release.contract.ts';
import { bundleFiles, bundleManifest } from '../fleet-control/bundle.contract.ts';
import { signatureRecord } from '../fleet-control/release.contract.ts';
import { maintenanceStatus } from '../maintenance/status.contract.ts';
import { engagementCost } from '../metering/ledger.contract.ts';
import { getManifest } from '../ontology/manifest.contract.ts';
import { registerSiloOAuthClient } from '../oauth/oauth.contract.ts';
import { measureBigQuery } from '../bigquery-metering/metering.contract.ts';
import * as bc from '../billing/contract.contract.ts';
import { addPrivateLink, listPrivateLinks, removePrivateLink } from '../connect-registry/privateLink.contract.ts';
import { setBillingStatus } from '../billing/staff.contract.ts';
import { runRetentionSweep } from '../siloes/siloes.contract.ts';
import { runReceiptRetentionSweep } from '../actions/receiptPurge.contract.ts';
import { putNotice, putNoticeUpdate, readStatus } from '../status/status.contract.ts';
import {
  abortTenantMigration, getTenantImportKey, proposeRebalancing, scheduleTenantMigration, signTenantMigration,
} from '../tenant-migrations/migration.contract.ts';
import { operatorSchema } from '../../schemas/platform/operator.schema.ts';
import { ACCESS_LEVELS, ACCESS_PURPOSES, MAX_SESSION_MINUTES, STAFF_CAPABILITIES, type StaffCapability } from './capability.contract.ts';
import { operatorAccessSessionView } from './operatorAccess.contract.ts';
import { SUPPORT_REFERENCE, SUPPORT_SEVERITIES, supportMessageView, supportTicketView } from './supportTicket.contract.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type StaffAccess =
  | { kind: 'public' }
  | { kind: 'signed_in' }
  | { kind: 'capability'; anyOf: readonly StaffCapability[] }
  | { kind: 'capability_of_input'; of: (input: { params: any; query: any; body: any }) => StaffCapability };

export interface StaffRoute<P extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType, B extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType> {
  name: string;
  method: Method;
  path: string;
  access: StaffAccess;
  params: P;
  query: Q;
  body: B;
  response: R;
  status: 200 | 201 | 204;
  maxBodyBytes: number;
  /** Sets the staff session cookie (sign-in) or clears it (sign-out). */
  session?: 'establishes' | 'ends';
}

export type StaffInput<R extends StaffRoute> = { params: z.output<R['params']>; query: z.output<R['query']>; body: z.output<R['body']> };
export type StaffOutput<R extends StaffRoute> = z.input<R['response']>;

const none = z.strictObject({});

function staffRoute<P extends z.ZodType = typeof none, Q extends z.ZodType = typeof none, B extends z.ZodType = z.ZodUndefined,
  R extends z.ZodType = z.ZodType>(def: {
  name: string; method: Method; path: string; access: StaffAccess | StaffCapability | readonly StaffCapability[];
  params?: P; query?: Q; body?: B; response: R; status?: 200 | 201 | 204; maxBodyBytes?: number; session?: 'establishes' | 'ends';
}): StaffRoute<P, Q, B, R> {
  const access: StaffAccess = typeof def.access === 'string' ? { kind: 'capability', anyOf: [def.access] }
    : Array.isArray(def.access) ? { kind: 'capability', anyOf: def.access as readonly StaffCapability[] } : def.access as StaffAccess;
  return {
    name: def.name, method: def.method, path: `/staff/v1${def.path}`, access,
    params: (def.params ?? none) as P, query: (def.query ?? none) as Q, body: (def.body ?? z.undefined()) as B,
    response: def.response, status: def.status ?? 200, maxBodyBytes: def.maxBodyBytes ?? 16 * 1024,
    ...(def.session ? { session: def.session } : {}),
  };
}

const PUBLIC: StaffAccess = { kind: 'public' };
const SIGNED_IN: StaffAccess = { kind: 'signed_in' };
const BREAK_GLASS = ['access.request', 'access.approve'] as const;

const organisation = z.strictObject({ organisationId: z.uuid() });
const session = organisation.extend({ sessionId: z.uuid() });
const timestamp = z.iso.datetime({ offset: true });
const ticket = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/, 'a ticket reference such as SUP-1234');

// ----------------------------------------------------------------------------- views

export const staffSelfView = z.object({
  operatorId: z.uuid(),
  displayName: z.string(),
  clearance: z.enum(['bpss', 'sc', 'dv']),
  sovereignAccessListed: z.boolean(),
  capabilities: z.array(z.enum(STAFF_CAPABILITIES)),
  expiresAt: timestamp,
});

export const staffOperatorView = operatorSchema.omit({ version: true });

export const staffOrganisationView = z.object({
  id: z.uuid(), name: z.string(), slug: z.string(), plan: z.string(), status: z.string(), billingStatus: z.string(), cellId: z.string(),
  operatorAccessApprovalRequired: z.boolean(),
});

/** A staff view of a session carries its organisation; the customer's view is the same row. */
export const staffAccessView = operatorAccessSessionView.extend({ organisationId: z.uuid() });

// ----------------------------------------------------------------------------- signing in

export const startStaffSignIn = staffRoute({
  name: 'startStaffSignIn', method: 'POST', path: '/sso/start', access: PUBLIC,
  response: z.object({ redirectUrl: z.url(), binding: z.string(), expiresAt: timestamp }), status: 201,
});

export const completeStaffSignIn = staffRoute({
  name: 'completeStaffSignIn', method: 'POST', path: '/sso/complete', access: PUBLIC,
  body: z.strictObject({ callbackQuery: z.string().min(1).max(8_192), binding: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  response: staffSelfView, status: 201, session: 'establishes',
});

export const readStaffSelf = staffRoute({ name: 'readStaffSelf', method: 'GET', path: '/session', access: SIGNED_IN, response: staffSelfView });

export const endStaffSession = staffRoute({
  name: 'endStaffSession', method: 'DELETE', path: '/session', access: SIGNED_IN, response: z.undefined(), status: 204, session: 'ends',
});

export const findOrganisation = staffRoute({
  name: 'findOrganisation', method: 'GET', path: '/organisations/by-slug/:slug', access: SIGNED_IN,
  params: z.strictObject({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) }), response: staffOrganisationView,
});

// ----------------------------------------------------------------------------- break-glass (13.3)

export const requestAccess = staffRoute({
  name: 'requestAccess', method: 'POST', path: '/access-sessions', access: 'access.request',
  body: z.strictObject({
    organisationId: z.uuid(),
    purpose: z.enum(ACCESS_PURPOSES),
    level: z.enum(ACCESS_LEVELS),
    /** Free text, checked for record values before it is stored. */
    reason: z.string().trim().min(10).max(1_000),
    ticketReference: ticket,
    scopeNote: z.string().trim().min(1).max(1_000).optional(),
    minutes: z.int().min(1).max(MAX_SESSION_MINUTES),
    /** Two staff approvers instead of the customer's, disclosed to the customer at once (63.6). Never tenant_act. */
    emergency: z.boolean().default(false),
  }),
  response: staffAccessView, status: 201, maxBodyBytes: 4_096,
});

export const listOpenAccess = staffRoute({
  name: 'listOpenAccess', method: 'GET', path: '/access-sessions', access: BREAK_GLASS,
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ sessions: z.array(staffAccessView) }),
});

export const getAccess = staffRoute({
  name: 'getAccess', method: 'GET', path: '/organisations/:organisationId/access-sessions/:sessionId', access: BREAK_GLASS,
  params: session, response: staffAccessView,
});

/** The second staff approval; an emergency request takes two, from two people other than the requester. */
export const approveAccess = staffRoute({
  name: 'approveAccess', method: 'POST', path: '/organisations/:organisationId/access-sessions/:sessionId/approval', access: 'access.approve',
  params: session, response: staffAccessView,
});

export const startAccess = staffRoute({
  name: 'startAccess', method: 'POST', path: '/organisations/:organisationId/access-sessions/:sessionId/start', access: 'access.request',
  params: session, response: staffAccessView,
});

export const endAccess = staffRoute({
  name: 'endAccess', method: 'POST', path: '/organisations/:organisationId/access-sessions/:sessionId/end', access: 'access.request',
  params: session, response: staffAccessView,
});

export const cancelAccess = staffRoute({
  name: 'cancelAccess', method: 'POST', path: '/organisations/:organisationId/access-sessions/:sessionId/cancel', access: 'access.request',
  params: session, response: staffAccessView,
});

// What a running session reaches. Each request is counted on the session and recorded in
// the customer's audit log before it is made.

export const sessionAuditEvents = staffRoute({
  name: 'sessionAuditEvents', method: 'GET', path: '/organisations/:organisationId/access-sessions/:sessionId/audit-events',
  access: 'access.request', params: session, query: listAuditEvents.query, response: listAuditEvents.response,
});

/**
 * tenant_read (spec 13.3): the tenant's tables a session may read through the reporting
 * replica, as silo_report: its grants decide (never a sealed column), and row-level security
 * binds it to the session's organisation. Each read is counted and recorded in the customer's
 * audit log, naming the table.
 */
export const sessionTenantTables = staffRoute({
  name: 'sessionTenantTables', method: 'GET', path: '/organisations/:organisationId/access-sessions/:sessionId/tenant-tables',
  access: 'access.request', params: session,
  response: z.object({ tables: z.array(z.object({ table: z.string(), columns: z.array(z.string()) })) }),
});

export const sessionTenantRows = staffRoute({
  name: 'sessionTenantRows', method: 'GET', path: '/organisations/:organisationId/access-sessions/:sessionId/tenant-rows',
  access: 'access.request', params: session,
  query: z.strictObject({
    table: z.string().regex(/^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  }),
  response: z.object({ table: z.string(), columns: z.array(z.string()), rows: z.array(z.record(z.string(), z.unknown())), more: z.boolean() }),
});

export const sessionManifest = staffRoute({
  name: 'sessionManifest', method: 'GET', path: '/organisations/:organisationId/access-sessions/:sessionId/manifest',
  access: 'access.request', params: session, query: getManifest.query, response: getManifest.response,
});

export const sessionEngagementCost = staffRoute({
  name: 'sessionEngagementCost', method: 'GET',
  path: '/organisations/:organisationId/access-sessions/:sessionId/engagements/:engagementId/cost',
  access: 'access.request', params: session.extend({ engagementId: z.uuid() }), response: engagementCost.response,
});

export const sessionBillingStatus = staffRoute({
  name: 'sessionBillingStatus', method: 'POST', path: '/organisations/:organisationId/access-sessions/:sessionId/billing-status',
  access: 'billing.status', params: session, body: setBillingStatus.body, response: setBillingStatus.response,
});

// ----------------------------------------------------------------------------- operations on an organisation

/** The organisation's retention, enforced now: its Siloes' windows (70.1) and its receipts past theirs (46.1). */
export const runOrganisationRetention = staffRoute({
  name: 'runOrganisationRetention', method: 'POST', path: '/organisations/:organisationId/retention-sweeps', access: 'operations.run',
  params: organisation, response: runRetentionSweep.response.extend({ receipts: runReceiptRetentionSweep.response }),
});

export const runOrganisationBigQueryMeasurement = staffRoute({
  name: 'runOrganisationBigQueryMeasurement', method: 'POST', path: '/organisations/:organisationId/bigquery-measurements',
  access: 'operations.run', params: organisation, response: measureBigQuery.response,
});

// ----------------------------------------------------------------------------- Enterprise contracts (71.6, 74.3 to 74.6)

const contract = z.strictObject({ organisationId: z.uuid(), contractId: z.uuid() });
const QUOTING = ['contracts.quote', 'contracts.manage'] as const;
const READING = ['contracts.quote', 'contracts.manage', 'operations.view'] as const;

export const quoteOrganisationContract = staffRoute({
  name: 'quoteOrganisationContract', method: 'POST', path: '/organisations/:organisationId/contracts/quote', access: QUOTING,
  params: organisation, body: bc.quoteContract.body, response: bc.quoteContract.response, maxBodyBytes: 8_192,
});
export const createOrganisationContract = staffRoute({
  name: 'createOrganisationContract', method: 'POST', path: '/organisations/:organisationId/contracts', access: QUOTING,
  params: organisation, body: bc.createContract.body, response: bc.createContract.response, status: 201, maxBodyBytes: 8_192,
});
export const listOrganisationContracts = staffRoute({
  name: 'listOrganisationContracts', method: 'GET', path: '/organisations/:organisationId/contracts', access: READING,
  params: organisation, query: bc.listContracts.query, response: bc.listContracts.response,
});
export const amendOrganisationContractDraft = staffRoute({
  name: 'amendOrganisationContractDraft', method: 'PATCH', path: '/organisations/:organisationId/contracts/:contractId', access: QUOTING,
  params: contract, body: bc.amendContractDraft.body, response: bc.amendContractDraft.response, maxBodyBytes: 8_192,
});
export const approveOrganisationContractMargin = staffRoute({
  name: 'approveOrganisationContractMargin', method: 'POST', path: '/organisations/:organisationId/contracts/:contractId/margin-approval',
  access: 'contracts.manage', params: contract, body: bc.approveContractMargin.body, response: bc.approveContractMargin.response,
});
export const activateOrganisationContract = staffRoute({
  name: 'activateOrganisationContract', method: 'POST', path: '/organisations/:organisationId/contracts/:contractId/activate',
  access: 'contracts.manage', params: contract, body: bc.activateContract.body, response: bc.activateContract.response,
});
export const amendOrganisationContract = staffRoute({
  name: 'amendOrganisationContract', method: 'POST', path: '/organisations/:organisationId/contracts/:contractId/amend',
  access: 'contracts.manage', params: contract, body: bc.amendContract.body, response: bc.amendContract.response, maxBodyBytes: 8_192,
});
export const renewOrganisationContract = staffRoute({
  name: 'renewOrganisationContract', method: 'POST', path: '/organisations/:organisationId/contracts/:contractId/renew',
  access: 'contracts.manage', params: contract, body: bc.renewContract.body, response: bc.renewContract.response, maxBodyBytes: 8_192,
});
// A sovereign customer's entitlement terms, in the sovereign cell's portal only (D204): entered by
// one cleared operator from the commercial contract by its reference, decided by another.
const sovereignTermsView = z.object({
  id: z.uuid(), organisationId: z.uuid(), commercialContractRef: z.string(), seats: z.int(), tokensPerSeatPeriod: z.int(), simulationsPerSeatPeriod: z.int(),
  dailyTokenLimit: z.int(), storageIncludedBytes: z.number(), liveObjectsLimit: z.int().nullable(), capabilities: z.array(z.string()),
  termStart: z.string(), termEnd: z.string(), status: z.enum(['pending', 'approved', 'rejected']), enteredBy: z.uuid(), enteredAt: z.string(),
  decidedBy: z.uuid().nullable(), decidedAt: z.string().nullable(),
});
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, YYYY-MM-DD');
export const enterSovereignTerms = staffRoute({
  name: 'enterSovereignTerms', method: 'POST', path: '/organisations/:organisationId/sovereign-terms', access: 'contracts.manage', params: organisation,
  body: z.strictObject({
    commercialContractRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/, 'the commercial contract\'s reference'),
    seats: z.int().min(0).max(1_000_000), tokensPerSeatPeriod: z.int().min(0), simulationsPerSeatPeriod: z.int().min(0), dailyTokenLimit: z.int().min(0),
    storageIncludedBytes: z.int().min(0), liveObjectsLimit: z.int().min(1).max(100_000_000).nullable().default(null),
    capabilities: z.array(z.enum(['sso', 'scim', 'custom_roles', 'dedicated', 'sovereign', 'ai_connector_builder', 'nocode_connector_builder'])).max(7).default([]),
    termStart: day, termEnd: day,
  }).refine((b) => b.termEnd > b.termStart, { message: 'the term ends after it starts', path: ['termEnd'] }),
  response: sovereignTermsView, status: 201, maxBodyBytes: 4_096,
});
export const listSovereignTerms = staffRoute({
  name: 'listSovereignTerms', method: 'GET', path: '/organisations/:organisationId/sovereign-terms', access: READING, params: organisation,
  response: z.object({ terms: z.array(sovereignTermsView) }),
});
export const decideSovereignTerms = staffRoute({
  name: 'decideSovereignTerms', method: 'POST', path: '/organisations/:organisationId/sovereign-terms/:termsId/decision', access: 'contracts.manage',
  params: z.strictObject({ organisationId: z.uuid(), termsId: z.uuid() }), body: z.strictObject({ decision: z.enum(['approve', 'reject']) }),
  response: sovereignTermsView, maxBodyBytes: 256,
});
export const setOrganisationContractRenewalState = staffRoute({
  name: 'setOrganisationContractRenewalState', method: 'POST', path: '/organisations/:organisationId/contracts/:contractId/renewal-state',
  access: QUOTING, params: contract, body: bc.setContractRenewalState.body, response: bc.setContractRenewalState.response,
});
export const readOrganisationContractUsage = staffRoute({
  name: 'readOrganisationContractUsage', method: 'GET', path: '/organisations/:organisationId/contracts/:contractId/usage', access: READING,
  params: contract, response: bc.contractUsage.response,
});
export const raiseOrganisationContractInvoice = staffRoute({
  name: 'raiseOrganisationContractInvoice', method: 'POST', path: '/organisations/:organisationId/contracts/:contractId/invoices',
  access: 'contracts.manage', params: contract, body: bc.raiseContractInvoice.body, response: bc.raiseContractInvoice.response,
  maxBodyBytes: 8_192,
});
export const recordOrganisationManualInvoice = staffRoute({
  name: 'recordOrganisationManualInvoice', method: 'POST', path: '/organisations/:organisationId/invoices/manual', access: 'contracts.manage',
  params: organisation, body: bc.recordManualInvoice.body, response: bc.recordManualInvoice.response, status: 201,
});
export const recordOrganisationManualPayment = staffRoute({
  name: 'recordOrganisationManualPayment', method: 'POST', path: '/organisations/:organisationId/invoices/:invoiceId/manual-payment',
  access: 'payments.record', params: z.strictObject({ organisationId: z.uuid(), invoiceId: z.uuid() }), body: bc.recordManualPayment.body,
  response: bc.recordManualPayment.response,
});

// ----------------------------------------------------------------------------- private links (decision 2026-11-09)

const privateLink = z.strictObject({ organisationId: z.uuid(), linkId: z.uuid() });

export const listOrganisationPrivateLinks = staffRoute({
  name: 'listOrganisationPrivateLinks', method: 'GET', path: '/organisations/:organisationId/private-links',
  access: ['network.private_links', 'operations.view'], params: organisation, query: listPrivateLinks.query, response: listPrivateLinks.response,
});

export const addOrganisationPrivateLink = staffRoute({
  name: 'addOrganisationPrivateLink', method: 'POST', path: '/organisations/:organisationId/private-links', access: 'network.private_links',
  params: organisation, body: addPrivateLink.body.omit({ operatorId: true }), response: addPrivateLink.response, status: 201,
});

export const removeOrganisationPrivateLink = staffRoute({
  name: 'removeOrganisationPrivateLink', method: 'POST', path: '/organisations/:organisationId/private-links/:linkId/remove',
  access: 'network.private_links', params: privateLink, body: removePrivateLink.body.omit({ operatorId: true }), response: removePrivateLink.response,
});

// ----------------------------------------------------------------------------- operators (13.4)

const operatorFacts = z.strictObject({
  displayName: z.string().trim().min(1).max(200),
  clearance: z.enum(['bpss', 'sc', 'dv']),
  ukResident: z.boolean(),
  sovereignAccessListed: z.boolean().default(false),
});

export const listOperators = staffRoute({
  name: 'listOperators', method: 'GET', path: '/operators', access: 'staff.review',
  query: z.strictObject({
    /** Only those due their quarterly review: last reviewed over 90 days ago, or never. */
    reviewDue: z.stringbool().default(false),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: z.object({ operators: z.array(staffOperatorView) }),
});

export const addOperator = staffRoute({
  name: 'addOperator', method: 'POST', path: '/operators', access: 'staff.manage',
  body: operatorFacts.extend({ idpSubject: z.string().trim().min(1).max(255) }), response: staffOperatorView, status: 201,
});

export const changeOperator = staffRoute({
  name: 'changeOperator', method: 'PATCH', path: '/operators/:operatorId', access: 'staff.manage',
  params: z.strictObject({ operatorId: z.uuid() }),
  body: operatorFacts.partial().extend({ version: z.int().min(1) }),
  response: staffOperatorView,
});

export const reviewOperator = staffRoute({
  name: 'reviewOperator', method: 'POST', path: '/operators/:operatorId/review', access: 'staff.review',
  params: z.strictObject({ operatorId: z.uuid() }), response: staffOperatorView,
});

export const setOperatorStatus = staffRoute({
  name: 'setOperatorStatus', method: 'POST', path: '/operators/:operatorId/status', access: 'staff.review',
  params: z.strictObject({ operatorId: z.uuid() }),
  body: z.strictObject({ status: z.enum(['active', 'suspended', 'removed']) }),
  response: staffOperatorView,
});

// ----------------------------------------------------------------------------- Silo's own OAuth clients (15.4)

const withoutOperator = <S extends z.ZodObject>(schema: S) => schema.omit({ operatorId: true } as never);

export const addSiloOAuthClient = staffRoute({
  name: 'addSiloOAuthClient', method: 'POST', path: '/oauth/silo-clients', access: 'oauth.clients',
  body: withoutOperator(registerSiloOAuthClient.body), response: registerSiloOAuthClient.response, status: 201, maxBodyBytes: 8_192,
});

// ----------------------------------------------------------------------------- fleet (11)

export const registerFleetRelease = staffRoute({
  name: 'registerFleetRelease', method: 'PUT', path: '/fleet/releases/:releaseId', access: 'fleet.release.register',
  params: registerRelease.params, body: z.strictObject({ manifest: releaseManifest }), response: registerRelease.response,
  maxBodyBytes: 512 * 1024,
});

export const readFleetRelease = staffRoute({
  name: 'readFleetRelease', method: 'GET', path: '/fleet/releases/:releaseId', access: 'operations.view',
  params: readRelease.params, response: readRelease.response,
});

export const signFleetBundle = staffRoute({
  name: 'signFleetBundle', method: 'PUT', path: '/fleet/bundles/:bundleId', access: 'fleet.release.register',
  params: signBundle.params,
  body: z.strictObject({ releaseId: releaseIdSchema, fromReleaseId: releaseIdSchema.nullable().default(null), files: bundleFiles }),
  response: signBundle.response, maxBodyBytes: 16 * 1024 * 1024,
});

export const countersignFleetBundle = staffRoute({
  name: 'countersignFleetBundle', method: 'PUT', path: '/fleet/bundles/:bundleId/countersignature', access: 'fleet.sovereign.countersign',
  params: countersignBundle.params, body: z.strictObject({ bundle: bundleManifest, signatures: z.array(signatureRecord).max(8) }),
  response: countersignBundle.response, maxBodyBytes: 16 * 1024 * 1024,
});

export const requestFleetPromotion = staffRoute({
  name: 'requestFleetPromotion', method: 'PUT', path: '/fleet/promotions/:promotionId', access: 'fleet.release.promote',
  params: z.strictObject({ promotionId: z.uuid() }),
  body: z.strictObject({ releaseId: releaseIdSchema, channel: z.enum(CHANNELS), expedite: z.boolean().default(false) }),
  response: readPromotion.response,
});

export const readFleetPromotion = staffRoute({
  name: 'readFleetPromotion', method: 'GET', path: '/fleet/promotions/:promotionId', access: 'operations.view',
  params: readPromotion.params, response: readPromotion.response,
});

export const approveFleetPromotion = staffRoute({
  name: 'approveFleetPromotion', method: 'PUT', path: '/fleet/promotions/:promotionId/approval', access: 'fleet.release.promote',
  params: approvePromotion.params, response: approvePromotion.response,
});

export const readFleetChannel = staffRoute({
  name: 'readFleetChannel', method: 'GET', path: '/fleet/channels/:channel', access: 'operations.view',
  params: readChannel.params, response: readChannel.response,
});

export const readFleetRollout = staffRoute({
  name: 'readFleetRollout', method: 'GET', path: '/fleet/rollouts/:rolloutId', access: 'operations.view',
  params: readRollout.params, response: readRollout.response,
});

export const uploadFleetSbom = staffRoute({
  name: 'uploadFleetSbom', method: 'PUT', path: '/fleet/releases/:releaseId/sboms/:sha256', access: 'fleet.release.register',
  params: putReleaseSbom.params, body: putReleaseSbom.body.pick({ document: true }), response: putReleaseSbom.response,
  maxBodyBytes: putReleaseSbom.maxBodyBytes!,
});

// A VEX statement decides whether a vulnerability blocks stable: the security officer's call (11.6).
export const stateFleetVex = staffRoute({
  name: 'stateFleetVex', method: 'PUT', path: '/fleet/releases/:releaseId/vex/:sha256', access: 'fleet.release.expedite',
  params: putReleaseVex.params, body: putReleaseVex.body.pick({ document: true }), response: putReleaseVex.response,
  maxBodyBytes: putReleaseVex.maxBodyBytes!,
});

export const readFleetFindings = staffRoute({
  name: 'readFleetFindings', method: 'GET', path: '/fleet/releases/:releaseId/findings', access: 'operations.view',
  params: readReleaseFindings.params, response: readReleaseFindings.response,
});

/** Start a KEK rotation in the cell (spec 61.1, 61.2): the new key named, created in the provider beforehand. */
export const startCellKeyRotation = staffRoute({
  name: 'startCellKeyRotation', method: 'POST', path: '/keys/rotations', access: 'key.rotate',
  body: z.strictObject({ keyUri: z.string().min(1).max(1024) }), response: startKeyRotation.response, status: 201,
});

export const readCellKeyRotation = staffRoute({
  name: 'readCellKeyRotation', method: 'GET', path: '/keys/rotations', access: 'key.rotate', response: readKeyRotation.response,
});

export const syncFleetAdvisories = staffRoute({
  name: 'syncFleetAdvisories', method: 'POST', path: '/fleet/advisories/sync', access: 'fleet.release.register',
  response: syncAdvisories.response,
});

// Fleet's own events (11.6): rollout_gate_failed is read first, so the list can be asked for one release or cell.
export const readFleetEvents = staffRoute({
  name: 'readFleetEvents', method: 'GET', path: '/fleet/events', access: 'operations.view',
  query: listFleetEvents.query, response: listFleetEvents.response,
});

export const verifyFleetEventChain = staffRoute({
  name: 'verifyFleetEventChain', method: 'GET', path: '/fleet/events/verification', access: 'operations.view',
  response: verifyFleetEvents.response,
});

export const haltFleetRollout = staffRoute({
  name: 'haltFleetRollout', method: 'POST', path: '/fleet/rollouts/:rolloutId/halt', access: 'fleet.rollout.halt',
  params: haltRollout.params, response: haltRollout.response,
});

// ----------------------------------------------------------------------------- the status page (13.2) and maintenance

export const readStatusPage = staffRoute({
  name: 'readStatusPage', method: 'GET', path: '/status', access: 'operations.view', response: readStatus.response,
});

const noticeBody = z.strictObject({
  kind: z.enum(['incident', 'maintenance']),
  severity: z.enum(['sev1', 'sev2', 'sev3']).optional(),
  title: z.string().trim().min(1).max(120),
  cellIds: z.array(cellIdSchema).min(1).max(20),
  components: z.array(z.string()).max(20).default([]),
  window: z.strictObject({ startsAt: timestamp, endsAt: timestamp }).optional(),
});

export const putStatusNotice = staffRoute({
  name: 'putStatusNotice', method: 'PUT', path: '/status/notices/:noticeId', access: 'status.publish',
  params: putNotice.params, body: noticeBody, response: putNotice.response, maxBodyBytes: 4_096,
});

export const putStatusNoticeUpdate = staffRoute({
  name: 'putStatusNoticeUpdate', method: 'PUT', path: '/status/notices/:noticeId/updates/:updateId', access: 'status.publish',
  params: putNoticeUpdate.params, body: z.strictObject({ state: z.string().regex(/^[a-z_]{1,32}$/), message: z.string().trim().min(1).max(2000) }),
  response: putNoticeUpdate.response, maxBodyBytes: 8_192,
});

export const readMaintenance = staffRoute({
  name: 'readMaintenance', method: 'GET', path: '/maintenance', access: 'operations.view', response: maintenanceStatus.response,
});

// ----------------------------------------------------------------------------- tenant migrations (6.4)

const SIGNATURE_CAPABILITY = {
  security_officer: 'tenancy.security_officer', sovereign_security_officer: 'tenancy.sovereign_security_officer', contract: 'tenancy.contract',
} as const satisfies Record<string, StaffCapability>;

const migration = organisation.extend({ migrationId: z.uuid() });

export const proposeOrganisationRebalancing = staffRoute({
  name: 'proposeOrganisationRebalancing', method: 'POST', path: '/organisations/:organisationId/tenant-migrations/rebalancing',
  access: 'tenancy.rebalance', params: organisation, body: z.strictObject({ destinationCellId: cellIdSchema }),
  response: proposeRebalancing.response, status: 201,
});

export const signOrganisationMigration = staffRoute({
  name: 'signOrganisationMigration', method: 'POST', path: '/organisations/:organisationId/tenant-migrations/:migrationId/signatures',
  access: { kind: 'capability_of_input', of: (input) => SIGNATURE_CAPABILITY[(input.body as { role: keyof typeof SIGNATURE_CAPABILITY }).role] },
  params: migration, body: z.strictObject({ role: z.enum(['security_officer', 'sovereign_security_officer', 'contract']) }),
  response: signTenantMigration.response,
});

export const scheduleOrganisationMigration = staffRoute({
  name: 'scheduleOrganisationMigration', method: 'POST', path: '/organisations/:organisationId/tenant-migrations/:migrationId/schedule',
  access: 'tenancy.schedule', params: migration, body: withoutOperator(scheduleTenantMigration.body).omit({ organisationId: true } as never),
  response: scheduleTenantMigration.response,
});

export const abortOrganisationMigration = staffRoute({
  name: 'abortOrganisationMigration', method: 'POST', path: '/organisations/:organisationId/tenant-migrations/:migrationId/abort',
  access: 'tenancy.schedule', params: migration, body: z.strictObject({ reason: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/) }),
  response: abortTenantMigration.response,
});

export const readTenantImportKey = staffRoute({
  name: 'readTenantImportKey', method: 'GET', path: '/tenant-migrations/import-key', access: 'tenancy.schedule',
  response: getTenantImportKey.response,
});

/** Every staff route, in the order the portal mounts them. */
// ----------------------------------------------------------------------------- support tickets (U4)

/** A ticket as support sees it: whose organisation, who raised it (by name), and its messages. */
export const staffTicketView = z.object({
  ticket: supportTicketView,
  organisation: z.object({ id: z.uuid(), name: z.string(), slug: z.string() }),
  raisedByName: z.string(),
  messages: z.array(supportMessageView),
});
const supportReference = z.strictObject({ reference: z.string().regex(SUPPORT_REFERENCE) });

export const listSupportQueue = staffRoute({
  name: 'listSupportQueue', method: 'GET', path: '/support-tickets', access: 'support.tickets',
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ tickets: z.array(staffTicketView.omit({ messages: true })) }),
});

export const readSupportTicketForStaff = staffRoute({
  name: 'readSupportTicketForStaff', method: 'GET', path: '/support-tickets/:reference', access: 'support.tickets',
  params: supportReference, response: staffTicketView,
});

export const replyToSupportTicketAsStaff = staffRoute({
  name: 'replyToSupportTicketAsStaff', method: 'POST', path: '/support-tickets/:reference/messages', access: 'support.tickets',
  params: supportReference,
  body: z.strictObject({
    /** The reply, checked for record values before it is stored. */
    body: z.string().trim().min(1).max(4000),
    /** What the ticket waits on afterwards: the customer (a question for them), or resolved. */
    status: z.enum(['waiting_on_customer', 'resolved']).default('waiting_on_customer'),
  }),
  response: staffTicketView, status: 201, maxBodyBytes: 16 * 1024,
});

export const updateSupportTicketAsStaff = staffRoute({
  name: 'updateSupportTicketAsStaff', method: 'PATCH', path: '/support-tickets/:reference', access: 'support.tickets',
  params: supportReference,
  body: z.strictObject({
    status: z.enum(['waiting_on_silo', 'waiting_on_customer', 'resolved']).optional(),
    severity: z.enum(SUPPORT_SEVERITIES).optional(),
    /** Take the ticket: the member of staff asking looks after it. */
    take: z.literal(true).optional(),
  }),
  response: staffTicketView,
});

export const STAFF_ROUTES: readonly StaffRoute[] = [
  listSupportQueue, readSupportTicketForStaff, replyToSupportTicketAsStaff, updateSupportTicketAsStaff,
  startStaffSignIn, completeStaffSignIn, readStaffSelf, endStaffSession, findOrganisation,
  requestAccess, listOpenAccess, getAccess, approveAccess, startAccess, endAccess, cancelAccess,
  sessionAuditEvents, sessionManifest, sessionEngagementCost, sessionBillingStatus, sessionTenantTables, sessionTenantRows,
  runOrganisationRetention, runOrganisationBigQueryMeasurement,
  listOrganisationPrivateLinks, addOrganisationPrivateLink, removeOrganisationPrivateLink,
  quoteOrganisationContract, createOrganisationContract, listOrganisationContracts, amendOrganisationContractDraft,
  approveOrganisationContractMargin, activateOrganisationContract, amendOrganisationContract, renewOrganisationContract,
  enterSovereignTerms, listSovereignTerms, decideSovereignTerms,
  setOrganisationContractRenewalState, readOrganisationContractUsage, raiseOrganisationContractInvoice, recordOrganisationManualInvoice,
  recordOrganisationManualPayment,
  listOperators, addOperator, changeOperator, reviewOperator, setOperatorStatus,
  addSiloOAuthClient,
  registerFleetRelease, readFleetRelease, signFleetBundle, countersignFleetBundle, requestFleetPromotion, readFleetPromotion,
  approveFleetPromotion, readFleetChannel, readFleetRollout, haltFleetRollout, uploadFleetSbom, stateFleetVex, readFleetFindings, syncFleetAdvisories, readFleetEvents, verifyFleetEventChain, startCellKeyRotation, readCellKeyRotation,
  readStatusPage, putStatusNotice, putStatusNoticeUpdate, readMaintenance,
  proposeOrganisationRebalancing, signOrganisationMigration, scheduleOrganisationMigration, abortOrganisationMigration, readTenantImportKey,
] as StaffRoute[];
