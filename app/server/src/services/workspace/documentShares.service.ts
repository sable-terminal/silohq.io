// Sharing a workbook, report, process analysis or AI agent (D232 to D236), as a saved view is shared (37.4): by its owner,
// with an active member, a scope or the organisation, to open (view) or to copy (copy), under the
// owner's sharing policy as ceiling; re-sharing updates the one row per grantee; a share's state is
// worked out at every read, and visibility is derived from the live shares the policy permits.

import type { ShareGrantee } from '../../contracts/workspace/sharing.contract.ts';
import type { Queryable } from '../../infra/postgres.infra.ts';
import type { ViewShare } from '../../models/workspace/viewShare.model.ts';
import { membershipRepo, scopeRepo } from '../../repos/iam/index.repo.ts';
import { viewShareRepo, type DocumentArm } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordEvent, type Member } from './deps.service.ts';
import { effectivePolicy, granteeOf, permitted, stateOf } from './sharing.service.ts';

export type DocumentHeld = 'owner' | 'view' | 'copy';
/** Each arm: the share row's column, the audited resource type, and what a message calls it. */
const ARM = {
  workbook: { field: 'workbookId', resource: 'workbook', noun: 'workbook' },
  report: { field: 'reportId', resource: 'report', noun: 'report' },
  process: { field: 'processAnalysisId', resource: 'process_analysis', noun: 'analysis' },
  ai_agent: { field: 'aiAgentId', resource: 'ai_agent', noun: 'AI agent' },
  notebook: { field: 'notebookId', resource: 'notebook', noun: 'notebook' },
  ml_model: { field: 'mlModelId', resource: 'ml_model', noun: 'model' },
} as const satisfies Record<DocumentArm, { field: keyof ViewShare; resource: string; noun: string }>;
type Visibility = 'private' | 'shared' | 'org_visible';
export interface SharedDocument { id: string; organisationId: string; ownerMembershipId: string; visibility: Visibility; archivedAt: string | null }

export interface DocumentKind<D extends SharedDocument> {
  arm: DocumentArm;
  findForUpdate(db: Queryable, id: string): Promise<D | undefined>;
  setVisibility(db: Queryable, id: string, visibility: Visibility): Promise<unknown>;
  notFound(): AppError;
}

/** What a member holds: owner, or the best live share the owner's policy still permits. */
export async function heldOn(db: Queryable, kind: DocumentKind<SharedDocument>, d: SharedDocument, membershipId: string): Promise<DocumentHeld | undefined> {
  if (d.ownerMembershipId === membershipId) return 'owner';
  if (d.archivedAt !== null) return undefined;
  const shares = await viewShareRepo.liveReachingDocument(db, kind.arm, d.id, membershipId);
  if (shares.length === 0) return undefined;
  const policy = await effectivePolicy(db, d.organisationId, d.ownerMembershipId);
  let best: DocumentHeld | undefined;
  for (const share of shares) {
    if (!await permitted(db, d.ownerMembershipId, granteeOf(share), policy)) continue;
    if (share.access === 'copy' || best === undefined) best = share.access as DocumentHeld;
  }
  return best;
}

export async function shareViewOf(db: Queryable, share: ViewShare, ownerId: string, policy: Awaited<ReturnType<typeof effectivePolicy>>) {
  let state: ReturnType<typeof stateOf> | 'forbidden_by_policy' = stateOf(share);
  if (state === 'live' && !await permitted(db, ownerId, granteeOf(share), policy)) state = 'forbidden_by_policy';
  return {
    id: share.id, documentId: (share.workbookId ?? share.reportId ?? share.processAnalysisId ?? share.aiAgentId ?? share.notebookId ?? share.mlModelId)!, grantee: granteeOf(share), access: share.access as 'view' | 'copy',
    sharedBy: share.sharedBy, sharedAt: share.sharedAt, expiresAt: share.expiresAt, revokedAt: share.revokedAt, state,
  };
}

async function refreshVisibility(db: Queryable, kind: DocumentKind<SharedDocument>, d: SharedDocument): Promise<void> {
  const policy = await effectivePolicy(db, d.organisationId, d.ownerMembershipId);
  let visibility: Visibility = 'private';
  for (const share of await viewShareRepo.listForDocument(db, kind.arm, d.id)) {
    if (stateOf(share) !== 'live' || !await permitted(db, d.ownerMembershipId, granteeOf(share), policy)) continue;
    visibility = share.organisationWide ? 'org_visible' : visibility === 'org_visible' ? visibility : 'shared';
  }
  if (visibility !== d.visibility) await kind.setVisibility(db, d.id, visibility);
}

async function owned<D extends SharedDocument>(db: Queryable, kind: DocumentKind<D>, id: string, membershipId: string): Promise<D> {
  const d = await kind.findForUpdate(db, id);
  if (!d || d.ownerMembershipId !== membershipId) throw kind.notFound();
  return d;
}

export async function shareDocument(db: Queryable, me: Member, correlationId: string, kind: DocumentKind<SharedDocument>, id: string,
  input: { grantee: ShareGrantee; access: 'view' | 'copy'; expiresAt?: string | undefined }) {
  if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= Date.now()) {
    throw new AppError('validation', 'a share expires in the future', { code: 'workspace.share_expiry_past' });
  }
  const d = await owned(db, kind, id, me.membershipId);
  if (d.archivedAt !== null) throw new AppError('conflict', `an archived ${ARM[kind.arm].noun} is not shared`, { code: `workspace.${kind.arm}_archived` });
  const grantee = input.grantee;
  if (grantee.kind === 'membership') {
    if (grantee.membershipId === me.membershipId) throw new AppError('validation', `${/^[AEIO]/.test(ARM[kind.arm].noun) ? 'an' : 'a'} ${ARM[kind.arm].noun} is not shared with its owner`, { code: 'workspace.share_self' });
    const target = await membershipRepo.findById(db, grantee.membershipId);
    if (!target || target.status !== 'active') throw new AppError('validation', 'share with an active member of this organisation', { code: 'workspace.share_grantee_unknown' });
  } else if (grantee.kind === 'scope') {
    const scope = await scopeRepo.findById(db, grantee.scopeId);
    if (!scope || scope.archivedAt !== null) throw new AppError('validation', 'no such scope', { code: 'workspace.share_grantee_unknown' });
  }
  const policy = await effectivePolicy(db, me.organisationId, me.membershipId);
  if (!await permitted(db, me.membershipId, grantee, policy)) {
    throw new AppError('forbidden', `the sharing policy (${policy.viewSharingPolicy}) does not allow this share`, { code: 'workspace.share_forbidden', details: { policy: policy.viewSharingPolicy } });
  }
  const now = new Date().toISOString();
  const existing = await viewShareRepo.findForDocumentGrantee(db, kind.arm, d.id, {
    ...(grantee.kind === 'membership' ? { membershipId: grantee.membershipId } : {}), ...(grantee.kind === 'scope' ? { scopeId: grantee.scopeId } : {}),
    ...(grantee.kind === 'organisation' ? { organisation: true as const } : {}),
  });
  const row = existing
    ? (await viewShareRepo.update(db, existing.id, { access: input.access, expiresAt: input.expiresAt ?? null, revokedAt: null, suspendedAt: null, sharedBy: me.membershipId, sharedAt: now }))!
    : await viewShareRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId,
      [ARM[kind.arm].field]: d.id,
      membershipId: grantee.kind === 'membership' ? grantee.membershipId : null, scopeId: grantee.kind === 'scope' ? grantee.scopeId : null,
      organisationWide: grantee.kind === 'organisation' ? true : null, access: input.access, sharedBy: me.membershipId, sharedAt: now, expiresAt: input.expiresAt ?? null,
    });
  await refreshVisibility(db, kind, d);
  await recordEvent(db, me, correlationId, {
    event: `${kind.arm}_shared`, resource: { type: ARM[kind.arm].resource, id: d.id }, subjectMembershipId: grantee.kind === 'membership' ? grantee.membershipId : null,
    scopeId: grantee.kind === 'scope' ? grantee.scopeId : null, detail: { share_id: row.id, grantee: grantee.kind, access: input.access },
  });
  return shareViewOf(db, row, me.membershipId, policy);
}

export async function revokeDocumentShare(db: Queryable, me: Member, correlationId: string, kind: DocumentKind<SharedDocument>, id: string, shareId: string) {
  const d = await owned(db, kind, id, me.membershipId);
  const found = await viewShareRepo.findById(db, shareId);
  const armOf = found?.[ARM[kind.arm].field];
  if (!found || armOf !== d.id) throw new AppError('not_found', 'no such share', { code: 'workspace.share_not_found' });
  const row = found.revokedAt !== null ? found : (await viewShareRepo.update(db, found.id, { revokedAt: new Date().toISOString() }))!;
  if (found.revokedAt === null) {
    await refreshVisibility(db, kind, d);
    await recordEvent(db, me, correlationId, {
      event: `${kind.arm}_share_revoked`, resource: { type: ARM[kind.arm].resource, id: d.id }, subjectMembershipId: found.membershipId, scopeId: found.scopeId, detail: { share_id: found.id },
    });
  }
  return shareViewOf(db, row, me.membershipId, await effectivePolicy(db, me.organisationId, me.membershipId));
}

export async function documentShares(db: Queryable, me: Member, kind: DocumentKind<SharedDocument>, d: SharedDocument | undefined) {
  if (!d || d.ownerMembershipId !== me.membershipId) throw kind.notFound();
  const policy = await effectivePolicy(db, me.organisationId, me.membershipId);
  const out = [];
  for (const row of await viewShareRepo.listForDocument(db, kind.arm, d.id)) out.push(await shareViewOf(db, row, me.membershipId, policy));
  return out;
}
