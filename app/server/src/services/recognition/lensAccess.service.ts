// Who holds what on a Lens (spec 38.9, chapter 56; decision 2026-11-14): its owner, or the
// best live share reaching a member that the owner's sharing policy still permits (the same
// test as saved views, so a later, stricter policy stops a share without rewriting it).
// Access levels view, use, copy, each including the ones before it. Holding a share never
// grants access to anything in the Lens: every open resolves under the opener's own access.

import type { Queryable } from '../../infra/postgres.infra.ts';
import type { Lens } from '../../models/recognition/lens.model.ts';
import type { LensShare } from '../../models/recognition/lensShare.model.ts';
import { lensShareRepo } from '../../repos/recognition/index.repo.ts';
import { effectivePolicy, permitted } from '../workspace/sharing.service.ts';
import type { ShareGrantee } from '../../contracts/workspace/sharing.contract.ts';

export type LensAccess = 'view' | 'use' | 'copy';
const ORDER: readonly LensAccess[] = ['view', 'use', 'copy'];

export function granteeOfLensShare(share: LensShare): ShareGrantee {
  if (share.granteeMembershipId !== null) return { kind: 'membership', membershipId: share.granteeMembershipId };
  if (share.granteeScopeId !== null) return { kind: 'scope', scopeId: share.granteeScopeId };
  return { kind: 'organisation' };
}

export async function accessToLens(db: Queryable, lens: Lens, membershipId: string): Promise<'owner' | LensAccess | undefined> {
  if (lens.archivedAt !== null) return undefined;
  if (lens.membershipId === membershipId) return 'owner';
  const shares = await lensShareRepo.liveReaching(db, lens.id, membershipId);
  if (shares.length === 0) return undefined;
  const policy = await effectivePolicy(db, lens.organisationId, lens.membershipId);
  let best: LensAccess | undefined;
  for (const share of shares) {
    if (!await permitted(db, lens.membershipId, granteeOfLensShare(share), policy)) continue;
    const access = share.access as LensAccess;
    if (best === undefined || ORDER.indexOf(access) > ORDER.indexOf(best)) best = access;
  }
  return best;
}
