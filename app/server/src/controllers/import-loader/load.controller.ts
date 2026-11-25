// The Import row store's endpoints: thin, over services/import-loader. siloes-import is the
// only caller; it acts in the organisation whose Silo the rows belong to.

import type {
  confirmImportValues, dropExpiredImportRows, dropImportDataset, loadImportRows, purgeImportFile, purgeImportObject,
} from '../../contracts/import-loader/load.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as loader from '../../services/import-loader/loader.service.ts';

export function loadController(deps: loader.LoaderDeps): {
  loadImportRows: RouteHandlers<typeof loadImportRows>;
  purgeImportFile: RouteHandlers<typeof purgeImportFile>;
  confirmImportValues: RouteHandlers<typeof confirmImportValues>;
  dropExpiredImportRows: RouteHandlers<typeof dropExpiredImportRows>;
  dropImportDataset: RouteHandlers<typeof dropImportDataset>;
  purgeImportObject: RouteHandlers<typeof purgeImportObject>;
} {
  return {
    loadImportRows: {
      handle: (input, ctx) => loader.loadRows(deps, ctx, input.body),
      resultRef: loader.loadRef,
      // A retried load answers with the first load's job: nothing is written again.
      replay: async (ref) => loader.replayLoad(ref),
    },
    purgeImportFile: { handle: (input, ctx) => loader.purgeFile(deps, ctx, { ...input.body, fileId: input.params.fileId }) },
    confirmImportValues: { handle: (input, ctx) => loader.confirmValues(deps, ctx, input.body) },
    dropExpiredImportRows: { handle: (input, ctx) => loader.dropExpired(deps, ctx, input.body) },
    dropImportDataset: { handle: (input, ctx) => loader.dropDataset(deps, ctx, input.body.siloId) },
    purgeImportObject: { handle: (input, ctx) => loader.purgeObject(deps, ctx, input.body.siloId, input.body.object) },
  };
}
