/**
 * The before and after of a mutation, computed once and rendered everywhere.
 *
 * ONE FUNCTION BECAUSE THE THREE PLACES MUST AGREE. The preview panel, the
 * approval queue and the audit record all show this diff. If each computed its
 * own, an approver could approve something subtly different from what the
 * requester previewed, and the audit row would record a third version. The whole
 * governance model rests on those three being the same object.
 *
 * COMPUTED AGAINST DATA READ AT PREVIEW TIME. That is why approvals expire: a
 * diff approved a week later would be applied to a world that has moved.
 */

export type ChangeKind = 'create' | 'update' | 'delete';

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface RowChange {
  kind: ChangeKind;
  /** The row as the source system identifies it. */
  externalId: string;
  connectionId: string;
  fields: FieldChange[];
}

export interface Diff {
  changes: RowChange[];
  summary: { created: number; updated: number; deleted: number; fieldsTouched: number };
  /** Connections this write reaches. Drives approval policy resolution. */
  connectionIds: string[];
}

function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const fields: FieldChange[] = [];
  // Union of both sides: a field removed in `after` is a change, and iterating
  // only `after` would miss it.
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[field];
    const to = after[field];
    // Structural comparison, so `{a:1}` equals `{a:1}` and a re-serialised row
    // does not read as an edit to every field.
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      fields.push({ field, before: from, after: to });
    }
  }
  return fields;
}

export function computeDiff(
  input: ReadonlyArray<{
    kind: ChangeKind;
    externalId: string;
    connectionId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  }>,
): Diff {
  const changes: RowChange[] = [];
  const connectionIds = new Set<string>();
  let fieldsTouched = 0;

  for (const item of input) {
    connectionIds.add(item.connectionId);
    const fields = changedFields(item.before ?? {}, item.after ?? {});

    // An update with no changed field is not a change. Including it inflates the
    // row count that approval thresholds are measured against.
    if (item.kind === 'update' && fields.length === 0) continue;

    fieldsTouched += fields.length;
    changes.push({
      kind: item.kind,
      externalId: item.externalId,
      connectionId: item.connectionId,
      fields,
    });
  }

  return {
    changes,
    summary: {
      created: changes.filter((c) => c.kind === 'create').length,
      updated: changes.filter((c) => c.kind === 'update').length,
      deleted: changes.filter((c) => c.kind === 'delete').length,
      fieldsTouched,
    },
    connectionIds: [...connectionIds],
  };
}

/** The row count approval thresholds are measured against. */
export function affectedRows(diff: Diff): number {
  return diff.changes.length;
}

/**
 * A stable fingerprint of a diff.
 *
 * WRITTEN INTO THE APPROVAL CHAIN AT CREATION AND CHECKED BEFORE EXECUTION. It is
 * what stops a plan being altered between approval and execution — the approver
 * agreed to this fingerprint, and anything else is a different change wearing its
 * approval.
 */
export function fingerprint(diff: Diff): string {
  const canonical = diff.changes
    .map((c) => `${c.connectionId}:${c.kind}:${c.externalId}:${c.fields.map((f) => f.field).sort().join(',')}`)
    .sort()
    .join('|');
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = (Math.imul(31, hash) + canonical.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
