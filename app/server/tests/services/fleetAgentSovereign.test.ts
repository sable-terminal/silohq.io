// Sovereign agent updates (spec 11.1, 11.4; D202): a sovereign cell takes an agent release from
// agent-sovereign only when the release carries the Silo release key's signature and the head the
// sovereign release key's (the sovereign fleet-control's, promoted once cleared staff
// countersigned the bundle that brought it in); a commercial cell's agent-stable head stays Silo's.

import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { ReleaseManifest } from '../../src/contracts/fleet-control/release.contract.ts';
import { checkAgentRelease } from '../../src/services/fleet-control/agentRelease.service.ts';
import { documentDigest, keyFileSigner, signDocument, trustedKey } from '../../src/services/fleet-control/signing.service.ts';
import { canonicalJson } from '../../src/utils/canonicalJson.util.ts';

const silo = generateKeyPairSync('ed25519');
const sovereign = generateKeyPairSync('ed25519');
const releaseSigner = keyFileSigner(silo.privateKey, 'release', createPublicKey(silo.privateKey));
const sovereignSigner = keyFileSigner(sovereign.privateKey, 'sovereign', createPublicKey(sovereign.privateKey));
const trusted = [trustedKey(silo.publicKey, 'release'), trustedKey(sovereign.publicKey, 'sovereign')];
const digest = `sha256:${'c'.repeat(64)}`;

const manifest: ReleaseManifest = {
  schema: 'silo.release.v1', releaseId: 'r-sov-1', target: 'sovereign', cellTemplateVersion: '1.0.0',
  images: [{ service: 'auth', digest, sbom: { format: 'spdx', digest } }], migrations: [],
  configurationDigest: digest, flagsDigest: digest, modelRoutingDigest: digest,
  agentBinaries: [{ platform: 'linux_x86_64', version: '1.4.0', digest, sbom: { format: 'cyclonedx', digest } }],
  capabilities: ['siloes_capture'], securityFix: false, provenance: { sourceCommit: 'f'.repeat(40), builder: 'ci' }, builtAt: '2026-11-19T09:00:00.000Z',
};

async function signed(headSigner: typeof releaseSigner, channel: 'agent-sovereign' | 'agent-stable') {
  const head = {
    schema: 'silo.channel.v1' as const, channel, sequence: 2, releaseId: manifest.releaseId, manifestDigest: documentDigest(manifest),
    promotedAt: '2026-11-19T10:00:00.000Z', promotionId: randomUUID(),
  };
  return {
    head: { text: canonicalJson(head), signatures: [await signDocument(headSigner, 'channel', head)] },
    release: { text: canonicalJson(manifest), signatures: [await signDocument(releaseSigner, 'release', manifest)] },
  };
}

describe('sovereign agent updates (D202)', () => {
  test('an agent-sovereign head needs the sovereign key\'s signature, the release Silo\'s', async () => {
    const checked = checkAgentRelease(await signed(sovereignSigner, 'agent-sovereign'), trusted, { channel: 'agent-sovereign', target: 'sovereign' });
    assert.equal(checked.manifest.releaseId, 'r-sov-1');
  });

  test('a head only Silo signed is not the sovereign fleet-control\'s promotion: refused', async () => {
    const unsigned = await signed(releaseSigner, 'agent-sovereign');
    assert.throws(() => checkAgentRelease(unsigned, trusted, { channel: 'agent-sovereign', target: 'sovereign' }), { code: 'fleet.signature_missing' });
    assert.throws(() => checkAgentRelease(unsigned, [trustedKey(silo.publicKey, 'release')], { channel: 'agent-sovereign', target: 'sovereign' }),
      { code: 'fleet.signature_missing' }, 'nor without the sovereign key trusted');
  });

  test('agent-stable heads stay Silo\'s: a sovereign signature does not stand in for the release key', async () => {
    const onStable = await signed(sovereignSigner, 'agent-stable');
    assert.throws(() => checkAgentRelease(onStable, trusted, { channel: 'agent-stable', target: 'sovereign' }), { code: 'fleet.signature_missing' });
  });
});
