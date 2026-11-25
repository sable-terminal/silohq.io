// The audit read endpoints: contract to the reader.

import type {
  listAuditEvents, listAuthEvents, listChainHeads, listCredentialUnwraps, listPartitionSeals, readAuditChain,
} from '../../contracts/audit/read.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { AuditReader } from '../../services/audit/read.service.ts';

export function readController(reader: AuditReader): {
  listAuditEvents: RouteHandlers<typeof listAuditEvents>;
  listAuthEvents: RouteHandlers<typeof listAuthEvents>;
  listCredentialUnwraps: RouteHandlers<typeof listCredentialUnwraps>;
  listChainHeads: RouteHandlers<typeof listChainHeads>;
  readAuditChain: RouteHandlers<typeof readAuditChain>;
  listPartitionSeals: RouteHandlers<typeof listPartitionSeals>;
} {
  return {
    listAuditEvents: { handle: (input, ctx) => reader.listEvents(ctx, input.query) },
    listAuthEvents: { handle: (input, ctx) => reader.listAuthEvents(ctx, input.query) },
    listCredentialUnwraps: { handle: (input, ctx) => reader.listCredentialUnwraps(ctx, input.query) },
    listChainHeads: { handle: (input, ctx) => reader.listChainHeads(ctx, input.query) },
    readAuditChain: { handle: (input, ctx) => reader.readChain(ctx, input.query) },
    listPartitionSeals: { handle: (input, ctx) => reader.listSeals(ctx, input.query) },
  };
}
