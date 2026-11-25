import type { Request, Response } from 'express';
import * as concept from '../services/concept.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';
import { refusal } from '../utils/error.util';
import * as conceptQuery from '../services/conceptQuery.service';
import * as render from '../services/render.service';

/**
 * §2 — concepts.
 *
 * `resolvable` IS REPORTED, NOT FILTERED ON. A concept built across finance and
 * engineering is inert to somebody granted neither and half-useful to somebody
 * granted one. Dropping it from the list would tell them it does not exist;
 * saying it is there and they cannot resolve it tells them the truth, which is
 * that somebody needs to grant them a connection.
 */
export async function list(req: Request, res: Response): Promise<void> {
  res.status(200).json({ concepts: await concept.list(actorOf(req)) });
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof concept.confirm>[1]>(req);
  res.status(201).json({ concept: await concept.confirm(actorOf(req), input) });
}

/**
 * §2.2 — derivation.
 *
 * IT RETURNS WHAT IT SKIPPED, NOT JUST WHAT IT FOUND. A second run over an
 * estate somebody has already worked through proposes nothing, and "nothing"
 * with no count beside it reads as a broken feature rather than as a queue
 * already cleared.
 */
export async function derive(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof concept.derive>[1]>(req);
  res.status(200).json(await concept.derive(actorOf(req), input));
}

/** Look across systems if a connection has arrived that nobody has yet (133). Returns at once when nothing is waiting. */
export async function join(req: Request, res: Response): Promise<void> {
  res.status(200).json({ joined: await concept.joinIfPending(actorOf(req)) });
}

export async function proposals(req: Request, res: Response): Promise<void> {
  res.status(200).json({ proposals: await concept.proposals(actorOf(req)) });
}

export async function reject(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await concept.reject(actorOf(req), id);
  res.status(204).end();
}

/**
 * §2.5 — the concept view.
 *
 * IT IS A VIEW AND AN EDITOR FOR CORRECTIONS, NOT A BUILDER. Nobody sits down
 * to design an ontology in Silo; these exist so an admin can see what the system
 * believes about their estate, and fix a mapping months after confirming it.
 */
/**
 * §4.1 — what the system believes references what.
 *
 * THE OTHER HALF OF THE CONCEPT VIEW. The view exists so an administrator can
 * see what this product has concluded about their estate, and a list of
 * concepts is only half of that: the relationships between them are derived
 * from the customer's own foreign keys and are the part nobody typed in.
 *
 * DERIVED EDGES ARE MARKED AS SUCH. `origin` separates what was read out of a
 * schema from what a person stated, because "your systems say this" and "one of
 * your colleagues says this" are answers to different questions.
 */
export async function relationships(req: Request, res: Response): Promise<void> {
  res.status(200).json({ relationships: await concept.relationships(actorOf(req)) });
}

export async function read(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ concept: await concept.read(actorOf(req), id) });
}

export async function rename(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<{ name: string; reason?: string }>(req);
  res.status(200).json({ concept: await concept.rename(actorOf(req), { conceptId: id, ...input }) });
}

export async function correct(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<Omit<Parameters<typeof concept.correct>[1], 'conceptId'>>(req);
  res.status(200).json({ concept: await concept.correct(actorOf(req), { conceptId: id, ...input }) });
}

export async function retire(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { reason } = body<{ reason: string }>(req);
  await concept.retire(actorOf(req), { conceptId: id, reason });
  res.status(204).end();
}

export async function revisions(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ revisions: await concept.revisions(actorOf(req), id) });
}

export async function markings(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ markings: await concept.markings(actorOf(req), id) });
}

export async function setMarkings(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<{ markingIds: string[]; reason?: string }>(req);
  res.status(200).json({
    markings: await concept.setMarkings(actorOf(req), { conceptId: id, ...input }),
  });
}

/**
 * §4.1 — which instances of one concept reach which instances of another.
 *
 * THE ROUTES COME BACK WHETHER OR NOT ONE WAS WALKED, because a caller asking
 * "how do these two relate" is owed the answer that there are two ways and they
 * can disagree. Each names the system that declared it, which is the only thing
 * separating two routes whose sentences read identically.
 *
 * IT SAYS WHERE THINGS SIT AND NEVER WHY. The paths state that a supplier is
 * upstream of an invoice, through the keys crossed to get there — see
 * `describeRoute`, where that vocabulary is fixed in code.
 */
export async function walk(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof concept.walk>[1]>(req);
  res.status(200).json(await concept.walk(actorOf(req), input));
}

/**
 * §2.6 — which records are the same thing, and which did not match.
 *
 * THE UNMATCHED COUNT IS THE ANSWER WORTH HAVING. "Two thousand six hundred
 * customers" is reassuring and easy; "ninety we could not place" is the honest
 * measure of how well an ontology fits an estate, and there was no way to ask
 * for it. §2.6 is explicit that those are QUESTIONS rather than findings — a
 * record is either genuinely absent or spelled differently, and nothing here
 * can tell which.
 */
export async function resolve(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { limit } = body<{ limit?: number }>(req);

  res.status(200).json(await concept.resolve(actorOf(req), { conceptId: id, limit }));
}

/**
 * §7 — a question asked in the concept's own words.
 *
 * THE JOIN IS ANSWERED NOW, and the clause being reserved from the start is why
 * adding it changed no API anybody had built on. It was refused BY NAME rather
 * than ignored, which is the difference between "not yet" and an answer about
 * invoices alone presented as an answer about invoices and suppliers.
 *
 * THE TWO SIDES COME BACK SEPARATELY, PAIRED BY IDENTIFIER, rather than
 * flattened into rows. One invoice reaching three suppliers is a fact about the
 * data; a flat table would silently triple the invoice.
 */
export async function ask(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const query = body<
    Parameters<typeof conceptQuery.ask>[1]['query'] & {
      join?: Array<{
        to: string;
        select: string[];
        where: Parameters<typeof conceptQuery.ask>[1]['query']['where'];
        limit: number;
        routeIndex?: number;
      }>;
    }
  >(req);

  const [joined] = query.join ?? [];

  if (joined) {
    const { join: _ignored, ...own } = query;

    const crossed = await conceptQuery.askJoined(actorOf(req), {
        conceptId: id,
        query: own,
        join: {
          conceptId: joined.to,
          query: {
            select: joined.select,
            where: joined.where,
            sort: [],
            limit: joined.limit,
          },
          routeIndex: joined.routeIndex,
        },
    });

    /*
     * Rendering §1 — "It receives a result that has already been computed…
     * and decides how to show it." So the archetype is attached HERE, in the
     * presentation layer, rather than inside the query: §1 also says "nothing
     * here queries", and a query service that returned a drawing instruction
     * would be both.
     *
     * A JOINED ANSWER IS DESCRIBED BY ITS LEADING SIDE, which is the one the
     * reader asked about. The joined side is reached through it.
     */
    res.status(200).json({
      ...crossed,
      /*
       * §12 step 6 — the pairs a join produces ARE §4.1's "relationship edges
       * between rows": which record reached which, by the identifier each
       * system states. Directed, because a walk follows a relationship one way
       * and the direction is the information.
       */
      render: render.describe(crossed.answer, {
        sort: own.sort,
        edges: crossed.joined.pairs,
        directedEdges: true,
      }),
    });
    return;
  }

  const answer = await conceptQuery.ask(actorOf(req), { conceptId: id, query });
  res.status(200).json({ ...answer, render: render.describe(answer, { sort: query.sort }) });
}
