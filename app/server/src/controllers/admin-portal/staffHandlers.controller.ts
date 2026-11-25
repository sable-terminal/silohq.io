// Each staff route's handler: thin, over services/admin-portal. The staff console's
// pipeline (staff.controller) has resolved the member of staff and checked the route's
// capability before any of these runs.

import type * as s from '../../contracts/admin-portal/staffApi.contract.ts';
import type { BreakGlass } from '../../services/admin-portal/breakGlass.service.ts';
import type { StaffContext } from '../../services/admin-portal/deps.service.ts';
import type { Operations } from '../../services/admin-portal/operations.service.ts';
import type { Operators } from '../../services/admin-portal/operators.service.ts';
import type { StaffAuth } from '../../services/admin-portal/staffAuth.service.ts';
import type { SovereignTerms } from '../../services/admin-portal/sovereignTerms.service.ts';
import type { SupportTickets } from '../../services/admin-portal/supportTickets.service.ts';
import type { StaffHandler, StaffRequestContext } from './staff.controller.ts';

type Handlers = Record<(typeof s.STAFF_ROUTES)[number]['name'], StaffHandler>;

const signedIn = (ctx: StaffRequestContext): StaffContext => ({ staff: ctx.staff!, correlationId: ctx.correlationId });

const selfOf = (ctx: StaffContext) => ({
  operatorId: ctx.staff.operator.id, displayName: ctx.staff.operator.displayName, clearance: ctx.staff.operator.clearance,
  sovereignAccessListed: ctx.staff.operator.sovereignAccessListed, capabilities: [...ctx.staff.capabilities],
  expiresAt: ctx.staff.absoluteExpiresAt,
});

export function staffHandlers(d: {
  auth: StaffAuth; operators: Operators; breakGlass: BreakGlass; operations: Operations; sovereignTerms: SovereignTerms; supportTickets: SupportTickets;
}): Handlers {
  const { auth, operators, breakGlass: bg, operations: ops, sovereignTerms: terms, supportTickets: tickets } = d;
  const handle = (work: (input: { params: any; query: any; body: any }, ctx: StaffContext) => Promise<unknown>): StaffHandler =>
    (input, ctx) => work(input, signedIn(ctx));
  return {
    startStaffSignIn: () => auth.start(),
    completeStaffSignIn: async (input, ctx) => {
      const signed = await auth.complete(input.body, ctx.correlationId);
      return {
        established: { token: signed.token, absoluteExpiresAt: signed.staff.absoluteExpiresAt },
        body: selfOf({ staff: signed.staff, correlationId: ctx.correlationId }),
      };
    },
    readStaffSelf: handle(async (_input, ctx) => selfOf(ctx)),
    listSupportQueue: handle((input, ctx) => tickets.queue(ctx, input.query.limit)),
    readSupportTicketForStaff: handle((input, ctx) => tickets.readForStaff(ctx, input.params.reference)),
    replyToSupportTicketAsStaff: handle((input, ctx) => tickets.replyAsStaff(ctx, input.params.reference, input.body)),
    updateSupportTicketAsStaff: handle((input, ctx) => tickets.updateAsStaff(ctx, input.params.reference, input.body)),
    endStaffSession: async (_input, ctx) => auth.end(ctx.token),
    findOrganisation: handle((input) => ops.findOrganisation(input.params.slug)),

    requestAccess: handle((input, ctx) => bg.request(ctx, input.body)),
    listOpenAccess: handle(async (input) => ({ sessions: await bg.listOpen(input.query.limit) })),
    getAccess: handle((input) => bg.get(input.params.organisationId, input.params.sessionId)),
    approveAccess: handle((input, ctx) => bg.approve(ctx, input.params.organisationId, input.params.sessionId)),
    startAccess: handle((input, ctx) => bg.start(ctx, input.params.organisationId, input.params.sessionId)),
    endAccess: handle((input, ctx) => bg.end(ctx, input.params.organisationId, input.params.sessionId)),
    cancelAccess: handle((input, ctx) => bg.cancel(ctx, input.params.organisationId, input.params.sessionId)),

    sessionAuditEvents: handle((input, ctx) => ops.auditEvents(ctx, input)),
    sessionManifest: handle((input, ctx) => ops.manifest(ctx, input)),
    sessionTenantTables: handle((input, ctx) => ops.tenantTables(ctx, input)),
    sessionTenantRows: handle((input, ctx) => ops.tenantRows(ctx, input)),
    sessionEngagementCost: handle((input, ctx) => ops.engagementCost(ctx, input)),
    sessionBillingStatus: handle((input, ctx) => ops.billingStatus(ctx, input)),

    runOrganisationRetention: handle((input, ctx) => ops.runRetention(ctx, input.params.organisationId)),
    runOrganisationBigQueryMeasurement: handle((input, ctx) => ops.measureBigQuery(ctx, input.params.organisationId)),
    quoteOrganisationContract: handle((input, ctx) => ops.quoteContract(ctx, input)),
    createOrganisationContract: handle((input, ctx) => ops.createContract(ctx, input)),
    enterSovereignTerms: handle((input, ctx) => terms.enter(ctx, input.params.organisationId, input.body)),
    listSovereignTerms: handle((input) => terms.list(input.params.organisationId)),
    decideSovereignTerms: handle((input, ctx) => terms.decide(ctx, input.params.organisationId, input.params.termsId, input.body.decision)),
    listOrganisationContracts: handle((input, ctx) => ops.listContracts(ctx, input)),
    amendOrganisationContractDraft: handle((input, ctx) => ops.amendContractDraft(ctx, input)),
    approveOrganisationContractMargin: handle((input, ctx) => ops.approveContractMargin(ctx, input)),
    activateOrganisationContract: handle((input, ctx) => ops.activateContract(ctx, input)),
    amendOrganisationContract: handle((input, ctx) => ops.amendContract(ctx, input)),
    renewOrganisationContract: handle((input, ctx) => ops.renewContract(ctx, input)),
    setOrganisationContractRenewalState: handle((input, ctx) => ops.setContractRenewalState(ctx, input)),
    readOrganisationContractUsage: handle((input, ctx) => ops.contractUsage(ctx, input)),
    raiseOrganisationContractInvoice: handle((input, ctx) => ops.raiseContractInvoice(ctx, input)),
    recordOrganisationManualInvoice: handle((input, ctx) => ops.recordManualInvoice(ctx, input)),
    recordOrganisationManualPayment: handle((input, ctx) => ops.recordManualPayment(ctx, input)),
    listOrganisationPrivateLinks: handle((input, ctx) => ops.listPrivateLinks(ctx, input)),
    addOrganisationPrivateLink: handle((input, ctx) => ops.addPrivateLink(ctx, input)),
    removeOrganisationPrivateLink: handle((input, ctx) => ops.removePrivateLink(ctx, input)),

    listOperators: handle((input) => operators.list(input.query)),
    addOperator: handle((input, ctx) => operators.add(ctx, input.body)),
    changeOperator: handle((input, ctx) => operators.change(ctx, input.params.operatorId, input.body)),
    reviewOperator: handle((input, ctx) => operators.review(ctx, input.params.operatorId)),
    setOperatorStatus: handle((input, ctx) => operators.setStatus(ctx, input.params.operatorId, input.body.status)),

    addSiloOAuthClient: handle((input, ctx) => ops.addOAuthClient(ctx, input)),

    registerFleetRelease: handle((input, ctx) => ops.registerRelease(ctx, input)),
    readFleetRelease: handle((input, ctx) => ops.readRelease(ctx, input)),
    signFleetBundle: handle((input, ctx) => ops.signBundle(ctx, input)),
    countersignFleetBundle: handle((input, ctx) => ops.countersignBundle(ctx, input)),
    requestFleetPromotion: handle((input, ctx) => ops.requestPromotion(ctx, input)),
    readFleetPromotion: handle((input, ctx) => ops.readPromotion(ctx, input)),
    approveFleetPromotion: handle((input, ctx) => ops.approvePromotion(ctx, input)),
    readFleetChannel: handle((input, ctx) => ops.readChannel(ctx, input)),
    readFleetRollout: handle((input, ctx) => ops.readRollout(ctx, input)),
    haltFleetRollout: handle((input, ctx) => ops.haltRollout(ctx, input)),
    uploadFleetSbom: handle((input, ctx) => ops.uploadSbom(ctx, input)),
    stateFleetVex: handle((input, ctx) => ops.stateVex(ctx, input)),
    readFleetFindings: handle((input, ctx) => ops.readFindings(ctx, input)),
    syncFleetAdvisories: handle((_input, ctx) => ops.syncAdvisories(ctx)),
    startCellKeyRotation: handle((input, ctx) => ops.startKeyRotation(ctx, input as never)),
    readCellKeyRotation: handle((_input, ctx) => ops.readKeyRotation(ctx)),
    readFleetEvents: handle((input, ctx) => ops.readFleetEvents(ctx, input)),
    verifyFleetEventChain: handle((_input, ctx) => ops.verifyFleetEvents(ctx)),

    readStatusPage: handle((_input, ctx) => ops.readStatus(ctx)),
    putStatusNotice: handle((input, ctx) => ops.putNotice(ctx, input)),
    putStatusNoticeUpdate: handle((input, ctx) => ops.putNoticeUpdate(ctx, input)),
    readMaintenance: handle((_input, ctx) => ops.maintenance(ctx)),

    proposeOrganisationRebalancing: handle((input, ctx) => ops.proposeRebalancing(ctx, input)),
    signOrganisationMigration: handle((input, ctx) => ops.signMigration(ctx, input)),
    scheduleOrganisationMigration: handle((input, ctx) => ops.scheduleMigration(ctx, input)),
    abortOrganisationMigration: handle((input, ctx) => ops.abortMigration(ctx, input)),
    readTenantImportKey: handle((_input, ctx) => ops.importKey(ctx)),
  };
}
