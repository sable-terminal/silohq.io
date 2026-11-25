// Agent releases arriving in the cell (spec 10.7, 11.1, 11.4). The cell's Fleet agent pulls its
// agent channel from fleet-control, checks the channel head and the release it names, copies
// each platform's binary into the cell's object storage by digest, and installs the release
// here. connect-runtime checks it all again before any agent is offered it: both signatures
// by the Silo release key, the head naming this release on this cell's agent channel, the
// manifest's digest, the build target, and every binary's bytes against its digest.
//
// The head and the manifest travel as the canonical JSON text fleet-control signed, and are
// kept as that text: the agent verifies the same bytes, without canonicalising anything itself.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { signatureRecord } from '../fleet-control/release.contract.ts';

const signedText = (max: number) => z.strictObject({
  /** Canonical JSON, exactly as signed. */
  text: z.string().min(2).max(max),
  signatures: z.array(signatureRecord).min(1).max(8),
});

export const installAgentRelease = defineContract({
  service: 'connect-runtime', name: 'installAgentRelease', method: 'POST', path: '/v1/agent-releases',
  callers: ['fleet-control'],
  // A release installed again changes nothing.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    /** The channel head (silo.channel.v1) naming the release. */
    head: signedText(4096),
    /** The release manifest (silo.release.v1). */
    release: signedText(512 * 1024),
  }),
  response: z.object({ releaseId: z.string(), version: z.string(), installed: z.boolean() }),
  maxBodyBytes: 600 * 1024,
});
