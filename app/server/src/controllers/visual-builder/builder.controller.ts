// visual-builder's endpoints: parsed input to the visual builder and back.

import type {
  convertDraft, importDraft, publishDraft, setBuildSecrets, tryDraft, validateDraft,
} from '../../contracts/visual-builder/builder.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { VisualBuilder } from '../../services/visual-builder/visualBuilder.service.ts';

export function builderController(builder: VisualBuilder) {
  return {
    validateDraft: {
      handle: async ({ body }, ctx) => builder.validate(ctx, body),
    } satisfies RouteHandlers<typeof validateDraft>,
    convertDraft: {
      handle: async ({ body }, ctx) => builder.convert(ctx, body),
    } satisfies RouteHandlers<typeof convertDraft>,
    importDraft: {
      handle: async ({ body }, ctx) => builder.import(ctx, body),
    } satisfies RouteHandlers<typeof importDraft>,
    tryDraft: {
      handle: ({ body }, ctx) => builder.tryDraft(ctx, body),
      // The probe run the try recorded: a retry reads its version through its connection again.
      resultRef: (out) => out.probeRunId,
      replay: (ref, ctx) => builder.replayTry(ctx, ref!),
    } satisfies RouteHandlers<typeof tryDraft>,
    publishDraft: {
      handle: ({ body }, ctx) => builder.publish(ctx, body),
      resultRef: (out) => out.conformanceRunId,
      replay: (ref, ctx) => builder.replayPublish(ctx, ref!),
    } satisfies RouteHandlers<typeof publishDraft>,
    setBuildSecrets: {
      handle: ({ params, body }, ctx) => builder.setSecrets(ctx, params.connectionId, body.values),
    } satisfies RouteHandlers<typeof setBuildSecrets>,
  };
}
