import type { Executor } from '../infra/db.infra';

/**
 * Finding a thing by its name, one statement per kind of thing.
 *
 * SQL AND THE ROW-TO-MODEL MAPPING, as everywhere in `repos/`. What a kind is
 * called on a screen, which href opens it and how many of each to show are all
 * the service's decisions and none of them are here.
 *
 * ── THE VISIBILITY PREDICATES ARE IN THE `WHERE`, AND THAT IS DELIBERATE ────
 *
 * `repos/README.md` says a condition belongs in a `WHERE` clause only when the
 * query would otherwise be wrong. It would be. Search asks "which of the
 * thousands of rows in this tenant match these letters", and a version that
 * fetched the matches and filtered them in TypeScript would hold every saved
 * view, file and connection in the organisation in memory — one careless
 * `return` away from being the response, and with a count that discloses what
 * was filtered out. `file.repo.filesIn` makes the same argument for the same
 * reason, in the same words.
 *
 * EVERY PREDICATE BELOW IS COPIED FROM THE LIST IT MUST AGREE WITH, and each
 * one says which. If a share, a grant or an ownership rule changes in its own
 * repo, the sibling here has to change with it — so they are written to look
 * identical rather than merely equivalent.
 *
 * ── ILIKE, AND WHAT WOULD HAVE TO CHANGE AT TEN TIMES THIS SIZE ────────────
 *
 * `ILIKE '%needle%'` cannot use a B-tree index, so each statement is a scan of
 * one tenant's rows for one kind. At the scale this product is at — hundreds of
 * views, files and connections per organisation, thousands of people at the
 * outside — a scan of a few thousand rows behind row level security is under a
 * millisecond, and a search index would be a second copy of the truth that goes
 * stale on every rename.
 *
 * At ten times the size the leading `%` is what breaks first: the scan becomes
 * the whole table per keystroke, times seven kinds, times everybody typing. The
 * change then is a `pg_trgm` GIN index on each searched column and `%` / `<->`
 * in place of `ILIKE`, which keeps the substring behaviour and makes it
 * indexable; `tsvector` is the wrong tool because these are names rather than
 * prose, and nobody searching for "acme" wants it stemmed. Both want a
 * generated `lower(...)` column so the index and the predicate agree, and both
 * want the ranking below expressed as an index-friendly expression rather than
 * as `ILIKE` a second time.
 */

/**
 * The matching and ordering shared by every statement here.
 *
 * ONE ESCAPED NEEDLE, TWO PATTERNS BUILT FROM IT IN SQL. A caller that composed
 * `%needle%` itself would be deciding how the match works, and the two tiers of
 * the ranking would then be built from different strings.
 *
 * `ORDER BY` IS THE SAME THREE TERMS EVERYWHERE: a prefix beats a substring,
 * then name, then id. The id is what makes it stable — two views called the
 * same thing must not swap places between keystrokes, which is what turns a
 * list somebody is arrowing down into a list they cannot hit.
 */
const rank = (column: string) => `(${column} ILIKE $1 || '%') DESC, lower(${column}), id`;

/**
 * `%`, `_` and the escape character itself, made literal.
 *
 * WITHOUT THIS A SEARCH FOR `_` MATCHES EVERYTHING, which reads as the search
 * being broken rather than as a wildcard nobody meant to type. `\` is the
 * default escape in Postgres's `LIKE`, so escaping it first is what stops a
 * trailing backslash making the pattern invalid.
 */
export const escapeNeedle = (needle: string): string =>
  needle.replace(/[\\%_]/g, (character) => `\\${character}`);

export interface ViewMatch {
  id: string;
  name: string;
  /** The concept it asks about, for the line under the name. */
  conceptName: string | null;
}

/**
 * Saved views this person owns or has been shared.
 *
 * THE PREDICATE IS `savedView.repo`'s, BOTH HALVES. `listOwnedBy` is
 * `owner_membership_id = $2`; `sharedWith` is the live-share test — not
 * revoked, not expired, and reaching them by name, by scope or by the whole
 * organisation. A view somebody can open is one or the other, so search is the
 * union and nothing else.
 *
 * `archived_at` AND `suspended_at` ARE READ THE STRICT WAY. Both columns are
 * newer than the lists above and neither is set by anything yet. An archived
 * view is one somebody put away and a suspended share is one that is not in
 * effect, so on the day either starts being written, a search that had ignored
 * them would be offering rows the sidebar does not show — which is the wrong
 * side to be wrong on.
 */
export async function views(
  db: Executor,
  input: { needle: string; membershipId: string; limit: number },
): Promise<ViewMatch[]> {
  const { rows } = await db.query<{ id: string; name: string; concept_name: string | null }>(
    `SELECT v.id, v.name, c.name AS concept_name
       FROM saved_views v
       LEFT JOIN concepts c ON c.id = v.concept_id
      WHERE v.name ILIKE '%' || $1 || '%'
        AND v.archived_at IS NULL
        AND (
          v.owner_membership_id = $2
          OR EXISTS (
               SELECT 1 FROM view_shares s
                WHERE s.view_id = v.id
                  AND s.revoked_at IS NULL
                  AND s.suspended_at IS NULL
                  AND (s.expires_at IS NULL OR s.expires_at > now())
                  AND (
                    s.membership_id = $2
                    OR s.organisation_wide
                    OR s.scope_id IN (SELECT scope_id FROM scope_memberships WHERE membership_id = $2)
                  )
             )
        )
      ORDER BY ${rank('v.name')}
      LIMIT $3`,
    [input.needle, input.membershipId, input.limit],
  );

  return rows.map((row) => ({ id: row.id, name: row.name, conceptName: row.concept_name }));
}

export interface FileMatch {
  id: string;
  name: string;
  kind: 'export' | 'upload';
  contentType: string;
}

/**
 * Files this person made or has been shared.
 *
 * THE PREDICATE IS `file.repo.filesIn`'s, WITHOUT THE FOLDER. Folders are an
 * arrangement and not a boundary, so searching is the same question asked of
 * every folder at once: created by them, or reached by a live share.
 *
 * `received_at IS NOT NULL` IS NOT A PERMISSION CHECK. A row whose bytes have
 * not turned up is not a file yet, and offering it would open a page with
 * nothing behind it.
 */
export async function files(
  db: Executor,
  input: { needle: string; membershipId: string; limit: number },
): Promise<FileMatch[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    kind: 'export' | 'upload';
    content_type: string;
  }>(
    `SELECT f.id, f.name, f.kind, f.content_type
       FROM files f
      WHERE f.name ILIKE '%' || $1 || '%'
        AND f.deleted_at IS NULL
        AND f.received_at IS NOT NULL
        AND (
          f.created_by = $2
          OR EXISTS (
               SELECT 1 FROM file_shares s
                WHERE s.file_id = f.id
                  AND s.revoked_at IS NULL
                  AND (s.expires_at IS NULL OR s.expires_at > now())
                  AND (
                    s.membership_id = $2
                    OR s.organisation_wide
                    OR s.scope_id IN (SELECT scope_id FROM scope_memberships WHERE membership_id = $2)
                  )
             )
        )
      ORDER BY ${rank('f.name')}
      LIMIT $3`,
    [input.needle, input.membershipId, input.limit],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    contentType: row.content_type,
  }));
}

export interface ConnectionMatch {
  id: string;
  name: string;
  provider: string;
  status: string;
}

/**
 * Connections this person holds a read grant on.
 *
 * THE PREDICATE IS `connector.repo.readableIds`, WRITTEN OUT. That function
 * takes a list of ids and answers which of them are readable, which is the
 * wrong shape here — search does not have the list, and fetching every
 * connection to ask would be the "filter in TypeScript" this file exists to
 * avoid. The clause is the same one: a live grant, `can_read`, reaching them
 * organisation-wide, by name, or through a scope and its subtree when the grant
 * says so.
 *
 * `status <> 'revoked'` MATCHES THE LIST. A revoked connection no longer names
 * a live system and `connection.repo.overview` leaves it out, so search must.
 */
export async function connections(
  db: Executor,
  input: { needle: string; membershipId: string; limit: number },
): Promise<ConnectionMatch[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    provider: string;
    status: string;
  }>(
    `SELECT c.id, c.name, c.provider, c.status
       FROM connections c
      WHERE c.name ILIKE '%' || $1 || '%'
        AND c.status <> 'revoked'
        AND EXISTS (
          SELECT 1
            FROM connection_grants g
           WHERE g.connection_id = c.id
             AND g.revoked_at IS NULL
             AND (g.expires_at IS NULL OR g.expires_at > now())
             AND g.can_read
             AND (
               g.organisation_wide
               OR g.membership_id = $2
               OR EXISTS (
                 SELECT 1
                   FROM scope_memberships sm
                   JOIN scopes mine ON mine.id = sm.scope_id
                   JOIN scopes granted ON granted.id = g.scope_id
                  WHERE sm.membership_id = $2
                    AND (
                      mine.id = granted.id
                      OR (g.include_descendants AND mine.path <@ granted.path)
                    )
               )
             )
        )
      ORDER BY ${rank('c.name')}
      LIMIT $3`,
    [input.needle, input.membershipId, input.limit],
  );

  return rows;
}

export interface SiloMatch {
  id: string;
  name: string;
  purpose: string;
  disabled: boolean;
}

/**
 * Siloes.
 *
 * NO PREDICATE BUT THE NAME, because `silo.repo.list` has none either — who may
 * see a Silo at all is a permission, `silo.manage`, and the service asks for it
 * before calling this. Adding a second, weaker test here would make the two
 * disagree the first time the permission changed.
 *
 * DISABLED ONES COME BACK, as they do on the list. A disabled Silo still has a
 * page, still says what it held, and still has to be findable to be re-enabled.
 */
export async function siloes(
  db: Executor,
  input: { needle: string; limit: number },
): Promise<SiloMatch[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    purpose: string;
    disabled_at: Date | null;
  }>(
    `SELECT id, name, purpose, disabled_at
       FROM siloes
      WHERE name ILIKE '%' || $1 || '%'
      ORDER BY ${rank('name')}
      LIMIT $2`,
    [input.needle, input.limit],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    disabled: row.disabled_at !== null,
  }));
}

export interface ConceptMatch {
  id: string;
  name: string;
  /** How many systems contribute to it — the line under the name. */
  systems: number;
}

/**
 * Live concepts.
 *
 * THE PREDICATE IS `concept.repo.listLive`'s: `retired_at IS NULL`, and
 * nothing else. A retired concept no longer describes anything; a live one is
 * visible to everybody in the tenant, exactly as `concept.service.list` returns
 * it. Clearance gates RESOLVING a concept and walking between two, not knowing
 * that it exists — `concept.service.read` asserts none either — so search must
 * not invent a stricter rule than the page it links to.
 *
 * THE SYSTEM COUNT IS EVERY CONTRIBUTING OBJECT, not the readable ones. It is
 * the same number the concepts list shows before any grant is considered, and
 * making it per-reader would mean a second statement per concept.
 */
export async function concepts(
  db: Executor,
  input: { needle: string; limit: number },
): Promise<ConceptMatch[]> {
  const { rows } = await db.query<{ id: string; name: string; systems: string }>(
    `SELECT c.id, c.name,
            (SELECT count(*) FROM concept_objects o WHERE o.concept_id = c.id) AS systems
       FROM concepts c
      WHERE c.name ILIKE '%' || $1 || '%'
        AND c.retired_at IS NULL
      ORDER BY ${rank('c.name')}
      LIMIT $2`,
    [input.needle, input.limit],
  );

  return rows.map((row) => ({ id: row.id, name: row.name, systems: Number(row.systems) }));
}

export interface CronMatch {
  id: string;
  name: string;
  status: string;
  schedule: string;
}

/**
 * Crons this person owns.
 *
 * THE PREDICATE IS `automation.repo.listOwnedBy`'s: `owner_membership_id`. An
 * automation is not shared with anybody — `/crons` returns only your own and
 * `/crons/:id` refuses a colleague's — so search returns only your own.
 */
export async function crons(
  db: Executor,
  input: { needle: string; membershipId: string; limit: number },
): Promise<CronMatch[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    status: string;
    schedule: string;
  }>(
    `SELECT id, name, status, schedule
       FROM automations
      WHERE name ILIKE '%' || $1 || '%'
        AND owner_membership_id = $2
      ORDER BY ${rank('name')}
      LIMIT $3`,
    [input.needle, input.membershipId, input.limit],
  );

  return rows;
}

export interface PersonMatch {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  status: string;
}

/**
 * People in this organisation.
 *
 * THE PREDICATE IS `membership.repo.listForOrganisationWithUser`'s, WHICH IS
 * THE TENANT AND NOTHING ELSE. `/members` is open to every authenticated member
 * with no permission in front of it — a colleague list is not a secret from
 * colleagues — so search says exactly what the People screen already does.
 *
 * NAME OR ADDRESS, because half of finding somebody is knowing only one of the
 * two. The prefix tier is the first name, which is what people type.
 */
export async function people(
  db: Executor,
  input: { needle: string; limit: number },
): Promise<PersonMatch[]> {
  const { rows } = await db.query<{
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    status: string;
  }>(
    `SELECT m.id, u.first_name, u.last_name, u.email::text AS email, m.status
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE u.first_name ILIKE '%' || $1 || '%'
         OR u.last_name ILIKE '%' || $1 || '%'
         OR u.email::text ILIKE '%' || $1 || '%'
      ORDER BY (u.first_name ILIKE $1 || '%'
                OR u.last_name ILIKE $1 || '%'
                OR u.email::text ILIKE $1 || '%') DESC,
               lower(u.first_name), lower(u.last_name), m.id
      LIMIT $2`,
    [input.needle, input.limit],
  );

  return rows.map((row) => ({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    status: row.status,
  }));
}
