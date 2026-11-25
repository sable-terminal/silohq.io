// A release's documents in fleet-control's artefact store (spec 11.1: "configuration ... flags,
// model routing"): each held by the SHA-256 of its bytes, put there by the build
// (src/scripts/putReleaseDocument.script.ts) before the release naming it is promoted, and read
// whole by each cell's Fleet agent, which checks the digest and keeps it in the cell beside the
// release, so a rollback brings back the configuration and flags as well (spec 11.3). A cell
// channel takes a release only once its three documents are in the store.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { sha256Hex } from './agentBinary.contract.ts';

export const RELEASE_DOCUMENTS = ['configuration', 'flags', 'modelRouting'] as const;
export type ReleaseDocument = (typeof RELEASE_DOCUMENTS)[number];

/** The largest document a release carries: a cell keeps each in a ConfigMap. */
export const MAX_RELEASE_DOCUMENT_BYTES = 512 * 1024;

/** Where a document is in the artefact store. */
export const releaseDocumentKey = (hex: string): string => `release-documents/${sha256Hex.parse(hex)}`;

export const readReleaseDocument = defineContract({
  service: 'fleet-control', name: 'readReleaseDocument', method: 'GET', path: '/v1/release-documents/:sha256',
  callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ sha256: sha256Hex }),
  response: z.object({ bytes: z.int().min(0).max(MAX_RELEASE_DOCUMENT_BYTES), data: z.base64() }),
});
