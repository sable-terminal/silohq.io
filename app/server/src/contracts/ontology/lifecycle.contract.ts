// ontology: the deprecation lifecycle and rollback (spec 25.7, 25.8).
//
// Deprecation and retirement are ontology.manage, by a person, each a new main version.
// A deprecation names the replacement (where one exists) and a retirement date at least 30
// days ahead; the element stays usable, and every compile that uses it says so. Retirement,
// from that date, takes the element out of the vocabulary of the new version; earlier
// versions keep it.
//
// A rollback is a proposal (origin rollback) whose branch restores a prior main version's
// content: impact analysis, approvals and the merge (ontology.merge) are the ordinary ones,
// and the merge is a new main version of kind rollback.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { WRITERS } from './element.contract.ts';
import { versionView } from './manifest.contract.ts';
import { ELEMENT_KINDS, proposalView } from './proposal.contract.ts';

const element = z.strictObject({ kind: z.enum(ELEMENT_KINDS), elementId: z.uuid() });

export const deprecateElement = defineContract({
  service: 'ontology', name: 'deprecateElement', method: 'POST', path: '/v1/ontology/elements/:kind/:elementId/deprecation', callers: WRITERS,
  context: 'organisation', idempotency: 'none',
  params: element,
  body: z.strictObject({
    /** An active element of the same kind that replaces it. */
    replacedById: z.uuid().optional(),
    /** The earliest day it may be retired: at least 30 days ahead. */
    retireAfter: z.iso.date(),
  }),
  response: versionView,
  maxBodyBytes: 1_024,
});

export const retireElement = defineContract({
  service: 'ontology', name: 'retireElement', method: 'POST', path: '/v1/ontology/elements/:kind/:elementId/retirement', callers: WRITERS,
  context: 'organisation', idempotency: 'none',
  params: element,
  response: versionView,
});

export const openRollback = defineContract({
  service: 'ontology', name: 'openRollback', method: 'POST', path: '/v1/ontology/rollbacks', callers: WRITERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    /** The main version whose content the rollback restores. */
    targetVersionId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4_000).optional(),
  }),
  response: proposalView,
  status: 201,
  maxBodyBytes: 8_192,
});
