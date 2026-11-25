// The configuration of one process, loaded once at startup and passed down. Every section
// is validated, then the rules that cross sections are applied, and the process refuses
// to start on any problem, listing them all.
//
// Rules applied here:
// - production: Cloud KMS (commercial) or the UK HSM (sovereign), never a local key or
//   Vault (spec 61.1, decision 2026-10-29), no emulator, TLS to Postgres, Redis (spec 8.3)
//   and NATS, service mTLS (spec 7.1), a release identifier (spec 11.1);
// - capabilities: an adapter whose capability the build does not carry cannot be
//   configured (spec 6.5), and the sovereign build uses JetStream (spec 9.1), a
//   self-hosted model (spec 62.7) and an in-cell collector (spec 13.1);
// - model routes are zero-retention and stay in the cell's residency (spec 7.8, 62.7);
// - services with a hard dependency refuse to start without it: credential without a
//   KMS key (spec 61.1), the directory service without the directory database and its key.

import { loadConformanceConfig, type ConformanceConfig } from './conformance.config.ts';
import { loadCompileConfig, type CompileConfig } from './compile.config.ts';
import { loadBusConfig, type BusConfig } from './bus.config.ts';
import { loadCellConfig, type Capability, type CellConfig } from './cell.config.ts';
import { loadConnectConfig, type ConnectConfig } from './connect.config.ts';
import { ConfigError, deepFreeze, type Env } from './env.config.ts';
import { loadGatewayConfig, type GatewayConfig } from './gateway.config.ts';
import { loadGlobalTierConfig, type GlobalTierConfig } from './globalTier.config.ts';
import { loadHttpConfig, type HttpConfig } from './http.config.ts';
import { loadKmsConfig, type KmsConfig } from './kms.config.ts';
import { LIMITS, loadExecutorBounds, type ExecutorBounds } from './limits.config.ts';
import { loadMaintenanceConfig, PLATFORM_WORKERS, type MaintenanceConfig } from './maintenance.config.ts';
import { loadCatalogueConfig, type CatalogueConfig } from './catalogue.config.ts';
import { loadFilesConfig, type FilesConfig } from './files.config.ts';
import { loadSchedulerConfig, type SchedulerConfig } from './scheduler.config.ts';
import { loadNotifyConfig, type NotifyConfig } from './notify.config.ts';
import { loadModelConfig, type ModelConfig } from './model.config.ts';
import { loadPaymentsConfig, type PaymentsConfig } from './payments.config.ts';
import { loadWebSearchConfig, type WebSearchConfig } from './webSearch.config.ts';
import { loadPostgresConfig, type PostgresConfig } from './postgres.config.ts';
import { loadRedisConfig, type RedisConfig } from './redis.config.ts';
import { loadSecurityConfig, type SecurityConfig } from './security.config.ts';
import { loadSsoConfig, type SsoConfig } from './sso.config.ts';
import { loadBigQueryJobsConfig, type BigQueryJobsConfig } from './bigqueryJobs.config.ts';
import { loadSiloesConfig, type SiloesConfig } from './siloes.config.ts';
import { loadTenantMigrationsConfig, type TenantMigrationsConfig } from './tenantMigrations.config.ts';
import { loadFdeConfig, type FdeConfig } from './fde.config.ts';
import { loadAdminPortalConfig, type AdminPortalConfig } from './adminPortal.config.ts';
import { CONTRACTS_DEFAULTS, loadContractsConfig, type ContractsConfig } from './contracts.config.ts';
import { loadWarehouseConfig, type WarehouseConfig } from './warehouse.config.ts';
import { loadServiceConfig, type Environment, type ServiceName } from './service.config.ts';
import { loadBigQueryConfig, loadObjectStorageConfig, type BigQueryConfig, type ObjectStorageConfig } from './storage.config.ts';
import { isInCellEndpoint, loadTelemetryConfig, type TelemetryConfig } from './telemetry.config.ts';

export interface Config {
  environment: Environment;
  service: ServiceName;
  /** Every service this process runs (SILO_SERVICES), the identity first. */
  hosted: ServiceName[];
  release: string;
  cell: CellConfig;
  http: HttpConfig;
  postgres: PostgresConfig;
  redis: RedisConfig;
  bus: BusConfig;
  kms: KmsConfig | undefined;
  objectStorage: ObjectStorageConfig | undefined;
  bigQuery: BigQueryConfig | undefined;
  model: ModelConfig | undefined;
  /** The payment provider, for the billing service (spec 74.5). */
  payments: PaymentsConfig | undefined;
  /** Ask's web context provider (36.7); undefined where none is configured. */
  webSearch: WebSearchConfig | undefined;
  /** Compile's narrowing of a large vocabulary (decision 2026-11-15). */
  compile: CompileConfig;
  /** The change-stream class's waits (decision 2026-11-15). */
  conformance: ConformanceConfig;
  telemetry: TelemetryConfig;
  security: SecurityConfig;
  /** Egress to customer systems and the OAuth engine (spec 14, 15). */
  connect: ConnectConfig;
  gateway: GatewayConfig;
  /** Directory, status and fleet-control (spec 6.2, 11, 13.2). */
  globalTier: GlobalTierConfig;
  executorBounds: ExecutorBounds;
  limits: typeof LIMITS;
  /** The notify service's mail relay and links. */
  notify: NotifyConfig | undefined;
  /** The maintenance jobs: their migration login, schedule and retention. */
  maintenance: MaintenanceConfig | undefined;
  /** The catalogue's migration login and release key (spec 16.2, 16.5). */
  catalogue: CatalogueConfig | undefined;
  /** The scheduler's sweep and the shortest schedule (spec 40.7). */
  scheduler: SchedulerConfig;
  /** Export bounds and retention (spec 41.5). */
  files: FilesConfig;
  /** Federated sign-in and WebAuthn, for auth (spec 55.4, 55.5). */
  sso: SsoConfig;
  /** The Import loader, the Object Index, BigQuery metering and Warehouse access (spec 68.6, 69, 74.1). */
  bigqueryJobs: BigQueryJobsConfig;
  warehouse: WarehouseConfig;
  /** Siloes Capture and Import (spec 67, 68, 70). */
  siloes: SiloesConfig;
  /** Tenant migrations and the organisation export (spec 6.4, 2.6). */
  tenantMigrations: TenantMigrationsConfig;
  /** The AI FDE's orchestrator (spec 49 to 54). */
  fde: FdeConfig;
  /** The staff console: its listener, the staff identity provider, staff sessions (spec 13). */
  adminPortal: AdminPortalConfig;
  contracts: ContractsConfig;
}

export { ConfigError } from './env.config.ts';
export type { Env } from './env.config.ts';

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const service = loadServiceConfig(env, problems);
  const cell = loadCellConfig(env, problems);
  const http = loadHttpConfig(env, problems);
  const postgres = loadPostgresConfig(env, problems);
  const redis = loadRedisConfig(env, problems);
  const bus = loadBusConfig(env, problems);
  const kms = loadKmsConfig(env, problems);
  const objectStorage = loadObjectStorageConfig(env, problems);
  const bigQuery = loadBigQueryConfig(env, problems);
  const model = loadModelConfig(env, problems);
  const payments = loadPaymentsConfig(env, problems);
  const webSearch = loadWebSearchConfig(env, problems, cell?.buildTarget === 'sovereign');
  const compile = loadCompileConfig(env, problems) ?? { narrowTypes: 20 };
  const conformance = loadConformanceConfig(env, problems) ?? { streamWaitMs: 120_000, streamPollMs: 2_000 };
  const telemetry = loadTelemetryConfig(env, problems);
  const security = loadSecurityConfig(env, problems);
  const connect = loadConnectConfig(env, problems);
  const gateway = loadGatewayConfig(env, problems);
  const globalTier = loadGlobalTierConfig(env, problems);
  const executorBounds = loadExecutorBounds(env, problems);
  const notify = loadNotifyConfig(env, problems);
  const maintenance = loadMaintenanceConfig(env, problems);
  const catalogue = loadCatalogueConfig(env, problems);
  const scheduler = loadSchedulerConfig(env, problems);
  const files = loadFilesConfig(env, problems);
  const sso = loadSsoConfig(env, problems);
  const bigqueryJobs = loadBigQueryJobsConfig(env, problems);
  const warehouse = loadWarehouseConfig(env, problems);
  const siloes = loadSiloesConfig(env, problems);
  const tenantMigrations = loadTenantMigrationsConfig(env, problems);
  const fde = loadFdeConfig(env, problems);
  const adminPortal = loadAdminPortalConfig(env, problems);
  const contracts = loadContractsConfig(env, problems);

  if (!service || !cell || !http || !postgres || !redis || !bus || !telemetry || !security || !gateway || !executorBounds || !globalTier) {
    throw new ConfigError(problems);
  }
  const config: Config = {
    environment: service.environment, service: service.service, hosted: service.hosted, release: service.release, cell, http, postgres,
    redis, bus, kms, objectStorage, bigQuery, model, payments, webSearch, compile, conformance, telemetry, security, gateway, globalTier, executorBounds, limits: LIMITS,
    notify, maintenance, catalogue,
    // When undefined their problems are listed and the load is refused below.
    scheduler: scheduler ?? { tickMs: 15_000, batch: 50, minIntervalMinutes: 15, concurrency: 4 },
    files: files ?? {
      maxExportBytes: 0, exportRetentionDays: undefined, sweepSeconds: 3_600, mapTilesKey: 'basemap.pmtiles', mapTilesAttribution: '© OpenStreetMap contributors · Protomaps',
    },
    sso: sso ?? { flowSeconds: 600, webauthnRpName: 'Silo', directoryRetrySeconds: 300 },
    bigqueryJobs: bigqueryJobs ?? {
      importMaxRows: 10_000, indexTickSeconds: 60, indexMaxResults: 100, meteringIntervalSeconds: 86_400,
      pricePerTibScanned: undefined, pricePerGibMonthStored: undefined,
    },
    warehouse: warehouse ?? {
      writerMembers: [], folderId: undefined, billingAccountId: undefined, syncIntervalSeconds: 3_600, reconcileIntervalSeconds: 86_400,
      reconcileSample: 50, batchRows: 500, accessCheckSeconds: 300,
    },
    siloes: siloes ?? {
      captureDrainSeconds: 5, purgePollSeconds: 10, retentionSweepSeconds: 86_400, importProcessSeconds: 10, importMaxFileBytes: 25 * 1024 * 1024,
      postgresPricePerGibMonth: undefined, storagePricePerGibMonth: undefined,
    },
    tenantMigrations: tenantMigrations ?? { tickSeconds: 30, exportTickSeconds: 30, exportMaxBytes: 2 * 1024 ** 3 },
    fde: fde ?? { tickSeconds: 15, providerPrice: { inputPerMillion: 0, outputPerMillion: 0 } },
    contracts: contracts ?? CONTRACTS_DEFAULTS,
    adminPortal: adminPortal ?? {
      publicHost: '0.0.0.0', publicPort: 8444, publicOrigin: undefined, tls: undefined,
      idp: {
        issuer: undefined, clientId: undefined, clientSecret: undefined, redirectUri: undefined, requiredAmr: ['hwk'], groupsClaim: 'groups',
        groupCapabilities: {}, deviceClaims: {}, allowInsecure: false,
      },
      session: { idleMinutes: 15, absoluteMinutes: 480, flowSeconds: 600 },
      rateLimits: { windowSeconds: 60, perAddress: 600, perSession: 300 }, sweepSeconds: 60,
    },
    // When undefined its problems are listed and the load is refused below.
    connect: connect ?? { egressAllowPrivate: false, egressAllowHttp: false, egressTimeoutMs: 30_000, egressMaxResponseBytes: 0, oauthFlowSeconds: 900, agentPort: 8443,
      agentFirstOrganisations: [], agentWaveSoakHours: 24 },
  };
  crossChecks(config, problems, {
    PUBSUB_EMULATOR_HOST: env['PUBSUB_EMULATOR_HOST'], STORAGE_EMULATOR_HOST: env['STORAGE_EMULATOR_HOST'],
  });
  if (problems.length > 0) throw new ConfigError(problems);
  return deepFreeze(config);
}

function crossChecks(c: Config, problems: string[], emulators: Env): void {
  const production = c.environment === 'production';
  const sovereign = c.cell.buildTarget === 'sovereign';
  const has = (capability: Capability): boolean => c.cell.capabilities.has(capability);

  if (production) {
    if (c.kms?.provider === 'local') problems.push('KMS_PROVIDER: production refuses a local key (spec 61.1)');
    if (c.kms?.provider === 'vault_transit') {
      problems.push('KMS_PROVIDER: Vault is for development only; production uses Cloud KMS or the UK HSM');
    }
    if (c.kms?.provider === 'gcp_kms' && sovereign) problems.push('KMS_PROVIDER: the sovereign build uses the UK HSM');
    // The sovereign cell's HSM is a Thales Luna (decision 2026-11-14; D206).
    if (c.kms?.provider === 'pkcs11_hsm' && sovereign && c.cell.kind === 'sovereign' && c.kms.pkcs11Profile !== 'luna') {
      problems.push('PKCS11_PROFILE: the sovereign cell\'s HSM is a Thales Luna (luna)');
    }
    if (c.kms?.provider === 'pkcs11_hsm' && !sovereign && c.cell.kind !== 'self_managed') {
      problems.push('KMS_PROVIDER: commercial cells use Cloud KMS');
    }
    for (const variable of ['PUBSUB_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST']) {
      if (emulators[variable] !== undefined) problems.push(`${variable}: an emulator is never used in production`);
    }
    if (c.objectStorage?.gcsEmulatorEndpoint !== undefined) {
      problems.push('GCS_EMULATOR_ENDPOINT: an emulator is never used in production');
    }
    if (c.postgres.ssl !== 'verify-full') problems.push('PG_SSL: production requires verify-full');
    for (const [instance, url] of Object.entries({ session: c.redis.session, data: c.redis.data, state: c.redis.state })) {
      if (url !== undefined && !url.startsWith('rediss://')) {
        problems.push(`REDIS_${instance.toUpperCase()}_URL: production requires TLS, a rediss:// URL (spec 8.3)`);
      }
    }
    for (const [variable, url] of [['NATS_LIVE_URL', c.bus.liveUrl], ['NATS_DURABLE_URL', c.bus.durableUrl]] as const) {
      if (url !== undefined && !url.startsWith('tls://')) problems.push(`${variable}: production requires TLS, a tls:// URL`);
    }
    if (c.http.tlsCertFile === undefined) problems.push('SERVICE_TLS_CERT_FILE: production services use mTLS (spec 7.1)');
    if (c.hosted.includes('fleet-control') && c.globalTier.fleet.role === 'control' && c.globalTier.fleet.signingKey !== undefined) {
      problems.push('FLEET_SIGNING_KEY: production signs releases in the HSM (spec 11.1); a key file is for development and tests');
    }
    if (c.connect.egressAllowPrivate) problems.push('CONNECT_EGRESS_ALLOW_PRIVATE: production never reaches private addresses from the cell');
    if (c.hosted.includes('actions') && c.connect.executionGrantKey === undefined) {
      problems.push('EXECUTION_GRANT_KEY: production actions signs every write through the Silo Agent (spec 10.4)');
    }
    if (c.hosted.includes('connect-runtime') && c.connect.agentCaCertFile !== undefined && c.connect.executionGrantPublicKey === undefined) {
      problems.push('EXECUTION_GRANT_PUBLIC_KEY: production agents check every write\'s grant (spec 10.4)');
    }
    // Discovery is compiled out of the sovereign build (spec 19): no scan key there.
    if (c.cell.buildTarget !== 'sovereign') {
      if (c.hosted.includes('discovery') && c.connect.discoveryScanKey === undefined) {
        problems.push('DISCOVERY_SCAN_KEY: production discovery signs every scan the Silo Agent runs (spec 10.5)');
      }
      if (c.hosted.includes('connect-runtime') && c.connect.agentCaCertFile !== undefined && c.connect.discoveryScanPublicKey === undefined) {
        problems.push('DISCOVERY_SCAN_PUBLIC_KEY: production agents check every scan\'s signature (spec 10.5)');
      }
      // Agents update through Fleet (spec 10.7): the cell checks each release and serves its binaries.
      if (c.hosted.includes('connect-runtime') && c.connect.agentCaCertFile !== undefined) {
        if (c.globalTier.fleet.releasePublicKey === undefined) {
          problems.push('FLEET_RELEASE_PUBLIC_KEY_FILE: production agents update through Fleet, on releases checked against the Silo release key (spec 10.7)');
        }
        if (c.objectStorage?.filesBucket === undefined) {
          problems.push('OBJECT_BUCKET_FILES: production agents download their updates from the cell\'s object storage (spec 10.7)');
        }
      }
    }
    if (c.connect.egressAllowHttp) problems.push('CONNECT_EGRESS_ALLOW_HTTP: production reaches customer systems over HTTPS only');
    if (c.connect.cellNetworks === undefined && (c.hosted.includes('credential') || c.hosted.includes('connect-registry'))) {
      problems.push('CONNECT_CELL_NETWORKS: production names the cell\'s own networks, which no private link may reach');
    }
    if (c.connect.oauthRedirectUri !== undefined && !c.connect.oauthRedirectUri.startsWith('https://')) {
      problems.push('OAUTH_REDIRECT_URI: production callbacks use https');
    }
    if (c.hosted.includes('auth') && c.security.breachListDir === undefined) {
      problems.push('BREACH_LIST_DIR: production auth checks new passwords against a breach list (spec 55.3)');
    }
    if (c.hosted.includes('gateway') && c.gateway.tls === undefined) {
      problems.push('GATEWAY_TLS_CERT_FILE: the production gateway terminates TLS (spec 7.3)');
    }
    if (c.hosted.includes('gateway') && c.gateway.publicOrigin?.startsWith('https://') === false) {
      problems.push('GATEWAY_PUBLIC_ORIGIN: production uses https');
    }
    if (c.hosted.includes('gateway') && c.gateway.uploadOrigins.some((o) => !o.startsWith('https://'))) {
      problems.push('GATEWAY_UPLOAD_ORIGINS: production uploads go over https');
    }
    if (c.hosted.includes('admin-portal')) {
      if (c.adminPortal.tls === undefined) problems.push('ADMIN_PORTAL_TLS_CERT_FILE: the production admin portal terminates TLS');
      if (c.adminPortal.publicOrigin?.startsWith('https://') === false) problems.push('ADMIN_PORTAL_PUBLIC_ORIGIN: production uses https');
      if (c.adminPortal.idp.allowInsecure) problems.push('ADMIN_PORTAL_IDP_ALLOW_INSECURE: production reaches the staff identity provider over HTTPS only');
      if (c.adminPortal.idp.issuer?.startsWith('https://') === false) problems.push('ADMIN_PORTAL_IDP_ISSUER: production uses https');
    }
    for (const [service, url] of Object.entries({ template: c.http.serviceUrlTemplate, ...c.http.serviceUrls })) {
      if (!url.startsWith('https://')) problems.push(`SERVICE_URL_${service === 'template' ? 'TEMPLATE' : service.toUpperCase()}: production uses https`);
    }
  } else if (c.kms?.provider === 'local' && !['development', 'test'].includes(c.environment)) {
    problems.push('KMS_PROVIDER: a local key is for development and tests only');
  }

  if (c.kms?.provider === 'gcp_kms' && !has('cloud_kms')) {
    problems.push('KMS_PROVIDER: Cloud KMS is not in this build; use the HSM (spec 6.5)');
  }
  if (c.objectStorage?.provider === 'gcs' && !has('gcs')) {
    problems.push('OBJECT_STORE: GCS is not in this build (spec 6.5)');
  }
  if (c.bigQuery !== undefined && !has('bigquery')) {
    problems.push('BIGQUERY_PROJECT_ID: BigQuery is not in this build (spec 6.5)');
  }
  // Billing is compiled out of the sovereign cell (spec 7); its entitlements come from a staff path.
  if (c.hosted.includes('billing') && !has('stripe')) {
    problems.push('SILO_SERVICES: billing is not in this build; entitlements are written by a staff path (spec 7, 71.4)');
  }
  if (production && c.hosted.includes('billing') && c.payments?.apiUrl.startsWith('https://') === false) {
    problems.push('PAYMENTS_API_URL: production uses https');
  }
  if (c.bus.durable === 'pubsub' && sovereign) {
    problems.push('DURABLE_BUS: the sovereign cell uses NATS JetStream (spec 9.1)');
  }
  // Spec 13.3: in the sovereign cell staff work only from Silo-managed devices in the UK,
  // which the staff identity provider asserts as claims.
  if (c.hosted.includes('admin-portal') && sovereign && Object.keys(c.adminPortal.idp.deviceClaims).length === 0) {
    problems.push('ADMIN_PORTAL_DEVICE_CLAIMS: the sovereign admin portal requires the managed-device claims (spec 13.3)');
  }
  if (c.telemetry.otlpEndpoint !== undefined && !has('telemetry_export') && !isInCellEndpoint(c.telemetry.otlpEndpoint)) {
    problems.push('OTEL_EXPORTER_OTLP_ENDPOINT: telemetry may not leave this cell (spec 13.1)');
  }

  for (const route of c.model?.routes ?? []) {
    const where = `MODEL_ROUTES_FILE (${route.role})`;
    if (route.provider === 'vertex_ai' && !has('vertex_ai')) problems.push(`${where}: Vertex AI is not in this build (spec 6.5)`);
    if (!route.zeroRetention) problems.push(`${where}: only zero-retention endpoints are permitted (spec 62.7)`);
    if (route.provider === 'vertex_ai' && !regionInResidency(route.region, c.cell.residency)) {
      problems.push(`${where}: region ${route.region} is outside the ${c.cell.residency} residency (spec 7.8)`);
    }
  }

  const needs: Partial<Record<ServiceName, [unknown, string][]>> = {
    credential: [[c.kms, 'KMS_PROVIDER'], [c.postgres.controlUrl, 'PG_CONTROL_URL']],
    directory: [[c.postgres.directoryUrl, 'PG_DIRECTORY_URL'], [c.kms?.directoryKeyUri, 'KMS_DIRECTORY_KEY_URI']],
    // Both read the cell registry in the directory database (status: which cells the
    // page shows; fleet-control: the waves of a rollout).
    status: [[c.postgres.directoryUrl, 'PG_DIRECTORY_URL'], [c.globalTier.status.publishDir, 'STATUS_PUBLISH_DIR']],
    // The global tier's reads the cell registry; a cell's Fleet agent checks what it pulls and puts binaries in object storage.
    'fleet-control': c.globalTier.fleet.role === 'cell_agent'
      ? [[c.globalTier.fleet.releasePublicKey, 'FLEET_RELEASE_PUBLIC_KEY_FILE'], [c.objectStorage?.filesBucket, 'OBJECT_BUCKET_FILES']]
      : [[c.postgres.directoryUrl, 'PG_DIRECTORY_URL'], [c.globalTier.fleet.artefactDir, 'FLEET_ARTEFACT_DIR'],
        [c.globalTier.fleet.signingKey, 'FLEET_SIGNING_KEY']],
    'model-gateway': [[c.model, 'MODEL_ROUTES_FILE'], [c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    metering: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL'], [c.bus.durable, 'DURABLE_BUS']],
    billing: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL'],
      [c.payments?.apiKey, 'PAYMENTS_API_KEY'], [c.payments?.webhookSecret, 'PAYMENTS_WEBHOOK_SECRET']],
    gateway: [[c.gateway.publicOrigin, 'GATEWAY_PUBLIC_ORIGIN'], [c.redis.data, 'REDIS_DATA_URL'], [c.bus.liveUrl, 'NATS_LIVE_URL'],
      [c.security.identifierHashKey, 'IDENTIFIER_HASH_KEY']],
    policy: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.session, 'REDIS_SESSION_URL']],
    'connect-registry': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    ontology: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    compile: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    planner: [[c.postgres.controlUrl, 'PG_CONTROL_URL']],
    executor: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    resolution: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    workspace: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    ask: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    'canvas-layout': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL'], [c.redis.state, 'REDIS_STATE_URL']],
    studio: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    lineage: [[c.postgres.controlUrl, 'PG_CONTROL_URL']],
    search: [[c.postgres.controlUrl, 'PG_CONTROL_URL']],
    recognition: [[c.postgres.controlUrl, 'PG_CONTROL_URL']],
    simulation: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    'connect-runtime': [[c.postgres.controlUrl, 'PG_CONTROL_URL']],
    'change-stream': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.state, 'REDIS_STATE_URL'], [c.redis.data, 'REDIS_DATA_URL'],
      [c.bus.liveUrl, 'NATS_LIVE_URL']],
    'state-plane': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.state, 'REDIS_STATE_URL'], [c.bus.liveUrl, 'NATS_LIVE_URL']],
    'pushdown-compiler': [[c.postgres.controlUrl, 'PG_CONTROL_URL']],
    conformance: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    'connector-maintenance': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    discovery: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    // The Warehouse (spec 69): Silo's own BigQuery, through infra/bigquery.infra.ts.
    'warehouse-provisioner': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL'],
      [c.bigQuery?.projectId, 'BIGQUERY_PROJECT_ID']],
    'warehouse-schema': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.bigQuery?.projectId, 'BIGQUERY_PROJECT_ID']],
    'warehouse-sync': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.bigQuery?.projectId, 'BIGQUERY_PROJECT_ID']],
    'warehouse-reconcile': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.bigQuery?.projectId, 'BIGQUERY_PROJECT_ID']],
    'warehouse-access': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.bigQuery?.projectId, 'BIGQUERY_PROJECT_ID']],
    // Siloes (spec 67, 68): redis-data holds the capture queue and idempotency keys; Import files live in object storage.
    'siloes-capture': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL'],
      [c.siloes.postgresPricePerGibMonth, 'SILOES_POSTGRES_PRICE_PER_GIB_MONTH']],
    'siloes-import': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL'], [c.objectStorage?.siloesBucket, 'OBJECT_BUCKET_SILOES'],
      [c.siloes.storagePricePerGibMonth, 'SILOES_STORAGE_PRICE_PER_GIB_MONTH']],
    // Silo's own BigQuery for Import rows and the Object Index (spec 68.6, 69.6), and its metering (74.1).
    'import-loader': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL'], [c.bigQuery?.projectId, 'BIGQUERY_PROJECT_ID']],
    'index-builder': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL'], [c.bigQuery?.projectId, 'BIGQUERY_PROJECT_ID']],
    'bigquery-metering': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.bigQuery?.projectId, 'BIGQUERY_PROJECT_ID'],
      [c.bigqueryJobs.pricePerTibScanned, 'BIGQUERY_PRICE_PER_TIB_SCANNED'], [c.bigqueryJobs.pricePerGibMonthStored, 'BIGQUERY_PRICE_PER_GIB_MONTH_STORED']],
    'schema-inference': [[c.postgres.controlUrl, 'PG_CONTROL_URL']],
    'visual-builder': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    'connector-builder': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    actions: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    approvals: [[c.postgres.controlUrl, 'PG_CONTROL_URL']],
    revert: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    catalogue: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL'], [c.catalogue?.databaseUrl, 'CATALOGUE_DATABASE_URL']],
    oauth: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL'], [c.connect.oauthRedirectUri, 'OAUTH_REDIRECT_URI']],
    // The staff console (spec 13): break-glass sessions and operators in the control plane;
    // staff sessions in redis-session; sign-in flows and rate limits in redis-data.
    'admin-portal': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.session, 'REDIS_SESSION_URL'], [c.redis.data, 'REDIS_DATA_URL'],
      [c.security.identifierHashKey, 'IDENTIFIER_HASH_KEY'], [c.adminPortal.publicOrigin, 'ADMIN_PORTAL_PUBLIC_ORIGIN'],
      [c.adminPortal.idp.issuer, 'ADMIN_PORTAL_IDP_ISSUER'], [c.adminPortal.idp.clientId, 'ADMIN_PORTAL_IDP_CLIENT_ID'],
      [c.adminPortal.idp.clientSecret, 'ADMIN_PORTAL_IDP_CLIENT_SECRET']],
    'outbox-relay': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.bus.durable, 'DURABLE_BUS']],
    audit: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.bus.durable, 'DURABLE_BUS']],
    notify: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.notify?.smtp.host, 'SMTP_HOST'], [c.notify?.linkBaseUrl, 'NOTIFY_LINK_BASE_URL']],
    // redis-data: idempotency keys of the keyed operations.
    scheduler: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    files: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL'], [c.objectStorage?.filesBucket, 'OBJECT_BUCKET_FILES']],
    render: [[c.redis.data, 'REDIS_DATA_URL']],
    maintenance: [[c.maintenance?.databaseUrl, 'MAINTENANCE_DATABASE_URL']],
    // Tenant migrations (spec 6.4): the export reads as the application role; the load and
    // the purge need the platform workers' migration login; bundles and receipts pass
    // through object-backup; an organisation's files travel from object-files. A cell with
    // no directory (SERVICE_URL_DIRECTORY unset, as a self-managed install may be) starts,
    // and refuses to move an organisation.
    'tenant-migrations': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.maintenance?.databaseUrl, 'MAINTENANCE_DATABASE_URL'],
      [c.objectStorage?.backupBucket, 'OBJECT_BUCKET_BACKUP'], [c.objectStorage?.filesBucket, 'OBJECT_BUCKET_FILES']],
    // The AI FDE's orchestrator (spec 49): its engagements' tables, and services as its principals.
    'fde-orchestrator': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.data, 'REDIS_DATA_URL']],
    // The organisation export (spec 2.6): written to object-files.
    'org-export': [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.objectStorage?.filesBucket, 'OBJECT_BUCKET_FILES']],
    auth: [[c.postgres.controlUrl, 'PG_CONTROL_URL'], [c.redis.session, 'REDIS_SESSION_URL'],
      [c.redis.data, 'REDIS_DATA_URL'], [c.security.identifierHashKey, 'IDENTIFIER_HASH_KEY']],
  };
  // The catalogue's migration login stays in the catalogue's own process.
  if (c.catalogue?.databaseUrl !== undefined && c.hosted.some((s) => s !== 'catalogue')) {
    problems.push(`CATALOGUE_DATABASE_URL: only the catalogue's process holds the migration login, not ${c.hosted.filter((s) => s !== 'catalogue').join(', ')} (spec 11.3)`);
  }
  // The migration login stays out of every request-serving pod (spec 11.3).
  if (c.maintenance?.databaseUrl !== undefined) {
    const others = c.hosted.filter((s) => !(PLATFORM_WORKERS as readonly string[]).includes(s));
    if (others.length > 0) {
      problems.push(`MAINTENANCE_DATABASE_URL: only the platform workers' process holds the migration login, not ${others.join(', ')} (spec 11.3)`);
    }
  }
  if (production && c.hosted.includes('notify')) {
    if (c.notify?.smtp.tls === 'none') problems.push('SMTP_TLS: production sends mail over TLS');
    if (c.notify?.linkBaseUrl !== undefined && !c.notify.linkBaseUrl.startsWith('https://')) {
      problems.push('NOTIFY_LINK_BASE_URL: production links use https');
    }
  }
  for (const service of c.hosted) {
    for (const [value, variable] of needs[service] ?? []) {
      if (value === undefined && !problems.includes(`${variable}: required by ${service}`)) problems.push(`${variable}: required by ${service}`);
    }
  }
}

// Vertex AI regions per residency. europe-west2 is London.
function regionInResidency(region: string, residency: CellConfig['residency']): boolean {
  if (residency === 'uk') return region === 'europe-west2';
  if (residency === 'eu') return region.startsWith('europe-') && region !== 'europe-west2';
  return region.startsWith('us-');
}

// For a section a code path cannot run without: a configuration error naming the variable.
export function required<T>(value: T | undefined, variable: string): T {
  if (value === undefined) throw new ConfigError([`${variable}: required here`]);
  return value;
}
