// The global tier's fleet-control, or an install's own (spec 11; D201), built from its
// configuration, for the service and for the bundle loader script alike.

import { createPublicKey } from 'node:crypto';
import { required, type Config } from '../../config/index.config.ts';
import { createAdvisorySource } from '../../infra/advisoryFeed.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases } from '../../infra/postgres.infra.ts';
import { directoryArtefactStore, type ArtefactStore } from './artefactStore.service.ts';
import { createFleet } from './fleet.service.ts';
import { keyFileSigner, trustedKey, type TrustedKey } from './signing.service.ts';
import { createSbomChecks } from './vulnerabilities.service.ts';

/**
 * The global tier's fleet-control (or an install's own) from its configuration: its signing
 * key and role, the keys it trusts (its own; the Silo release key wherever configured, which a
 * sovereign or self-managed fleet-control checks releases and bundles against), its artefact
 * store, the SBOM checks where advisories are configured. The service and the bundle loader
 * script build it alike.
 */
export async function openFleetControl(config: Config, databases: Databases, logger: Logger, options: { store?: ArtefactStore; now?: () => number } = {}) {
  const settings = config.globalTier.fleet;
  const privateKey = required(settings.signingKey, 'FLEET_SIGNING_KEY');
  const signer = keyFileSigner(privateKey, settings.signingRole, createPublicKey(privateKey));
  const trusted: TrustedKey[] = [trustedKey(signer.publicKey, signer.role)];
  if (settings.signingRole === 'sovereign') trusted.push(trustedKey(required(settings.releasePublicKey, 'FLEET_RELEASE_PUBLIC_KEY_FILE'), 'release'));
  else if (settings.releasePublicKey !== undefined && trustedKey(settings.releasePublicKey, 'release').keyId !== trusted[0]!.keyId) {
    trusted.push(trustedKey(settings.releasePublicKey, 'release'));
  }
  const store = options.store ?? directoryArtefactStore(required(settings.artefactDir, 'FLEET_ARTEFACT_DIR'));
  // SBOM checks (spec 11.1) where advisories are configured: the release key's fleet-control.
  const sbom = settings.advisoryUrl === undefined ? undefined : createSbomChecks({
    databases, store, feed: createAdvisorySource(settings.advisoryUrl), logger,
    syncEveryMs: settings.advisorySyncHours * 3_600_000, maxAgeMs: settings.advisoryMaxAgeHours * 3_600_000,
    extraFeeds: settings.advisoryEcosystems, ...(options.now ? { now: options.now } : {}),
  });
  const fleet = await createFleet({
    databases, store,
    signer, trusted, plan: { testCells: settings.testCells, canaryCells: settings.canaryCells },
    verdictGraceMinutes: settings.verdictGraceMinutes, logger, noticeHours: settings.changeNoticeHours,
    ...(options.now ? { now: options.now } : {}),
    ...(sbom ? { sbomGate: sbom.gate } : {}),
  });
  return { fleet, sbom, store };
}

