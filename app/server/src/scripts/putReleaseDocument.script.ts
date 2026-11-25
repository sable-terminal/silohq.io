// Puts a release document (configuration, flags or model routing; spec 11.1) into
// fleet-control's artefact store, by the SHA-256 of its bytes: the build runs it for each before
// the release naming them is promoted to a cell channel. The same document put again changes
// nothing; different bytes can never land under a digest, since the key is the digest of what
// is written.
//
// Usage: node src/scripts/putReleaseDocument.script.ts <file>   (uses FLEET_ARTEFACT_DIR)
// Prints the digest the release manifest names: sha256:<hex>.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RELEASE_DOCUMENT_BYTES, releaseDocumentKey } from '../contracts/fleet-control/releaseDocument.contract.ts';
import { directoryArtefactStore, type ArtefactStore } from '../services/fleet-control/artefactStore.service.ts';

export async function putReleaseDocument(store: ArtefactStore, body: Buffer): Promise<{ digest: string; created: boolean }> {
  if (body.length > MAX_RELEASE_DOCUMENT_BYTES) throw new Error(`a release document is at most ${MAX_RELEASE_DOCUMENT_BYTES} bytes`);
  const hex = createHash('sha256').update(body).digest('hex');
  const created = await store.create(releaseDocumentKey(hex), body);
  if (created === 'exists' && (await store.sha256(releaseDocumentKey(hex)))?.hex !== hex) {
    throw new Error('the artefact store holds other bytes under this digest: it is damaged');
  }
  return { digest: `sha256:${hex}`, created: created === 'created' };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const dir = process.env['FLEET_ARTEFACT_DIR'];
  if (file === undefined || dir === undefined) {
    process.stderr.write('usage: FLEET_ARTEFACT_DIR=... node src/scripts/putReleaseDocument.script.ts <file>\n');
    process.exit(2);
  }
  const put = await putReleaseDocument(directoryArtefactStore(dir), await readFile(file));
  process.stdout.write(`${put.digest}\n`);
}
