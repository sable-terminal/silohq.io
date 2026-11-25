import { withTransaction } from '../infra/db.infra';
import { checkCredentialFields, checkParameters, formFor } from './connectForm.service';
import { seal } from '../utils/envelope.util';
import { wrapper } from '../infra/kms.infra';
import { lastFour } from '../utils/lastFour.util';
import { invalid, notFound, policy } from '../utils/error.util';
import { USER_FACING_STRATEGIES, credentialFieldsOf } from '../schemas/connectorAuth.schema';
import { pinConnection } from './connectionPins.service';
import { derivedTokens } from './derivedTokens.service';
import { expiryOf } from '../utils/credentialExpiry.util';
import * as connectorRepo from '../repos/connector.repo';
import * as connectionRepo from '../repos/connection.repo';
import * as grantRepo from '../repos/connectionGrant.repo';
import { availabilityOf, othersConnected } from '../models/connection.model';
import { log as writeAudit } from './audit.service';
import { readableIds } from './connector.service';
import * as connectorService from './connector.service';
import type { Actor } from './scope.service';

/**
 * A connected instance of a connector — "Acme's Salesforce", as against "how to
 * talk to Salesforce".
 *
 * THE CREATOR IS GRANTED IN THE SAME TRANSACTION. `connection_grants` is default
 * deny, so a connection created without one is reachable by nobody — including
 * the person who just made it, who then cannot test it, cannot query it, and has
 * no way to tell that a grant is what is missing.
 */

export interface NewConnection {
  connectionId: string;
  name: string;
  status: string;
}

export async function create(
  actor: Actor,
  input: { manifestId: string; name: string; owningScopeId?: string | null },
): Promise<NewConnection> {
  const name = input.name.trim();

  return withTransaction(async (db) => {
    /*
     * READ THROUGH RLS. A manifest belonging to another tenant does not come
     * back, and a prebuilt one (organisation_id null) is visible to everybody by
     * 013's `FOR SELECT` policy — so both cases work without a branch here.
     */
    const manifest = await connectionRepo.findConnectableManifest(db, input.manifestId);

    if (!manifest) {
      throw notFound({
        message: 'That connector does not exist, or has been replaced by a newer version.',
        code: 'missing.manifest',
      });
    }

    /*
     * THE UNIQUE VIOLATION IS TURNED INTO A SENTENCE HERE AND NOT IN THE REPO.
     * A constraint is information — somebody has already used that name — and
     * what to tell the person who hit it is this layer's question.
     */
    const connectionId = await connectionRepo
      .insert(db, {
        organisationId: actor.organisationId,
        manifestId: manifest.id,
        name,
        provider: manifest.provider,
        owningScopeId: input.owningScopeId ?? null,
        createdBy: actor.membershipId,
      })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === '23505') {
          throw policy({
            message: `There is already a connection called ${name}.`,
            code: 'policy.connection_name_taken',
          });
        }
        throw error;
      });

    /*
     * THE MANIFEST DECIDES WHO THIS IS FOR, and the two cases are genuinely
     * different acts.
     *
     * A `shareable` SYSTEM IS SET UP ONCE FOR EVERYBODY. An admin registers the
     * source with a service account and the organisation queries through it —
     * granting only the creator would mean the person who did the work is the
     * only one who benefits from it, and every colleague sees nothing and
     * concludes the system is not connected.
     *
     * A `per_user` SYSTEM IS THIS PERSON'S OWN. Their credential carries their
     * own permissions at the source, so the connection is theirs and granting it
     * to anybody else would hand them somebody else's access.
     */
    const perUser = manifest.credentialSharing === 'per_user';

    await grantRepo.insert(db, {
      connectionId,
      organisationWide: !perUser,
      scopeId: null,
      membershipId: perUser ? actor.membershipId : null,
      principalId: null,
      canRead: true,
      /*
       * READ ONLY, EVEN FOR THE CREATOR. §7 turns writes on for a CONNECTION
       * once it has been verified against a test record, and a creation grant
       * that carried write would hand that decision to whoever made the
       * connection, before anything had been probed.
       */
      canWrite: false,
      includeDescendants: false,
      grantedBy: actor.membershipId,
      /* Made at creation by whoever created the connection rather than under a
         scoped authority, so there is no subtree to record — and revision 5
         then leaves it revocable by its issuer or a super admin. */
      grantedAtScopeId: null,
      expiresAt: null,
    });

    /*
     * BOTH ROWS, IN THIS TRANSACTION. The grant is a privilege change and is
     * audited as one even though it is implied by the creation — a trail where
     * some grants appear and others are inferred is one nobody can total.
     */
    await writeAudit(db, {
      event: 'connector_created',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { connectionId, manifestId: manifest.id, name },
    });

    await writeAudit(db, {
      event: 'connection_granted',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: {
        connectionId,
        granteeType: perUser ? 'membership' : 'organisation',
        granteeId: perUser ? actor.membershipId : null,
        grantedAtScopePath: null,
      },
    });

    return { connectionId, name, status: 'draft' };
  });
}

/**
 * Store the secret a connection authenticates with.
 *
 * WRITE-ONLY AFTER ENTRY, per §4.2. Nothing reads this back out — the only
 * things that ever see the plaintext again are the mediator and the transport it
 * hands it to, and what a screen can show is the last four characters.
 *
 * THE MANIFEST SAYS WHERE THE VALUE BELONGS AND THE SECRET IS THE VALUE. There
 * is no field here for a header name or a query parameter, because those are the
 * connector's business and putting them beside the secret would let two
 * connections using one connector disagree about how it works.
 */
export async function setCredential(
  actor: Actor,
  input: { connectionId: string; strategy: string; secret?: string; fields?: Record<string, string> },
): Promise<{ lastFour: string | null; origins: string[] }> {
  if (!USER_FACING_STRATEGIES.includes(input.strategy as never)) {
    throw invalid({
      message: `${input.strategy} is not a strategy a connection can be given directly.`,
      code: 'invalid.auth_strategy',
    });
  }

  return withTransaction(async (db) => {
    const [connection] = await connectorRepo.load(db, [input.connectionId]);
    if (!connection) {
      throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });
    }

    /*
     * THE MANIFEST HAS TO ACCEPT THE STRATEGY. Sealing a credential for a
     * strategy the connector never declared produces a connection that fails at
     * the first request with an authentication error, which is the least
     * explicable way for a typo in a dropdown to surface.
     */
    if (!connection.manifest.auth.some((a) => a.strategy === input.strategy)) {
      throw invalid({
        message: `This connector does not use ${input.strategy}.`,
        code: 'invalid.strategy_not_declared',
      });
    }

    /*
     * NAMED FIELDS ARE CHECKED AGAINST WHAT THE CONNECTOR ASKS FOR, and sealed
     * together as one JSON document — one unwrap per request, one row per
     * connection, as a single secret always was.
     */
    let plaintext: string;
    let hint: string | null;
    if (input.fields) {
      const fields = Object.fromEntries(Object.entries(input.fields).filter(([, value]) => value.trim() !== ''));
      checkCredentialFields(connection.manifest, input.strategy, fields);
      plaintext = JSON.stringify(fields);
      const secrets = formFor(connection.manifestId, connection.manifest)
        .alternatives.find((a) => a.strategy === input.strategy)!
        .fields.filter((f) => f.secret && fields[f.name]);
      hint = lastFour(fields[secrets[0]?.name ?? Object.keys(fields)[0]!] ?? '');
    } else {
      plaintext = input.secret!;
      hint = lastFour(plaintext);
    }

    const sealed = await seal(plaintext, wrapper(), `connection:${input.connectionId}`);

    /*
     * A CONNECTION USES EXACTLY ONE OF THE STRATEGIES ITS MANIFEST ACCEPTS, and
     * setting a credential is the act that chooses. The rows for the strategies
     * it is no longer using go first, in the same transaction, so nothing ever
     * observes a connection holding two.
     */
    await connectionRepo.removeOtherTokenCredentials(db, {
      connectionId: input.connectionId,
      strategy: input.strategy,
    });

    await connectionRepo.upsertTokenCredential(db, {
      connectionId: input.connectionId,
      strategy: input.strategy,
      sealed,
      /*
       * A SECRET TOO SHORT TO HAVE A LAST FOUR STILL NEEDS A HINT, and the
       * column refuses anything that is not four characters. `0000` reads as
       * "there is nothing to recognise this by", which is true of it.
       */
      lastFour: hint ?? '0000',
    });

    /*
     * WHEN IT STOPS WORKING, IF THE CREDENTIAL SAYS: a certificate's notAfter,
     * a signed token's exp, or the lifetime the connector declares for keys
     * the system issues. The expiry sweep warns ahead of it.
     */
    const given = input.fields ?? { [credentialFieldsOf(connection.manifest.auth.find((a) => a.strategy === input.strategy)!)[0] ?? 'token']: input.secret ?? '' };
    const declared = Object.fromEntries(Object.entries(connection.manifest.credentials).map(([name, field]) => [name, field.expiresAfterDays]));
    const expiry = expiryOf(given, declared);
    await connectionRepo.recordCredentialExpiry(db, { connectionId: input.connectionId, strategy: input.strategy, sealedBy: actor.membershipId, expiresAt: expiry?.at ?? null, source: expiry?.source ?? null });

    /* Giving the credential is the confirmation of where it may go (§9.2). */
    const pins = await pinConnection(db, {
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      connectionId: input.connectionId,
      credential: { strategy: input.strategy, fields: input.fields ?? {} },
    });

    await writeAudit(db, {
      event: 'credential_sealed',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: {
        connectionId: input.connectionId,
        strategy: input.strategy,
        lastFour: hint,
        /* Which named fields were given, never their values. */
        fields: input.fields ? Object.keys(input.fields).sort() : null,
      },
    });

    return { lastFour: hint, origins: pins.origins };
  }).then(async (result) => {
    /* Tokens derived from the credential it replaced are forgotten on every instance. */
    await derivedTokens().invalidate(input.connectionId);
    return result;
  });
}

/**
 * A connection's parameters — what one connector document needs to reach this
 * customer's instance of a system.
 *
 * CHECKED WHOLE AGAINST THE MANIFEST, and a value that looks like a secret is
 * refused: parameters are shown, logged and bound into expressions, which is
 * exactly where a key must never be.
 */
export async function setParameters(
  actor: Actor,
  input: { connectionId: string; parameters: Record<string, string> },
): Promise<{ parameters: Record<string, string>; origins: string[] }> {
  return withTransaction(async (db) => {
    const [connection] = await connectorRepo.load(db, [input.connectionId]);
    if (!connection) throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });

    const checked = checkParameters(connection.manifest, input.parameters);
    await connectionRepo.setParameters(db, input.connectionId, checked);

    /* A parameter can decide an address — a subdomain, a region — so setting one re-pins (§9.2). */
    const pins = await pinConnection(db, { organisationId: actor.organisationId, membershipId: actor.membershipId, connectionId: input.connectionId, credential: null });

    await writeAudit(db, {
      event: 'connection_parameters_set',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { connectionId: input.connectionId, parameters: Object.keys(checked).sort() },
    });
    return { parameters: checked, origins: pins.origins };
  });
}

/**
 * The connections this person can actually reach.
 *
 * FILTERED BY GRANT, NOT MERELY BY TENANT. Row level security keeps another
 * organisation's connections out; `connection_grants` is what decides which of
 * this organisation's a given member may see. A list showing everything would
 * hand somebody with no grants a map of the estate — every system the company
 * runs, by name — and would also be a list of things they cannot use.
 */
export async function list(actor: Actor) {
  return withTransaction(async (db) => {
    const connections = await connectionRepo.overview(db);

    const readable = await readableIds(db, actor, connections.map((c) => c.id));

    return connections.filter((c) => readable.has(c.id)).map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      status: c.status,
      writesEnabled: c.writesEnabled,
      haltedReason: c.haltedReason,
      lastHealthyAt: c.lastHealthyAt?.toISOString() ?? null,
      /*
       * WHAT THIS CONNECTION ACTS AS AT THE SOURCE, on the list rather than
       * buried, because "which of these is the broad service account" is the
       * question somebody reviewing a set of connections is actually asking.
       */
      credentialActsAs: c.credentialActsAs,
      credentialRights: c.credentialRights,
      /*
       * THE ONLY FRAGMENT OF A CREDENTIAL A SCREEN SEES. "Which of these three
       * Salesforce connections is the one that broke" is unanswerable when every
       * row reads the same.
       */
      credentialHint: c.credentialLastFour,
      /* Settings, not secrets: which shop, which tenant, which region. */
      parameters: c.parameters,
      manifestId: c.manifestId,
      /* Where the credential may be sent, as the person who connected confirmed (§9.2). */
      origins: c.pinnedOrigins,
      /* When the credential lapses — a certificate's notAfter, a token's exp, a declared lifetime. */
      credentialExpiresAt: c.credentialExpiresAt?.toISOString() ?? null,
      credentialExpirySource: c.credentialExpirySource,
      /*
       * NAMES FOR SCOPES, COUNTS FOR THE REST. "Engineering" tells somebody
       * what they need to know; "1 scope" makes them open the row to find out
       * which. People and service principals have no such shorthand — a list of
       * twelve names in a table cell is not a summary.
       */
      reach: c.reach,
      /*
       * WHAT THIS INSTANCE HOLDS, and which version of the manifest it reads it
       * through. Two connections to the same system are otherwise identical on
       * a screen, and the note is the only thing that says which one a question
       * about the UK book should go to.
       */
      notes: c.notes,
      manifestVersion: c.manifestVersion,
    }));
  });
}


/* ── What is available, before it is usable ─────────────────────────────── */

export interface Available {
  manifestId: string;
  connectorKey: string;
  name: string;
  provider: string;
  credentialSharing: 'shareable' | 'per_user';
  /** A connection this person can already query through. */
  connectionId: string | null;
  status: 'ready' | 'needs_your_credential' | 'needs_setup';
  /** For a per-user system, how many colleagues have connected. Not who. */
  othersConnected: number;
}

/**
 * Every connector the organisation has approved, and what each one needs.
 *
 * THE POINT IS THE `needs_your_credential` STATE. Without it, somebody on a
 * per-user system opens Silo, sees nothing about Jira, and concludes it is not
 * connected — when in fact an admin approved it weeks ago and is waiting for
 * them. Showing a connector as available before anybody has authorised it is
 * what turns that silence into an instruction.
 *
 * `othersConnected` IS A COUNT AND NEVER A LIST. That eleven colleagues have
 * connected their Jira is useful — it says the thing works and you are the one
 * who has not. WHICH colleagues is not this screen's business.
 */
export async function available(actor: Actor): Promise<Available[]> {
  return withTransaction(async (db) => {
    const connectors = await connectionRepo.available(db, actor.membershipId);

    return connectors.map((connector) => ({
      manifestId: connector.manifestId,
      connectorKey: connector.connectorKey,
      name: connector.name,
      provider: connector.provider,
      version: connector.version,
      credentialSharing: connector.credentialSharing,
      connectionId: connector.connectionId,
      /*
       * BOTH DERIVED IN THE MODEL, from the connection and the count. A status
       * computed here would be a second copy of an answer the map screen and
       * this list both need, and telling somebody `needs_setup` when the truth
       * is `needs_your_credential` sends them to an admin who has already done
       * their part.
       */
      status: availabilityOf(connector),
      othersConnected: othersConnected(connector),
    }));
  });
}

/* ── Coming back from a halt ────────────────────────────────────────────── */

/**
 * Clear a halt, after a person has looked.
 *
 * §8 HALTS AND SAYS IT "STAYS HALTED UNTIL A PERSON LOOKS", and until now there
 * was no way for a person to say they had. Self-heal could stop a connection and
 * nothing in the product could start it again — a dead end reachable by an
 * automated weekly job.
 *
 * THE PREVIOUS REASON IS RECORDED ON THE WAY OUT. Somebody clearing a halt is
 * asserting they checked a specific thing; a trail that does not say what they
 * were shown makes that assertion unauditable, and the halt reason is cleared by
 * this very statement.
 */
export async function resume(
  actor: Actor,
  connectionId: string,
): Promise<{ status: string; previousReason: string | null }> {
  return withTransaction(async (db) => {
    const current = await connectionRepo.readHalt(db, connectionId);

    if (!current) {
      throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });
    }
    if (current.status !== 'halted') {
      throw policy({
        message: 'That connection is not halted.',
        code: 'policy.not_halted',
      });
    }

    await connectionRepo.resume(db, connectionId);

    await writeAudit(db, {
      event: 'connection_resumed',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { connectionId, previousReason: current.haltedReason },
    });

    return { status: 'active', previousReason: current.haltedReason };
  });
}


/**
 * Record what the credential is at the source and how far it reaches.
 *
 * IT ENFORCES NOTHING AND IS NOT MEANT TO. Silo cannot verify what a service
 * account can read inside somebody else's Salesforce; only their admin can. What
 * this does is put the answer where the person who will be ASKED for it can find
 * it — a reviewer's first question about a shared credential is what it can
 * reach, and "log into the source and check" is the wrong answer from a platform
 * whose whole claim is that it knows where the data came from.
 *
 * `broad` IS THE ONE THAT MATTERS. It says Silo's own field policies are the
 * only limit on what that credential exposes, which is a statement about how
 * much weight the permission model is carrying rather than a complaint.
 */
export async function recordProvenance(
  actor: Actor,
  connectionId: string,
  input: { actsAs?: string | null; rights?: 'broad' | 'scoped' | 'unknown' },
): Promise<{ actsAs: string | null; rights: string }> {
  return withTransaction(async (db) => {
    const recorded = await connectionRepo.recordProvenance(db, {
      connectionId,
      actsAs: input.actsAs ?? null,
      rights: input.rights ?? null,
    });

    if (!recorded) {
      throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });
    }

    return recorded;
  });
}


/**
 * Retire a connection.
 *
 * `revoked` IS IN §10's STATUS LIST AND NOTHING COULD REACH IT. A connection
 * whose credential has been withdrawn at the source, or a system a customer has
 * stopped using, had no way out of the product except being left `active` and
 * failing every query — which reads as a broken connector rather than a retired
 * one.
 *
 * NOT A DELETE. The rows stay: probe runs, heal proposals and the audit trail
 * all reference this connection, and answers already given cite the manifest it
 * used. Retiring stops it being queryable and leaves the history intact.
 */
export async function retire(
  actor: Actor,
  connectionId: string,
  reason: string,
): Promise<{ status: string }> {
  return withTransaction(async (db) => {
    const retired = await connectionRepo.revoke(db, connectionId);

    if (!retired) {
      throw notFound({
        message: 'That connection does not exist, or was already retired.',
        code: 'missing.connection',
      });
    }

    /*
     * EVERY GRANT GOES WITH IT. Leaving them live would mean a retired
     * connection still appears in "who can reach what", and reinstating it later
     * would silently restore access somebody may since have wanted removed.
     */
    await grantRepo.revokeAllFor(db, {
      connectionId,
      revokedBy: actor.membershipId,
    });

    await writeAudit(db, {
      event: 'connection_retired',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { connectionId, reason },
    });

    return { status: 'revoked' };
  }).then(async (result) => {
    /* A session a retired connection held is dropped everywhere, not left to expire. */
    await derivedTokens().invalidate(connectionId);
    return result;
  });
}


/* ── Reading the record ─────────────────────────────────────────────────── */

/**
 * Every verification and maintenance run against this connection.
 *
 * §7's RECORD, AND THE ONLY PLACE IT IS VISIBLE. The table has held these since
 * the first probe and nothing could read them back, which makes "when was this
 * last checked, and what did it find" a question answerable only with psql.
 */
export async function probeRuns(actor: Actor, connectionId: string) {
  await connectorService.manageableConnection(actor, connectionId);

  return withTransaction(async (db) => {
    const runs = await connectionRepo.probeRuns(db, connectionId);

    return runs.map((run) => ({
      id: run.id,
      stage: run.stage,
      status: run.status,
      findings: run.findings,
      errors: run.errors,
      /* §7 step 1 is read-only and step 4 is not; the difference has to survive. */
      readOnly: run.readOnly,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    }));
  });
}

/**
 * The manifest lineage behind a connection.
 *
 * "LINEAGE ON EVERY RETURNED FIGURE CITES A CONNECTOR VERSION." An answer given
 * last month names a version, and without this there is no way to look that
 * version up and see what it said — which makes the citation decorative.
 */
export async function versions(actor: Actor, connectionId: string) {
  const connection = await connectorService.manageableConnection(actor, connectionId);

  return withTransaction(async (db) => {
    const lineage = await connectionRepo.manifestLineage(db, connection.manifestId);

    return lineage.map((version) => ({
      manifestId: version.id,
      version: version.version,
      sourceRoute: version.sourceRoute,
      createdAt: version.createdAt.toISOString(),
      supersededAt: version.supersededAt?.toISOString() ?? null,
      /* WHICH ONE THIS CONNECTION IS ACTUALLY READING THROUGH. Every other row
         is history, and a lineage that does not say where you are standing in it
         is a list of numbers. */
      inUse: version.id === connection.manifestId,
    }));
  });
}
