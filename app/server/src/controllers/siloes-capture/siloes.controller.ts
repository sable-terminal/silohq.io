// The Siloes endpoints owned by siloes-capture: thin, over services/siloes-capture.

import type * as c from '../../contracts/siloes/siloes.contract.ts';
import type * as l from '../../contracts/siloes/captureLedger.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { readCaptureCoverage, readHistory, readObjectChanges } from '../../services/siloes-capture/capture.service.ts';
import { readStateAt } from '../../services/siloes-capture/time.service.ts';
import * as ledger from '../../services/siloes-capture/ledger.service.ts';
import * as move from '../../services/siloes-capture/move.service.ts';
import { loadSiloView } from '../../services/siloes-capture/deps.service.ts';
import * as purge from '../../services/siloes-capture/purge.service.ts';
import { sweepOrganisation } from '../../services/siloes-capture/retention.service.ts';
import * as siloes from '../../services/siloes-capture/siloes.service.ts';

type ContractName = 'getSiloesSetting' | 'setSiloesEnabled' | 'listSiloes' | 'getSiloesWeb' | 'getSilo' | 'createCaptureSilo' | 'addCaptureType'
  | 'changeCaptureProperties' | 'removeCaptureType' | 'changeRetention' | 'requestPurge' | 'previewPurge' | 'getPurge' | 'listPurges' | 'readHistory'
  | 'runRetentionSweep' | 'readStateAt' | 'readObjectChanges' | 'readCaptureCoverage' | 'adoptMovedSiloes' | 'releaseMovedSiloes';
type Handlers<K extends ContractName> = RouteHandlers<(typeof c)[K]>;
type LedgerHandlers<K extends keyof typeof l & ('setCaptureActionLedger' | 'writeCaptureLedger' | 'purgeCaptureLedgerValues' | 'listCaptureLedger')> =
  RouteHandlers<(typeof l)[K]>;

export function siloesController(deps: purge.PurgeDeps): {
  getSiloesSetting: Handlers<'getSiloesSetting'>; setSiloesEnabled: Handlers<'setSiloesEnabled'>; listSiloes: Handlers<'listSiloes'>; getSiloesWeb: Handlers<'getSiloesWeb'>;
  getSilo: Handlers<'getSilo'>; createCaptureSilo: Handlers<'createCaptureSilo'>; addCaptureType: Handlers<'addCaptureType'>;
  changeCaptureProperties: Handlers<'changeCaptureProperties'>; removeCaptureType: Handlers<'removeCaptureType'>;
  changeRetention: Handlers<'changeRetention'>; requestPurge: Handlers<'requestPurge'>; previewPurge: Handlers<'previewPurge'>;
  getPurge: Handlers<'getPurge'>; listPurges: Handlers<'listPurges'>; readHistory: Handlers<'readHistory'>; runRetentionSweep: Handlers<'runRetentionSweep'>;
  readStateAt: Handlers<'readStateAt'>; readObjectChanges: Handlers<'readObjectChanges'>; readCaptureCoverage: Handlers<'readCaptureCoverage'>;
  adoptMovedSiloes: Handlers<'adoptMovedSiloes'>; releaseMovedSiloes: Handlers<'releaseMovedSiloes'>;
  setCaptureActionLedger: LedgerHandlers<'setCaptureActionLedger'>; writeCaptureLedger: LedgerHandlers<'writeCaptureLedger'>;
  purgeCaptureLedgerValues: LedgerHandlers<'purgeCaptureLedgerValues'>; listCaptureLedger: LedgerHandlers<'listCaptureLedger'>;
} {
  return {
    getSiloesSetting: { handle: (_input, ctx) => siloes.getSetting(deps, ctx) },
    setSiloesEnabled: { handle: (input, ctx) => siloes.setEnabled(deps, ctx, input.body.enabled) },
    listSiloes: { handle: (input, ctx) => siloes.listSiloes(deps, ctx, input.query.includeDisabled === 'true') },
    getSiloesWeb: { handle: (_input, ctx) => siloes.getSiloesWeb(deps, ctx) },
    getSilo: { handle: (input, ctx) => siloes.getSilo(deps, ctx, input.params.siloId) },
    createCaptureSilo: {
      handle: (input, ctx) => siloes.createCaptureSilo(deps, ctx, input.body),
      resultRef: (out) => out.id,
      // A retried create answers with the Silo it made, as it stands now.
      replay: (ref, ctx) => loadSiloView(deps, ctx, ref!),
    },
    addCaptureType: { handle: (input, ctx) => siloes.addCaptureType(deps, ctx, input.params.siloId, input.body) },
    changeCaptureProperties: {
      handle: (input, ctx) => siloes.changeCaptureProperties(deps, ctx, input.params.siloId, input.params.objectTypeId, input.body.properties),
    },
    removeCaptureType: { handle: (input, ctx) => siloes.removeCaptureType(deps, ctx, input.params.siloId, input.params.objectTypeId) },
    changeRetention: { handle: (input, ctx) => siloes.changeRetention(deps, ctx, input.params.siloId, input.body.retentionDays) },
    requestPurge: { handle: (input, ctx) => purge.requestPurge(deps, ctx, input.params.siloId, input.body) },
    previewPurge: { handle: (input, ctx) => purge.previewPurge(deps, ctx, input.params.siloId, input.body) },
    getPurge: { handle: (input, ctx) => purge.getPurge(deps, ctx, input.params.siloId, input.params.purgeId) },
    listPurges: { handle: (input, ctx) => purge.listPurges(deps, ctx, input.params.siloId, input.query.limit) },
    readHistory: { handle: (input, ctx) => readHistory(deps, ctx, input.body) as never },
    readObjectChanges: { handle: (input, ctx) => readObjectChanges(deps, ctx, input.body) },
    readCaptureCoverage: { handle: (input, ctx) => readCaptureCoverage(deps, ctx, input.body) },
    readStateAt: { handle: (input, ctx) => readStateAt(deps, ctx, input.body) as never },
    runRetentionSweep: { handle: async (_input, ctx) => ({ siloes: await sweepOrganisation(deps, ctx.request.organisationId!, ctx.correlationId) }) },
    setCaptureActionLedger: {
      handle: (input, ctx) => ledger.setCaptureActionLedger(deps, ctx, input.params.siloId, input.body.mode, input.body.disclosureAcknowledged),
    },
    writeCaptureLedger: { handle: (input, ctx) => ledger.writeCaptureLedger(deps, ctx, input.body.receiptId, input.body.rows) },
    purgeCaptureLedgerValues: { handle: (input, ctx) => ledger.purgeCaptureLedgerValues(deps, ctx, input.body.receiptIds) },
    listCaptureLedger: { handle: (input, ctx) => ledger.listCaptureLedger(deps, ctx, input.params.siloId, input.query) },
    adoptMovedSiloes: { handle: (_input, ctx) => move.adoptMovedSiloes(deps, ctx) },
    releaseMovedSiloes: { handle: (_input, ctx) => move.releaseMovedSiloes(deps, ctx) },
  };
}
