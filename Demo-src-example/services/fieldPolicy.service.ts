import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, notFound } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import { applyFieldPolicies, type FieldPolicy } from '../utils/effectivePermissions.util';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import * as fieldPolicyRepo from '../repos/fieldPolicy.repo';
import * as connectorRepo from '../repos/connector.repo';
import * as authzRepo from '../repos/authz.repo';
import * as scopeRepo from '../repos/scope.repo';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

/**
 * Field policies — which fields of a connection each person may see.
 *
 * ── The resolver is auth's; enforcement is the compilers' and the gate's ───
 *
 * `hiddenFields` answers one question: for this membership, on these
 * connections, which fields are hidden. Everything that builds a query asks it
 * first — the connector gate every read passes, the vocabulary a question or a
 * change is compiled against, and the mutation planner — so a hidden field is
 * never in a plan rather than removed from an answer.
 *
 * ── Mask and redact hide the field, for now ────────────────────────────────
 *
 * The policy model distinguishes deny from mask and redact, and nothing yet
 * renders a masked value. Until something does, a masked field is treated as
 * hidden: the stricter reading, so a policy meant to limit a field never limits
 * it less than it said.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

/**
 * The fields hidden from this membership, per connection. Empty sets where
 * nothing is hidden, so callers can skip work.
 */
export async function hiddenFields(
  db: PoolClient,
  actor: Actor,
  connectionIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const hidden = new Map<string, Set<string>>(connectionIds.map((id) => [id, new Set<string>()]));
  if (connectionIds.length === 0) return hidden;

  const policies = await fieldPolicyRepo.live(db, connectionIds);
  if (policies.length === 0) return hidden;

  const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
  const assignments = await authzRepo.effectiveAssignments(db, actor.membershipId);

  const subject = {
    scopePaths: authority.scopePaths,
    roleAssignments: [],
    connectionGrants: [],
    clearances: { held: authority.clearances },
    roleIds: new Set(assignments.map((one) => one.roleId)),
  };

  for (const connectionId of connectionIds) {
    const { denied, masked } = applyFieldPolicies(subject, policies, connectionId);
    hidden.set(connectionId, new Set([...denied, ...masked]));
  }

  return hidden;
}

/**
 * A concept's contributing objects as a reader may see them: every mapping to a
 * hidden column removed.
 */
export function visibleObjects<T extends { connectionId: string; fieldMap: Record<string, string> }>(
  objects: readonly T[],
  hidden: ReadonlyMap<string, ReadonlySet<string>>,
): T[] {
  return objects.map((object) => {
    const columns = hidden.get(object.connectionId);
    if (!columns || columns.size === 0) return object;
    return {
      ...object,
      fieldMap: Object.fromEntries(Object.entries(object.fieldMap).filter(([, column]) => !columns.has(column))),
    };
  });
}

/* ── Administering them ───────────────────────────────────────────────────── */

export async function list(actor: Actor): Promise<fieldPolicyRepo.StoredFieldPolicy[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'field_policy.manage');
      return fieldPolicyRepo.live(db);
    }),
  );
}

export async function create(
  actor: Actor,
  input: {
    connectionId: string;
    fieldPath: string;
    effect: FieldPolicy['effect'];
    appliesToRoleId: string | null;
    appliesToMarkingId: string | null;
    appliesToScopeId: string | null;
    includeDescendants: boolean;
  },
): Promise<fieldPolicyRepo.StoredFieldPolicy[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'field_policy.manage');

      const [connection] = await connectorRepo.load(db, [input.connectionId]);
      if (!connection) {
        throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });
      }

      /*
       * A POLICY ON A FIELD THE CONNECTOR DOES NOT DESCRIBE HIDES NOTHING, and
       * would sit in the list looking like protection. Refused by name.
       */
      const described = connection.manifest.objects.some((object) =>
        object.fields.some((field) => field.name === input.fieldPath),
      );
      if (!described) {
        throw invalid({
          message: `${connection.name} has no field called ${input.fieldPath}.`,
          code: 'invalid.unknown_field',
        });
      }

      if (input.appliesToRoleId && !(await authzRepo.listRoles(db)).some((one) => one.id === input.appliesToRoleId)) {
        throw invalid({ message: 'That role does not exist.', code: 'invalid.role' });
      }
      if (input.appliesToMarkingId && !(await authzRepo.markingIdsInOrganisation(db)).has(input.appliesToMarkingId)) {
        throw invalid({ message: 'That marking does not exist.', code: 'invalid.marking' });
      }
      if (input.appliesToScopeId && !(await scopeRepo.findById(db, input.appliesToScopeId))) {
        throw notFound({ message: 'That scope does not exist.', code: 'missing.scope' });
      }

      await fieldPolicyRepo.create(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        connectionId: input.connectionId,
        fieldPath: input.fieldPath,
        effect: input.effect,
        appliesToRole: input.appliesToRoleId,
        appliesToMarking: input.appliesToMarkingId,
        appliesToScope: input.appliesToScopeId,
        includeDescendants: input.includeDescendants,
        createdBy: actor.membershipId,
      });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'field_policy_changed',
        detail: {
          change: 'created',
          connectionId: input.connectionId,
          fieldPath: input.fieldPath,
          effect: input.effect,
          roleId: input.appliesToRoleId,
          markingId: input.appliesToMarkingId,
          scopeId: input.appliesToScopeId,
        },
      });

      return fieldPolicyRepo.live(db);
    }),
  );
}

export async function revoke(actor: Actor, id: string): Promise<void> {
  await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'field_policy.manage');

      const revoked = await fieldPolicyRepo.revoke(db, { id, revokedBy: actor.membershipId });
      if (!revoked) {
        throw notFound({ message: 'That field policy does not exist.', code: 'missing.field_policy' });
      }

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'field_policy_changed',
        detail: { change: 'revoked', connectionId: revoked.connectionId, fieldPath: revoked.fieldPath },
      });
    }),
  );
}
