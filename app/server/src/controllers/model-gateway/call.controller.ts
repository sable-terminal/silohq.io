// The model-gateway endpoints: contract to gateway.

import type { callModel } from '../../contracts/model-gateway/call.contract.ts';
import type { embedTexts } from '../../contracts/model-gateway/embedding.contract.ts';
import type { extractDocument } from '../../contracts/model-gateway/extraction.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { ModelGateway } from '../../services/model-gateway/gateway.service.ts';

export function callController(gateway: ModelGateway): {
  callModel: RouteHandlers<typeof callModel>;
  extractDocument: RouteHandlers<typeof extractDocument>;
  embedTexts: RouteHandlers<typeof embedTexts>;
} {
  return {
    callModel: { handle: (input, ctx) => gateway.call(input.body, ctx) },
    extractDocument: { handle: (input, ctx) => gateway.extract(input.body, ctx) },
    embedTexts: { handle: (input, ctx) => gateway.embed(input.body, ctx) },
  };
}
