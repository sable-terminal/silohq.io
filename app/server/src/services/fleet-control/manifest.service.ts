// What a release manifest must satisfy before fleet-control signs it (spec 11.1, 6.5).
// The schema (contracts/fleet-control/release.contract.ts) checks each field; these are
// the rules across fields.

import { BUILD_CAPABILITIES } from '../../config/cell.config.ts';
import type { ServiceName } from '../../config/service.config.ts';
import type { ReleaseManifest } from '../../contracts/fleet-control/release.contract.ts';
import { AppError } from '../../utils/errors.util.ts';

// Compiled out of the sovereign build outright (spec 6.5; Warehouse "is never available
// in the sovereign cell", chapter 69.18; billing per the catalogue). Others are compiled
// out by capability, which the capability check covers.
export const SOVEREIGN_EXCLUDED_SERVICES: readonly ServiceName[] = [
  'discovery', 'billing', 'warehouse-provisioner', 'warehouse-schema', 'warehouse-sync', 'warehouse-reconcile', 'warehouse-access',
];

const invalid = (reason: string, message: string): AppError =>
  new AppError('validation', message, { code: 'fleet.manifest_invalid', details: { reason } });

const duplicates = (values: readonly string[]): boolean => new Set(values).size !== values.length;

export function validateManifest(manifest: ReleaseManifest): void {
  if (duplicates(manifest.images.map((i) => i.service))) throw invalid('image_twice', 'each service has one image');
  if (duplicates(manifest.agentBinaries.map((b) => b.platform))) throw invalid('binary_twice', 'each platform has one agent binary');
  if (new Set(manifest.agentBinaries.map((b) => b.version)).size > 1) throw invalid('binary_versions', 'agent binaries share one version');
  if (duplicates(manifest.migrations.map((m) => `${m.database}:${m.version}`))) throw invalid('migration_twice', 'each migration once');
  if (duplicates(manifest.capabilities)) throw invalid('capability_twice', 'each capability once');
  if (manifest.images.length === 0 && manifest.agentBinaries.length === 0) throw invalid('empty', 'a release carries images or agent binaries');

  if (manifest.target === 'sovereign') {
    if (manifest.commercialRelease === undefined) {
      throw invalid('commercial_release', 'a sovereign build names the commercial release built from the same source');
    }
    const allowed = new Set(BUILD_CAPABILITIES.sovereign);
    if (manifest.capabilities.some((c) => !allowed.has(c))) {
      throw invalid('sovereign_capability', 'a sovereign build carries only the capabilities its build allows (spec 6.5)');
    }
    if (manifest.images.some((i) => SOVEREIGN_EXCLUDED_SERVICES.includes(i.service))) {
      throw invalid('sovereign_service', 'a sovereign build has no image for a service compiled out of it (spec 6.5)');
    }
  } else if (manifest.commercialRelease !== undefined) {
    throw invalid('commercial_release', 'only a sovereign build names a commercial release');
  }
}
