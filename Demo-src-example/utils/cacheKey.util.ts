/**
 * What a cache key must look like, and what may survive in one.
 *
 * THE RULE LIVES HERE, NOT IN THE REDIS CLIENT, for the same reason
 * `tenantContext` does not live in the database wrapper. It is a tenancy
 * decision, and it would be just as true if the cache were Memcached or a Map.
 * A rule implemented inside one client is a rule the second client's author has
 * no reason to know about.
 *
 * TWO PLANES, AND THEY HAVE DIFFERENT RULES:
 *
 *   CONTROL PLANE   Sessions, rate limit counters, locks. May persist for their
 *                   TTL. Keyed by the thing itself, not by tenant.
 *
 *   DATA PLANE      Anything derived from customer data: a compiled result, a
 *                   resolved entity, a schema probe. MUST carry an organisation
 *                   namespace, and MUST have a short TTL.
 *
 * THE DATA PLANE NEVER PERSISTS, WHICH IS A PRODUCT CLAIM AND NOT AN
 * OPTIMISATION. "0 rows stored" is on the marketing site. A result cached for an
 * hour is customer data at rest in a system nobody thinks of as a database, in a
 * process with no row level security and no audit trail.
 */

export type Plane = 'control' | 'data';

/** The longest a data-plane value may live. See the note above. */
export const MAX_DATA_PLANE_TTL_SECONDS = 60;

const NAMESPACE_PATTERN = /^[a-z][a-z0-9:_-]*$/;

export interface KeySpec {
  plane: Plane;
  /** `session`, `ratelimit`, `result`, `entity`. */
  kind: string;
  /** Required on the data plane, forbidden on the control plane. */
  organisationId?: string | null;
  /** The rest of the identity: an id, a hash, a composite. */
  parts: readonly string[];
}

export function build(spec: KeySpec): string {
  if (!NAMESPACE_PATTERN.test(spec.kind)) {
    throw new Error(`Cache kind "${spec.kind}" must be lowercase alphanumeric.`);
  }

  if (spec.plane === 'data') {
    /*
     * WITHOUT THE TENANT IN THE KEY, TWO CUSTOMERS ASKING THE SAME QUESTION
     * SHARE AN ANSWER. It is the single worst bug this system could have: a
     * cache hit that returns another company's figures, with no query executed,
     * no policy consulted and nothing in any log to say it happened.
     */
    if (!spec.organisationId) {
      throw new Error(
        `A data-plane cache key ("${spec.kind}") must carry an organisation id. ` +
          `Without it, two tenants asking the same question share an answer.`,
      );
    }
    return ['d', spec.organisationId, spec.kind, ...spec.parts].join(':');
  }

  if (spec.organisationId) {
    // Not fatal, but it means somebody has mislabelled the plane — and a
    // tenant-scoped value on the control plane is one with no TTL ceiling.
    throw new Error(
      `Control-plane key "${spec.kind}" carries an organisation id. If it holds ` +
        `tenant data it belongs on the data plane, which is TTL-capped.`,
    );
  }

  return ['c', spec.kind, ...spec.parts].join(':');
}

/** Which plane a key belongs to, read back from the key itself. */
export function planeOf(key: string): Plane | null {
  if (key.startsWith('d:')) return 'data';
  if (key.startsWith('c:')) return 'control';
  return null;
}

/**
 * A TTL that respects the plane's ceiling.
 *
 * CLAMPED RATHER THAN REJECTED. A caller asking for an hour on a data-plane key
 * has made a mistake, and the safe correction is to cache it for a minute. A
 * throw here would mean a caching bug takes a request down, which invites
 * somebody to remove the cache rather than fix the TTL.
 */
export function ttlFor(plane: Plane, requestedSeconds: number): number {
  if (plane === 'data') return Math.min(requestedSeconds, MAX_DATA_PLANE_TTL_SECONDS);
  return requestedSeconds;
}

/** The prefix that deletes everything cached for one tenant. */
export function tenantPrefix(organisationId: string): string {
  return `d:${organisationId}:`;
}
