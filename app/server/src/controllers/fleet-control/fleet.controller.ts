// fleet-control's endpoints: contracts to the fleet.
//
// Each cell's Fleet agent asks for its own release and reports its own verdicts (the HTTP
// layer names the calling cell); a caller inside the global tier itself may name any.

import type { countersignBundle, signBundle } from '../../contracts/fleet-control/bundle.contract.ts';
import type { readAgentBinary } from '../../contracts/fleet-control/agentBinary.contract.ts';
import type { readReleaseDocument } from '../../contracts/fleet-control/releaseDocument.contract.ts';
import type { readRelease, registerRelease } from '../../contracts/fleet-control/release.contract.ts';
import type { putReleaseSbom, putReleaseVex, readReleaseFindings, syncAdvisories } from '../../contracts/fleet-control/sbom.contract.ts';
import type { listCellEvents, listFleetEvents, reportMigrationApplied, verifyFleetEvents } from '../../contracts/fleet-control/events.contract.ts';
import type { getConceptTemplateSet } from '../../contracts/fleet-control/conceptTemplates.contract.ts';
import type {
  approvePromotion, desiredRelease, haltRollout, putCellChangePolicy, readChannel, readPromotion, readRollout, reportVerdict, requestPromotion,
} from '../../contracts/fleet-control/rollout.contract.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import type { Fleet } from '../../services/fleet-control/fleet.service.ts';
import type { SbomChecks } from '../../services/fleet-control/vulnerabilities.service.ts';
import { AppError } from '../../utils/errors.util.ts';

/** The SBOM endpoints; where advisories are not configured (the sovereign fleet-control), each refuses. */
export function sbomController(sbom: SbomChecks | undefined, logger: { failure(message: string, error: unknown, fields: object): void }): {
  putReleaseSbom: RouteHandlers<typeof putReleaseSbom>;
  putReleaseVex: RouteHandlers<typeof putReleaseVex>;
  readReleaseFindings: RouteHandlers<typeof readReleaseFindings>;
  syncAdvisories: RouteHandlers<typeof syncAdvisories>;
} {
  const checks = (): SbomChecks => {
    if (sbom === undefined) {
      throw new AppError('configuration', 'this fleet-control promotes nothing and checks no SBOMs', { code: 'fleet.sbom_checks_off' });
    }
    return sbom;
  };
  return {
    putReleaseSbom: { handle: (input) => checks().putSbom(input.params.releaseId, input.params.sha256, input.body.document, input.body.operatorId) },
    putReleaseVex: { handle: (input) => checks().putVex(input.params.releaseId, input.params.sha256, input.body.document, input.body.operatorId) },
    readReleaseFindings: { handle: (input) => checks().findings(input.params.releaseId) },
    syncAdvisories: {
      handle: async () => {
        // After the response: a first load of a feed takes minutes.
        void checks().run(true).catch((error: unknown) => logger.failure('an advisory sync asked for failed', error, { event: 'fleet.advisories_run_failed' }));
        return { accepted: true as const };
      },
    },
  };
}

export function fleetController(fleet: Fleet, selfCell: string): {
  registerRelease: RouteHandlers<typeof registerRelease>;
  readRelease: RouteHandlers<typeof readRelease>;
  requestPromotion: RouteHandlers<typeof requestPromotion>;
  approvePromotion: RouteHandlers<typeof approvePromotion>;
  readPromotion: RouteHandlers<typeof readPromotion>;
  readChannel: RouteHandlers<typeof readChannel>;
  desiredRelease: RouteHandlers<typeof desiredRelease>;
  reportVerdict: RouteHandlers<typeof reportVerdict>;
  putCellChangePolicy: RouteHandlers<typeof putCellChangePolicy>;
  listFleetEvents: RouteHandlers<typeof listFleetEvents>;
  verifyFleetEvents: RouteHandlers<typeof verifyFleetEvents>;
  listCellEvents: RouteHandlers<typeof listCellEvents>;
  getConceptTemplateSet: RouteHandlers<typeof getConceptTemplateSet>;
  reportMigrationApplied: RouteHandlers<typeof reportMigrationApplied>;
  haltRollout: RouteHandlers<typeof haltRollout>;
  readRollout: RouteHandlers<typeof readRollout>;
  signBundle: RouteHandlers<typeof signBundle>;
  countersignBundle: RouteHandlers<typeof countersignBundle>;
  readAgentBinary: RouteHandlers<typeof readAgentBinary>;
  readReleaseDocument: RouteHandlers<typeof readReleaseDocument>;
} {
  const ownCell = (ctx: HandlerContext, cellId: string): void => {
    if (ctx.callerCell !== selfCell && ctx.callerCell !== cellId) {
      throw new AppError('forbidden', 'a cell asks and reports only for itself', { code: 'fleet.foreign_cell', details: { callerCell: ctx.callerCell } });
    }
  };
  return {
    registerRelease: { handle: (input) => fleet.registerRelease(input.params.releaseId, input.body.manifest, input.body.operatorId) },
    readRelease: { handle: (input) => fleet.readRelease(input.params.releaseId) },
    requestPromotion: { handle: (input) => fleet.requestPromotion(input.params.promotionId, input.body) },
    approvePromotion: { handle: (input) => fleet.approvePromotion(input.params.promotionId, input.body.approvedBy) },
    readPromotion: { handle: (input) => fleet.readPromotion(input.params.promotionId) },
    readChannel: { handle: (input) => fleet.readChannel(input.params.channel) },
    desiredRelease: {
      handle: (input, ctx) => {
        ownCell(ctx, input.params.cellId);
        return fleet.desiredRelease(input.params.cellId, input.query.channel);
      },
    },
    reportVerdict: {
      handle: (input, ctx) => {
        ownCell(ctx, input.params.cellId);
        return fleet.reportVerdict(input.params.rolloutId, input.params.cellId, input.body.releaseId, input.body.gates);
      },
    },
    putCellChangePolicy: {
      handle: (input, ctx) => {
        ownCell(ctx, input.params.cellId);
        return fleet.putCellChangePolicy(input.params.cellId, input.body);
      },
    },
    listFleetEvents: {
      handle: (input) => fleet.listEvents({
        after: Number(input.query.after ?? 0), releaseId: input.query.releaseId, cellId: input.query.cellId,
        limit: Math.min(Math.max(Number(input.query.limit ?? 200), 1), 1_000),
      }),
    },
    verifyFleetEvents: { handle: () => fleet.verifyEvents() },
    getConceptTemplateSet: { handle: () => fleet.templateSet() },
    listCellEvents: {
      handle: (input, ctx) => {
        ownCell(ctx, input.params.cellId);
        return fleet.listEvents({ after: Number(input.query.after ?? 0), cellId: input.params.cellId, limit: 500 });
      },
    },
    reportMigrationApplied: {
      handle: (input, ctx) => {
        ownCell(ctx, input.params.cellId);
        return fleet.reportMigrationApplied(input.params.cellId, input.params.releaseId, {
          database: input.params.database, version: input.params.version, ...input.body,
        });
      },
    },
    haltRollout: {
      handle: (input, ctx) => {
        ctx.logger.warn('rollout halt requested', { event: 'fleet.rollout_halt_requested', resourceType: 'operator', resourceId: input.body.haltedBy });
        return fleet.haltRollout(input.params.rolloutId, input.body.haltedBy);
      },
    },
    readRollout: { handle: (input) => fleet.readRollout(input.params.rolloutId) },
    signBundle: {
      handle: (input, ctx) => {
        ctx.logger.info('bundle signing requested', { event: 'fleet.bundle_sign_requested', resourceType: 'operator', resourceId: input.body.operatorId });
        return fleet.signBundle(input.params.bundleId, input.body);
      },
    },
    countersignBundle: {
      handle: (input, ctx) => {
        ctx.logger.info('countersignature requested', {
          event: 'fleet.countersign_requested', resourceType: 'operator', resourceId: input.body.operatorId,
        });
        return fleet.countersignBundle(input.params.bundleId, input.body.bundle, input.body.signatures);
      },
    },
    readAgentBinary: { handle: (input) => fleet.readAgentBinary(input.params.sha256, input.query.offset) },
    readReleaseDocument: { handle: (input) => fleet.readReleaseDocument(input.params.sha256) },
  };
}
