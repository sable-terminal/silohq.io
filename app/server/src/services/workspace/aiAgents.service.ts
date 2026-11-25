// AI agents (D236): a builder's brief, the object types it works with and the Ask tools it may
// use, asked in Ask threads made with it. Its owner edits it; others ask it or copy it through
// shares, under the owner's sharing policy as ceiling (37.4). Saving screens the name and brief
// for value patterns, since both reach the model gateway with every question asked of it, and
// checks each type is one the ontology has. What it may answer is decided per question, by
// compile, against the asker's own access (ask.service.ts).

import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import type { AiAgentDefinition, AiAgentView } from '../../contracts/workspace/aiAgent.contract.ts';
import type { ShareGrantee } from '../../contracts/workspace/sharing.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { AiAgent } from '../../models/workspace/aiAgent.model.ts';
import { aiAgentRepo, viewShareRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { findValuePatterns } from '../../utils/redaction.util.ts';
import { demand, member, recordEvent, type Context, type Member, type WorkspaceDeps } from './deps.service.ts';
import { documentShares, heldOn, revokeDocumentShare, shareDocument, type DocumentHeld, type DocumentKind, type SharedDocument } from './documentShares.service.ts';

const notFound = () => new AppError('not_found', 'no such AI agent', { code: 'workspace.ai_agent_not_found' });
const stale = () => new AppError('conflict', 'the AI agent changed since you read it', { code: 'workspace.ai_agent_stale' });

function summaryOf(a: AiAgent, held: DocumentHeld) {
  return {
    id: a.id, name: a.name, description: a.description, ownerMembershipId: a.ownerMembershipId, visibility: a.visibility, access: held,
    objectTypeIds: a.objectTypeIds, tools: a.tools, createdAt: a.createdAt, updatedAt: a.updatedAt, archivedAt: a.archivedAt, lockVersion: a.lockVersion,
  };
}
const viewOf = (a: AiAgent, held: DocumentHeld): AiAgentView => ({ ...summaryOf(a, held), brief: a.brief });

export const AI_AGENT: DocumentKind<AiAgent> = {
  arm: 'ai_agent', notFound,
  findForUpdate: (db, id) => aiAgentRepo.findForUpdate(db, id),
  setVisibility: (db, id, visibility) => aiAgentRepo.update(db, id, { visibility }),
};

/** What a member holds on an AI agent: owner, or the best live share its owner's policy permits. Ask asks it only so. */
export const aiAgentHeld = (db: Queryable, a: AiAgent, membershipId: string) => heldOn(db, AI_AGENT as DocumentKind<SharedDocument>, a, membershipId);

async function readable(deps: WorkspaceDeps, me: Member, id: string): Promise<{ a: AiAgent; held: DocumentHeld }> {
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const a = await aiAgentRepo.findById(db, id);
    const held = a === undefined ? undefined : await aiAgentHeld(db, a, me.membershipId);
    return a === undefined || held === undefined ? undefined : { a, held };
  }, { readOnly: true });
  if (found === undefined) throw notFound();
  return found;
}

/** The name and brief go to a model with every question: nothing in them may look like a record value (62.1). Each type is the ontology's. */
async function check(deps: WorkspaceDeps, ctx: Context, d: AiAgentDefinition): Promise<void> {
  for (const [where, text] of [['name', d.name], ['brief', d.brief]] as const) {
    const kinds = findValuePatterns(text);
    if (kinds.length > 0) {
      throw new AppError('validation', `the ${where} holds something that looks like a record value (${kinds.join(', ')}); it is sent to a model, which never sees one`, {
        code: 'workspace.ai_agent_value_pattern', details: { where, kinds: kinds.join(',') },
      });
    }
  }
  if (d.objectTypeIds.length === 0) return;
  const manifest = await deps.services.call(getManifest, { query: {} }, { request: ctx.request, correlationId: ctx.correlationId });
  const known = new Set(manifest.objectTypes.map((t) => t.id));
  if (d.objectTypeIds.some((id) => !known.has(id))) {
    throw new AppError('validation', 'an object type the AI agent works with is not in the ontology', { code: 'workspace.ai_agent_type_unknown' });
  }
}

const detailOf = (d: Pick<AiAgent, 'brief' | 'objectTypeIds' | 'tools'>) => ({
  brief_length: d.brief.length, object_types: d.objectTypeIds.length, tools: [...d.tools].sort().join(','),
});

export async function create(deps: WorkspaceDeps, ctx: Context, d: AiAgentDefinition): Promise<AiAgentView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'ai_agent.save' });
  await check(deps, ctx, d);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const a = await aiAgentRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name: d.name, description: d.description, brief: d.brief,
      objectTypeIds: d.objectTypeIds, tools: d.tools,
    });
    await recordEvent(db, me, ctx.correlationId, { event: 'ai_agent_created', resource: { type: 'ai_agent', id: a.id }, detail: { copied_from: null, ...detailOf(a) } });
    return viewOf(a, 'owner');
  });
}

export async function list(deps: WorkspaceDeps, ctx: Context, filter: 'mine' | 'shared' | 'archived', limit: number) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    if (filter !== 'shared') return { aiAgents: (await aiAgentRepo.listMine(db, me.membershipId, filter === 'archived', limit)).map((a) => summaryOf(a, 'owner')) };
    const out: ReturnType<typeof summaryOf>[] = [];
    for (const a of await aiAgentRepo.listByIds(db, await viewShareRepo.documentsReaching(db, 'ai_agent', me.membershipId), limit)) {
      const held = await aiAgentHeld(db, a, me.membershipId);
      if (held !== undefined && held !== 'owner') out.push(summaryOf(a, held));
    }
    return { aiAgents: out };
  }, { readOnly: true });
}

export async function get(deps: WorkspaceDeps, ctx: Context, id: string): Promise<AiAgentView> {
  const me = member(ctx);
  const { a, held } = await readable(deps, me, id);
  return viewOf(a, held);
}

export async function save(deps: WorkspaceDeps, ctx: Context, id: string, input: AiAgentDefinition & { lockVersion: number }): Promise<AiAgentView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'ai_agent.save' });
  // Only its owner edits: anyone else is told it does not exist, before anything of the edit is checked.
  const current = await inTransaction(deps.databases.pool('control'), me.request, (db) => aiAgentRepo.findById(db, id), { readOnly: true });
  if (!current || current.ownerMembershipId !== me.membershipId) throw notFound();
  await check(deps, ctx, input);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const a = await aiAgentRepo.findForUpdate(db, id);
    if (!a || a.ownerMembershipId !== me.membershipId) throw notFound();
    if (a.archivedAt !== null) throw new AppError('conflict', 'an archived AI agent is not edited', { code: 'workspace.ai_agent_archived' });
    if (a.lockVersion !== input.lockVersion) throw stale();
    const saved = (await aiAgentRepo.update(db, id, {
      name: input.name, description: input.description, brief: input.brief, objectTypeIds: input.objectTypeIds, tools: input.tools, lockVersion: a.lockVersion + 1,
    }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'ai_agent_saved', resource: { type: 'ai_agent', id }, detail: { ...detailOf(saved), brief_changed: saved.brief !== a.brief, lock_version: saved.lockVersion },
    });
    return viewOf(saved, 'owner');
  });
}

export async function copy(deps: WorkspaceDeps, ctx: Context, id: string, name: string): Promise<AiAgentView> {
  const me = member(ctx);
  const { a, held } = await readable(deps, me, id);
  if (held === 'view') throw new AppError('forbidden', 'this AI agent is shared with you to ask, not to copy', { code: 'workspace.ai_agent_copy_not_shared' });
  await demand(deps, ctx, { permission: 'ai_agent.save' });
  await check(deps, ctx, { name, description: a.description, brief: a.brief, objectTypeIds: a.objectTypeIds, tools: a.tools });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const made = await aiAgentRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name, description: a.description, brief: a.brief,
      objectTypeIds: a.objectTypeIds, tools: a.tools,
    });
    await recordEvent(db, me, ctx.correlationId, { event: 'ai_agent_created', resource: { type: 'ai_agent', id: made.id }, detail: { copied_from: a.id, ...detailOf(made) } });
    return viewOf(made, 'owner');
  });
}

export async function archive(deps: WorkspaceDeps, ctx: Context, id: string): Promise<AiAgentView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const a = await aiAgentRepo.findForUpdate(db, id);
    if (!a || a.ownerMembershipId !== me.membershipId) throw notFound();
    const done = a.archivedAt !== null ? a : (await aiAgentRepo.update(db, id, { archivedAt: new Date().toISOString(), lockVersion: a.lockVersion + 1 }))!;
    if (a.archivedAt === null) await recordEvent(db, me, ctx.correlationId, { event: 'ai_agent_archived', resource: { type: 'ai_agent', id }, detail: {} });
    return viewOf(done, 'owner');
  });
}

// ----------------------------------------------------------------------------- sharing (37.4, as saved views)

const asShare = <T extends { documentId: string }>(v: T) => { const { documentId, ...rest } = v; return { ...rest, aiAgentId: documentId }; };

export async function share(deps: WorkspaceDeps, ctx: Context, id: string, input: { grantee: ShareGrantee; access: 'view' | 'copy'; expiresAt?: string | undefined }) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'ai_agent.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    asShare(await shareDocument(db, me, ctx.correlationId, AI_AGENT as DocumentKind<SharedDocument>, id, input)));
}

export async function revoke(deps: WorkspaceDeps, ctx: Context, id: string, shareId: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    asShare(await revokeDocumentShare(db, me, ctx.correlationId, AI_AGENT as DocumentKind<SharedDocument>, id, shareId)));
}

export async function shares(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    ({ shares: (await documentShares(db, me, AI_AGENT as DocumentKind<SharedDocument>, await aiAgentRepo.findById(db, id))).map(asShare) }), { readOnly: true });
}
