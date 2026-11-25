// Signing and checking discovery scans (contracts/discovery/scan.contract.ts). discovery signs
// a scan for one run of one approved authorisation on one agent; connect-runtime checks it
// before it leaves the cell; the agent checks it again (agent/internal/discovery).

import type { KeyObject } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import {
  DISCOVERY_SCAN_PREFIX, discoveryScan, SCAN_START_SECONDS, type DiscoveryScan, type ScanRefusal, type SignedDiscoveryScan,
} from '../../contracts/discovery/scan.contract.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { instructionKeyId, signInstruction, verifyInstruction } from '../../utils/signedInstruction.util.ts';

export interface ScanSigner {
  readonly available: boolean;
  sign(input: { scanId: string; organisationId: string; agentId: string; authorisationId: string; authorisation: string }, now?: Date): SignedDiscoveryScan;
}

const unavailable = (): AppError =>
  new AppError('configuration', 'this cell has no discovery scan key: scans through the Silo Agent cannot be signed', { code: 'discovery.signing_unavailable' });

/** discovery's signer: none without a key (development without agents; production requires one). */
export function createScanSigner(privateKey: KeyObject | undefined): ScanSigner {
  const keyId = privateKey === undefined ? '' : instructionKeyId(createPublicKey(privateKey));
  return {
    available: privateKey !== undefined,
    sign(input, now = new Date()) {
      if (privateKey === undefined) throw unavailable();
      const scan: DiscoveryScan = discoveryScan.parse({
        version: 1, ...input, authorisationSha256: sha256(Buffer.from(input.authorisation, 'utf8')).toString('hex'),
        issuedAt: now.toISOString(), startBy: new Date(now.getTime() + SCAN_START_SECONDS * 1000).toISOString(),
      });
      const text = JSON.stringify(scan);
      return { scan: text, keyId, signature: signInstruction(DISCOVERY_SCAN_PREFIX, text, privateKey) };
    },
  };
}

const refused = (reason: ScanRefusal): AppError =>
  new AppError('forbidden', `the discovery scan's signature does not hold (${reason})`, { code: 'discovery.scan_refused', details: { reason } });

/** The scan, if it holds for this run on this agent under this key; otherwise refused, with the reason. */
export function verifyDiscoveryScan(publicKey: KeyObject, signed: SignedDiscoveryScan,
  expect: { organisationId: string; agentId: string; runId: string; now?: Date }): DiscoveryScan {
  if (signed.keyId !== instructionKeyId(publicKey)) throw refused('key_unknown');
  if (!verifyInstruction(DISCOVERY_SCAN_PREFIX, signed.scan, signed.signature, publicKey)) throw refused('signature');
  let parsed: unknown;
  try {
    parsed = JSON.parse(signed.scan);
  } catch {
    throw refused('signature');
  }
  const result = discoveryScan.safeParse(parsed);
  if (!result.success) throw refused('signature');
  const scan = result.data;
  const now = (expect.now ?? new Date()).getTime();
  if (Date.parse(scan.startBy) <= now || Date.parse(scan.issuedAt) > now + 60_000) throw refused('expired');
  if (scan.organisationId !== expect.organisationId) throw refused('organisation');
  if (scan.agentId !== expect.agentId || scan.scanId !== expect.runId) throw refused('agent');
  if (sha256(Buffer.from(scan.authorisation, 'utf8')).toString('hex') !== scan.authorisationSha256) throw refused('authorisation');
  return scan;
}
