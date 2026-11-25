// Ontology manifests by version. A version is immutable (spec 25.1), so a manifest read
// once is the manifest for good: kept in process, per organisation and version, bounded.
// A branch's version is served from here to services only: a person's read goes to the
// ontology, which decides ontology.branch for them (spec 25.3).

import { getActiveVersion, getVersionManifest, type OntologyManifest, type VersionView } from '../../contracts/ontology/manifest.contract.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { callOptions, type PlanCall, type PlannerDeps } from './deps.service.ts';

const MAX_CACHED = 64;
const cache = new Map<string, OntologyManifest>();

export async function manifestOf(deps: PlannerDeps, call: PlanCall, versionId: string): Promise<OntologyManifest> {
  const key = `${call.request.organisationId}:${versionId}`;
  const hit = cache.get(key);
  // A branch's version is read again for each person: the ontology decides ontology.branch every time (spec 25.3).
  if (hit !== undefined && (hit.version.branchKind === 'main' || call.request.membershipId === undefined)) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let manifest: OntologyManifest;
  try {
    manifest = await deps.services.call(getVersionManifest, { params: { versionId } }, callOptions(call));
  } catch (error) {
    if (isAppError(error) && error.category === 'not_found') {
      throw new AppError('not_found', 'the plan names an ontology version this organisation does not have', {
        code: 'plan.ontology_version_unknown',
      });
    }
    throw error;
  }
  if (manifest.organisationId !== call.request.organisationId) {
    throw new AppError('integrity', 'the ontology served another organisation\'s manifest', { code: 'plan.manifest_mismatch' });
  }
  cache.set(key, manifest);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return manifest;
}

/** Main's head: what a new compile is bound to. */
/** Main's head, or a branch's for a holder of ontology.branch on it (spec 25.3). */
export async function activeVersion(deps: PlannerDeps, call: PlanCall, branchId?: string): Promise<VersionView> {
  return deps.services.call(getActiveVersion, { query: branchId === undefined ? {} : { branchId } }, callOptions(call));
}
