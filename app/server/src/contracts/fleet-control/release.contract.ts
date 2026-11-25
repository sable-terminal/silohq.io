// Fleet (spec 11): "the only path by which software, configuration and schema changes
// reach a cell, an agent or an air-gapped install. Every change is signed, staged in
// waves, gated on health, and reversible."
//
// A release is an immutable signed set (spec 11.1): images by digest, the cell template
// version, configuration, migrations, flags, model routing, agent binaries, and an SBOM
// per image and binary. fleet-control signs the canonical JSON of the manifest; a cell
// refuses any artefact whose signature fails.
//
// Release engineers act through admin-portal, which authenticates them and names them
// by operator id; the cell-side Fleet agent runs as fleet-control inside each cell.

import { z } from 'zod';
import { BUILD_TARGETS, CAPABILITIES } from '../../config/cell.config.ts';
import { SERVICES } from '../../config/service.config.ts';
import { defineContract } from '../endpoint.contract.ts';

export const CHANNELS = ['dev', 'canary', 'stable', 'sovereign', 'agent-stable', 'agent-sovereign'] as const;
export const AGENT_PLATFORMS = ['linux_x86_64', 'linux_arm64', 'windows_x86_64', 'container'] as const;
export const SIGNING_ROLES = ['release', 'sovereign'] as const;

export type Channel = (typeof CHANNELS)[number];
export type SigningRole = (typeof SIGNING_ROLES)[number];

export const timestamp = z.iso.datetime({ offset: true });
export const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 hex>');
// As SILO_RELEASE (config/service.config.ts): what a cell records as its release.
export const releaseIdSchema = z.string().regex(/^[A-Za-z0-9._+-]{1,128}$/, 'must be a release identifier');
export const semver = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$/, 'must be a semantic version');
const sbom = z.strictObject({ format: z.enum(['spdx', 'cyclonedx']), digest });

export const releaseManifest = z.strictObject({
  schema: z.literal('silo.release.v1'),
  releaseId: releaseIdSchema,
  target: z.enum(BUILD_TARGETS),
  /** A sovereign-target build names the commercial release built from the same source. */
  commercialRelease: releaseIdSchema.optional(),
  cellTemplateVersion: semver,
  images: z.array(z.strictObject({ service: z.enum(SERVICES), digest, sbom })).max(SERVICES.length),
  migrations: z.array(z.strictObject({
    database: z.enum(['cell', 'directory']),
    version: z.string().regex(/^[0-9]{4}$/),
    name: z.string().regex(/^[A-Z][A-Za-z0-9]{0,99}$/),
    digest,
  })).max(1000),
  configurationDigest: digest,
  flagsDigest: digest,
  modelRoutingDigest: digest,
  /**
   * The connector catalogue's release this release carries, if any (D200): a release document,
   * the signed catalogue release exactly as catalogue's installCatalogueRelease takes it
   * ({release, signature, keyId}), which catalogue checks with its own release key.
   */
  catalogueDigest: digest.optional(),
  agentBinaries: z.array(z.strictObject({ platform: z.enum(AGENT_PLATFORMS), version: semver, digest, sbom }))
    .max(AGENT_PLATFORMS.length),
  /** The capability set the images were built with; a sovereign cell refuses any other (spec 6.5). */
  capabilities: z.array(z.enum(CAPABILITIES)),
  securityFix: z.boolean(),
  provenance: z.strictObject({
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    builder: z.string().min(1).max(200),
  }),
  builtAt: timestamp,
});

export type ReleaseManifest = z.infer<typeof releaseManifest>;

export const signatureRecord = z.strictObject({
  /** base64url SHA-256 of the public key's SubjectPublicKeyInfo. */
  keyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  role: z.enum(SIGNING_ROLES),
  /** Ed25519, base64url. */
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export type SignatureRecord = z.infer<typeof signatureRecord>;

export const signedRelease = z.object({
  manifest: releaseManifest,
  manifestDigest: digest,
  signatures: z.array(signatureRecord),
});

export const registerRelease = defineContract({
  service: 'fleet-control', name: 'registerRelease', method: 'PUT', path: '/v1/releases/:releaseId',
  callers: ['admin-portal'],
  // A release is immutable: registering the same manifest again returns the first result.
  context: 'none', idempotency: 'none',
  params: z.strictObject({ releaseId: releaseIdSchema }),
  body: z.strictObject({ manifest: releaseManifest, operatorId: z.uuid() }),
  response: signedRelease.extend({ registeredAt: timestamp }),
  maxBodyBytes: 512 * 1024,
});

export const readRelease = defineContract({
  service: 'fleet-control', name: 'readRelease', method: 'GET', path: '/v1/releases/:releaseId',
  callers: ['admin-portal', 'fleet-control'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ releaseId: releaseIdSchema }),
  response: signedRelease,
});
