// Discovery scans through the Silo Agent (spec 10.5, 19.2, 19.3).
//
// A scan runs only on a cell-signed instruction the agent checks itself: discovery signs, with
// Ed25519 over a fixed prefix and the scan's JSON text (which travels as that text, so whoever
// checks it checks exactly the bytes signed), one scan of one approved authorisation for one
// agent, carrying the authorisation document's exact text, the one whose hash the approvers
// quoted. The agent takes targets, methods, the host bound and the expiry from that document
// alone. A scan must begin within five minutes and runs once.
//
// What the agent does comes back up its work stream as scan events, which connect-runtime (the
// replica holding the agent's tunnel) passes to discovery in numbered reports, at least every
// few seconds while the scan runs, so a stop (revoked, switched off, a bound crossed) reaches
// the agent within seconds. discovery holds every event to the authorisation.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { DISCOVERY_METHODS, foundStructure, PROBE_OUTCOMES } from './discovery.contract.ts';

export const DISCOVERY_SCAN_PREFIX = 'silo.discovery_scan.v1';
/** A signed scan begins within this, or not at all. */
export const SCAN_START_SECONDS = 300;
/** The longest a scan runs, whatever its authorisation's expiry. */
export const MAX_SCAN_SECONDS = 4 * 3_600;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.iso.datetime({ offset: true });

/** What a signed scan says, as its JSON text is parsed. */
export const discoveryScan = z.strictObject({
  version: z.literal(1),
  /** The discovery run. */
  scanId: z.uuid(),
  organisationId: z.uuid(),
  agentId: z.uuid(),
  authorisationId: z.uuid(),
  /** The approved authorisation document, as the canonical JSON text approvers hashed. */
  authorisation: z.string().min(2).max(16_384),
  authorisationSha256: sha256Hex,
  issuedAt: timestamp,
  startBy: timestamp,
});
export type DiscoveryScan = z.infer<typeof discoveryScan>;

/** A scan as it travels: its JSON text as signed, the signing key's id and the signature. */
export const signedDiscoveryScan = z.strictObject({
  scan: z.string().min(2).max(20_000),
  /** base64url SHA-256 of the signing key's SubjectPublicKeyInfo. */
  keyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type SignedDiscoveryScan = z.infer<typeof signedDiscoveryScan>;

/** Why a scan was refused, by the cell or by the agent. */
export const SCAN_REFUSALS = [
  'unsigned', 'key_unknown', 'signature', 'expired', 'organisation', 'agent', 'authorisation', 'replayed', 'disabled_locally',
] as const;
export type ScanRefusal = (typeof SCAN_REFUSALS)[number];

const host = z.string().trim().toLowerCase().min(1).max(253);

/** What the agent reports: each probe, each finding (structure only), and the end. */
export const scanProbe = z.strictObject({
  type: z.literal('probe'),
  host,
  port: z.int().min(1).max(65_535).nullable(),
  method: z.enum(DISCOVERY_METHODS),
  outcome: z.enum(PROBE_OUTCOMES),
  probedAt: timestamp,
});
export const scanFinding = z.strictObject({
  type: z.literal('finding'),
  host,
  method: z.enum(DISCOVERY_METHODS),
  found: foundStructure,
});
export const scanEnd = z.strictObject({
  type: z.literal('end'),
  status: z.enum(['completed', 'failed']),
  /** A code: why it failed, or why it stopped short (max_hosts). */
  reason: z.string().regex(/^[a-z0-9_.:]{1,100}$/).optional(),
  /** Authorised methods this agent cannot carry out. */
  unavailable: z.array(z.enum(DISCOVERY_METHODS)).max(DISCOVERY_METHODS.length).optional(),
});
export const scanEvent = z.discriminatedUnion('type', [scanProbe, scanFinding, scanEnd]);
export type ScanEvent = z.infer<typeof scanEvent>;

export const reportScanEvents = defineContract({
  service: 'discovery', name: 'reportScanEvents', method: 'POST', path: '/v1/discovery/runs/:runId/events',
  // Not keyed: reports are numbered, and one taken already is answered again, not taken twice.
  callers: ['connect-runtime'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ runId: z.uuid() }),
  body: z.strictObject({
    agentId: z.uuid(),
    /** From 1, one more each report; none at all is a keep-alive asking whether to go on. */
    sequence: z.int().min(1),
    events: z.array(scanEvent).max(1_000),
  }),
  /** stop: end the scan now (revoked, switched off, outside its authorisation, or already over). */
  response: z.object({ stop: z.boolean(), reason: z.string().nullable() }),
  maxBodyBytes: 8 * 1024 * 1024,
});
