// Air-gapped bundles on the media (spec 11.4): describing the files when one is built,
// and the check the on-premises Fleet agent runs before loading anything.
//
// The check refuses the whole bundle on any mismatch: a signature missing or not
// verifying (the Silo release key always; the sovereign release key too for a sovereign
// customer), a listed file missing or a different size or hash, a file present that the
// manifest does not list, or a path that leaves the bundle. Nothing is loaded until every
// file has been hashed. The caller writes the outcome to the local audit log
// (bundle_verified, bundle_refused).

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { bundleManifest, type BundleManifest } from '../../contracts/fleet-control/bundle.contract.ts';
import { signatureRecord, type SigningRole } from '../../contracts/fleet-control/release.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { verifyDocument, type TrustedKey } from './signing.service.ts';

export const BUNDLE_FILE = 'bundle.json';
export const SIGNATURES_FILE = 'signatures.json';
export const ARTEFACTS_DIR = 'artefacts';

const refused = (reason: string, message: string, cause?: unknown): AppError =>
  new AppError('integrity', `bundle refused: ${message}`, { code: 'fleet.bundle_refused', details: { reason }, cause });

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Every regular file under root, as sorted relative paths with '/' separators. Links are refused. */
async function walk(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(root, relative));
    else if (entry.isFile()) found.push(relative);
    else throw refused('not_a_file', 'the artefacts hold something that is not a plain file');
  }
  return found.sort();
}

/** The files list of a bundle manifest, from an artefacts directory as built. */
export async function describeBundleFiles(artefactsDir: string): Promise<BundleManifest['files']> {
  const files: BundleManifest['files'] = [];
  for (const relative of await walk(artefactsDir)) {
    const file = path.join(artefactsDir, ...relative.split('/'));
    files.push({ path: relative, sha256: await sha256File(file), bytes: (await lstat(file)).size });
  }
  return files;
}

export interface BundleTrust {
  keys: readonly TrustedKey[];
  /** A sovereign customer's install also requires the sovereign countersignature. */
  requireSovereign: boolean;
}

export async function verifyBundle(dir: string, trust: BundleTrust): Promise<{ bundle: BundleManifest; files: number; bytes: number }> {
  let bundle: BundleManifest;
  let signatures: z.infer<typeof signatureRecord>[];
  try {
    bundle = bundleManifest.parse(JSON.parse(await readFile(path.join(dir, BUNDLE_FILE), 'utf8')));
    signatures = z.array(signatureRecord).parse(JSON.parse(await readFile(path.join(dir, SIGNATURES_FILE), 'utf8')));
  } catch (cause) {
    throw refused('manifest_unreadable', 'the manifest or its signatures cannot be read', cause);
  }

  const required: SigningRole[] = trust.requireSovereign ? ['release', 'sovereign'] : ['release'];
  try {
    verifyDocument('bundle', bundle, signatures, trust.keys, required);
  } catch (cause) {
    throw refused('signature', 'a required signature is missing or does not verify', cause);
  }

  const root = path.join(dir, ARTEFACTS_DIR);
  let present: string[];
  try {
    present = await walk(root);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw refused('artefacts_unreadable', 'the artefacts cannot be read', cause);
  }
  const listed = new Set(bundle.files.map((f) => f.path));
  if (present.some((p) => !listed.has(p))) throw refused('unlisted_file', 'the media holds a file the manifest does not list');

  let bytes = 0;
  for (const entry of bundle.files) {
    const file = path.join(root, ...entry.path.split('/'));
    if (!file.startsWith(root + path.sep)) throw refused('path', 'a listed path leaves the bundle');
    const stat = await lstat(file).catch(() => undefined);
    if (stat === undefined || !stat.isFile()) throw refused('missing_file', 'a listed file is missing');
    if (stat.size !== entry.bytes) throw refused('size', 'a file is not the size the manifest lists');
    if (await sha256File(file) !== entry.sha256) throw refused('hash', 'a file does not match its hash');
    bytes += stat.size;
  }
  return { bundle, files: bundle.files.length, bytes };
}
