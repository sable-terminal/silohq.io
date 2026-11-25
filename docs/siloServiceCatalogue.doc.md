# Silo service catalogue

The services the build creates, as agreed on 1 November 2026. This list replaces the 47-service table in chapter 7 of the master specification: it splits Connect so the protocol engines and the connector builders have owners, and it splits the BigQuery work into the five jobs BigQuery does.

"A service not in this catalogue does not exist" (spec 7). The code uses these names exactly: `SILO_SERVICE`, folders, logs, metrics and mTLS identities.

62 services: 61 Node services in `app/server`, plus `silo-agent`, a static binary.

## Protocols are code; connections are data

Silo builds protocols, not connections to APIs or databases. A connection to a specific system (HubSpot, Sage, a customer's Postgres, their BigQuery) is never code. It is data: a validated manifest describing how to reach that system with one of Silo's protocols. The AI connector builder generates the manifest; the generic engine executes it. Adding a new system never requires a code change.

- **Protocol engines are code.** REST, GraphQL, SOAP, SQL, OData, SAP RFC, SFTP, email, MQTT, OPC UA and BigQuery live in `src/services/connect-runtime/protocols/<protocol>/` (files `<name>.protocol.ts`) and in the agent. Each implements the same interface: discover, read, push down, write, stream.
- **Connections are data.** No file may hold logic for a named provider. "If provider is HubSpot" belongs in the manifest. `tests/architecture/providers.test.ts` fails the build on:
  - a provider or vendor name in code, as a string or a lookup key;
  - a comparison or switch on a provider, vendor, slug or connector field. The only exception is Silo's own deployment adapters (KMS, object storage, bus, model routes), in config and infra.
- **SQL for customer systems is generated, never written by hand.** The SQL and BigQuery protocol engines generate it at run time from a plan and a manifest; the warehouse generator generates the warehouse tables.
  - **Where:** only `src/services/connect-runtime/protocols/sql/`, `src/services/connect-runtime/protocols/bigquery/` and `src/services/warehouse-schema/generator/` may build SQL.
  - **How:** only through `src/utils/sqlBuilder.util.ts`. Constant text comes from `sql` templates written in code. Every value is a bound parameter. Identifiers come from the manifest and are quoted by the dialect's quoting rule. Run-time words come from a closed keyword list.
  - **Reach:** these modules import no database driver and nothing that reaches Silo's own database. They talk to customer systems through connect-runtime connections only.
  - `tests/architecture/sql.test.ts` enforces all of this.

## How services become code

- **One folder per service in each layer:** `src/contracts/<service>/`, `src/services/<service>/`, `src/controllers/<service>/`, `src/routes/<service>/`, `src/workers/<service>/`, with files named `fileName.layer.ts` (for example `src/services/auth/login.service.ts`). This mirrors `src/models/<schema>/`.
  - A service's endpoints are contracts in `src/contracts/<service>/`, which its callers import too.
  - Its definition (needs, routes, workers) is `src/routes/<service>/index.route.ts`, listed in `src/app.ts`.
- **Names stay separate even when services share a process,** so they can be split later without changing interfaces. To start with:
  - `maintenance`, `outbox-relay` and `tenant-migrations` run as workers in one process;
  - `planner` starts inside `executor`.
- **No service holds SQL.**
  - Queries against Silo's databases live in `src/repos`, built from the specs in `src/models`; services call repos.
  - `tests/architecture/sql.test.ts` fails the build on a SQL statement, SQL built at run time, a driver import or a `.query()` call anywhere else.
  - The exceptions are the transaction mechanism in `src/infra/postgres.infra.ts` (`begin`, `set_config`, `commit`, `rollback` and the health ping, which is infrastructure, not table access) and the SQL generators for customer systems (above).
- **Modules, not deployments:**
  - The protocol engines are modules inside `connect-runtime` and `silo-agent`.
  - `bigquery-adapter` is shared code, one client used by every BigQuery service, so it lives in `src/infra`.
- **For the first design partner (build phases 1 and 2),** about 20 of these services need to exist.

## Global tier (outside every cell)

| Service | Responsibility |
|---|---|
| `directory` | Routes each login to the right cell. Holds keyed email hashes and cell IDs, never customer data. |
| `fleet-control` | Releases, channels, rollout waves and signing for every cell and agent, including air-gapped bundles. |
| `status` | Publishes component health per cell to the public status page. |

## Customer network

| Service | Responsibility |
|---|---|
| `silo-agent` | The static binary inside the customer's network. Opens an outbound tunnel, reads databases and industrial systems, runs CDC readers and authorised scans, and refuses anything unsigned. |

## Entry and identity

| Service | Responsibility |
|---|---|
| `gateway` | The HTTP and WebSocket API. TLS, rate limits, routing, and fan-out of live clone updates to browsers. |
| `auth` | Passwords, MFA, SSO, SCIM, sessions, memberships, scopes and seats. |
| `policy` | The authorisation decision point for every request. Applies roles, grants, field policies and markings, with deny winning, and caches results per policy version. |
| `admin-portal` | The Silo staff console for operations and break-glass access. Every action is visible to the customer. |

## Connect: the source layer

| Service | Responsibility |
|---|---|
| `connect-registry` | Connector catalogue entries, immutable manifest versions, trust tiers, connections, probe runs and heal proposals. |
| `connect-runtime` | The one generic engine that executes every manifest. Authentication, pagination, rate limits, retries and error classification. Runs CEL and JSONata expressions in a bounded evaluator with cost limits, no network access and no loops. Terminates agent tunnels. No per-provider code exists anywhere. |
| `oauth` | The one OAuth engine. State, token exchange, scope checks and locked refresh. |
| `credential` | The only service that can see a secret. Decrypts it inside a callback, logs the reason, and never returns plaintext. |
| `discovery` | Runs authorised network scans through the agent and turns findings into proposals. Compiled out of the sovereign cell. |
| `change-stream` | Ingests webhooks, agent CDC and polling. Verifies, normalises and deduplicates changes, then publishes them to the live bus. |

### Building connectors

| Service | Responsibility |
|---|---|
| `connector-builder` | The AI route. Turns an OpenAPI spec, GraphQL schema, WSDL, documentation page, or just a URL and key into a draft manifest: parse, probe, reconcile against the live system, propose mapping, then hand off for confirmation. Never emits a manifest it could not run. |
| `visual-builder` | The forms-based builder over the same manifest. A half-built AI connector opens here, so a failed generation is never thrown away. Includes the raw YAML view with schema checking, autocomplete and a live test panel. |
| `schema-inference` | Derives objects, fields, types, keys and relationships from live responses and database catalogues when there is no documentation, or when the documentation is wrong. Field profiles are counts only, never values. |
| `conformance` | The fixed test suite run against every connector on every route: read, pagination, filter pushdown, error classification, write-verify-undo against a test record, and change streams. Gates verified status and turns writes on. |
| `connector-maintenance` | Self-heal. The weekly re-check, and errors caught at runtime. Tells a renamed field (repairable) from a field whose meaning changed (halt). Proposes repairs, tests them in the sandbox, and forks a private copy rather than ever editing a catalogue connector. |

### Running connectors

| Service | Responsibility |
|---|---|
| `pushdown-compiler` | Translates a plan step into each protocol's native filter, sort and aggregate form, using only what the manifest declares. Anything that cannot be pushed down comes back bounded, or the step is refused. |
| `expression-evaluator` | The sandboxed CEL and JSONata runtime, shared by connectors, Functions, state rules and Action validation. Separate so it can be hardened once and fuzz-tested. |

**Protocol engines** are modules, one per protocol, each implementing the same interface (discover, read, push down, write, stream). New protocols are written by Silo, never by customers; only a genuinely unsupported protocol becomes a support ticket.

| Engine | Covers |
|---|---|
| REST | OpenAPI discovery or live probing. |
| GraphQL | Introspection, with query building from the plan. |
| SOAP | WSDL. |
| SQL | Postgres, SQL Server, Oracle, MySQL, Snowflake, BigQuery and Databricks: catalogue introspection and query generation per dialect, where pushdown matters most. For BigQuery, a dry run estimates bytes scanned before each query, and a query over the organisation's limit is refused. |
| OData | SAP S/4HANA and ECC. |
| SAP RFC/BAPI and IDoc | Through the agent only, using the NetWeaver SDK. |
| SFTP and file drop | CSV, Excel and fixed-width files. |
| Email | The fallback for systems with no API: forwarded notifications parsed into fields. |
| MQTT and OPC UA | Inside the agent: telemetry reads and allow-listed setpoint writes. |

### Catalogue

| Service | Responsibility |
|---|---|
| `catalogue` | The 300 prebuilt connectors as signed data released by Fleet, and browsing them with the organisation's own private connectors. (The marketplace of spec 16.5, community promotion, its review and the 70% share, was dropped on 2026-11-23.) |

### Connector build order (spec chapter 16)

1. Two hand-built connectors against a design partner's systems. Building them defines the manifest schema.
2. The engine, OAuth and the visual builder.
3. The AI builder, graded on whether it reproduces those hand-built manifests from the same documentation.
4. Self-heal, then discovery.

Building the AI route first would design the manifest schema against imagined systems.

## Ontology and query

| Service | Responsibility |
|---|---|
| `ontology` | Object types, properties, links, interfaces, Action types, Functions, versions, branches and proposals. |
| `resolution` | The entity graph: exact match keys, confirmed mappings, field authority and disputes. |
| `compile` | Builds the vocabulary, makes the model call, validates the plan and resolves time periods. Charges only once a plan exists. |
| `planner` | Expands object types into source objects, translates field names, chooses pushdown and splits aggregates. Starts inside `executor`. |
| `executor` | The deterministic federated engine. Pushes work down, merges, bounds results and refuses rather than truncating. |
| `search` | Federated object search, plus the Object Index adapter where that Silo is enabled. |
| `lineage` | Provenance of every value, object and Action. Propagates markings along it. |

## Clones and the operational layer

| Service | Responsibility |
|---|---|
| `state-plane` | Live object state for subscribed sets, held in memory and never written to disk. |
| `workspace` | New. Saved views, sharing, dashboards, favourites, recents, terminology skins and the Home briefing. |
| `ask` | New. Ask threads: routes questions through compile, assembles prose from the result, handles clarifications and proposes Actions or Crons. |
| `studio` | App definitions, versions, publishing and runtime bindings for Studio apps. |
| `canvas-layout` | New. Precomputes layouts for large Clone Canvas graphs and spatial plans. Results are cached, never persisted. |
| `recognition` | Detectors, associations, findings and ranking, plus personal Lenses. |
| `simulation` | The dependency graph, failure scenarios, scenario branches and staged Actions. |
| `scheduler` | Runs Crons in the organisation's time zone, on schedules and on change-stream triggers. Prevents overlapping runs and applies failure policy. |

## Write-back

| Service | Responsibility |
|---|---|
| `actions` | The mutation path: plan, prior state, diff, blast radius, execution, read-back verification, receipts and commits. Writes to a customer's BigQuery tables are ordinary write-backs. |
| `approvals` | Approval routing, thresholds, floors, two-person rules and chain expiry. Shared by Actions, purges and scans. |
| `revert` | Three-way revert per field. Builds the reverse Action, including recreating deleted records. |

## Storage (Siloes)

| Service | Responsibility |
|---|---|
| `siloes-capture` | Records changes from queries and streams, runs the retention sweep and executes purges. |
| `siloes-import` | File intake, structuring definitions and extraction, including the document carve-out. |
| `files` | Exports, uploads, folders and sharing, with frozen permissions and provenance. |
| `render` | Renders exports in a sandbox with no network access except object storage. |

## BigQuery

BigQuery does five jobs. A customer's own BigQuery is a source and write-back target through the SQL protocol engine and `actions` (above). The other four:

**The Silo-run Warehouse** (replaces `siloes-warehouse`)

| Service | Responsibility |
|---|---|
| `warehouse-provisioner` | Creates the per-organisation Google Cloud project, the London dataset and its encryption key, and grants access to service accounts only. Each step is recorded, can be retried, and leaves nothing half-built. |
| `warehouse-schema` | Turns the ontology into tables (current state, history, links, Action ledger). When the ontology changes it adds columns, versions any type change rather than rewriting history, and records every change. |
| `warehouse-sync` | Rate-limited backfill on creation, then change-stream writes and scheduled watermark queries, through the BigQuery Storage Write API with exactly-once writes and batching. |
| `warehouse-reconcile` | Compares row counts and a sample of keys against the sources on a schedule, resyncs drift, and marks stale tables so they are never shown as current. |

**Siloes Import storage and the Object Index**

| Service | Responsibility |
|---|---|
| `import-loader` | Loads extracted rows from documents and files into BigQuery. Every value keeps its extraction method and a link to its source document, page and cell. Purging a file deletes its rows. |
| `index-builder` | Keeps the searchable copy of the properties an organisation nominates, refreshed from change streams and queries. The search engine (BigQuery search, Postgres full text or OpenSearch) is an open decision. |

**Shared**

| Service | Responsibility |
|---|---|
| `bigquery-metering` | Reads job statistics and storage measurements per organisation, records provider cost, and bills Siloes at cost plus 10%, with the provider cost shown on each line. |
| `warehouse-access` | Grants and revokes direct SQL access for a customer's analysts. Refuses access to any table holding marked data. On exit, hands the project over to the customer's Google Cloud organisation, or exports Parquet. |

`bigquery-adapter`, the one client all of these use, is shared code in `src/infra`: location pinning (every dataset fixed to the cell's region), customer-managed keys per organisation, job labels per organisation, retries, quota handling and dry-run cost checks.

## AI

| Service | Responsibility |
|---|---|
| `model-gateway` | Every model call passes through here. Enforces vocabulary-only prompts, redaction, zero retention, metering and residency. |
| `fde-orchestrator` | The AI FDE. Runs engagements, agent tasks and proposal queues, and stops at human checkpoints. |

## Commercial

| Service | Responsibility |
|---|---|
| `metering` | Token and simulation charges, daily limits and Siloes byte counts. |
| `billing` | Subscriptions, contracts, entitlements, Stripe webhooks and billing status. Compiled out of the sovereign cell. |

## Platform and operations

| Service | Responsibility |
|---|---|
| `audit` | The append-only, hash-chained audit ledger. Seals partitions and publishes the daily chain head. |
| `notify` | Email, in-product items and push. Carries references only, never record values. |
| `outbox-relay` | New. Publishes each committed outbox row to the durable bus, in order, with retries and dead-lettering. |
| `maintenance` | New. Partition creation at least three months ahead, retention drops, expiry sweeps, and alerting when any falls behind. |
| `tenant-migrations` | New. Moves an organisation between cells with checksums, re-authorisation and a receipted purge of the source. |
| `org-export` | New. Runs exit exports with marking-aware omissions and a receipt. |

## Specification

Chapter 7 of the master specification is being updated to this 62-service catalogue.
