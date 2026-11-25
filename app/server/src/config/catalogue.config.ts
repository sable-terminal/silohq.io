// The catalogue service (docs/siloServiceCatalogue.doc.md; spec 16.2): prebuilt connectors
// released by Fleet as signed data.
//
// Global catalogue rows (organisation_id null) are written only by the migration role
// (database: connect.connectors RLS). So the catalogue's release path connects with its own login, a member of
// silo_migrate, given in CATALOGUE_DATABASE_URL, and act as the role inside each
// transaction, as maintenance does. The configuration refuses the URL in any process that
// hosts another service. Tenant requests use the ordinary control pool, under row-level
// security.
//
// A catalogue release is verified with the Ed25519 public key in
// CATALOGUE_RELEASE_PUBLIC_KEY_FILE before anything is installed.

import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseSection, read, readSecret, zPostgresUrl, type Env } from './env.config.ts';

const schema = z.object({ databaseUrl: zPostgresUrl.optional() });

export interface CatalogueConfig {
  /** A login in silo_migrate. Only the catalogue's own process holds it. */
  databaseUrl: string | undefined;
  /** Verifies catalogue releases (Fleet's catalogue signing key). */
  releasePublicKey: KeyObject | undefined;
}

export function loadCatalogueConfig(env: Env, problems: string[]): CatalogueConfig | undefined {
  const parsed = parseSection(schema, { databaseUrl: readSecret(env, 'CATALOGUE_DATABASE_URL', problems) },
    { databaseUrl: 'CATALOGUE_DATABASE_URL' }, problems);
  if (!parsed) return undefined;
  if (parsed.databaseUrl !== undefined && new URL(parsed.databaseUrl).username === 'postgres') {
    problems.push('CATALOGUE_DATABASE_URL: never the superuser; a login in silo_migrate (spec 11.3)');
  }
  let releasePublicKey: KeyObject | undefined;
  const keyFile = read(env, 'CATALOGUE_RELEASE_PUBLIC_KEY_FILE');
  if (keyFile !== undefined) {
    try {
      const key = createPublicKey(readFileSync(keyFile, 'utf8'));
      if (key.asymmetricKeyType === 'ed25519') releasePublicKey = key;
    } catch {
      // Reported below.
    }
    if (releasePublicKey === undefined) problems.push('CATALOGUE_RELEASE_PUBLIC_KEY_FILE: must name a file holding an Ed25519 public key in PEM');
  }
  return { databaseUrl: parsed.databaseUrl, releasePublicKey };
}
