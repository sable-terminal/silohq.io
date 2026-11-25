// The Object Index endpoints: thin, over services/index-builder.

import { indexCoverage, readIndex } from '../../services/index-builder/read.service.ts';
import type { applyIndexObservations } from '../../contracts/index-builder/observations.contract.ts';
import type {
  addIndexType, changeIndexProperties, createObjectIndex, exportObjectIndex, getObjectIndex, purgeObjectIndex, rebuildIndexType, removeIndexType,
  objectIndexCoverage, readObjectIndex, searchObjectIndex, sweepObjectIndex,
} from '../../contracts/index-builder/index.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { indexDefinitionRepo } from '../../repos/siloes/index.repo.ts';
import * as index from '../../services/index-builder/index.service.ts';
import { startRefresh } from '../../services/index-builder/refresh.service.ts';
import { applyObservations as applyIndex } from '../../services/index-builder/observations.service.ts';
import { searchIndex } from '../../services/index-builder/search.service.ts';
import { recordEvent } from '../../services/warehouse-schema/warehouse.service.ts';
import { AppError } from '../../utils/errors.util.ts';

export function indexController(deps: index.IndexDeps): {
  createObjectIndex: RouteHandlers<typeof createObjectIndex>;
  getObjectIndex: RouteHandlers<typeof getObjectIndex>;
  addIndexType: RouteHandlers<typeof addIndexType>;
  changeIndexProperties: RouteHandlers<typeof changeIndexProperties>;
  removeIndexType: RouteHandlers<typeof removeIndexType>;
  rebuildIndexType: RouteHandlers<typeof rebuildIndexType>;
  searchObjectIndex: RouteHandlers<typeof searchObjectIndex>;
  objectIndexCoverage: RouteHandlers<typeof objectIndexCoverage>;
  readObjectIndex: RouteHandlers<typeof readObjectIndex>;
  purgeObjectIndex: RouteHandlers<typeof purgeObjectIndex>;
  sweepObjectIndex: RouteHandlers<typeof sweepObjectIndex>;
  exportObjectIndex: RouteHandlers<typeof exportObjectIndex>;
  applyIndexObservations: RouteHandlers<typeof applyIndexObservations>;
} {
  return {
    applyIndexObservations: { handle: (input, ctx) => applyIndex(deps, ctx, input.body.siloId, input.body.entries) },
    createObjectIndex: {
      handle: (input, ctx) => index.createObjectIndex(deps, ctx, input.body),
      resultRef: (out) => out.id,
      // A retried create answers with the Object Index it made, as it stands now.
      replay: (ref, ctx) => index.loadIndexView(deps, ctx, ref!),
    },
    getObjectIndex: { handle: (input, ctx) => index.getObjectIndex(deps, ctx, input.params.siloId) },
    exportObjectIndex: { handle: (input, ctx) => index.exportIndexPage(deps, ctx, input.body) },
    addIndexType: {
      async handle(input, ctx) {
        const added = await index.addIndexType(deps, ctx, input.params.siloId, input.body);
        // The first refresh builds the entries at once (69.4), then the schedule keeps them.
        await startRefresh(deps, added.row, 'schedule', ctx.correlationId);
        return added.definition;
      },
    },
    changeIndexProperties: {
      async handle(input, ctx) {
        const changed = await index.changeIndexProperties(deps, ctx, input.params.siloId, input.params.definitionId, input.body.properties);
        await startRefresh(deps, changed.row, 'schedule', ctx.correlationId);
        return changed.definition;
      },
    },
    removeIndexType: { handle: (input, ctx) => index.removeIndexType(deps, ctx, input.params.siloId, input.params.definitionId) },
    rebuildIndexType: {
      async handle(input, ctx) {
        // siloes-capture rebuilding an index the organisation brought with it (6.4; D212) acts for no member: no permission of a person applies.
        const view = ctx.caller === 'siloes-capture' ? await index.indexViewForMove(deps, ctx, input.params.siloId) : await index.getObjectIndex(deps, ctx, input.params.siloId);
        const definition = view.definitions.find((d) => d.id === input.params.definitionId && d.removedAt === null);
        if (definition === undefined) throw new AppError('not_found', 'no such nomination', { code: 'index.definition_not_found' });
        const row = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
          await recordEvent(db, ctx.request, ctx.correlationId, {
            event: 'index_rebuilt', resource: { type: 'silo', id: view.id }, detail: { definition_id: definition.id },
          });
          return (await indexDefinitionRepo.findById(db, definition.id))!;
        });
        const refreshId = await startRefresh(deps, row, 'rebuild', ctx.correlationId);
        if (refreshId === undefined) throw new AppError('conflict', 'a refresh of this nomination is already running', { code: 'index.refresh_running' });
        return { refreshId };
      },
    },
    searchObjectIndex: { handle: (input, ctx) => searchIndex(deps, ctx, input.body) },
    objectIndexCoverage: { handle: (input, ctx) => indexCoverage(deps, ctx, input.body.objectTypeIds) },
    readObjectIndex: { handle: (input, ctx) => readIndex(deps, ctx, input.body) as never },
    purgeObjectIndex: { handle: (input, ctx) => index.purgeObjectIndex(deps, ctx, input.params.siloId, input.body.objectTypeId) },
    sweepObjectIndex: { handle: (input, ctx) => index.sweepIndex(deps, ctx, input.params.siloId, input.body.refreshedBefore) },
  };
}
