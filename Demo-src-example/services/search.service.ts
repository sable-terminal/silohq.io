import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { authorityOf, can } from './authorisation.service';
import * as searchRepo from '../repos/search.repo';
import { env } from '../config/env.config';
import type { Capabilities } from '../models/organisation.model';
import type { Actor } from './scope.service';

/**
 * Finding something by name, from anywhere in the app.
 *
 * ── SEARCH IS NOT A SEPARATE PERMISSION, AND MUST NOT BECOME ONE ───────────
 *
 * Every kind below is already reachable by navigating: a saved view from the
 * Console, a file from Files, a connection from Connections, and so on. This
 * endpoint is a shortcut to those pages and nothing else, so each kind asks the
 * SAME question its own list asks, and `search.repo` names the sibling it
 * copied. A search that could see one row more than the list it links to would
 * be an oracle: type letters, watch what comes back, and learn the names of
 * things you are not allowed to open. That is worth saying plainly because it
 * is the failure mode this feature has, and it does not announce itself — a
 * too-permissive search looks exactly like a working one.
 *
 * WHAT A KIND IS *GATED BY* IS ASKED HERE; WHAT A ROW IS *FILTERED BY* IS
 * ASKED IN SQL. Siloes need `silo.manage` before there is any point in looking,
 * and files need a live billing state, so both are decided once, up here.
 * Ownership and shares cannot be decided once — they are per row — so they are
 * in the `WHERE`, which `search.repo` explains at length.
 *
 * NOTHING HERE IS LOGGED OR AUDITED. What somebody typed is their business:
 * there is no audit row, no `detail`, and the request logger records the route
 * rather than the URL, so `?q=` never reaches a log line. A search is a read
 * that changes nothing, and an audit trail of half-typed customer names would
 * be a new disclosure rather than a record of one.
 */

export type SearchKind = 'view' | 'file' | 'connection' | 'silo' | 'concept' | 'cron' | 'person';

export interface Hit {
  kind: SearchKind;
  id: string;
  title: string;
  /** One line under the name. Facts about the thing, never data from inside it. */
  context: string;
  /** Where the app should go. Worked out from `app/client/src/app/(app)`. */
  href: string;
}

export interface SearchResult {
  hits: Hit[];
  /** The cap each kind was asked for, so the panel can say what it is showing. */
  perKind: number;
  /** Kinds with more matches than the cap, so the panel can offer "more". */
  more: SearchKind[];
}

/**
 * A handful of each, not a page of one.
 *
 * FIVE, BECAUSE THE PANEL IS A DROPDOWN AND NOT A RESULTS SCREEN. Seven kinds
 * at five each is already more than fits without scrolling, and somebody whose
 * answer is not in the first five of its kind is better served by the list
 * page for that kind than by a longer dropdown.
 */
const PER_KIND = 5;

/**
 * Where each kind opens.
 *
 * THE SERVER KNOWS THE CLIENT'S ROUTES, WHICH IS A DEBT AND A DELIBERATE ONE.
 * The alternative is the client holding a switch on `kind` — the same knowledge,
 * further from the thing that decides which kinds exist, and a new kind then
 * ships as rows the app silently drops. A hit that 404s is worse than no hit,
 * so the two facts that have to agree are kept side by side.
 *
 * A SAVED VIEW OPENS THE CONSOLE, NOT A PAGE OF ITS OWN. There is no
 * `/views/:id` route: views live in the Console's sidebar, which is where
 * somebody who clicks one expects to land.
 *
 * A PERSON OPENS THE PEOPLE SCREEN, for the same reason — there is no page per
 * membership, and sending somebody to a URL that does not exist to prove a
 * point about consistency helps nobody.
 */
const HREF: Record<SearchKind, (id: string) => string> = {
  view: () => '/console',
  /* The room is Exports; an upload opens at the same address, reached from its Silo. */
  file: (id) => `/exports/${id}`,
  connection: (id) => `/connections/${id}`,
  silo: (id) => `/siloes/${id}`,
  concept: (id) => `/connectors/concepts/${id}`,
  cron: (id) => `/governance/crons/${id}`,
  person: () => '/settings/members',
};

/** A cron's stored schedule, said the way the governance screens say it. */
const CRON_STATUS: Record<string, string> = {
  active: 'Running',
  paused: 'Paused',
};

/**
 * Everything matching, grouped by kind and capped.
 *
 * ONE STATEMENT PER KIND AND ONE TRANSACTION FOR ALL OF THEM. Seven small
 * queries on one connection under one tenant context; a connection per kind
 * would put a keystroke's worth of search against a pool of ten.
 *
 * ASKED FOR ONE MORE THAN THE CAP. "There are more" is a fact the panel needs
 * and a count is the expensive way to get it — a `count(*)` per kind doubles
 * the work to answer a question whose only honest answer is "yes" or "no".
 */
export async function search(
  actor: Actor,
  input: { query: string; capabilities: Capabilities },
): Promise<SearchResult> {
  const needle = searchRepo.escapeNeedle(input.query.trim());
  if (needle === '') return { hits: [], perKind: PER_KIND, more: [] };

  const limit = PER_KIND + 1;

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const forMe = { needle, membershipId: actor.membershipId, limit };

        /*
         * SILOES ONLY WHERE THE BUILD HAS THEM AND THE PERSON MAY MANAGE THEM.
         * `silo.service.list` asserts `silo.manage` and the router is mounted
         * only when `SILOES_AVAILABLE`; a sovereign build has no `/siloes` page
         * to send anybody to, and somebody without the permission cannot open
         * one. Both checks are the list's, not new ones.
         *
         * THE AUTHORITY IS LOADED ONLY WHEN IT COULD MATTER. It is several
         * statements of its own — roles, scopes, clearances — and nothing else
         * here asks a permission, so a build without storage should not pay for
         * it on every keystroke.
         */
        const siloesVisible =
          env.SILOES_AVAILABLE &&
          can(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.manage');

        const [views, files, connections, siloes, concepts, crons, people] = await Promise.all([
          /* Saved views and crons are questions, which a cancelled account
             cannot ask — the same `canQuery` their routers require. */
          input.capabilities.canQuery ? searchRepo.views(db, forMe) : [],
          /* Files need `canExport`, which is what `/files` is mounted behind. */
          input.capabilities.canExport ? searchRepo.files(db, forMe) : [],
          searchRepo.connections(db, forMe),
          siloesVisible ? searchRepo.siloes(db, { needle, limit }) : [],
          searchRepo.concepts(db, { needle, limit }),
          input.capabilities.canQuery ? searchRepo.crons(db, forMe) : [],
          searchRepo.people(db, { needle, limit }),
        ]);

        const hits: Hit[] = [];
        const more: SearchKind[] = [];

        /**
         * Take the cap, and remember whether there was more.
         *
         * THE ORDER WITHIN A KIND IS THE STATEMENT'S, UNTOUCHED. Each query
         * already put prefix matches first and broke ties on the id so the list
         * cannot reshuffle between keystrokes; re-sorting here would throw that
         * away and re-derive it worse.
         */
        const take = <T>(
          kind: SearchKind,
          rows: T[],
          hit: (row: T) => { id: string; title: string; context: string },
        ) => {
          if (rows.length > PER_KIND) more.push(kind);
          for (const row of rows.slice(0, PER_KIND)) {
            const made = hit(row);
            hits.push({ kind, id: made.id, title: made.title, context: made.context, href: HREF[kind](made.id) });
          }
        };

        take('view', views, (view) => ({
          id: view.id,
          title: view.name,
          context: view.conceptName ? `A saved question about ${view.conceptName}` : 'A saved question',
        }));

        take('file', files, (file) => ({
          id: file.id,
          title: file.name,
          context: `${file.kind === 'export' ? 'Exported' : 'Uploaded'} · ${file.contentType}`,
        }));

        take('connection', connections, (connection) => ({
          id: connection.id,
          title: connection.name,
          context: `${connection.provider} · ${connection.status}`,
        }));

        take('silo', siloes, (silo) => ({
          id: silo.id,
          title: silo.name,
          /* The purpose is what somebody typed when they made it, and it is the
             only line that tells two Siloes apart. Disabled is said first
             because it changes what the page means. */
          context: silo.disabled ? `Disabled · ${silo.purpose}` : silo.purpose,
        }));

        take('concept', concepts, (concept) => ({
          id: concept.id,
          title: concept.name,
          context: concept.systems === 1 ? 'In 1 system' : `In ${concept.systems} systems`,
        }));

        take('cron', crons, (cron) => ({
          id: cron.id,
          title: cron.name,
          context: `${CRON_STATUS[cron.status] ?? cron.status} · ${cron.schedule}`,
        }));

        take('person', people, (person) => ({
          id: person.id,
          title: `${person.firstName} ${person.lastName}`.trim() || person.email,
          /*
           * THE ADDRESS, WHICH IS HOW TWO PEOPLE WITH ONE NAME ARE TOLD APART.
           * Suspended and removed memberships are said, because the People
           * screen shows them and a row that looked active would be a lie.
           */
          context: person.status === 'active' ? person.email : `${person.email} · ${person.status}`,
        }));

        return { hits, perKind: PER_KIND, more };
      }),
  );
}
