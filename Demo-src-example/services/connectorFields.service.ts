import { childLogger } from '../config/logger.config';
import { withTransaction } from '../infra/db.infra';
import { proposeFieldList } from '../infra/model.infra';
import { executeRead } from '../engine/read/execute.read';
import { listingName, listingObject, typeOf, withEveryField, type ListedField } from '../engine/discovery/fields.discovery';
import { fieldList as fieldListSchema, manifestV2, type ManifestV2 } from '../schemas/manifest.schema';
import * as connectorRepo from '../repos/connector.repo';
import { runWithTenant } from '../utils/tenantContext.util';
import { refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { manageableConnection } from './connector.service';
import { withConnection } from './connectorRuntime.service';
import { publishExpanded } from './connectorBuilder.service';
import { adopt, adoption } from './connectionVersion.service';
import { refreshSystemConcepts } from './concept.service';
import type { Actor } from './scope.service';

const log = childLogger('connector-fields');

/**
 * Read every field a system holds.
 *
 * ── THE ROOT OF "YOUR RECORDS HAVE NO INDUSTRY" ───────────────────────────
 *
 * A connector reads the fields it was built with. Built by the AI from a first
 * reading of the documentation, HubSpot's asked for name and domain and nothing
 * else, so Silo told a person their companies had no industry — a false
 * statement about their data. This asks the system for each object's own field
 * list, widens the connector to read every field on it, publishes that as a new
 * version, and moves the connection onto it.
 *
 * ── A LIST THE CONNECTOR DOES NOT DECLARE IS PROPOSED, THEN TESTED ────────
 *
 * Nothing about any system is written here. Where an object does not say how
 * to list its fields, the model proposes a `fieldList` in the connector's own
 * format — an ordinary read of the list and an expression for any one field —
 * and, where the system must be told which fields to return, the object's read
 * naming them through `listed`. It has seen names and paths, never a record.
 * Every candidate, declared or proposed, must pass one test against the live
 * system: the same records read through it return every field the current
 * version returns, unchanged, and at least one new field holds a value. The
 * move to the new version then reads every object first, as adopting any
 * version does.
 */

export type ObjectFields = {
  object: string;
  /** Fields the connector read before, and after. */
  before: number;
  after: number;
  /** How the field list was known: the connector said, the model proposed and it was tested, or neither. */
  list: 'declared' | 'proposed' | 'none';
  problem?: string;
};

export type FieldsOutcome = {
  objects: ObjectFields[];
  /** The version the connection is on now, when it moved. */
  version?: number;
};

/* Fewer fields than this on a system's list is not a field list. */
const FEWEST = 3;

export async function readEveryField(actor: Actor, connectionId: string): Promise<FieldsOutcome> {
  const connection = await manageableConnection(actor, connectionId);
  if (connection.status !== 'active') {
    throw refusal({ message: `${connection.name} is not connected yet, so its fields cannot be read.`, code: 'refusal.connection_inactive' });
  }

  const credential = await inTenant(actor, () =>
    withTransaction(async (db) => (await connectorRepo.credentialsFor(db, [connectionId])).get(connectionId)),
  );

  let document = JSON.parse(JSON.stringify(connection.manifest)) as ManifestV2 & { objects: Array<Record<string, unknown>> };
  const outcomes: ObjectFields[] = [];

  for (const object of connection.manifest.objects.filter((one) => one.available)) {
    const before = object.fields.length;
    const outcome = (problem: string, list: ObjectFields['list']): ObjectFields => ({ object: object.name, before, after: before, list, problem });

    /* The list as the connector declares it, or as the model proposes it — with the read it needs, if any. */
    let how: ObjectFields['list'] = object.fieldList ? 'declared' : 'none';
    let list: unknown = object.fieldList;
    let read: unknown = object.read;
    if (!list) {
      const proposal = await proposed(connection, object);
      if (proposal) {
        how = 'proposed';
        list = proposal.fieldList;
        read = proposal.read ?? object.read;
      }
    }
    if (!list) {
      outcomes.push(outcome(`${connection.name} gave no way to list the fields of ${object.name}.`, 'none'));
      continue;
    }

    const listed = await readList(actor, connection, credential, document, object.name, list);
    if ('problem' in listed) {
      outcomes.push(outcome(listed.problem, how));
      continue;
    }
    log.info({ object: object.name, listed: listed.fields.length }, 'Field list read');

    const withList = {
      ...document,
      objects: document.objects.map((one) => (one.name === object.name ? { ...one, fieldList: list, read } : one)),
    };
    const widened = withEveryField(withList, object.name, listed.fields);
    if (widened.problem) {
      outcomes.push(outcome(widened.problem, how));
      continue;
    }

    const candidate = manifestV2.safeParse(widened.document);
    if (!candidate.success) {
      log.info({ object: object.name, issues: candidate.error.issues.slice(0, 3) }, 'The widened connector did not validate');
      outcomes.push(outcome(`Reading every field of ${object.name} did not make a valid connector, so it was left as it was.`, how));
      continue;
    }

    /* THE TEST, THE SAME FOR EVERY SYSTEM: what was read before is read the same, and something new is read too. */
    const tested = await sameAndMore(actor, connection, credential, document, candidate.data, object.name, widened.added);
    if (tested) {
      outcomes.push(outcome(tested, how));
      continue;
    }

    document = widened.document as typeof document;
    outcomes.push({ object: object.name, before, after: before + widened.added.length, list: how });
  }

  const added = outcomes.reduce((sum, one) => sum + (one.after - one.before), 0);
  if (added === 0) return { objects: outcomes };

  const checked = manifestV2.safeParse(document);
  if (!checked.success) {
    throw refusal({ message: 'The connector could not be widened to read every field. Nothing was changed.', code: 'refusal.fields_unwidened' });
  }

  const published = await inTenant(actor, () => publishExpanded(actor, checked.data));
  await inTenant(actor, async () => {
    const shown = await adoption(actor, connectionId, published.manifestId);
    await adopt(actor, connectionId, published.manifestId, { origins: shown.pins.origins, statements: shown.pins.statements });
  });

  await inTenant(actor, () =>
    withTransaction(async (db) => {
      await refreshSystemConcepts(db, actor, connectionId);
      await writeAudit(db, {
        event: 'connector_fields_listed',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { connectionId, manifestId: published.manifestId, objectCount: outcomes.length, added },
      });
    }),
  );

  return { objects: outcomes, version: published.version };
}

const inTenant = <T>(actor: Actor, work: () => Promise<T>) =>
  runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, work);

type Credential = Awaited<ReturnType<typeof connectorRepo.credentialsFor>> extends Map<string, infer C> ? C | undefined : never;

/** A few records of one object, read through a given version of the connector. */
async function sample(actor: Actor, connection: connectorRepo.LoadedConnection, credential: Credential, manifest: ManifestV2, objectName: string) {
  return inTenant(actor, () =>
    withConnection({
      actor,
      connection: { ...connection, manifest },
      credential,
      use: async (open) => executeRead(await open(objectName), { object: objectName, fields: [], filters: [], sort: [], limit: SAMPLE }),
    }),
  );
}

/* Records compared between the current read and the widened one. */
const SAMPLE = 5;

/**
 * Whether the widened read is the current read and more.
 *
 * ── ONE TEST FOR EVERY SYSTEM ─────────────────────────────────────────────
 *
 * Nothing about how a system names its fields or where it keeps their values
 * is assumed. The same records are read through both versions: every field
 * the current version read must come back the same, and at least one field
 * added must hold a value somewhere. A proposal that reads a different object,
 * drops a field, or adds fields that are always empty fails it. Null means it
 * passed; otherwise, why not.
 */
async function sameAndMore(
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
  credential: Credential,
  current: ManifestV2,
  widened: ManifestV2,
  objectName: string,
  added: string[],
): Promise<string | null> {
  try {
    const before = (await sample(actor, connection, credential, current, objectName)).rows;
    const after = (await sample(actor, connection, credential, widened, objectName)).rows;
    if (before.length === 0) return null;

    const identifier = current.objects.find((one) => one.name === objectName)?.identifier ?? [];
    const keyOf = (row: Record<string, unknown>) => JSON.stringify(identifier.map((name) => row[name]));
    const byKey = new Map(after.map((row) => [keyOf(row), row]));
    const compared = before.filter((row) => byKey.has(keyOf(row)));
    if (compared.length === 0) return `Reading every field of ${objectName} returned different records, so it was not used.`;

    for (const row of compared) {
      const other = byKey.get(keyOf(row))!;
      for (const [field, read] of Object.entries(row)) {
        if (JSON.stringify(read ?? null) !== JSON.stringify(other[field] ?? null)) {
          return `Reading every field of ${objectName} changed what ${field} reads, so it was not used.`;
        }
      }
    }
    if (added.length > 0 && !after.some((row) => added.some((field) => row[field] !== null && row[field] !== undefined))) {
      return `None of the fields found for ${objectName} held a value, so they were not added.`;
    }
    return null;
  } catch (error) {
    log.info({ err: error, object: objectName }, 'The widened read failed');
    return `${connection.name} refused the read that asks for every field of ${objectName}, so it was left as it was.`;
  }
}

/** The model's proposal for listing an object's fields, and the read that names them where it must — validated, or nothing. */
async function proposed(
  connection: connectorRepo.LoadedConnection,
  object: ManifestV2['objects'][number],
): Promise<{ fieldList: unknown; read?: unknown } | null> {
  const transport = connection.manifest.transport as { baseUrl?: string };
  try {
    const result = await proposeFieldList({
      system: `${connection.manifest.identity.name} (${connection.manifest.identity.provider})`,
      baseUrl: transport.baseUrl ?? null,
      object: {
        name: object.name,
        ...(object.description ? { description: object.description } : {}),
        read: object.read,
        fields: object.fields.map((field) => field.name),
      },
    });
    if (!result.ok || !result.raw) return null;
    const body = JSON.parse(result.raw) as { fieldList?: unknown; read?: unknown };
    if (!body.fieldList) return null;
    const checked = fieldListSchema.safeParse(body.fieldList);
    if (!checked.success) return null;
    return { fieldList: checked.data, ...(body.read ? { read: body.read } : {}) };
  } catch (error) {
    log.info({ err: error, object: object.name }, 'No field list could be proposed');
    return null;
  }
}

/** Read an object's field list from the live system, through the connection, as any read is made. */
async function readList(
  actor: Actor,
  connection: connectorRepo.LoadedConnection,
  credential: Credential,
  document: ManifestV2,
  objectName: string,
  list: unknown,
): Promise<{ fields: ListedField[] } | { problem: string }> {
  const probing = manifestV2.safeParse({
    ...document,
    objects: [...document.objects, listingObject(objectName, list as never)],
  });
  if (!probing.success) return { problem: `The way to list the fields of ${objectName} is not a valid read.` };

  try {
    const name = listingName(objectName);
    const most = (list as { most?: number }).most ?? 500;
    const result = await inTenant(actor, () =>
      withConnection({
        actor,
        connection: { ...connection, manifest: probing.data },
        credential,
        use: async (open) => executeRead(await open(name), { object: name, fields: [], filters: [], sort: [], limit: most }),
      }),
    );
    const fields = result.rows
      .map((row) => ({
        name: typeof row.name === 'string' ? row.name.trim() : typeof row.name === 'number' ? String(row.name) : '',
        ...(typeof row.key === 'string' || typeof row.key === 'number' ? { key: String(row.key).trim() } : {}),
        type: typeOf(row.type),
        ...(typeof row.label === 'string' && row.label.trim() ? { label: row.label.trim() } : {}),
      }))
      .filter((field) => field.name !== '');
    if (fields.length < FEWEST) return { problem: `${connection.name} listed too few fields for ${objectName} to be its field list.` };
    return { fields };
  } catch (error) {
    log.info({ err: error, object: objectName }, 'The field list could not be read');
    return { problem: `${connection.name} did not answer when asked for the fields of ${objectName}.` };
  }
}
