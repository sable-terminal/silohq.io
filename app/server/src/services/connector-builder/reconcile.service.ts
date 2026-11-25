// Reconcile and propose mapping (spec 16.3): documented against observed, the probe being the
// source of truth; then each object to an object type with its confidence.
//
// Reconcile works on the build draft (draft.service.ts), so the reconciled manifest is
// compiled through the same templates as the first: every expression stays one Silo wrote.
// Per object, from the documented draft object and what the probe inferred:
// - the records sit where the probe found them;
// - fields are the observed ones, keeping the documented name where the paths agree and
//   the observed type always; a documented field the source never returned is dropped and
//   named in the findings;
// - the identifier is the documented one if the probe saw it present and unique, else the
//   probe's;
// - a cursor's documented path gives way to where the probe found it;
// - filters stay only on fields that remain.
// Findings name source fields and count; they never hold a value.

import type { ManifestObject } from '../../contracts/connect/manifest.contract.ts';
import type { MappingProposal } from '../../contracts/connector-builder/build.contract.ts';
import type { InferredObject } from '../../contracts/schema-inference/inference.contract.ts';
import type { DraftObject } from './draft.service.ts';

export interface ReconcileFindings {
  object: string;
  recordsPath: { documented: string; observed: string };
  agreed: number;
  observedOnly: number;
  documentedOnly: string[];
  typeChanged: string[];
  identifier: { documented: string | null; chosen: string | null };
  pagingPath: { documented: string | null; observed: string | null } | null;
}

const normalise = (path: string | null): string => (path === null || path === '' || path === '$' ? '$' : path);

export function reconcileObject(documented: DraftObject, observed: InferredObject): { object: DraftObject | undefined; findings: ReconcileFindings } {
  const docByPath = new Map(documented.fields.map((f) => [f.path, f]));
  const observedPaths = new Set(observed.fields.map((f) => f.path));
  let agreed = 0;
  const typeChanged: string[] = [];
  const fields: DraftObject['fields'] = observed.fields.map((o) => {
    const doc = docByPath.get(o.path);
    if (doc !== undefined) {
      agreed += 1;
      if (doc.type !== o.type) typeChanged.push(doc.name);
    }
    return { name: doc?.name ?? o.name, path: o.path, type: o.type };
  });
  const documentedOnly = documented.fields.filter((f) => !observedPaths.has(f.path)).map((f) => f.name);

  const docIdPath = documented.identifier === null ? undefined
    : documented.fields.find((f) => f.name === documented.identifier)?.path ?? documented.identifier;
  const docIdSeen = docIdPath === undefined ? undefined : observed.fields.find((f) => f.path === docIdPath);
  const unique = docIdSeen !== undefined && docIdSeen.evidence.nulls === 0 && docIdSeen.evidence.present === observed.sampled
    && docIdSeen.evidence.distinct === observed.sampled;
  const observedIdPath = observed.identifier === null ? undefined : observed.fields.find((f) => f.name === observed.identifier!.fields[0])?.path;
  const idPath = unique ? docIdPath : observedIdPath;
  const identifier = idPath === undefined ? undefined : fields.find((f) => f.path === idPath)?.name;

  const cursorHint = observed.paging.find((p) => p.style === 'cursor');
  let paging = documented.paging;
  let pagingPath: ReconcileFindings['pagingPath'] = null;
  if (paging.style === 'cursor' && cursorHint !== undefined && paging.path !== cursorHint.path) {
    pagingPath = { documented: paging.path, observed: cursorHint.path };
    paging = { ...paging, path: cursorHint.path };
  }
  const remaining = new Map(fields.map((f) => [f.path, f.name]));
  const filters = documented.filters.flatMap((f) => {
    const path = documented.fields.find((d) => d.name === f.field)?.path ?? f.field;
    const field = remaining.get(path);
    return field === undefined ? [] : [{ field, param: f.param }];
  });

  const findings: ReconcileFindings = {
    object: documented.name,
    recordsPath: { documented: normalise(documented.recordsPath), observed: normalise(observed.recordsPath) },
    agreed, observedOnly: fields.length - agreed, documentedOnly, typeChanged,
    identifier: { documented: documented.identifier, chosen: identifier ?? null }, pagingPath,
  };
  if (fields.length === 0 || identifier === undefined) return { object: undefined, findings };
  return {
    object: {
      ...documented, recordsPath: normalise(observed.recordsPath) === '$' ? null : observed.recordsPath, identifier, fields, paging, filters,
    },
    findings,
  };
}

// ----------------------------------------------------------------------------- mapping

const words = (name: string): string => name.replace(/[_\s]+/g, ' ').trim();
const title = (name: string): string => words(name).replace(/\b\w/g, (c) => c.toUpperCase());
const sentence = (name: string): string => {
  const w = words(name);
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const singular = (word: string): string =>
  word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('ses') ? word.slice(0, -2)
    : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;

/** Each object to an object type, its identifier and properties, and foreign keys to links (spec 16.3, 22). */
export function proposeMapping(objects: readonly ManifestObject[], observed: readonly InferredObject[]): MappingProposal[] {
  return objects.map((o) => {
    const seen = observed.find((x) => x.object === o.name);
    const confidenceOf = new Map((seen?.fields ?? []).map((f) => [f.path, f.confidence]));
    const properties = o.fields.map((f) => ({
      field: f.name, property: sentence(f.name), type: f.type, confidence: confidenceOf.get(f.path ?? f.name) ?? 0.5,
    }));
    const links = (seen?.relationships ?? [])
      .filter((r) => objects.some((t) => t.name === r.targetObject) && o.fields.some((f) => f.name === r.field))
      .map((r) => ({ field: r.field, targetObject: r.targetObject, targetField: r.targetField, confidence: r.confidence }));
    const meanField = properties.length === 0 ? 0 : properties.reduce((n, p) => n + p.confidence, 0) / properties.length;
    return {
      object: o.name, objectType: title(singular(o.name)),
      confidence: Math.round(Math.min(seen?.identifier?.confidence ?? 0.5, Math.max(meanField, 0.5)) * 100) / 100,
      identifier: [...o.identifier], properties, links,
    };
  });
}
