// Air-gapped bundles (spec 11.4): "one cumulative archive of all artefacts since the last
// supported release ... and a manifest of SHA-256 hashes signed by the Silo release key
// and, for sovereign customers, countersigned by the sovereign release key." The
// on-premises Fleet agent verifies both signatures and every hash before loading
// anything, and refuses the whole bundle on any mismatch.
//
// On the media: bundle.json (the manifest), signatures.json, and artefacts/ holding
// exactly the files the manifest lists, by path relative to artefacts/.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { releaseIdSchema, signatureRecord, timestamp } from './release.contract.ts';

const bundlePath = z.string().max(512)
  .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/, 'must be a relative path of plain names')
  .refine((p) => p.split('/').every((part) => part !== '.' && part !== '..'), 'no . or .. segments');

export const bundleFiles = z.array(z.strictObject({
  path: bundlePath,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
})).min(1).max(100_000)
  .refine((files) => files.every((file, i) => i === 0 || files[i - 1]!.path < file.path), 'sorted by path, each once');

export const bundleManifest = z.strictObject({
  schema: z.literal('silo.bundle.v1'),
  bundleId: z.uuid(),
  releaseId: releaseIdSchema,
  /** The last supported release the bundle builds on; null for a first install. */
  fromReleaseId: releaseIdSchema.nullable(),
  createdAt: timestamp,
  files: bundleFiles,
});

export type BundleManifest = z.infer<typeof bundleManifest>;

export const signedBundle = z.object({ bundle: bundleManifest, signatures: z.array(signatureRecord) });

export const signBundle = defineContract({
  service: 'fleet-control', name: 'signBundle', method: 'PUT', path: '/v1/bundles/:bundleId',
  callers: ['admin-portal'],
  // The bundle is immutable once signed: the same files again return the first result.
  context: 'none', idempotency: 'none',
  params: z.strictObject({ bundleId: z.uuid() }),
  body: z.strictObject({
    releaseId: releaseIdSchema,
    fromReleaseId: releaseIdSchema.nullable().default(null),
    files: bundleFiles,
    operatorId: z.uuid(),
  }),
  response: signedBundle,
  maxBodyBytes: 16 * 1024 * 1024,
});

/** In the sovereign fleet-control: UK cleared staff countersign a reviewed bundle (fleet.sovereign.countersign). */
export const countersignBundle = defineContract({
  service: 'fleet-control', name: 'countersignBundle', method: 'PUT', path: '/v1/bundles/:bundleId/countersignature',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ bundleId: z.uuid() }),
  body: z.strictObject({ bundle: bundleManifest, signatures: z.array(signatureRecord).max(8), operatorId: z.uuid() }),
  response: signedBundle,
  maxBodyBytes: 16 * 1024 * 1024,
});
