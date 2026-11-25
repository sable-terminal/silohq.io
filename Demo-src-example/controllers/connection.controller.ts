import type { Request, Response } from 'express';
import * as forms from '../services/connectForm.service';
import { env } from '../config/env.config';
import { withTransaction } from '../infra/db.infra';
import * as connectorRepo from '../repos/connector.repo';
import * as connectorOAuth from '../services/connectorOAuth.service';
import * as provider from '../services/oauthProvider.service';
import * as connections from '../services/connection.service';
import * as connectionVersions from '../services/connectionVersion.service';
import * as connectionDerive from '../services/connectorDerive.service';
import * as connectorFields from '../services/connectorFields.service';
import * as verify from '../services/connectorVerify.service';
import * as heal from '../services/connectorHeal.service';
import * as inbound from '../services/inbound.service';
import * as grants from '../services/connectionGrant.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params, query } from '../middleware/validate.middleware';
import { notFound } from '../utils/error.util';

/**
 * Connecting a system that authenticates with OAuth.
 *
 * THREE OF THESE FOUR REQUIRE A SESSION AND ONE CANNOT. The callback is a
 * browser navigation arriving from the provider, so there is no session to read
 * and no organisation in the request — the state token is what says which
 * connection this belongs to, and it is consumed in a single statement so a
 * replayed callback finds nothing.
 */

export async function inspect(req: Request, res: Response): Promise<void> {
  actorOf(req);
  const { issuerUrl } = body<{ issuerUrl: string }>(req);
  res.status(200).json(await provider.inspectProvider(issuerUrl));
}

export async function configureClient(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const { id } = params<{ id: string }>(req);
  const input = body<{
    clientName: string;
    issuerUrl?: string;
    clientId?: string;
    clientSecret?: string;
  }>(req);

  await load(actor, id);

  const result = await provider.provisionClient({
    connectionId: id,
    clientName: input.clientName,
    issuerUrl: input.issuerUrl,
    supplied:
      input.clientId && input.clientSecret
        ? { clientId: input.clientId, clientSecret: input.clientSecret }
        : undefined,
  });

  // `result` carries a client id and never a secret. See `provisionClient`.
  res.status(200).json(result);
}

export async function start(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const { id } = params<{ id: string }>(req);

  const connection = await load(actor, id);

  const { redirectTo } = await connectorOAuth.begin({
    organisationId: actor.organisationId,
    membershipId: actor.membershipId,
    connectionId: id,
    manifest: connection.manifest,
  });

  /*
   * THE URL IS RETURNED, NOT REDIRECTED TO. This is called by script from a
   * builder screen, and a 302 on an XHR is followed by the runtime into a
   * cross-origin consent page it cannot read — the caller navigates the top
   * window itself.
   */
  res.status(200).json({ redirectTo });
}

export async function callback(req: Request, res: Response): Promise<void> {
  const params_ = query<{ state?: string; code?: string; error?: string }>(req);
  const back = (outcome: string, extra = '') =>
    res.redirect(`${env.APP_URL}/connections?oauth=${outcome}${extra}`);

  /*
   * A PROVIDER THAT SAYS "denied" IS NOT AN ERROR HERE. Somebody pressed cancel
   * on the consent screen, and telling them the connection failed when they
   * chose not to make one is how a product reads as broken.
   */
  if (params_.error) {
    return void back(params_.error === 'access_denied' ? 'cancelled' : 'failed');
  }
  if (!params_.state || !params_.code) return void back('failed');

  try {
    const outcome = await connectorOAuth.complete({ state: params_.state, code: params_.code });

    /*
     * MISSING SCOPES ARE REPORTED, NOT TREATED AS FAILURE. §4.3 — a provider
     * that grants less than was asked for has made a connection that works for
     * some objects and not others, and the person should be told which rather
     * than be handed a connection that fails later on one table.
     */
    const missingScopes = outcome.missingScopes.length
      ? `&missing=${encodeURIComponent(outcome.missingScopes.join(','))}`
      : '';

    return void back('connected', `&connection=${outcome.connectionId}${missingScopes}`);
  } catch (error) {
    /*
     * LOGGED HERE AND NOT SENT ON. The redirect target is a page in a browser
     * that may not be signed in, and the reason a state failed to consume is
     * information about our own storage.
     */
    req.log.warn({ err: error }, 'Connector OAuth callback failed');
    return void back('failed');
  }
}

async function load(
  actor: { organisationId: string; membershipId: string },
  connectionId: string,
): Promise<connectorRepo.LoadedConnection> {
  /*
   * READ THROUGH RLS RATHER THAN CHECKING THE ORGANISATION IN CODE. A connection
   * belonging to another tenant does not come back at all, so there is no
   * comparison here to get wrong and no difference between "not yours" and "not
   * there" for a caller to probe.
   */
  const [connection] = await withTransaction((db) => connectorRepo.load(db, [connectionId]));

  if (!connection) {
    throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });
  }
  return connection;
}

export async function list(req: Request, res: Response): Promise<void> {
  res.status(200).json({ connections: await connections.list(actorOf(req)) });
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = body<{ manifestId: string; name: string; owningScopeId?: string | null }>(req);
  res.status(201).json(await connections.create(actorOf(req), input));
}

/**
 * WHAT COMES BACK IS FOUR CHARACTERS. Enough to tell two credentials apart on a
 * screen, and not enough to matter if that screen leaks.
 */
export async function setCredential(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { strategy, secret, fields } = body<{ strategy: string; secret?: string; fields?: Record<string, string> }>(req);

  const { lastFour } = await connections.setCredential(actorOf(req), {
    connectionId: id,
    strategy,
    ...(secret !== undefined ? { secret } : {}),
    ...(fields !== undefined ? { fields } : {}),
  });

  res.status(200).json({ credentialHint: lastFour });
}

export async function setParameters(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { parameters } = body<{ parameters: Record<string, string> }>(req);
  res.status(200).json(await connections.setParameters(actorOf(req), { connectionId: id, parameters }));
}

/** What connecting to a connector version asks for. Nothing secret; any member may read it. */
export async function connectForm(req: Request, res: Response): Promise<void> {
  const { manifestId } = params<{ manifestId: string }>(req);
  res.status(200).json(await forms.connectForm(actorOf(req), manifestId));
}

/* ── §7 ─────────────────────────────────────────────────────────────────── */

export async function confirm(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await verify.confirmMappings(actorOf(req), id));
}

/**
 * A FAILED VERIFICATION IS A 200. It ran, and which stage it stopped at is the
 * answer — particularly when the answer is "a test record is still in your
 * system and here is its identifier", which must not be buried in an error body.
 */
export async function verifyWrites(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<{ object: string; testRecord: Record<string, unknown> }>(req);

  res.status(200).json(await verify.verifyWrites(actorOf(req), { connectionId: id, ...input }));
}

export async function promote(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await verify.promote(actorOf(req), id));
}

/* ── §8 ─────────────────────────────────────────────────────────────────── */

/**
 * Re-check one connection against the system it points at.
 *
 * A HALT IS A 200. The check ran and found something; which field and why is the
 * answer, and burying it in an error body would make the most important outcome
 * this endpoint has the hardest one to read.
 */
export async function recheck(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await heal.recheck(actorOf(req), id));
}

export async function recheckAll(req: Request, res: Response): Promise<void> {
  const outcomes = await heal.recheckOrganisation(actorOf(req));

  res.status(200).json({
    checked: outcomes.length,
    halted: outcomes.filter((o) => o.halted).map((o) => ({
      connectionId: o.connectionId,
      reason: o.haltedReason,
    })),
    proposals: outcomes.flatMap((o) => o.proposals),
  });
}

/**
 * The proposals waiting for somebody to look.
 *
 * SEPARATE FROM THE RE-CHECK because they have different rhythms: the check runs
 * weekly and unattended, and the queue is read whenever a person gets to it.
 */
export async function healProposals(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ proposals: await heal.proposalsFor(actorOf(req), id) });
}

/* ── Inbound ────────────────────────────────────────────────────────────── */

/**
 * THE URL IS RETURNED ONCE AND IS NOT READABLE AFTERWARDS. It is stored as a
 * hash, so a screen that wants to show it again has to mint a new one — which is
 * the same trade a session token makes, for the same reason: an address that can
 * be read back is an address that can be read by whoever else reaches that
 * screen.
 */
export async function mintIntake(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { retentionHours } = body<{ retentionHours?: number }>(req);

  res.status(201).json(await inbound.mintIntake(actorOf(req), id, retentionHours));
}

/**
 * A webhook arriving from a customer's own system.
 *
 * NO SESSION, AND THERE CANNOT BE ONE. The caller is an ERP or a SaaS product
 * posting an event; what authenticates it is that the address is unguessable.
 */
export async function receiveWebhook(req: Request, res: Response): Promise<void> {
  const { token } = params<{ token: string }>(req);

  const outcome = await inbound.receiveWebhook({
    token,
    body: body<Record<string, unknown>>(req),
    objectName: typeof req.query.object === 'string' ? req.query.object : undefined,
    sourceLabel: req.get('user-agent') ?? undefined,
  });

  /*
   * 202, NOT 200. The event is stored and will be read when somebody asks a
   * question; nothing has been processed yet, and a sender deciding whether to
   * retry should be told that it was accepted rather than that it was acted on.
   */
  res.status(202).json(outcome);
}

export async function receiveEmail(req: Request, res: Response): Promise<void> {
  const { token } = params<{ token: string }>(req);
  const { from, subject, body: text } = body<{ from: string; subject: string; body: string }>(req);

  res.status(202).json(await inbound.receiveEmail({ token, from, subject, body: text }));
}

/**
 * Reclaim what has expired, for the organisation asking.
 *
 * THE COUNT IS THE CALLER'S OWN. This used to return a cell-wide total, which
 * told a member of one organisation how much traffic every other one had.
 */
export async function sweepInbound(req: Request, res: Response): Promise<void> {
  res.status(200).json(await inbound.sweep(actorOf(req)));
}

/* ── Grants ─────────────────────────────────────────────────────────────── */

export async function listGrants(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ grants: await grants.list(actorOf(req), id) });
}

export async function grantConnection(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<Omit<Parameters<typeof grants.grant>[1], 'connectionId'>>(req);

  res.status(201).json(await grants.grant(actorOf(req), { connectionId: id, ...input }));
}

export async function revokeGrant(req: Request, res: Response): Promise<void> {
  const { grantId } = params<{ grantId: string }>(req);
  await grants.revoke(actorOf(req), grantId);
  res.status(204).end();
}

/* ── Availability and halts ─────────────────────────────────────────────── */

/**
 * WHAT THE ORGANISATION HAS, not what this person can already use. Somebody on a
 * per-user system who sees nothing concludes the connector does not exist, when
 * an admin approved it weeks ago and is waiting for them.
 */
export async function available(req: Request, res: Response): Promise<void> {
  res.status(200).json({ connectors: await connections.available(actorOf(req)) });
}

export async function resume(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await connections.resume(actorOf(req), id));
}

export async function recordProvenance(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<{ actsAs?: string | null; rights?: 'broad' | 'scoped' | 'unknown' }>(req);

  res.status(200).json(await connections.recordProvenance(actorOf(req), id, input));
}

export async function retire(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { reason } = body<{ reason: string }>(req);

  res.status(200).json(await connections.retire(actorOf(req), id, reason));
}

/**
 * §8 — "New field appears. Propose mapping. Never apply silently." This is where
 * the not-silently happens.
 */
export async function decideProposal(req: Request, res: Response): Promise<void> {
  const { proposalId } = params<{ proposalId: string }>(req);
  const { decision } = body<{ decision: 'accepted' | 'rejected' }>(req);

  res.status(200).json(await heal.decideProposal(actorOf(req), proposalId, decision));
}

export async function probeRuns(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ runs: await connections.probeRuns(actorOf(req), id) });
}

export async function versions(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ versions: await connections.versions(actorOf(req), id) });
}

/** Find out what the connected system holds, as a draft of its connector. */
export async function derive(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { paths } = body<{ paths: string[] }>(req);
  res.status(201).json(await connectionDerive.deriveFor(actorOf(req), id, { paths }));
}

/**
 * Read every field the system holds: ask it for its field lists, widen the
 * connector to read them all, and move the connection onto that version.
 */
export async function readEveryField(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await connectorFields.readEveryField(actorOf(req), id));
}

/** What moving to another version would change about where the credential goes. */
export async function adoption(req: Request, res: Response): Promise<void> {
  const { id, manifestId } = params<{ id: string; manifestId: string }>(req);
  res.status(200).json({ adoption: await connectionVersions.adoption(actorOf(req), id, manifestId) });
}

export async function adopt(req: Request, res: Response): Promise<void> {
  const { id, manifestId } = params<{ id: string; manifestId: string }>(req);
  res.status(200).json(await connectionVersions.adopt(actorOf(req), id, manifestId, body<{ origins: string[]; statements: string[] }>(req)));
}

/**
 * WHO CAN REACH IT, resolved. The grants block on the connection screen shows
 * this rather than the rows somebody typed, because the two diverge as soon as
 * a scope grant covers a subtree.
 */
export async function reach(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ reach: await grants.reach(actorOf(req), id) });
}
