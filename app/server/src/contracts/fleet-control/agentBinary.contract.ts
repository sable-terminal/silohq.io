// Silo Agent binaries in fleet-control's artefact store (spec 11.1, 10.7): held by the SHA-256
// of their bytes, put there by the build that made them (src/scripts/putAgentBinary.script.ts),
// and read in parts by each cell's Fleet agent, which copies them into the cell for its agents
// to download over their tunnels. A release names each platform's binary by that digest, and
// an agent channel takes a release only once every binary it names is in the store, whole.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

/** The most a part carries. */
export const AGENT_BINARY_PART_BYTES = 4 * 1024 * 1024;
/** The largest binary Fleet holds or a cell takes. */
export const MAX_AGENT_BINARY_BYTES = 256 * 1024 * 1024;

export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex');

/** Where a binary is in the artefact store. */
export const agentBinaryKey = (hex: string): string => `agent-binaries/${sha256Hex.parse(hex)}`;

export const readAgentBinary = defineContract({
  service: 'fleet-control', name: 'readAgentBinary', method: 'GET', path: '/v1/agent-binaries/:sha256',
  callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ sha256: sha256Hex }),
  query: z.strictObject({ offset: z.coerce.number().int().min(0).max(MAX_AGENT_BINARY_BYTES) }),
  response: z.object({
    /** The whole binary's size. */
    bytes: z.int().min(1).max(MAX_AGENT_BINARY_BYTES),
    offset: z.int().min(0),
    /** At most AGENT_BINARY_PART_BYTES from offset, base64. */
    data: z.base64(),
  }),
});
