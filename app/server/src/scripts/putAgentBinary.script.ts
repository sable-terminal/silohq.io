// Puts a Silo Agent binary into fleet-control's artefact store (spec 11.1, 10.7), by the SHA-256
// of its bytes: the build runs it for each platform's binary before the release naming them
// is registered. An agent channel takes a release only once every binary it names is there.
// The same binary put again changes nothing; different bytes can never land under a digest,
// since the key is the digest of what is written.
//
// Usage: node src/scripts/putAgentBinary.script.ts <binary>   (uses FLEET_ARTEFACT_DIR)
// Prints the digest the release manifest names: sha256:<hex>.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentBinaryKey, MAX_AGENT_BINARY_BYTES } from '../contracts/fleet-control/agentBinary.contract.ts';
import { directoryArtefactStore, type ArtefactStore } from '../services/fleet-control/artefactStore.service.ts';

export async function putAgentBinary(store: ArtefactStore, body: Buffer): Promise<{ digest: string; bytes: number; created: boolean }> {
  if (body.length === 0 || body.length > MAX_AGENT_BINARY_BYTES) throw new Error(`an agent binary is 1 byte to ${MAX_AGENT_BINARY_BYTES} bytes`);
  const hex = createHash('sha256').update(body).digest('hex');
  const created = await store.create(agentBinaryKey(hex), body);
  if (created === 'exists' && (await store.sha256(agentBinaryKey(hex)))?.hex !== hex) {
    throw new Error('the artefact store holds other bytes under this digest: it is damaged');
  }
  return { digest: `sha256:${hex}`, bytes: body.length, created: created === 'created' };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const dir = process.env['FLEET_ARTEFACT_DIR'];
  if (file === undefined || dir === undefined) {
    process.stderr.write('usage: FLEET_ARTEFACT_DIR=... node src/scripts/putAgentBinary.script.ts <binary>\n');
    process.exit(2);
  }
  const put = await putAgentBinary(directoryArtefactStore(dir), await readFile(file));
  process.stdout.write(`${put.digest}\n`);
}
