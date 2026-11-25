// AI agents (D236; beyond the spec: the customer-built agents of the Foundry-comparison
// features). An AI agent is what a builder makes of Ask for a purpose: a name, a brief (what
// it is for and how to read the questions put to it, in the builder's words), the object types
// it works with, and the Ask tools it may use. A person asks it in an Ask thread made with it.
//
// It answers under the asker's own access, never its builder's: compile offers the model only
// the agent's types of those the asker may see, and the plan runs as the asker. Its brief
// reaches the model gateway as documentation (spec 62.1), so it is refused when saved if it
// holds anything that looks like a record value; instructions stay constant. A proposed change
// or Cron is a draft the asker submits, as in any thread. Shared like a saved view (37.4): to ask
// (view) or to copy (copy); only the owner edits. Holders see its brief: what shapes an answer
// is never hidden from the person asking.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { shareGrantee } from './sharing.contract.ts';

const CALLERS = ['gateway'] as const;

/** The compiled Ask tools (36.4). Explaining and opening ask no model, so every thread has them. */
export const AI_AGENT_TOOLS = ['answer', 'find_objects', 'propose_action', 'propose_cron'] as const;
export type AiAgentTool = (typeof AI_AGENT_TOOLS)[number];
export const MAX_BRIEF = 8_000;

const distinct = <T>(items: readonly T[]) => new Set(items).size === items.length;

export const aiAgentDefinition = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).default(''),
  /** Sent to a model with every question asked of the agent: guidance, never a record value. */
  brief: z.string().trim().max(MAX_BRIEF).default(''),
  /** Empty: every type the asker may see. */
  objectTypeIds: z.array(z.uuid()).max(50).default([]).refine(distinct, 'each object type once'),
  tools: z.array(z.enum(AI_AGENT_TOOLS)).min(1).max(AI_AGENT_TOOLS.length).refine(distinct, 'each tool once'),
});
export type AiAgentDefinition = z.infer<typeof aiAgentDefinition>;

const access = z.enum(['owner', 'view', 'copy']);
export const aiAgentSummary = z.object({
  id: z.uuid(), name: z.string(), description: z.string(), ownerMembershipId: z.uuid(), visibility: z.enum(['private', 'shared', 'org_visible']), access,
  objectTypeIds: z.array(z.uuid()), tools: z.array(z.enum(AI_AGENT_TOOLS)),
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(), lockVersion: z.int(),
});
export const aiAgentView = aiAgentSummary.extend({ brief: z.string() });
export type AiAgentView = z.infer<typeof aiAgentView>;

export const aiAgentShareView = z.object({
  id: z.uuid(), aiAgentId: z.uuid(), grantee: shareGrantee, access: z.enum(['view', 'copy']), sharedBy: z.uuid(), sharedAt: z.string(),
  expiresAt: z.string().nullable(), revokedAt: z.string().nullable(), state: z.enum(['live', 'expired', 'revoked', 'suspended', 'forbidden_by_policy']),
});

const params = z.strictObject({ aiAgentId: z.uuid() });

export const createAiAgent = defineContract({
  service: 'workspace', name: 'createAiAgent', method: 'POST', path: '/v1/ai-agents', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', body: aiAgentDefinition, response: aiAgentView, status: 201, maxBodyBytes: 64 * 1024,
});

export const listAiAgents = defineContract({
  service: 'workspace', name: 'listAiAgents', method: 'GET', path: '/v1/ai-agents', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ filter: z.enum(['mine', 'shared', 'archived']).default('mine'), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ aiAgents: z.array(aiAgentSummary) }),
});

/** Its owner, or anyone it is shared with: the brief included. */
export const getAiAgent = defineContract({
  service: 'workspace', name: 'getAiAgent', method: 'GET', path: '/v1/ai-agents/:aiAgentId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: aiAgentView,
});

/** The owner's edit: the brief screened for values, each type one the ontology has. Threads made with it ask the saved agent from their next question. */
export const saveAiAgent = defineContract({
  service: 'workspace', name: 'saveAiAgent', method: 'PUT', path: '/v1/ai-agents/:aiAgentId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: aiAgentDefinition.extend({ lockVersion: z.int().min(1) }), response: aiAgentView, maxBodyBytes: 64 * 1024,
});

export const copyAiAgent = defineContract({
  service: 'workspace', name: 'copyAiAgent', method: 'POST', path: '/v1/ai-agents/:aiAgentId/copies', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params, body: z.strictObject({ name: z.string().trim().min(1).max(200) }), response: aiAgentView, status: 201,
});

/** Archived, it is asked no more: its threads keep their turns and take no new question. */
export const archiveAiAgent = defineContract({
  service: 'workspace', name: 'archiveAiAgent', method: 'POST', path: '/v1/ai-agents/:aiAgentId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: aiAgentView,
});

export const shareAiAgent = defineContract({
  service: 'workspace', name: 'shareAiAgent', method: 'POST', path: '/v1/ai-agents/:aiAgentId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ grantee: shareGrantee, access: z.enum(['view', 'copy']), expiresAt: z.iso.datetime({ offset: true }).optional() }),
  response: aiAgentShareView, status: 201,
});

export const revokeAiAgentShare = defineContract({
  service: 'workspace', name: 'revokeAiAgentShare', method: 'POST', path: '/v1/ai-agents/:aiAgentId/shares/:shareId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ aiAgentId: z.uuid(), shareId: z.uuid() }), response: aiAgentShareView,
});

export const listAiAgentShares = defineContract({
  service: 'workspace', name: 'listAiAgentShares', method: 'GET', path: '/v1/ai-agents/:aiAgentId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: z.object({ shares: z.array(aiAgentShareView) }),
});
