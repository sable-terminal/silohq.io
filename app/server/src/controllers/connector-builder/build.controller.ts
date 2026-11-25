// connector-builder's endpoints: parsed input to the AI builder and back.

import type {
  confirmBuild, draftConnector, getBuild, previewBuild, probeBuild,
} from '../../contracts/connector-builder/build.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { ConnectorBuilder } from '../../services/connector-builder/builder.service.ts';

export function buildController(builder: ConnectorBuilder) {
  return {
    draftConnector: {
      handle: ({ body }, ctx) => builder.draft(ctx, body),
      // The sandbox connection identifies the build: a retry reads it back.
      resultRef: (out) => out.connectionId,
      replay: (ref, ctx) => builder.get(ctx, ref!),
    } satisfies RouteHandlers<typeof draftConnector>,
    probeBuild: {
      handle: ({ params }, ctx) => builder.probe(ctx, params.connectionId),
      resultRef: (out) => out.connectionId,
      replay: (ref, ctx) => builder.get(ctx, ref!),
    } satisfies RouteHandlers<typeof probeBuild>,
    getBuild: {
      handle: ({ params }, ctx) => builder.get(ctx, params.connectionId),
    } satisfies RouteHandlers<typeof getBuild>,
    previewBuild: {
      handle: ({ params, body }, ctx) => builder.preview(ctx, params.connectionId, body.object, body.limit),
    } satisfies RouteHandlers<typeof previewBuild>,
    confirmBuild: {
      handle: ({ params, body }, ctx) => builder.confirm(ctx, params.connectionId, body.decisions),
      resultRef: (out) => out.connectionId,
      replay: (ref, ctx) => builder.get(ctx, ref!),
    } satisfies RouteHandlers<typeof confirmBuild>,
  };
}
