// fleet-control's one lock. Every change to fleet state (a release, a promotion, a verdict,
// a halt, the rollout worker's pass, a bundle) takes it inside its transaction, so the
// replicas of fleet-control apply changes one at a time and agree on channel sequences
// and wave starts. Transaction-scoped: released at commit or rollback, so a replica that
// dies mid-change never holds it. Fleet changes are rare and short; one lock is enough.

import type { Queryable } from '../base.repo.ts';

export const fleetLockRepo = {
  async lock(db: Queryable): Promise<void> {
    await db.query(`select pg_advisory_xact_lock(hashtext('silo.fleet-control'))`);
  },
};
