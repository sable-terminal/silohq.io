// SBOM checks (spec 11.1): "SBOMs are checked for vulnerabilities daily; a critical one in a
// reachable component blocks stable."
//
// putReleaseSbom: one of the SBOMs a release's signed manifest names, by its SHA-256; one
// whose bytes hash otherwise is refused. CycloneDX 1.x or SPDX 2.x JSON. Its components are
// checked against the advisory mirror at once. Receiving it again changes nothing.
// putReleaseVex: an OpenVEX or CycloneDX VEX document about the release, from the security
// officer (admin-portal checks fleet.release.expedite): whether each named component is
// affected by each named vulnerability. A not_affected statement carries a justification.
// readReleaseFindings: the release's SBOMs, the feeds its components draw on, and every
// open finding, blocking first.
// syncAdvisories: every advisory feed synced now rather than at its daily turn, then the
// live releases checked again. It runs after the response.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { digest, releaseIdSchema, timestamp } from './release.contract.ts';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lower-case hex digits');
const severity = z.enum(['critical', 'high', 'medium', 'low', 'none', 'unrated']);
const subject = z.string().regex(/^(image|agent):[a-z0-9_-]{1,64}$/);
const checkCounts = { components: z.int().min(0), unmatched: z.int().min(0), findings: z.int().min(0), blocking: z.int().min(0) };
/** SBOMs of large images run to tens of megabytes. */
const MAX_DOCUMENT_BYTES = 48 * 1024 * 1024;

export const putReleaseSbom = defineContract({
  service: 'fleet-control', name: 'putReleaseSbom', method: 'PUT', path: '/v1/releases/:releaseId/sboms/:sha256',
  callers: ['admin-portal'],
  // Keyed by the document's own hash: the same SBOM again changes nothing.
  context: 'none', idempotency: 'none',
  params: z.strictObject({ releaseId: releaseIdSchema, sha256: sha256Hex }),
  body: z.strictObject({ document: z.string().min(2).max(MAX_DOCUMENT_BYTES), operatorId: z.uuid() }),
  response: z.object({
    releaseId: releaseIdSchema, digest, format: z.enum(['spdx', 'cyclonedx']), subject, withoutPurl: z.int().min(0), ...checkCounts,
  }),
  maxBodyBytes: MAX_DOCUMENT_BYTES + 4096,
});

export const putReleaseVex = defineContract({
  service: 'fleet-control', name: 'putReleaseVex', method: 'PUT', path: '/v1/releases/:releaseId/vex/:sha256',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ releaseId: releaseIdSchema, sha256: sha256Hex }),
  body: z.strictObject({ document: z.string().min(2).max(4 * 1024 * 1024), operatorId: z.uuid() }),
  response: z.object({ releaseId: releaseIdSchema, digest, statements: z.int().min(1), ...checkCounts }),
  maxBodyBytes: 4 * 1024 * 1024 + 4096,
});

export const releaseFindingsView = z.object({
  releaseId: releaseIdSchema,
  sboms: z.array(z.object({
    subject, digest, format: z.enum(['spdx', 'cyclonedx']), receivedAt: timestamp.nullable(), components: z.int().min(0).nullable(),
  })),
  checkedAt: timestamp.nullable(),
  components: z.int().min(0),
  unmatched: z.int().min(0),
  blocking: z.int().min(0),
  feeds: z.array(z.object({ feed: z.string(), lastSyncedAt: timestamp.nullable(), lastError: z.string().nullable() })),
  findings: z.array(z.object({
    advisoryId: z.string(), aliases: z.array(z.string()), summary: z.string().nullable(), purl: z.string(), subject,
    severity, score: z.number().nullable(), resolution: z.enum(['affected', 'unresolved']), blocking: z.boolean(),
    vexStatus: z.enum(['not_affected', 'affected', 'fixed', 'under_investigation']).nullable(), firstFoundAt: timestamp,
  })),
});

export const readReleaseFindings = defineContract({
  service: 'fleet-control', name: 'readReleaseFindings', method: 'GET', path: '/v1/releases/:releaseId/findings',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ releaseId: releaseIdSchema }),
  response: releaseFindingsView,
});

export const syncAdvisories = defineContract({
  service: 'fleet-control', name: 'syncAdvisories', method: 'POST', path: '/v1/advisories/sync',
  callers: ['admin-portal'],
  // A sync already running holds each feed's lease, so asking twice syncs once.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ operatorId: z.uuid() }),
  response: z.object({ accepted: z.literal(true) }),
  status: 202,
  maxBodyBytes: 256,
});
