/**
 * Roles, assignments, markings and clearances.
 *
 * THE THREE ADMIN TIERS ARE NOT A COLUMN. They are derived from the assignment:
 *
 *   Super admin   an assignment with no scope. Whole organisation.
 *   Admin         an assignment scoped to a scope. That subtree, inclusive.
 *   Member        no admin assignment at all.
 *
 * There is no fixed number of levels — an Engineering admin may create Platform
 * beneath it and appoint an admin there, who may appoint one beneath that.
 * Storing a tier would be a second source of truth for something the assignment
 * already says, and the two would disagree the first time a scope moved.
 */

export type PermissionId = string;

export interface Permission {
  id: PermissionId;
  category: string;
  description: string;
  scopeable: boolean;
}

export interface Role {
  id: string;
  organisationId: string;
  name: string;
  description: string | null;
  systemRole: boolean;
  createdAt: Date;
}

export type AssignmentScopeType = 'scope' | 'connection' | 'silo' | 'view';

export interface RoleAssignment {
  id: string;
  membershipId: string;
  roleId: string;
  /** Null means organisation-wide: a super admin. */
  scopeType: AssignmentScopeType | null;
  scopeId: string | null;
  grantedBy: string;
  /** The scope the granter held when issuing. See `004_authz.sql`. */
  grantedAtScopeId: string | null;
  grantedAt: Date;
  expiresAt: Date | null;
  revokedBy: string | null;
  revokedAt: Date | null;
}

export interface Marking {
  id: string;
  organisationId: string;
  name: string;
  kind: 'classification' | 'compartment';
  description: string | null;
}

export interface Clearance {
  id: string;
  membershipId: string;
  markingId: string;
  grantedBy: string;
  grantedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export type AdminTier = 'super-admin' | 'admin' | 'member';

export function tierOf(assignments: readonly RoleAssignment[]): AdminTier {
  if (assignments.some((a) => a.scopeType === null)) return 'super-admin';
  if (assignments.some((a) => a.scopeType === 'scope')) return 'admin';
  return 'member';
}

/**
 * The system roles created with every organisation.
 *
 * `Super admin` IS A SYSTEM ROLE AND CANNOT BE DELETED. An organisation that
 * deleted it would have nobody able to create another, and no way back — the
 * permission to create one is held by the role being deleted.
 */
export const SYSTEM_ROLES = {
  superAdmin: {
    name: 'Super admin',
    description: 'The whole organisation. Billing, SSO, clearances, scope types.',
    permissions: [
      'query.compile', 'query.run', 'mutation.propose', 'mutation.approve',
      'connection.create', 'connection.grant', 'view.share',
      'member.invite', 'member.suspend', 'member.remove',
      'scope.create', 'scope.move', 'scope.archive', 'scope.assign',
      'role.grant', 'seat.allocate', 'seat.release',
      'clearance.grant', 'billing.manage', 'tokens.purchase',
      'org.logo.manage', 'org.sharing.manage', 'sso.manage', 'audit.read',
      'billing.view',
      /*
       * §12 — what the organisation calls a concept. Administrative, because it
       * changes what every reader is told a thing is. The per-user lens has no
       * permission at all and never appears in this list: it is a preference,
       * and needing a grant to hold one would be the product telling somebody
       * what to call their own work.
       */
      'terminology.manage',
      /* Automations §10 — pausing or deleting somebody else's scheduled check,
         which is scopeable: a scope admin manages the automations in theirs. */
      'automation.create', 'automation.manage',
      /*
       * §5 — attaching a change to a schedule, in propose mode. It writes
       * nothing: the proposal lands in the approvals queue and a named person
       * decides. `automation.execute` is the one that writes with nobody
       * present, and it does not exist until the code that bounds it does.
       */
      'automation.mutate',
      /*
       * §10 — "the only permission in the product that allows a write with
       * nobody present", and deliberately not on `Admin`. Not scopeable either:
       * a scope bounds where a change lands, and this bounds whether a human is
       * there at all, which no subtree can narrow.
       */
      'automation.execute',
      /*
       * Simulation §7 — reading the ontology and writing candidate edges that
       * nothing walks. Ordinary, because a proposal is not a claim: §2.3 puts a
       * person between it and the graph, and `graph.confirm` is that person's
       * permission.
       */
      'graph.propose',
      /*
       * Simulation §7 — "graph.confirm is consequential. A confirmed edge
       * changes what every future simulation concludes, and a wrong lead time
       * is a wrong answer that looks computed. It should sit with the people
       * who understand the operation, not with whoever administers the system."
       *
       * So it is NOT on `Admin`, which is whoever administers the system. The
       * people who understand the operation do not have a system role, because
       * no product can guess which of a customer's people those are: they get a
       * role the customer builds, and this is what gets attached to it. It sits
       * here only so it is reachable at all — a permission no role holds
       * refuses everybody, including the person who would create that role.
       */
      'graph.confirm',
      /*
       * Simulation §7 — running is reading. It walks a graph somebody else
       * confirmed and queries records the runner can already see, and §7's
       * marking rule does the narrowing: "a simulation whose path crosses a
       * concept the runner lacks clearance for stops at that edge and reports
       * it". So the permission does not need to narrow it as well.
       */
      'simulation.run',
      /* §7 — sharing widens who can see an answer, and §3.1's answer names
         records. Not on `Member` for the same reason no other share is. */
      'simulation.share',
      'file.export', 'file.share', 'file.manage', 'file.delete',
      /*
       * §5 — putting a document into a customer's retained storage, which is
       * why it is not on `Member`: exporting is reading something you can
       * already see, and this is not. §7 also makes it conditional on
       * `silo.import`, checked at the same moment.
       */
      'file.upload',
      /*
       * §9.1 — SUPER ADMIN ONLY, AND DELIBERATELY ABSENT FROM `Admin` BELOW. The
       * reasoning is clearance's: a scope admin administers part of a network,
       * and authorising a scan of it would let them authorise scanning of the
       * parts they do not administer. Not delegable is a property of the role
       * list, not a check somewhere in a service.
       */
      'discovery.manage',

      /*
       * §2 AND §4.3 — THE ONTOLOGY PERMISSIONS. `concept.confirm` is also on
       * `Admin` below, because it is scopeable and bounded by the connections a
       * scope admin can already reach. The others are not, and stay here:
       * deciding what is SECRET, what counts as a BAD OUTCOME, and WHICH SYSTEM
       * IS RIGHT are organisation-wide statements. Every ranking anybody sees
       * is ordered by the second; every figure anybody is given is merged by
       * the third, and a department deciding the organisation's numbers from
       * inside one corner of it is exactly what that must not allow.
       */
      'concept.confirm', 'marking.apply', 'outcome.designate', 'authority.declare',

      /*
       * Capture §4 — STORAGE. `silo.enable` is super admin only and never
       * delegable: it changes the deployment's security posture. `silo.purge`
       * is "separate, destructive", held here and granted deliberately rather
       * than arriving with Admin. `silo.create` and `silo.manage` are also on
       * Admin below, as the specification's table says.
       */
      'silo.enable', 'silo.create', 'silo.manage', 'silo.purge', 'silo.import',

      /*
       * THE APPROVAL CHAIN. Which destructive actions need a second person is a
       * rule about the organisation, so it is configured here and nowhere below.
       */
      'approval.configure',

      'mutation.policy', 'mutation.execute', 'mutation.revert', 'mutation.purge',

      'field_policy.manage',

      /*
       * THE AGENT REACHES INTO THE CUSTOMER'S OWN NETWORK for every connection
       * that uses it, so installing one and confirming what it may contact is an
       * organisation-wide act.
       */
      'agent.manage',
    ],
  },
  admin: {
    name: 'Admin',
    description: 'A scope and everything beneath it.',
    permissions: [
      'query.compile', 'query.run', 'mutation.propose', 'mutation.approve',
      'connection.grant', 'view.share',
      'member.invite', 'member.suspend',
      'scope.create', 'scope.assign', 'role.grant', 'seat.allocate', 'audit.read',
      'billing.view',
      /*
       * Automations §10 — `automation.manage` is "pause, resume or delete
       * automations owned by others WITHIN SCOPE", which is a scope admin's job
       * by definition. `automation.mutate` queues a change for approval and is
       * bounded by `mutation.propose` on the connections it would touch, which
       * a scope admin already holds for theirs. `automation.execute` — the one
       * that writes with nobody present — is not here and does not exist yet.
       */
      'automation.create', 'automation.manage', 'automation.mutate',
      /*
       * Simulation §7 — reading the ontology and writing candidate edges that
       * nothing walks. Ordinary, because a proposal is not a claim: §2.3 puts a
       * person between it and the graph, and `graph.confirm` is that person's
       * permission.
       */
      'graph.propose',
      /*
       * Simulation §7 — running is reading. It walks a graph somebody else
       * confirmed and queries records the runner can already see, and §7's
       * marking rule does the narrowing: "a simulation whose path crosses a
       * concept the runner lacks clearance for stops at that edge and reports
       * it". So the permission does not need to narrow it as well.
       */
      'simulation.run',
      /* §7 — sharing widens who can see an answer, and §3.1's answer names
         records. Not on `Member` for the same reason no other share is. */
      'simulation.share',
      'file.export', 'file.share', 'file.manage', 'file.delete',
      /*
       * §5 — putting a document into a customer's retained storage, which is
       * why it is not on `Member`: exporting is reading something you can
       * already see, and this is not. §7 also makes it conditional on
       * `silo.import`, checked at the same moment.
       */
      'file.upload',
      /*
       * SCOPEABLE, SO DELEGABLE. §2.4's blast radius is bounded by the
       * connections a scope admin can already reach — somebody administering a
       * subtree with its own systems has every business naming what those
       * systems mean. Unlike discovery's, which reaches a network they only
       * partly administer.
       */
      'concept.confirm',
      /*
       * Capture §4 — creating a Silo inside a switched-on organisation and
       * managing what it captures are ordinary administration. Bounded by the
       * marking check at add time: an admin without clearance on a concept
       * cannot nominate it.
       */
      'silo.create', 'silo.manage', 'silo.import',
      'mutation.policy', 'mutation.execute', 'mutation.revert',
    ],
  },
  member: {
    name: 'Member',
    description: 'Ask questions, save views, schedule checks, propose changes.',
    /*
     * Automations §10 — `automation.create` covers a notify action, which
     * writes nothing and approves nothing. An ordinary member who can already
     * ask a question every morning may as well have it asked for them; the
     * permissions that let an automation CHANGE anything are separate and
     * arrive with the code that enforces them.
     */
    permissions: [
      'query.compile', 'query.run', 'mutation.propose', 'mutation.revert', 'view.share',
      'automation.create',
      /*
       * Simulation §7 — an ordinary member runs one. It reaches nothing they
       * could not already ask about: the graph is somebody else's confirmed
       * assertions, and §7's marking rule stops the walk at any concept this
       * reader has no clearance for. Sharing the answer is the part that is
       * not here.
       */
      'simulation.run',
      /*
       * Files §7 — producing an export. An ordinary member exports what they
       * can already see: §3 redacts to the exporter, so this hands nobody
       * anything they could not read on screen.
       */
      'file.export',
      /*
       * Files §7 — sharing a document, and arranging folders. Neither widens
       * what anybody can read: §2 makes a folder an arrangement rather than a
       * boundary, and §4 keeps Silo access a precondition a share cannot grant.
       */
      'file.share', 'file.manage',
      /*
       * §7 — deleting. An upload additionally needs `silo.purge`, checked at
       * the same moment, because §6 makes deleting Silo data a purge rather
       * than a tidy-up: it destroys data a detector may depend on.
       */
      'file.delete',
    ],
  },
} as const;

/**
 * Which system role may hand out which.
 *
 * A SUPER ADMIN MAY CREATE ANOTHER SUPER ADMIN; AN ADMIN MAY NOT. That is
 * delegation rule 3, and it is the difference between a hierarchy and a flat
 * system where anybody who can grant can grant everything. An admin appointing
 * another admin beneath them is the model working as intended.
 */
export const GRANTABLE: Record<string, readonly string[]> = {
  'Super admin': ['Super admin', 'Admin', 'Member'],
  Admin: ['Admin', 'Member'],
  Member: [],
};
