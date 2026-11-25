// schema-inference's endpoint: parsed input to the inference service and back.

import type { inferConnection } from '../../contracts/schema-inference/inference.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { SchemaInference } from '../../services/schema-inference/schemaInference.service.ts';

export function inferenceController(inference: SchemaInference) {
  return {
    inferConnection: {
      handle: ({ body }, ctx) => inference.infer(ctx, body),
    } satisfies RouteHandlers<typeof inferConnection>,
  };
}
