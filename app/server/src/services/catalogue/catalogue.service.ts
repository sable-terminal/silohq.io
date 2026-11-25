// catalogue (catalogue: catalogue; spec 16.2, 17.5): browsing connectors (Silo's prebuilt
// ones, certified, and the organisation's own private ones), and installing Silo's prebuilt
// connectors from a signed catalogue release. The marketplace (spec 16.5: promotion of a
// private connector to community, the Silo review, tiers above it and the authors' revenue
// share) was dropped on 2026-11-23: a connector an organisation builds stays its own.
//
// Two pools. Browsing runs on the control pool under the organisation's row-level
// security. The release path writes global rows (organisation_id null), which only the
// migration role may (connect.connectors RLS); it runs on the catalogue's own migration
// login, acting as silo_migrate inside each transaction.

import { planGates } from '../billing/planGates.service.ts';
import { verify, type KeyObject } from 'node:crypto';
import type { CatalogueEntry, CatalogueRelease } from '../../contracts/catalogue/catalogue.contract.ts';
import { manifestSchema, type Manifest } from '../../contracts/connect/manifest.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { Connector } from '../../models/connect/connector.model.ts';
import { connectorManifestRepo, connectorRepo } from '../../repos/connect/index.repo.ts';
import { maintenanceRepo, outboxRepo } from '../../repos/platform/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { validateManifest } from '../connect-registry/registry.service.ts';
import { protocolIssues } from '../connect-runtime/protocols/checks.protocol.ts';
import { keyIdOf, trustedKey, verifyDocument } from '../fleet-control/signing.service.ts';
import type { ConceptTemplateSet } from '../../contracts/fleet-control/conceptTemplates.contract.ts';
import type { SignatureRecord } from '../../contracts/fleet-control/release.contract.ts';
import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { conceptTemplateRepo as cellTemplateRepo } from '../../repos/ontology/index.repo.ts';

export interface CatalogueDeps {
  databases: Databases;
  /** The migration login's pool, for global rows and trust tiers. Undefined: the staff and release paths refuse. */
  migrate: ReturnType<Databases['pool']> | undefined;
  services: ServiceClient;
  logger: Logger;
  releasePublicKey: KeyObject | undefined;
}

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

/** Domain separation: a catalogue signature never passes as a release, channel or bundle one. */
export const CATALOGUE_SIGNATURE_PREFIX = 'silo.catalogue.v1\u0000';
export const catalogueMessage = (release: CatalogueRelease): Buffer =>
  Buffer.concat([Buffer.from(CATALOGUE_SIGNATURE_PREFIX, 'utf8'), canonicalJsonBytes(release)]);

const hashOf = (document: unknown): Buffer => sha256(canonicalJsonBytes(document));
const documentOf = (manifest: Manifest): Record<string, unknown> => JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;

export function createCatalogue(deps: CatalogueDeps) {
  const control = deps.databases.pool('control');


  /** A transaction as the migration role: global rows, trust tiers, every organisation. */
  async function asMigrate<T>(work: (db: Queryable) => Promise<T>): Promise<T> {
    if (deps.migrate === undefined) {
      throw new AppError('unavailable', 'the catalogue has no migration login here (CATALOGUE_DATABASE_URL)', { code: 'catalogue.migrate_unconfigured' });
    }
    return inTransaction(deps.migrate, {}, async (db) => {
      await maintenanceRepo.actAsMigrate(db);
      return work(db);
    });
  }

  async function entryOf(db: Queryable, connector: Connector, organisationId: string): Promise<CatalogueEntry> {
    const current = await connectorManifestRepo.current(db, connector.id);
    const protocol = current === undefined ? undefined : manifestSchema.safeParse(current.document);
    return {
      id: connector.id, kind: connector.kind, slug: connector.slug, name: connector.name, provider: connector.provider,
      description: connector.description, trustTier: connector.trustTier, sourceRoute: connector.sourceRoute, status: connector.status,
      authoredHere: connector.organisationId === organisationId,
      current: current === undefined ? null : { manifestId: current.id, version: current.version, protocol: protocol?.success ? protocol.data.protocol.kind : 'unknown' },
    };
  }


  return {
    /**
     * Fleet's signed concept template set (22.7; D210): Silo's signature verified before any row
     * is written; each newly reviewed template installed and each withdrawn one withdrawn, every
     * organisation told. A set seen before changes nothing.
     */
    async installConceptTemplates(set: ConceptTemplateSet, signatures: SignatureRecord[], correlationId: string) {
      if (deps.releasePublicKey === undefined) {
        throw new AppError('configuration', 'the catalogue has no release key to verify Fleet\'s set (CATALOGUE_RELEASE_PUBLIC_KEY_FILE)', { code: 'catalogue.release_key_missing' });
      }
      verifyDocument('templates', set, signatures, [trustedKey(deps.releasePublicKey, 'release')], ['release']);
      return asMigrate(async (db) => {
        let installed = 0;
        let withdrawn = 0;
        let unchanged = 0;
        const tell = (event: 'template_reviewed' | 'template_withdrawn', t: ConceptTemplateSet['templates'][number]) => outboxRepo.insertForEveryOrganisation(db, {
          topic: auditEventMessage.topic, event: auditEventMessage.name, schemaVersion: auditEventMessage.version, correlationId,
          payload: auditEventMessage.schema.parse({
            event, actor: { kind: 'service', service: 'catalogue' }, subjectMembershipId: null, scopeId: null, resource: { type: 'concept_template', id: t.id },
            purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
            detail: { name: t.name.slice(0, 200), fields: t.fieldNames.length, revision: t.revision },
          }),
        });
        for (const t of set.templates) {
          const here = await cellTemplateRepo.findById(db, t.id);
          if (here === undefined) {
            await cellTemplateRepo.install(db, {
              id: t.id, name: t.name, fieldNames: t.fieldNames, revision: t.revision, authoredBy: t.authoredBy, reviewedBy: t.reviewedBy, reviewedAt: t.reviewedAt, status: t.status,
            });
            if (t.status === 'reviewed') {
              installed += 1;
              await tell('template_reviewed', t);
            } else {
              unchanged += 1;
            }
          } else if (t.status === 'withdrawn' && here.status !== 'withdrawn') {
            await cellTemplateRepo.withdraw(db, t.id);
            withdrawn += 1;
            await tell('template_withdrawn', t);
          } else {
            unchanged += 1;
          }
        }
        return { installed, withdrawn, unchanged };
      });
    },

    async browse(ctx: Context, filter: { tier?: string | undefined; kind?: string | undefined; q?: string | undefined; limit: number }) {
      const organisationId = ctx.request.organisationId!;
      return inTransaction(control, ctx.request, async (db) => {
        // A self-serve plan lists certified prebuilt connectors only (D76).
        const prebuiltOnly = (await planGates(db, organisationId)).prebuiltOnly;
        if (prebuiltOnly && filter.tier !== undefined && filter.tier !== 'certified') return [];
        const rows = (await connectorRepo.browse(db, { tier: prebuiltOnly ? 'certified' : filter.tier, kind: filter.kind, search: filter.q, limit: filter.limit }))
          .filter((row) => !prebuiltOnly || row.organisationId === null);
        const entries: CatalogueEntry[] = [];
        for (const row of rows) entries.push(await entryOf(db, row, organisationId));
        return entries;
      }, { readOnly: true });
    },

    // ------------------------------------------------------------------------- releases

    /**
     * A signed catalogue release: verified, then every manifest validated exactly as any
     * manifest is, then installed in one transaction, or refused whole. A version already
     * installed with the same document is left alone; a different document under an
     * installed version is refused, because versions never change.
     */
    async install(release: CatalogueRelease, signature: string, keyId: string): Promise<{ installed: number; unchanged: number }> {
      const key = deps.releasePublicKey;
      if (key === undefined) throw new AppError('unavailable', 'no catalogue release key is configured', { code: 'catalogue.release_key_unconfigured' });
      if (keyId !== keyIdOf(key) || !verify(null, catalogueMessage(release), key, Buffer.from(signature, 'base64url'))) {
        throw new AppError('integrity', 'the catalogue release signature does not verify', { code: 'catalogue.signature_invalid' });
      }
      const prepared = release.connectors.map((entry, i) => {
        let manifest: Manifest;
        try {
          const { manifest: parsed, expressionIssues } = validateManifest(entry.document);
          if (expressionIssues.length > 0 || protocolIssues(parsed).length > 0) throw new Error('refused');
          manifest = parsed;
        } catch {
          throw new AppError('integrity', 'a manifest in the release is refused; nothing was installed', {
            code: 'catalogue.release_manifest_invalid', details: { index: i, slug: entry.slug },
          });
        }
        const document = documentOf(manifest);
        return { entry, manifest, document, hash: hashOf(document) };
      });
      return asMigrate(async (db) => {
        let installed = 0;
        let unchanged = 0;
        for (const { entry, manifest, document, hash } of prepared) {
          let connector = await connectorRepo.findGlobalBySlug(db, entry.slug);
          if (connector !== undefined && connector.kind !== 'prebuilt') {
            throw new AppError('conflict', 'a community connector holds a slug the release uses', { code: 'catalogue.slug_taken', details: { slug: entry.slug } });
          }
          connector ??= await connectorRepo.insert(db, {
            id: uuidv7(), organisationId: null, kind: 'prebuilt', slug: entry.slug, name: entry.name, provider: entry.provider,
            description: entry.description ?? null, trustTier: 'certified', sourceRoute: 'catalogue', status: 'active',
          });
          const existing = await connectorManifestRepo.findByConnectorIdAndVersion(db, { connectorId: connector.id, version: manifest.identity.version });
          if (existing !== undefined) {
            if (!existing.documentHash.equals(hash)) {
              throw new AppError('integrity', 'the release changes an installed version; versions never change', {
                code: 'catalogue.version_changed', details: { slug: entry.slug, version: manifest.identity.version },
              });
            }
            unchanged += 1;
            continue;
          }
          await connectorManifestRepo.supersedeCurrent(db, connector.id);
          await connectorManifestRepo.insert(db, {
            id: uuidv7(), organisationId: null, connectorId: connector.id, version: manifest.identity.version, document: document as never,
            documentHash: hash, schemaVersion: manifest.schemaVersion, sourceRoute: 'catalogue',
          });
          installed += 1;
        }
        deps.logger.info('catalogue release installed', { event: 'catalogue.release_installed', count: installed });
        return { installed, unchanged };
      });
    },
  };
}

export type Catalogue = ReturnType<typeof createCatalogue>;
