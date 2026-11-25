// catalogue: the connector catalogue (docs/siloServiceCatalogue.doc.md; spec 16.2, 17.5).
//
// - Browse: Silo's prebuilt connectors (certified) and the organisation's own private ones.
// - Prebuilt connectors arrive as a catalogue release from Fleet, signed, installed whole
//   or not at all; the release path is called by fleet-control.
// The marketplace of spec 16.5 (community promotion, its review, the tiers above it and the
// authors' revenue share) was dropped on 2026-11-23: a connector an organisation builds
// stays its own.

import { z } from 'zod';
import { conceptTemplateSet } from '../fleet-control/conceptTemplates.contract.ts';
import { signatureRecord } from '../fleet-control/release.contract.ts';
import { connectorSchema } from '../../schemas/connect/connector.schema.ts';
import { defineContract } from '../endpoint.contract.ts';

const TENANT_CALLERS = ['gateway', 'connector-builder', 'visual-builder'] as const;

export const catalogueEntry = connectorSchema.pick({
  id: true, kind: true, slug: true, name: true, provider: true, description: true, trustTier: true, sourceRoute: true, status: true,
}).extend({
  /** True when this organisation wrote it: its private connectors. */
  authoredHere: z.boolean(),
  current: z.object({ manifestId: z.uuid(), version: z.string(), protocol: z.string() }).nullable(),
});
export type CatalogueEntry = z.infer<typeof catalogueEntry>;

export const browseCatalogue = defineContract({
  service: 'catalogue', name: 'browseCatalogue', method: 'GET', path: '/v1/catalogue/connectors', callers: TENANT_CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    tier: z.enum(['private', 'certified']).optional(),
    kind: z.enum(['prebuilt', 'private']).optional(),
    /** A plain substring of the name. */
    q: z.string().trim().min(2).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: z.object({ connectors: z.array(catalogueEntry) }),
});

export const catalogueRelease = z.strictObject({
  /** The release identifier Fleet gives the catalogue. */
  version: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/),
  connectors: z.array(z.strictObject({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    name: z.string().trim().min(1).max(200),
    provider: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    /** A manifest document: validated exactly as any manifest is before anything is installed. */
    document: z.record(z.string(), z.json()),
  })).min(1).max(1_000),
});
export type CatalogueRelease = z.infer<typeof catalogueRelease>;

export const installCatalogueRelease = defineContract({
  service: 'catalogue', name: 'installCatalogueRelease', method: 'POST', path: '/v1/catalogue/releases', callers: ['fleet-control'],
  // Installing a release again installs nothing new.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    release: catalogueRelease,
    /** Ed25519 over "silo.catalogue.v1\0" and the release's canonical JSON. */
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    keyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
  response: z.object({ installed: z.number().int(), unchanged: z.number().int() }),
  maxBodyBytes: 16 * 1024 * 1024,
});

/**
 * Concept templates (spec 22.7; D210): the cell's Fleet agent hands the catalogue Fleet's signed
 * set; the catalogue verifies Silo's signature, then installs each newly reviewed template and
 * withdraws each one Fleet withdrew, telling every organisation (template_reviewed,
 * template_withdrawn): it is the one thing every tenant of the cell shares.
 */
export const installConceptTemplates = defineContract({
  service: 'catalogue', name: 'installConceptTemplates', method: 'POST', path: '/v1/concept-templates', callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ set: conceptTemplateSet, signatures: z.array(signatureRecord).min(1).max(4) }),
  response: z.object({ installed: z.int().min(0), withdrawn: z.int().min(0), unchanged: z.int().min(0) }),
  maxBodyBytes: 4 * 1024 * 1024,
});
