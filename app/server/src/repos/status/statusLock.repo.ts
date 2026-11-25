// The status service's locks, transaction-scoped so a replica that dies never holds one:
// per cell (so two replicas taking reports from one cell compare against the same last
// report), per notice (so concurrent writes of one notice apply in turn), and one for
// publishing (so replicas write the page in the order they read it, newest last).

import type { Queryable } from '../base.repo.ts';

export const statusLockRepo = {
  async lock(db: Queryable, key: string): Promise<void> {
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`silo.status:${key}`]);
  },
};
