// Staff operations through the portal (spec 7 catalogue): each calls the service that owns
// the work, naming the member of staff from their session, never from the request. The
// route table has checked the capability; the rules a capability cannot state are here:
// - break-glass requests run under the requester's own running session, counted and
//   recorded before the call (breakGlass.use), and the serving service checks it again;
// - approving an expedited promotion needs fleet.release.expedite (11.6, the security
//   officer); fleet-control itself enforces the two-person rule;
// - countersigning a sovereign bundle needs the sovereign access list (11.6, 13.3).
// Reads of the customer's tenant never happen outside a session.

import { reportingReadRepo } from '../../repos/platform/reportingRead.repo.ts';
import type { AccessLevel } from '../../contracts/admin-portal/capability.contract.ts';
import type * as s from '../../contracts/admin-portal/staffApi.contract.ts';
import { listAuditEvents } from '../../contracts/audit/read.contract.ts';
import { setBillingStatus } from '../../contracts/billing/staff.contract.ts';
import { measureBigQuery } from '../../contracts/bigquery-metering/metering.contract.ts';
import * as bc from '../../contracts/billing/contract.contract.ts';
import { addPrivateLink, listPrivateLinks, removePrivateLink } from '../../contracts/connect-registry/privateLink.contract.ts';
import { countersignBundle, signBundle } from '../../contracts/fleet-control/bundle.contract.ts';
import { readRelease, registerRelease } from '../../contracts/fleet-control/release.contract.ts';
import { putReleaseSbom, putReleaseVex, readReleaseFindings, syncAdvisories } from '../../contracts/fleet-control/sbom.contract.ts';
import { readKeyRotation, startKeyRotation } from '../../contracts/credential/keyRotation.contract.ts';
import { listFleetEvents, verifyFleetEvents } from '../../contracts/fleet-control/events.contract.ts';
import {
  approvePromotion, haltRollout, readChannel, readPromotion, readRollout, requestPromotion,
} from '../../contracts/fleet-control/rollout.contract.ts';
import { maintenanceStatus } from '../../contracts/maintenance/status.contract.ts';
import { engagementCost } from '../../contracts/metering/ledger.contract.ts';
import { registerSiloOAuthClient } from '../../contracts/oauth/oauth.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import { runRetentionSweep } from '../../contracts/siloes/siloes.contract.ts';
import { runReceiptRetentionSweep } from '../../contracts/actions/receiptPurge.contract.ts';
import { putNotice, putNoticeUpdate, readStatus } from '../../contracts/status/status.contract.ts';
import {
  abortTenantMigration, getTenantImportKey, proposeRebalancing, scheduleTenantMigration, signTenantMigration,
} from '../../contracts/tenant-migrations/migration.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import type { BreakGlass } from './breakGlass.service.ts';
import { requireCapability, type AdminPortalDeps, type StaffContext } from './deps.service.ts';

type In<R extends s.StaffRoute> = s.StaffInput<R>;

export function createOperations(deps: AdminPortalDeps, breakGlass: BreakGlass) {
  const { services } = deps;
  const as = (ctx: StaffContext) => ({ correlationId: ctx.correlationId });
  const operatorId = (ctx: StaffContext): string => ctx.staff.operator.id;
  /** A call on one organisation, naming the member of staff from their session (D45). */
  const onOrganisation = (ctx: StaffContext, organisationId: string) =>
    ({ request: { organisationId, operatorId: operatorId(ctx) }, correlationId: ctx.correlationId });

  /** The reporting replica, where the deployment gives one (PG_REPORT_URL): tenant_read reads there only. */
  const reporting = () => {
    if (deps.databases.report === undefined) {
      throw new AppError('configuration', 'this cell has no reporting replica: tenant_read reads need PG_REPORT_URL', { code: 'config.reporting_replica' });
    }
    return deps.databases.pool('report');
  };

  /** A call under the requester's running break-glass session, counted and recorded first. */
  const underSession = async (ctx: StaffContext, params: { organisationId: string; sessionId: string }, level: AccessLevel,
    touched: { type: string; id: string; route: string }) => ({
    request: await breakGlass.use(ctx, params.organisationId, params.sessionId, level, touched), correlationId: ctx.correlationId,
  });

  return {
    async findOrganisation(slug: string) {
      const found = await inTransaction(deps.databases.pool('control'), {}, (db) => organisationRepo.findForStaff(db, slug), { readOnly: true });
      if (found === undefined) throw new AppError('not_found', 'no organisation has that slug', { code: 'staff.organisation_unknown' });
      return found;
    },

    // ----------------------------------------------------------------------- under a break-glass session

    async auditEvents(ctx: StaffContext, input: In<typeof s.sessionAuditEvents>) {
      const call = await underSession(ctx, input.params, 'metadata_read',
        { type: 'organisation', id: input.params.organisationId, route: 'audit_events' });
      return services.call(listAuditEvents, { query: input.query }, call);
    },

    // tenant_read (13.3): the tenant's rows through the reporting replica, as silo_report.
    async tenantTables(ctx: StaffContext, input: In<typeof s.sessionTenantTables>) {
      const request = await breakGlass.use(ctx, input.params.organisationId, input.params.sessionId, 'tenant_read',
        { type: 'organisation', id: input.params.organisationId, route: 'tenant_tables' });
      return { tables: await inTransaction(reporting(), request, (db) => reportingReadRepo.readableTables(db), { readOnly: true }) };
    },

    async tenantRows(ctx: StaffContext, input: In<typeof s.sessionTenantRows>) {
      const { organisationId, sessionId } = input.params;
      const table = (await inTransaction(reporting(), { organisationId }, (db) => reportingReadRepo.readableTables(db), { readOnly: true }))
        .find((t) => t.table === input.query.table);
      if (table === undefined) throw new AppError('not_found', 'the reporting role reads no such tenant table', { code: 'staff.table_unknown' });
      const request = await breakGlass.use(ctx, organisationId, sessionId, 'tenant_read', { type: 'organisation', id: organisationId, route: `tenant_rows:${table.table}`.slice(0, 120) });
      const rows = await inTransaction(reporting(), request, (db) => reportingReadRepo.rows(db, table, input.query.limit + 1, input.query.offset), { readOnly: true });
      return { table: table.table, columns: table.columns, rows: rows.slice(0, input.query.limit), more: rows.length > input.query.limit };
    },

    async manifest(ctx: StaffContext, input: In<typeof s.sessionManifest>) {
      const call = await underSession(ctx, input.params, 'metadata_read',
        { type: 'organisation', id: input.params.organisationId, route: 'ontology_manifest' });
      return services.call(getManifest, { query: input.query }, call);
    },

    async engagementCost(ctx: StaffContext, input: In<typeof s.sessionEngagementCost>) {
      const call = await underSession(ctx, input.params, 'metadata_read',
        { type: 'fde_engagement', id: input.params.engagementId, route: 'engagement_cost' });
      return services.call(engagementCost, { params: { engagementId: input.params.engagementId } }, call);
    },

    async billingStatus(ctx: StaffContext, input: In<typeof s.sessionBillingStatus>) {
      const call = await underSession(ctx, input.params, 'tenant_act',
        { type: 'organisation', id: input.params.organisationId, route: 'billing_status' });
      return services.call(setBillingStatus, { body: input.body }, call);
    },

    // ----------------------------------------------------------------------- operations on an organisation (no record values)

    async runRetention(ctx: StaffContext, organisationId: string) {
      const siloes = await services.call(runRetentionSweep, {}, { request: { organisationId }, ...as(ctx) });
      const receipts = await services.call(runReceiptRetentionSweep, {}, { request: { organisationId }, ...as(ctx) });
      return { ...siloes, receipts };
    },

    measureBigQuery: (ctx: StaffContext, organisationId: string) =>
      services.call(measureBigQuery, {}, { request: { organisationId }, ...as(ctx) }),

    // Enterprise contracts and invoices: staff work on an organisation, naming the member of
    // staff in the request context (D45), which billing's staff-only writes require.
    quoteContract: (ctx: StaffContext, input: In<typeof s.quoteOrganisationContract>) =>
      services.call(bc.quoteContract, { body: input.body }, onOrganisation(ctx, input.params.organisationId)),
    createContract: (ctx: StaffContext, input: In<typeof s.createOrganisationContract>) =>
      services.call(bc.createContract, { body: input.body }, onOrganisation(ctx, input.params.organisationId)),
    listContracts: (ctx: StaffContext, input: In<typeof s.listOrganisationContracts>) =>
      services.call(bc.listContracts, { query: input.query }, onOrganisation(ctx, input.params.organisationId)),
    amendContractDraft: (ctx: StaffContext, input: In<typeof s.amendOrganisationContractDraft>) =>
      services.call(bc.amendContractDraft, { params: { contractId: input.params.contractId }, body: input.body },
        onOrganisation(ctx, input.params.organisationId)),
    approveContractMargin: (ctx: StaffContext, input: In<typeof s.approveOrganisationContractMargin>) =>
      services.call(bc.approveContractMargin, { params: { contractId: input.params.contractId }, body: input.body },
        onOrganisation(ctx, input.params.organisationId)),
    activateContract: (ctx: StaffContext, input: In<typeof s.activateOrganisationContract>) =>
      services.call(bc.activateContract, { params: { contractId: input.params.contractId }, body: input.body },
        onOrganisation(ctx, input.params.organisationId)),
    amendContract: (ctx: StaffContext, input: In<typeof s.amendOrganisationContract>) =>
      services.call(bc.amendContract, { params: { contractId: input.params.contractId }, body: input.body },
        onOrganisation(ctx, input.params.organisationId)),
    renewContract: (ctx: StaffContext, input: In<typeof s.renewOrganisationContract>) =>
      services.call(bc.renewContract, { params: { contractId: input.params.contractId }, body: input.body },
        onOrganisation(ctx, input.params.organisationId)),
    setContractRenewalState: (ctx: StaffContext, input: In<typeof s.setOrganisationContractRenewalState>) =>
      services.call(bc.setContractRenewalState, { params: { contractId: input.params.contractId }, body: input.body },
        onOrganisation(ctx, input.params.organisationId)),
    contractUsage: (ctx: StaffContext, input: In<typeof s.readOrganisationContractUsage>) =>
      services.call(bc.contractUsage, { params: { contractId: input.params.contractId } }, onOrganisation(ctx, input.params.organisationId)),
    raiseContractInvoice: (ctx: StaffContext, input: In<typeof s.raiseOrganisationContractInvoice>) =>
      services.call(bc.raiseContractInvoice, { params: { contractId: input.params.contractId }, body: input.body },
        onOrganisation(ctx, input.params.organisationId)),
    recordManualInvoice: (ctx: StaffContext, input: In<typeof s.recordOrganisationManualInvoice>) =>
      services.call(bc.recordManualInvoice, { body: input.body }, onOrganisation(ctx, input.params.organisationId)),
    recordManualPayment: (ctx: StaffContext, input: In<typeof s.recordOrganisationManualPayment>) =>
      services.call(bc.recordManualPayment, { params: { invoiceId: input.params.invoiceId }, body: input.body },
        onOrganisation(ctx, input.params.organisationId)),

    // An Enterprise organisation's private links: ranges only, never a record value.
    listPrivateLinks: (ctx: StaffContext, input: In<typeof s.listOrganisationPrivateLinks>) =>
      services.call(listPrivateLinks, { query: input.query }, { request: { organisationId: input.params.organisationId }, ...as(ctx) }),
    addPrivateLink: (ctx: StaffContext, input: In<typeof s.addOrganisationPrivateLink>) =>
      services.call(addPrivateLink, { body: { ...input.body, operatorId: operatorId(ctx) } },
        { request: { organisationId: input.params.organisationId }, ...as(ctx) }),
    removePrivateLink: (ctx: StaffContext, input: In<typeof s.removeOrganisationPrivateLink>) =>
      services.call(removePrivateLink, { params: { linkId: input.params.linkId }, body: { ...input.body, operatorId: operatorId(ctx) } },
        { request: { organisationId: input.params.organisationId }, ...as(ctx) }),

    // ----------------------------------------------------------------------- OAuth

    addOAuthClient: (ctx: StaffContext, input: In<typeof s.addSiloOAuthClient>) =>
      services.call(registerSiloOAuthClient, { body: { ...input.body, operatorId: operatorId(ctx) } as never }, as(ctx)),

    // ----------------------------------------------------------------------- fleet

    registerRelease: (ctx: StaffContext, input: In<typeof s.registerFleetRelease>) =>
      services.call(registerRelease, { params: input.params, body: { manifest: input.body.manifest, operatorId: operatorId(ctx) } }, as(ctx)),
    readRelease: (ctx: StaffContext, input: In<typeof s.readFleetRelease>) => services.call(readRelease, { params: input.params }, as(ctx)),
    signBundle: (ctx: StaffContext, input: In<typeof s.signFleetBundle>) =>
      services.call(signBundle, { params: input.params, body: { ...input.body, operatorId: operatorId(ctx) } }, as(ctx)),

    async countersignBundle(ctx: StaffContext, input: In<typeof s.countersignFleetBundle>) {
      if (!ctx.staff.operator.sovereignAccessListed) {
        throw new AppError('forbidden', 'sovereign releases are countersigned by staff on the sovereign access list', { code: 'staff.not_sovereign_listed' });
      }
      return services.call(countersignBundle, { params: input.params, body: { ...input.body, operatorId: operatorId(ctx) } }, as(ctx));
    },

    requestPromotion: (ctx: StaffContext, input: In<typeof s.requestFleetPromotion>) =>
      services.call(requestPromotion, { params: input.params, body: { ...input.body, requestedBy: operatorId(ctx) } }, as(ctx)),
    readPromotion: (ctx: StaffContext, input: In<typeof s.readFleetPromotion>) => services.call(readPromotion, { params: input.params }, as(ctx)),

    async approvePromotion(ctx: StaffContext, input: In<typeof s.approveFleetPromotion>) {
      const promotion = await services.call(readPromotion, { params: input.params }, as(ctx));
      if (promotion.expedite) requireCapability(ctx.staff, 'fleet.release.expedite');
      return services.call(approvePromotion, { params: input.params, body: { approvedBy: operatorId(ctx) } }, as(ctx));
    },

    readChannel: (ctx: StaffContext, input: In<typeof s.readFleetChannel>) => services.call(readChannel, { params: input.params }, as(ctx)),
    readRollout: (ctx: StaffContext, input: In<typeof s.readFleetRollout>) => services.call(readRollout, { params: input.params }, as(ctx)),
    haltRollout: (ctx: StaffContext, input: In<typeof s.haltFleetRollout>) =>
      services.call(haltRollout, { params: input.params, body: { haltedBy: operatorId(ctx) } }, as(ctx)),
    uploadSbom: (ctx: StaffContext, input: In<typeof s.uploadFleetSbom>) =>
      services.call(putReleaseSbom, { params: input.params, body: { ...input.body, operatorId: operatorId(ctx) } }, as(ctx)),
    stateVex: (ctx: StaffContext, input: In<typeof s.stateFleetVex>) =>
      services.call(putReleaseVex, { params: input.params, body: { ...input.body, operatorId: operatorId(ctx) } }, as(ctx)),
    readFindings: (ctx: StaffContext, input: In<typeof s.readFleetFindings>) => services.call(readReleaseFindings, { params: input.params }, as(ctx)),
    syncAdvisories: (ctx: StaffContext) => services.call(syncAdvisories, { body: { operatorId: operatorId(ctx) } }, as(ctx)),
    startKeyRotation: (ctx: StaffContext, input: In<typeof s.startCellKeyRotation>) =>
      services.call(startKeyRotation, { body: { keyUri: input.body.keyUri, operatorId: operatorId(ctx) } }, as(ctx)),
    readKeyRotation: (ctx: StaffContext) => services.call(readKeyRotation, {}, as(ctx)),
    readFleetEvents: (ctx: StaffContext, input: In<typeof s.readFleetEvents>) => services.call(listFleetEvents, { query: input.query }, as(ctx)),
    verifyFleetEvents: (ctx: StaffContext) => services.call(verifyFleetEvents, {}, as(ctx)),

    // ----------------------------------------------------------------------- the status page and maintenance

    readStatus: (ctx: StaffContext) => services.call(readStatus, {}, as(ctx)),
    putNotice: (ctx: StaffContext, input: In<typeof s.putStatusNotice>) =>
      services.call(putNotice, { params: input.params, body: { ...input.body, postedBy: operatorId(ctx) } as never }, as(ctx)),
    putNoticeUpdate: (ctx: StaffContext, input: In<typeof s.putStatusNoticeUpdate>) =>
      services.call(putNoticeUpdate, { params: input.params, body: { ...input.body, postedBy: operatorId(ctx) } as never }, as(ctx)),
    maintenance: (ctx: StaffContext) => services.call(maintenanceStatus, {}, as(ctx)),

    // ----------------------------------------------------------------------- tenant migrations

    proposeRebalancing: (ctx: StaffContext, input: In<typeof s.proposeOrganisationRebalancing>) =>
      services.call(proposeRebalancing, {
        body: { operatorId: operatorId(ctx), organisationId: input.params.organisationId, destinationCellId: input.body.destinationCellId },
      }, as(ctx)),

    async signMigration(ctx: StaffContext, input: In<typeof s.signOrganisationMigration>) {
      if (input.body.role === 'sovereign_security_officer' && !ctx.staff.operator.sovereignAccessListed) {
        throw new AppError('forbidden', 'the sovereign security officer is on the sovereign access list', { code: 'staff.not_sovereign_listed' });
      }
      return services.call(signTenantMigration, {
        params: { migrationId: input.params.migrationId },
        body: { operatorId: operatorId(ctx), organisationId: input.params.organisationId, role: input.body.role },
      }, as(ctx));
    },

    scheduleMigration: (ctx: StaffContext, input: In<typeof s.scheduleOrganisationMigration>) =>
      services.call(scheduleTenantMigration, {
        params: { migrationId: input.params.migrationId },
        body: { ...(input.body as object), operatorId: operatorId(ctx), organisationId: input.params.organisationId } as never,
      }, as(ctx)),

    abortMigration: (ctx: StaffContext, input: In<typeof s.abortOrganisationMigration>) =>
      services.call(abortTenantMigration, {
        params: { migrationId: input.params.migrationId },
        body: { operatorId: operatorId(ctx), organisationId: input.params.organisationId, reason: input.body.reason },
      }, as(ctx)),

    importKey: (ctx: StaffContext) => services.call(getTenantImportKey, {}, as(ctx)),

  };
}

export type Operations = ReturnType<typeof createOperations>;
