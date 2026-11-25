import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { bounds, invalid, notFound, policy, refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { childLogger } from '../config/logger.config';
import { env } from '../config/env.config';
import { SUPPORTED_SCHEMA_VERSION } from '../repos/connector.repo';
import * as drafts from '../repos/connectorDraft.repo';
import * as repo from '../repos/discovery.repo';
import { isDecided, proposedConnectorName } from '../models/discovery.model';
import type { FindingDecision, ScanMethod } from '../models/discovery.model';
import { draftFrom, structureOnly } from '../engine/discovery/structure.discovery';
import type { Actor } from './scope.service';

const log = childLogger('discovery');

/**
 * §9 — agent discovery.
 *
 * WHAT THIS FILE IS AND IS NOT. The agent is a separate program the customer
 * runs inside their own network; Silo never scans anything itself and could not
 * — it is on the other side of the firewall by design. This is the half that
 * lives here: issuing an authorisation, accepting what an agent reports under
 * it, and turning a finding into a proposed connector once a person approves it.
 *
 * NOTHING HERE CONNECTS ANYTHING. §9.4 — "Finding a Postgres instance is not
 * access to it." Approving a finding produces a connector in the private tier
 * with no credential, which then goes through the same §7 verification as one
 * somebody built by hand.
 *
 * OFF MEANS UNREACHABLE, NOT IDLE. The routes are not mounted when
 * `DISCOVERY_AVAILABLE` is false, and this refuses as well — the second check
 * exists because a service reachable from anywhere else in the process would
 * otherwise be a way around the first.
 *
 * THE SQL IS IN `repos/discovery.repo`. What is left here is the deciding: the
 * availability switch, the shape of a window, what a database error means to
 * the person who caused it, and what a promoted finding turns into.
 */

/**
 * The method an agent used, re-exported because the HTTP layer names it.
 *
 * The type itself belongs to the model — a scan method is a fact about
 * discovery, not about this service — but `discovery.controller` has always
 * read it through here and moving the import is a change to a file this pass
 * does not own.
 */
export type { ScanMethod } from '../models/discovery.model';

function assertAvailable(): void {
  if (!env.DISCOVERY_AVAILABLE) {
    throw refusal({
      message: 'Agent discovery is not part of this deployment.',
      code: 'refusal.discovery_unavailable',
    });
  }
}

/* ── 9.1 Configuration ──────────────────────────────────────────────────── */

export async function setEnabled(
  actor: Actor,
  enabled: boolean,
): Promise<{ enabled: boolean }> {
  assertAvailable();

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const settings = await repo.saveEnabled(db, {
          organisationId: actor.organisationId,
          enabled,
          by: actor.membershipId,
        });

        await writeAudit(db, {
          event: enabled ? 'discovery_enabled' : 'discovery_disabled',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { enabled },
        });

        return { enabled: settings.enabled };
      }),
  );
}

/* ── 9.2 Scan authorisation ─────────────────────────────────────────────── */

const MAX_WINDOW_HOURS = 24 * 14;

/**
 * A window, not standing permission.
 *
 * ENABLING THE SWITCH AUTHORISES NOTHING. §9.2 — each scan carries its own
 * record naming the agent, the ranges, the methods, the expiry and who said so.
 * That is what makes a scan reviewable afterwards: "discovery was on" is not an
 * answer to "who agreed to this being contacted".
 *
 * RANGES ARE EXPLICIT AND ARE NOT INFERRED. No default of the local subnet and
 * nothing derived from the agent's own address — an agent that could decide its
 * own scope would make the authorisation a formality.
 */
export async function authoriseScan(
  actor: Actor,
  input: {
    agentId: string;
    ranges: string[];
    methods: ScanMethod[];
    expiresAt: Date;
    approvalId?: string | null;
  },
): Promise<{ authorisationId: string; expiresAt: string }> {
  assertAvailable();

  if (input.expiresAt.getTime() <= Date.now()) {
    throw invalid({
      message: 'That authorisation would already have expired.',
      code: 'invalid.expiry_in_past',
    });
  }

  if (input.expiresAt.getTime() - Date.now() > MAX_WINDOW_HOURS * 3600_000) {
    /*
     * A LONG ENOUGH WINDOW IS STANDING PERMISSION WEARING A DATE. The point of
     * expiry is that somebody has to agree again; a year-long authorisation
     * agrees once and calls it a window.
     */
    throw bounds({
      message: `A scan authorisation can last at most ${MAX_WINDOW_HOURS / 24} days.`,
      code: 'bounds.authorisation_window',
    });
  }

  for (const range of input.ranges) {
    if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(range)) {
      throw invalid({
        message: `${range} is not an address range. Ranges must be written as CIDR, such as 10.2.0.0/24.`,
        code: 'invalid.range',
      });
    }
  }

  const id = generateId();

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        /*
         * THE TRIGGER IN 019 REFUSES THIS IF DISCOVERY IS OFF, and that is where
         * the check belongs — it holds for any path that ever inserts a row,
         * including one written later by somebody who did not read this file.
         * Turning its exception into a refusal that names the switch is this
         * layer's half of the job: the repo lets the error through because a
         * constraint violation is information.
         */
        await repo
          .insertAuthorisation(db, {
            id,
            organisationId: actor.organisationId,
            agentId: input.agentId,
            ranges: input.ranges,
            methods: input.methods,
            authorisedBy: actor.membershipId,
            approvalId: input.approvalId ?? null,
            expiresAt: input.expiresAt,
          })
          .catch((error: unknown) => {
            if (String((error as Error).message).includes('Discovery is not enabled')) {
              throw policy({
                message: 'Turn on agent discovery for this organisation before authorising a scan.',
                code: 'policy.discovery_disabled',
              });
            }
            throw error;
          });

        await writeAudit(db, {
          event: 'scan_authorised',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            authorisationId: id,
            agentId: input.agentId,
            ranges: input.ranges,
            methods: input.methods,
            expiresAt: input.expiresAt.toISOString(),
          },
        });

        return { authorisationId: id, expiresAt: input.expiresAt.toISOString() };
      }),
  );
}

export async function revokeAuthorisation(actor: Actor, authorisationId: string): Promise<void> {
  assertAvailable();

  await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const revoked = await repo.revokeAuthorisation(db, {
          id: authorisationId,
          by: actor.membershipId,
        });

        /* Nothing revoked means there was no live window by that id. The repo
           cannot tell "already revoked" from "never existed" and does not try;
           either way the caller has nothing left to close. */
        if (!revoked) {
          throw notFound({
            message: 'That authorisation does not exist, or was already revoked.',
            code: 'missing.authorisation',
          });
        }
      }),
  );
}

/* ── 9.3 Running, and what may be recorded ──────────────────────────────── */

export interface Finding {
  host: string;
  port?: number | null;
  /**
   * WHICH METHOD FOUND IT, which is not the same as which methods were
   * permitted. "Postgres, from the catalogue" is a schema; "Postgres, from a
   * port scan" is a guess from an open 5432, and an admin approving findings one
   * at a time needs to know which they are looking at.
   */
  method: ScanMethod;
  /** §9.3: schema, columns, types, foreign keys, row counts, endpoint shapes. */
  structure: Record<string, unknown>;
  proposedTransport?: string | null;
  confidence?: number | null;
}

const MAX_FINDINGS_PER_REPORT = 500;

/**
 * An agent starting work under an authorisation.
 *
 * THE TRIGGER CHECKS THE AUTHORISATION IS LIVE. An expired or revoked window
 * cannot start a run, and that is enforced by the database rather than by
 * whoever calls this — the agent is a program on the customer's network and the
 * server must not depend on it behaving.
 */
export async function startRun(
  actor: Actor,
  authorisationId: string,
): Promise<{ runId: string }> {
  assertAvailable();
  const runId = generateId();

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        await repo.insertRun(db, { id: runId, authorisationId }).catch((error: unknown) => {
          if (String((error as Error).message).includes('expired or been revoked')) {
            throw policy({
              message: 'That scan authorisation has expired or been revoked. Authorise it again.',
              code: 'policy.authorisation_expired',
            });
          }
          throw error;
        });

        return { runId };
      }),
  );
}

/**
 * What the agent found.
 *
 * STRUCTURE ONLY, AND THE TABLE HAS NOWHERE TO PUT ANYTHING ELSE. §9.3 —
 * "Discovery must not be the phase where the no-data-stored claim quietly
 * breaks." 019 gives findings a `structure` column and no column for a value
 * read out of the customer's data; this strips anything that looks like one on
 * the way in, because an agent is a program and a future version of it could be
 * more generous than this one.
 *
 * `structureOnly` STAYS ON THIS SIDE OF THE REPO. It is a rule about what Silo
 * agrees to store rather than a fact about the column, so a second caller
 * inserting a finding has to apply it too — and would not be made to if the repo
 * did it quietly on everybody's behalf.
 *
 * EVERY PROBE IS LOGGED INDIVIDUALLY. §9.3 again — per host, naming the
 * authorisation it ran under. Without that the trail says something was
 * contacted and cannot say by whose permission.
 */
export async function recordFindings(
  actor: Actor,
  input: { runId: string; authorisationId: string; findings: Finding[]; hostsContacted: number },
): Promise<{ recorded: number }> {
  assertAvailable();

  if (input.findings.length > MAX_FINDINGS_PER_REPORT) {
    throw bounds({
      message: `A scan may report at most ${MAX_FINDINGS_PER_REPORT} findings at a time.`,
      code: 'bounds.findings',
    });
  }

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        for (const finding of input.findings) {
          await repo.insertFinding(db, {
            runId: input.runId,
            host: finding.host,
            port: finding.port ?? null,
            method: finding.method,
            structure: structureOnly(finding.structure),
            proposedTransport: finding.proposedTransport ?? null,
            confidence: finding.confidence ?? null,
          });

          await writeAudit(db, {
            event: 'host_probed',
            organisationId: actor.organisationId,
            membershipId: actor.membershipId,
            userId: null,
            detail: {
              authorisationId: input.authorisationId,
              runId: input.runId,
              host: finding.host,
              method: finding.method,
            },
          });
        }

        await repo.completeRun(db, {
          runId: input.runId,
          hostsContacted: input.hostsContacted,
        });

        return { recorded: input.findings.length };
      }),
  );
}

/* ── 9.4 Output: a proposal, never a configuration ──────────────────────── */

export async function listFindings(
  actor: Actor,
  options: { runId?: string } = {},
): Promise<Array<{
  id: string;
  host: string;
  port: number | null;
  method: string;
  structure: Record<string, unknown>;
  proposedTransport: string | null;
  confidence: number | null;
  decision: string | null;
  promotedConnectionId: string | null;
}>> {
  assertAvailable();

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const findings = await repo.listFindings(db, { runId: options.runId ?? null });

        /* The review screen is shown who decided nothing about a finding — not
           who reviewed it or when. Narrowing here rather than in the repo keeps
           the audit columns readable by anything that needs them later. */
        return findings.map((finding) => ({
          id: finding.id,
          host: finding.host,
          port: finding.port,
          method: finding.method,
          structure: finding.structure,
          proposedTransport: finding.proposedTransport,
          confidence: finding.confidence,
          decision: finding.decision,
          promotedConnectionId: finding.promotedConnectionId,
        }));
      }),
  );
}

/**
 * A person approves one finding, and a connector appears in the private tier.
 *
 * ITEM BY ITEM, NOT IN BULK. §9.4 — "An admin approves items individually." A
 * scan of a large estate returns dozens of findings and a single Approve All
 * would make the review a formality, which is exactly what the approval is there
 * to prevent.
 *
 * NO CREDENTIAL IS CREATED. Finding a Postgres instance is not access to it; the
 * connection is a draft that somebody supplies a credential to through the
 * normal path, and it verifies like any other.
 */
export async function promoteFinding(
  actor: Actor,
  findingId: string,
  decision: FindingDecision,
): Promise<{ decision: string; connectionId: string | null }> {
  assertAvailable();

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const finding = await repo.findFinding(db, findingId);

        if (!finding) {
          throw notFound({ message: 'That finding does not exist.', code: 'missing.finding' });
        }

        /* DECIDED IS THE DECISION BEING PRESENT, NOT ITS VALUE — rejecting
           closes a finding as firmly as accepting does, and a second reviewer
           must not be able to reopen the first one's answer. */
        if (isDecided(finding)) {
          throw policy({
            message: `That finding was already ${finding.decision}.`,
            code: 'policy.finding_decided',
          });
        }

        if (decision !== 'accepted') {
          await repo.decideFinding(db, {
            id: findingId,
            decision,
            reviewedBy: actor.membershipId,
          });
          return { decision, connectionId: null };
        }

        /*
         * A DRAFT MANIFEST, NOT A WORKING CONNECTOR. Discovery saw a shape; what
         * it did not see is a credential, a base URL that works from Silo's side,
         * or whether any of it is what somebody wants queried. So this opens in
         * the builder rather than pretending to be finished.
         *
         * WHAT IT DID SEE IS CARRIED ACROSS. Tables, columns, types and — the
         * part that matters — foreign keys, which §2.2 calls the highest-value
         * input to ontology derivation and the primary reason agent discovery is
         * worth more than convenience. This used to write `{ schemaVersion: 1 }`
         * and drop the rest, so a scan of somebody's network produced a blank
         * form and the data model was retyped by hand.
         */
        const draftId = generateId();
        const document = draftFrom(finding.structure, {
          schemaVersion: SUPPORTED_SCHEMA_VERSION,
          transport: finding.proposedTransport,
        });

        await drafts.insert(db, {
          id: draftId,
          organisationId: actor.organisationId,
          name: proposedConnectorName(finding),
          document,
          sourceRoute: 'ai',
          failedStage: null,
          createdBy: actor.membershipId,
        });

        await repo.decideFinding(db, {
          id: findingId,
          decision: 'accepted',
          reviewedBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'finding_promoted_to_connector',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { findingId, connectionId: draftId },
        });

        log.info(
          {
            findingId,
            draftId,
            objects: Array.isArray(document.objects) ? document.objects.length : 0,
          },
          'Discovery finding promoted to a draft connector',
        );

        return { decision, connectionId: draftId };
      }),
  );
}


/**
 * The scans that have run.
 *
 * §9.3 SAYS EVERY PROBE IS LOGGED; this is what makes the log reachable. A
 * security review asking "what has this agent contacted" needs the runs before
 * it can ask about the hosts, and the count of hosts contacted is the first
 * number anybody looks at.
 */
export async function listRuns(actor: Actor) {
  assertAvailable();

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const runs = await repo.listRuns(db);

        /* Dates become strings at the edge, not in the model: a `Date` that has
           already been through `toISOString` cannot be compared with another. */
        return runs.map((run) => ({
          id: run.id,
          authorisationId: run.authorisationId,
          agentId: run.agentId,
          status: run.status,
          hostsContacted: run.hostsContacted,
          findings: run.findings,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
        }));
      }),
  );
}
