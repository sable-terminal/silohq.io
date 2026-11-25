# Silo server

The services of a Silo cell: Node.js and TypeScript, Express and Zod (spec 7.1), Postgres
through `pg` with no ORM. The database has its own README in `src/db`.

## Layers

Dependencies point one way, and `tests/architecture/layers.test.ts` fails the build if
an import goes the other way:

```
utils  <-  config  <-  infra  <-  repos  <-  services  <-  middleware  <-  controllers, workers  <-  routes  <-  app.ts, process.ts, server.ts
models (types only)  <-  schemas (Zod, typed by the models)  <-  contracts (service endpoints)  <-  infra
```

| Folder | What lives there |
|---|---|
| `src/utils/` | Pure shared logic, no I/O: crypto primitives, the envelope scheme of spec 61, Argon2id passwords, tokens, TOTP, the audit hash chain, canonical JSON, redaction, record-value markers, errors, retry, time, ids. |
| `src/config/` | One Zod-validated configuration per process, a file per concern, loaded once by `loadConfig()`. Spec constants live in `limits.config.ts` with their section numbers. |
| `src/infra/` | Adapters for what the cell runs on: Postgres pools (through PgBouncer in transaction mode) and the request transaction, the three Redis instances and their keyspace catalogue (`keyspaces.infra.ts`), both buses, key management, object storage, the typed logger, OpenTelemetry, health checks. |
| `src/middleware/` | The steps every request passes before its handler, one file per step (`<step>.middleware.ts`), chained the Express way: correlation id and log line, security headers, cross-site defences, CORS (the directory's login page only), client address, rate limits, sessions and cookies, body reading, Zod validation of requests and replies, the caller's mTLS identity and request context, permissions and staff capabilities, idempotency, the deadline, tracing, and errors. Four listeners use them: the service listener (`src/process.ts`), the public API (`controllers/gateway/edge.controller.ts`), the staff console (`controllers/admin-portal/staff.controller.ts`) and the directory's login listener. No middleware reads the database; a step that needs a decision asks a service. |
| `src/contracts/` | One contract per service endpoint (`src/contracts/<service>/<name>.contract.ts`): who may call it, the request context it needs, its idempotency, and Zod schemas for the request and response, built from the table schemas. The callee's router and the caller's client both read it, so "every body crossing a service boundary is validated by Zod on both sides" (spec 7.1). |
| `src/routes/<service>/index.route.ts` | The service's definition: what it needs (databases, Redis, buses) and, given them, its routes (each contract bound to a controller) and workers. `src/app.ts` lists the services this build can run; `src/process.ts` opens what they need and runs them; `server.ts` starts the ones `SILO_SERVICE` and `SILO_SERVICES` name. |
| `src/models/`, `src/schemas/`, `src/repos/` | One generated model, one generated Zod schema and one repo per table (see `src/db/README.md`). The schemas carry the database's column rules; endpoint and message schemas are built from them (spec 7.1: every body crossing a service boundary is validated by Zod on both sides). |

Services are the ones in `docs/siloServiceCatalogue.doc.md` (61 here, plus `silo-agent`), each with a folder per layer: `src/services/<service>/`, `src/controllers/<service>/`, `src/routes/<service>/`, `src/workers/<service>/`.

Rules the code enforces rather than documents:

- **SQL for Silo's own databases lives only in models and repos** (`tests/architecture/sql.test.ts`).
  - No service, controller, route or worker holds a SQL statement, imports the Postgres driver or calls `.query()`; they call repos.
  - The one exception is the transaction mechanism in `src/infra/postgres.infra.ts` (`begin`, `set_config`, `commit`, `rollback`, the health ping), which holds no statement on a table.
  - `src/db` (migrations, bootstrap, scripts) is SQL by nature.
- **SQL for customer systems is generated, never hand-written.**
  - Only the SQL and BigQuery protocol engines and the warehouse generator build it, through `src/utils/sqlBuilder.util.ts`: every value a bound parameter, every identifier quoted by the dialect, no raw text.
  - Those modules import no driver and nothing that reaches Silo's database.
- **Connections are data, not code** (`tests/architecture/providers.test.ts`).
  - No code names a provider or branches on a provider, vendor, slug or connector field; that belongs in the manifest.
  - The exception is Silo's own deployment adapters (KMS, object storage, bus, model providers, the payment provider, outbound HTTP), in config and infra only.

- **The process refuses to start on bad configuration**, listing every problem by variable name and never echoing a value. Production refuses a local key, Vault, any emulator, plain-text Redis, Postgres or NATS, and a missing release. Commercial cells use Cloud KMS and the sovereign build the UK HSM: a Thales Luna, reached with `PKCS11_PROFILE=luna` (its partition by token label, the partition's Crypto User, IVs generated in the HSM as Luna requires in FIPS mode; D206). The sovereign build refuses Cloud KMS, Pub/Sub, GCS, BigQuery, Vertex AI and an out-of-cell collector. Model routes must be zero-retention and inside the residency.
- **No record value reaches a log.** The logger takes only named fields typed as identifiers, counts or flags. A `RecordValue<T>` does not compile as one. Any string matching a value pattern is dropped and counted as a redaction violation. Errors are logged by category, never by message.
- **No record value reaches bus-durable.** Its schema registry refuses a schema with a field marked `recordValue()`, and both buses refuse a message that does not match its schema.
- **Every Redis key belongs to a keyspace in `src/infra/keyspaces.infra.ts`**, which fixes its instance, its Zod schema, its TTL cap and its size bound, as the design doc's keyspace tables do.
  - Keys are `<class>:{<organisation_id>}:<rest>`, where the braces are a Redis Cluster hash tag.
  - Every write sets a TTL, and a value over its bound is refused, never truncated.
  - Record values are refused outside result pages, the capture queue and live object state (spec 8.5).
  - Values are MessagePack, or Redis hashes where fields change on their own.
  - A value that fails its schema on read is a miss.
  - `cached()` fails open: a Redis problem means a fresh load, never a failed request or a stale value.
  - An instance that persists data is refused at connection, and a full one (noeviction) refuses writes as a capacity error.
- **Only the credential service opens, seals or re-wraps a secret.** This is the single mediator of spec 61.3, checked by the architecture test.
- **The credential service refuses to start if a key is missing.** `startupKeyCheck` reads the metadata of every key version that may still open a secret, and the MAC keys, and never creates a key. Keys come from Terraform only. In Vault, `vault/credential.policy.hcl` grants read on keys and update on encrypt, decrypt and hmac, so it cannot create, change or delete a key.

## The service shell

Every service runs in the same shell: `src/process.ts` (the process and its service listener), the steps in `src/middleware/`, and `src/infra/serviceClient.infra.ts` for calls out. Each request goes through these steps in order:

1. **Caller.** The caller's mTLS identity is checked against the contract's callers. Each certificate names `spiffe://<cell id>/service/<name>`, so a caller from another cell is refused, except by the global tier (directory, status, fleet-control), which every registered cell calls: there the handler is told the caller's cell (`ctx.callerCell`) and decides what it may touch. A process hosting several services carries one identity per service. Without TLS (development and tests only) the caller names itself in `x-silo-caller`, and its cell in `x-silo-caller-cell`.
2. **Context.** The context headers the contract requires (`x-silo-organisation-id`, `x-silo-membership-id`, `x-silo-service-principal-id`, `x-silo-user-id`) must be present, as lowercase UUIDs. `inTransaction` sets them with `SET LOCAL`.
3. **Validation.** Path parameters, query and body are checked against the contract. A refusal names the paths that failed, never the values.
4. **Idempotency.** For a keyed operation, the `Idempotency-Key` is claimed in redis-data with a hash of the request.
   - A retry of a finished request replays its result by reference; no value is stored in Redis.
   - A retry of a running request is told to wait.
   - A key reused for a different request is refused.
5. **Handler.** It runs under the request timeout. Past the timeout the caller gets a 504, but the work may still finish, which is why callers retry under keys.
6. **Response.** It is validated against the contract before it is sent.

The caller's client validates the request before sending and the response on arrival. It retries a GET or a keyed call when the error is retryable, sends any other call once, and turns an error response back into the `AppError` the callee raised.

On SIGTERM:
- readiness fails at once;
- after `HTTP_DRAIN_SECONDS` the listener closes, and in-flight requests get `HTTP_SHUTDOWN_TIMEOUT_MS` to finish;
- workers stop;
- connections close.

A failing worker stops the process, so the orchestrator restarts it.

## Auth and credential

- **auth** (`src/routes/auth/index.route.ts`):
  - **Login:** password login per organisation, with lockout and rate limits. Every failure answers the same, and a decoy hash keeps timing level.
  - **Sessions:** issue, resolve, sign out.
  - **MFA:** TOTP enrolment and verification.
  - **Password reset.**
  - **Audit:** every auth event of spec 55.8 goes to the outbox in the same transaction as its change.
- **credential** (`src/routes/credential/index.route.ts`):
  - It holds the KMS and refuses to start unless every usable key version is present.
  - It seals TOTP secrets at enrolment, and checks codes by opening the factor auth sends.
  - It records each unwrap in `iam.credential_unwraps` with reason `mfa_verify`.
  - After enrolment the secret never leaves it again.
- **Session token:** `silo_ses_` followed by the organisation id, the session id and 32 random bytes. The Redis copy is keyed by the ids, so a request resolves without a database lookup; the random part is checked against the stored SHA-256.
- **Session copy lifetime:** the copy lives until the session's absolute expiry and carries the idle deadline and window. A session found idle is revoked in Postgres. If the copy vanished at the idle deadline instead, a rebuild from Postgres, which keeps no idle clock, would revive it.
- **Provisioning:** `npm run provision` registers a local cell, a key version, and a first organisation with its first person, who is its super admin, until the admin portal exists.
- **OIDC** (Entra, Google and any other provider are configuration of one flow; no provider names in code):
  - The provider's configuration and client secret are sealed together in the credential service, which runs discovery, PKCE, the code exchange and ID-token validation (openid-client) under the cell's egress rules. Auth never sees the secret.
  - ID-token signatures are always checked against the provider's published keys, even from the token endpoint (`enableNonRepudiationChecks`).
  - The flow is single-use in Redis under a hash of its state, and bound to the browser: the PKCE verifier derives from a binding value only the browser holds.
  - Linking is never by email address alone: an existing link, an invitation whose address the provider verified, the signed-in person linking their own account (after MFA), or just-in-time joining when no user in the cell has that address.
  - `sso_required` blocks password sign-in. A provider's MFA counts only when the configuration trusts its `amr` claim.
- **SAML** is SP-initiated through @node-saml, which does all signature checking. Metadata import, and several certificates at once for rollover. A verified response becomes a one-time ticket redeemed by the browser at `/sso/complete`.
- **SCIM 2.0** is served by the gateway at `/scim/v2` with bearer tokens (`silo_scim_<org>.<random>`, stored hashed). Users only; deprovisioning suspends the membership, reclaims its seat and revokes its sessions in one transaction.
- **WebAuthn** is an MFA factor (@simplewebauthn/server): single-use challenges per session, and a signature counter that must move forward (compare-and-set), so a cloned key is caught.
- **Password change** needs the current password and the breach check, and revokes every other session.
- **A person's own memberships and factors** (spec 55.4, 60.2): the memberships of the signed-in person in this cell (`iam.list_user_memberships`); switching issues a new session in the other organisation and revokes the old one (an organisation that requires SSO is reached through its own provider, never by switching; a second factor verified in the session carries over; both organisations record `membership_switched`). Factors are listed without secrets; removing a confirmed one needs a verified second factor, and the last stays while the organisation requires MFA (`mfa_factor_removed`, an event the spec does not name).
- **API clients** (spec 60.4 to 60.6): an `api_client` principal exchanges its secret at `POST /api/v1/api-clients/sessions` (a server's call: browser fetch metadata refused) for an access session of at most 15 minutes that never outlives the client (`session_issued`). It sends it as `Authorization: Bearer`; the gateway resolves it in Postgres on each request (a revoked client's session ends at once) and forwards as the service principal. A bearer reaches only routes for a complete session that name a permission or let the forwarded service decide; never a person's own records or session routes, never with a session cookie too. The cookie defences (Origin, `x-silo-csrf`) do not apply to a bearer request, which a browser cannot attach cross-site.
- **Directory:** new people are registered with the directory by their keyed email hash, computed by the credential service. A no-op without `SERVICE_URL_DIRECTORY`.

## Policy and invitations

- **policy** (`src/routes/policy/index.route.ts`) is the cell's single decision point (spec 7.7, 57).
  - It takes the organisation, membership and session as context, and a permission with an optional scope or resource.
  - It reads the session's Redis copy itself, so no caller can vouch for MFA. A session that hasn't satisfied MFA where it's due is authorised for nothing.
  - It unions the membership's live grants. Organisation-wide grants apply everywhere; a scope grant applies within that subtree, or, when no scope is named, where the membership sits.
  - The resolved grants are cached per session and policy version, so a change applies on the next request.
  - The decision runs spec 57.6 in full:
    1. a live actor: a membership with its session (and MFA where due), or a service principal that is unrevoked, unexpired and whose owner is active;
    2. the union of live grants (an organisation-wide decision, `organisationWide: true`, counts only organisation-wide grants; a principal's roles apply within its bounding scope);
    3. a principal never holds an authorising permission, nor more than its owner at the same place;
    4. a connection is reached only through a live grant (direct, by role or by scope) or by owning it;
    5. the mandatory gate: every marking on the resource satisfied, by clearances, or for a purpose marking by a purpose session named in the request and bound to this session;
    6. field policies, strictest wins (deny, then redact, then mask).
  - `resolveAccess` answers steps 3 to 5 for compile and the executor in one call: access to each connection, visibility of each type, property and field, and each field's policy. It never names the marking that failed.
  - The cached authority also holds roles, clearances and connection grants, and lives no longer than the earliest of their expiries, since expiry bumps no policy version.
- **The catalogue and roles:**
  - The 135 permissions of spec 76 are seeded by the migration.
  - Every organisation starts with Super admin, Admin, Member, Security reviewer and Billing.
  - No customer role can hold a Silo-staff permission. Organisation-wide-only and never-delegable permissions (`clearance.grant`, `purpose.define`, `marking.declassify` and the like) live only in Super admin.
- **Delegation (spec 56.7, 56.8)** is enforced by database triggers on every role assignment and revocation:
  - a grant stays within the granter's subtree;
  - no escalation;
  - only a super admin grants organisation-wide;
  - only whitelisted roles may be assigned;
  - the grant records the scope it was granted from;
  - revocation is by the issuer, an admin over that scope, or a super admin.
- **Administration** (policy, spec 55.7, 56): scope types and scopes, custom roles, role assignments and the orphan list, scope memberships, and suspension, removal and reinstatement of members (sessions revoked in the same transaction). Every change, and every refusal (`authorisation_denied`, high volume), is an audit event.
- **Governance** (policy, spec 58): connection grants (delegation and revocation enforced by database triggers, like role assignments), markings and direct markings, clearances, purpose definitions (approved by someone other than the author), eligibility and purpose sessions, field policies, and service principals (an API client's secret is shown once).
- **Declassification** (policy, spec 58.9): removing a direct marking is requested by a holder of `marking.declassify` who satisfies it, with a justification. The preview gives the markings before and after, the active members who would gain access (cleared for every other marking on the resource, not this one) and, applied downstream, the artefacts that would lose the inherited marking. Policy writes an approval chain of subject kind `declassification` (one approver other than the requester who satisfies the marking; never self-approval; approvals asks policy's `declassificationDecision`), and the final approval has approvals call `executeDeclassification`: the marking leaves the resource, and downstream each artefact that only inherited it loses it (one that still has another input carrying it keeps it). A revert puts back exactly what was removed.
- **Invitations** (auth):
  - **Issuing:** policy decides `member.invite` at the scope, and the delegation rules are checked up front, so an invitation that could never be accepted is refused when it's made.
  - **Accepting:** a new person picks a password; an existing person proves the account with their current one. The membership, role and scope are written in one transaction, under the delegation trigger, which refuses if the inviter has since lost the authority. Then the person is signed in.

## Ontology

- **The manifest** (`src/contracts/ontology/manifest.contract.ts`): `getVersionManifest`, `getManifest` (main's head, or a branch's) and `getActiveVersion` return the whole ontology of a version: object types with their contributing objects, properties and mappings, link types and routes, shared properties, interfaces and functions. Every reference is an id, lists are sorted, and the SHA-256 hash is over the canonical content. Compile, planner and executor read it; a reader answering a person applies that person's access first (`resolveAccess`).
- **Authoring** is on a branch: each keyed write commits a new immutable version, and writing the same definition again commits nothing. Mappings must name objects and fields the connection's manifest declares; a resolvable type needs match keys on every contributing object; computed properties and normalisations are type-checked CEL. A property keeps its identity across renames.
- **Proposals** merge a branch into main: the author never approves (the service and a database trigger both check), a breaking change also needs an ontology.manage approval, merge needs the branch rebased onto main's head, and a changed diff withdraws the proposal so stale approvals never carry over.
- **Derivation** proposes object and link types from a connection's declared schema, each decision with its confidence and evidence; nothing is written until a person other than the requester confirms.
- **Object sets** are saved definitions (filter, traversal, explicit, composite), checked against main; a predicate that looks like a record value is refused.
- Main is created the first time anyone touches the ontology. Reading a version walks its parent chain; a snapshot table may be needed as chains grow.
- **Field profiles** (22.3): derivation profiles each object first, through connect-runtime's `profileObject`, which reads up to 10,000 rows of values as the source sent them and returns counts only (rows, distinct, null, empty, shortest and longest text, values that read as the declared type). A distinct count is given only when every row was examined, never estimated. Profiles are kept in `ontology.field_profiles` (`field_profiled`), and derivation reads them: an identifier confirmed unique or flagged, a title ranked by distinctness when no field is named for one, a field whose values mostly do not read as its type flagged. A source that cannot be profiled leaves the declared schema as the evidence. `POST /v1/ontology/connections/:connectionId/profiles` profiles again; `GET` lists the latest.
- **Deprecation and rollback** (25.7, 25.8). Every version entry says where its element stands: active, deprecated (with its replacement and earliest retirement), or retired.
  - Deprecation (`ontology.manage`, by a person) names an active replacement of the same kind, where one exists, and a retirement date at least 30 days ahead. It is a new main version. The element stays usable, and a compile that uses it returns a notice naming the replacement.
  - Retirement, from that date, is a new main version without the element. Earlier versions, which lineage references, keep it; nothing is deleted.
  - A rollback is a proposal (origin `rollback`): a working branch whose one commit makes its content equal a prior main version, reviewed with the ordinary impact analysis and approvals, and merged under `ontology.merge` as a new main version of kind `rollback`. Elements created since are retired; elements retired since come back, the one move the status trigger allows backwards, and only inside a rollback. Restored object types are new type versions, so their `typeVersionId` is new.


## Query: compile, planner, executor

- **The plan** (`src/contracts/planner/plan.contract.ts`, `QueryPlan`) names the ontology only by id and is bound to one ontology version, so a later merge never changes what a stored plan means. Nodes (object types with filters and at most one period), hops along link routes (a tree, at most 4), select, aggregate, sort and limit. Values never live in a plan: they travel as `planParameters`, and stored plans hold placeholders.
- **compile** (spec 26): vocabulary (only what the person may see), the model call through model-gateway, schema and reference checks (refused, never repaired; one re-prompt with no data), the planner's bounds, the plan kept, the charge (keyed), then execution. A retried question replays its outcome with no second model call or charge. `compilePlan` takes a structured plan and is never metered.
- **planner and executor** (spec 27): access is re-resolved at run time through `resolveAccess`; filters are pushed to each source where the pushdown compiler says it can apply them, and applied locally only where that is exact (equality, nulls, ranges on numbers and times), otherwise refused naming the property. Every bound refuses rather than truncates. Results are cached per actor in redis-data (a hit is never metered), and concurrent plans per organisation are capped.
- **Merging across systems** goes through resolution's `resolveRecords`; if resolution cannot be reached, the plan is refused (`query.resolution_unavailable`), never merged by a rule of the executor's own, which would mint ids the entity graph does not know. Answers carry each property's state (declared, agreed, disputed, unchecked) and say when access reduced them. Multi-source types are read whole within their per-source bound and filtered after resolution.
- **Bound values** of a stored plan are sealed under the organisation data key in `ontology.plan_bindings`, under the id of what holds the plan (an ask turn, a saved view), so a stored plan replays exactly. Cached results carry the change epochs of every source they read; a moved epoch is a miss.
- **Field policies:** masked values show at most their last four characters, redacted values nothing, and neither can be filtered, sorted, grouped or measured; a denied property is absent from the vocabulary.

- **Partial aggregate pushdown** (spec 27.7): for a single-source type whose filters the source applies in full, with every measure splittable (sum, count, average, minimum, maximum over numeric properties shown plainly; a distinct count never is), the planner asks the pushdown compiler whether the source computes the aggregate natively. If so the executor reads one aggregated step: per group the rows, each measure's column and its count of values, and combines them (an average as the sum over the count). The answer's `aggregateForm` is `partial_pushdown` and `aggregate_partial_pushdown_used` is recorded; otherwise it is `merged`. A saved set's membership test always aggregates over merged objects.
- **Computed properties** (spec 21.11, 26.7): a property whose function is a `computed_property` over the object's own properties is the reader's only when every input is shown to them plainly. The plan reads its inputs; the executor evaluates the CEL (`object`, `now`: one evaluation time per run) after merge, before filters, so it filters, sorts, groups and measures on decided values. A disputed, unchecked or empty input, or an expression that fails or passes its cost limit, gives no value (undecided). Its lineage names the fields it was computed from. Whole numbers reach CEL as integers, so a function over a decimal uses `double(...)` where it mixes in a fraction.
- **Many-to-many links** (spec 21.8): a route through a junction object is followed in two reads: the junction's pairs for the from side's keys (bounded chunks), then the to side by the keys they name. The route gives the junction's key to its source object; the key to the other side is the relationship the junction's manifest declares, read by the planner from Connect's tables under the request's row-level security. A junction declaring no such key is refused (`plan.junction_undeclared`).
- **Object sets the engine walks** (spec 21.9, 24.4, `setMembers.service.ts`): a set over an interface runs one sub-plan per implementing type the reader may see, its values named by the interface's shared properties, and the answer lists `contributingTypes`; a traversal runs the start (a type and predicate, or a saved set) along its path by each hop's route (or the link's default; several routes and no default is refused) and its members are the distinct objects at the end; union, intersection and difference combine saved sets by Silo object id, nested to a depth of five. Each is stored as one paged answer, refused past the merged-result bound, never truncated.
- **Apps of a removed member** (studio, spec 37.7): policy calls studio's `transferApps` beside workspace's `transferViews` when it removes or suspends a member; each live app goes to the same receiving admin as the views, flagged in `workspace.app_transfer_flags`, its shares suspended (`app_transferred`), and shares of others' apps to the member are revoked. The admin shares each onward (shares resume), retains it privately or archives it (shares revoked) (`app_transfer_reviewed`). Maintenance ends app shares at their expiry (`app_share_expired`).
## Resolution

- **`resolveRecords`** (`src/contracts/resolution/resolve.contract.ts`): rows from each contributing source in, Silo objects out, each property `declared`, `agreed`, `only`, `disputed` (never with a value), `empty` or `unchecked`, with coverage counts. It writes the entity graph (keyed hashes only) as it answers.
- **Runs** read each contributing object (identifier and key fields only), key and link records, retire what a complete read no longer returns, then analyse what did not resolve: deterministic rules first, the model only with key shapes and counts. A candidate rule is refused if it would merge two records of one system or break a match that exists.
- **Proposals** (rules, pair lists, splits) are confirmed by a person other than the proposer, holding `resolution.confirm` on the type and read access to every connection involved. Merges leave redirects naming the proposal.
- **Field authority** names which system wins for a property, optionally under a CEL condition over the winning row; refused when only one system maps the property.
- **Silo object ids** come from one module (`src/utils/siloObjectId.util.ts`): UUIDv5 under a fixed namespace from the organisation, the type and the record's key hashes, or, for a single-source type, from the plain SHA-256 of the source identifier, so any service derives the same id. Executor, resolution, state plane and write-back are tested to agree.

## Search and lineage

- **lineage** (spec 59): a producer writes the artefact, its lineage and its inherited markings in one transaction, in-process (`writeLineage` in `src/services/lineage/writer.service.ts`; node reference conventions in `src/contracts/lineage/lineage.contract.ts`). Compile (`ask_prompt` per stored plan), workspace (views), actions (actions and receipts), canvas-layout (canvas views), studio (app versions), recognition (findings), simulation (results) and files (exports) write it; `tests/architecture/lineage.test.ts` fails when a listed producer's write path does not. Reads are bounded (depth 32, 2,000 nodes by default) and refuse past either. A node whose markings the reader lacks is counted as withheld, never named, and the walk does not pass through it. `lineage.read` must be held organisation-wide.
- **Marking propagation** (spec 58.6): a marking applied upstream is requested by trigger in the same transaction, then walked downstream in bounded batches by a worker (two passes, 60 seconds apart, depth 256). Until it completes, policy counts it at read time, so there is no window of exposure.
- **search**: the vocabulary a person may see, ranked from exact match to near spelling (trigrams), and objects through each source that can filter its title natively; a source not searched is named with its reason. Never metered.

## Workspace and ask

- **workspace** (spec 33, 37): saved views (a plan by reference, replayed under the viewer's own access), dashboards, favourites, preferences and terminology skins. Sharing nests view, run and copy; a scope share reaches the subtree; the effective policy is the strictest of the organisation's and every scope above the owner, applied when a share is written and at every access. A removed member's views go to the nearest admin above them for review.
- **ask** (spec 36): threads of turns, each a compile and an execution through the real contracts, keeping references, the sealed question and the tokens charged. A retried question never compiles or charges twice. A follow-up marked as a rephrase falls inside metering's rephrase window; answering a clarification sends the chosen option and the options passed over.

## Write-back: actions, approvals, revert

- **Action types** (spec 42) bind to an ontology version; a published version is checked against it, its connections' declared write operations, CEL validations and its rules (`set_property`, `clear_property`, `create_object`, `delete_object`, `add_link`, `remove_link`, `invoke_custom`).
- **Mutations** (spec 43): intent, resolve, the policy gate, plan, prior state and a sealed, hashed preview. Execution re-reads every target first (a stale one refuses), writes connection by connection, verifies each field by read-back (spec 45), and writes the receipt (hashed, sealed, hash in the audit ledger), commits per object and `control.action` messages in one transaction.
- **The blast radius** (43.7): before the preview, the records that reference what a mutation deletes, or whose key an update changes, by the manifest's declared foreign keys and the ontology's same-connection link routes. A reference the source cascades (`onDelete: cascade` on the manifest's relationship) is a cascading delete, and the walk goes on from it. Others are dependent records, re-pointable on revert where their key is writable. The walk is bounded (2 hops, 100 records per relationship, 1,000 in all) and says at which hop it stopped. It stores references only (`action.blast_radius_results`) and raises `blast_radius_computed`.
- **The canary** (43.9, 45.4): at 10,000 rows or more the preview says so, and execution writes and verifies a sample first (100, taken in turn from every connection). The mutation then waits in `canary` until the executor, or the final approver where execution is not separated, confirms the remainder, stating how many diverged and failed sample records they saw, which must match. The receipt covers both phases. A canary not confirmed before its chain expires finishes as `expired`, with a receipt for its sample alone; the sample is not undone, and a governed revert is offered as for partial failure.
- **An interrupted execution** (a process that died mid-write) is recovered by the actions sweep, never run again (45.3: nothing is retried blindly). Each target is read back: an update that reads as intended is verified (diverged where fields differ), one that reads as before was not applied, a delete is applied when the record is gone, and a create whose identifier never came back is failed. A canary's sample then waits for confirmation as usual; anything else finishes with its receipt, and what was not written can be proposed again. Executions this process is still running, or started less than 15 minutes ago, are left alone.
- **Side effects** (42.6): after every connection is verified, and only where a write landed, a notification goes to the people the Action type names (the proposer by default; approvers; the executor), in the product, with the receipt as its only content (`workspace.notifications`, kind `action_completed`, once per receipt and person). The receipt lists what fired, and `side_effect_fired` or `side_effect_failed` is raised for each; a failure never changes the write's outcome. A webhook side effect makes the type external; it is recorded as not fired until chapter 48's signed delivery exists.
- **Custom actions** (42.5): a REST manifest declares them per object (`writes.custom`: the request, an optional JSONata body over the inputs, the fields it changes, and `compensatedBy`, the custom action that undoes it). An Action type invokes one as its only rule (`invoke_custom`, its inputs from parameters or CEL). The declared fields are the prior state, and they are read back after it runs: a field with an expected value (a compensating action's) is verified against it, any other is verified when it reads changed and diverged when it reads as before. A custom action is sent once, never retried; the preview shows its inputs and each field it changes, proposed unknown. A recovered execution whose declared fields all read as before was not applied.
- **Link rules** (42.4): `add_link` and `remove_link` name a link type of the target type. On each permitted connection the link must be a foreign key the target's source object holds, referencing the other end's identifier; it is then written as an update of that field (`add_link` takes the linked record from an `object_reference` parameter of the other end's type; `remove_link` needs the key nullable). A key the other end holds is written from that end's type, and a join record's link by an Action type over the join record's type.
- **Outbound Action events** (48.3): every executed Action (reverts and partial failures included) is an `action_executed` message on bus-durable, written with its receipt: identifiers, the Action type and version, fields, outcomes per connection and object, people and times, never values (at most 200 objects; the receipt lists them all). A holder of `action.define` subscribes an HTTPS endpoint with a filter (Action types, object types, risk classes, outcomes, origins) and is shown its signing secret once; the credential service holds it (a sealed credential of purpose `action_event_secret`) and computes each signature, so notify never sees it. Notify takes each event from the bus into one delivery per admitting subscription (`action.action_event_deliveries`, once per subscription and event), and posts it through the egress with `silo-signature: v1=<HMAC-SHA256 over timestamp.body>`, `silo-timestamp` and the event id as the idempotency key. Anything but a 2xx is retried with backoff (30 seconds doubling, at most an hour) for 24 hours; then the delivery and its subscription are dead-lettered and the owner is told in the product. A paused subscription is offered nothing new and its pending deliveries wait.
- **The Action ledger** (48.2, 66.4): a Warehouse's ledger is switched on by a holder of `silo.enable` who acknowledges its disclosure, with references only or with values (the Silo records which); `ledger_enabled` records who chose it and whether values were included. Switching it on creates `action_ledger` in the Warehouse's dataset. After each receipt the actions service sends one row per object (ledger id from the receipt and target, so a repeat adds nothing; the receipt's inherited markings in `_marking_ids`; values only when chosen), and warehouse-sync merges them in and raises `ledger_row_written`. The receipt remains the record.
- **approvals** (spec 44): policies by level, row threshold, risk class and marking, raised by floors; a decision quotes the diff hash and needs `mutation.approve` at each connection's owning scope and read access to every field the diff writes. One rejection rejects the chain.
  - The markings a mutation touches are those its receipt inherits (58.6): on the Action type, the object type, the properties it writes (the proposal records them; a delete touches every property mapped on the connection) and the connections it writes through. They are read when the chain is requested and kept in its snapshot.
  - A policy with a marking condition applies only when the mutation touches one of its markings (44.3 rule 3). A `marking_holder` approver must be cleared for the touched markings the condition names (clearance, or a purpose session of the request). A floor with unwaivable markings applies to whatever touches them, and nothing configures it away (44.4).
- **revert** (spec 46): three-way from the receipt; a field changed since is a conflict a person decides; creates are deleted and deletes recreated from their prior record. The Action type's revert behaviour (42.8) shapes the plan: `state_only` writes the stored state back with no conflicts; `compensating` invokes the custom action that undoes the one invoked (sent the stored prior state, and expected to leave it), then restores three-way the fields it does not declare; `not_revertible` (physical types only) is refused. A custom action reverted three-way or state-only has its fields restored by the manifest's update, and is refused where the manifest declares none.
- **The write path** in connect-runtime: REST writes from the manifest's templates and JSONata bodies; SQL INSERT, UPDATE and DELETE generated through `sqlBuilder` and run by the agent in one transaction, each update or delete changing exactly one row or the plan rolls back. Writes need `writes_enabled`, which needs a passed write-verify-undo conformance run on the current manifest.
- **Record values at rest** are sealed by the credential service under each organisation's data key (format byte, key version, nonce, ciphertext and tag; the row's binding as associated data). Organisation keys (`data`, `hmac`) share one store, created on first use and cached for five minutes.

- **Bayesian inference** (decision 2026-11-11; D71 to D75). Shared closed-form maths in `src/utils/bayes.util.ts` (Beta-Binomial posteriors and intervals, a log-normal lead-time model with a seeded predictive draw, Fellegi-Sunter match probabilities), no library.
  - Always on: AI FDE confidence bands per kind are set where the evidence is 95% sure of the acceptance rate (52.3); the canary sample is drawn at random (seeded by the mutation) and a waiting canary states a 95% upper bound on the rest's divergence or failure rate (`canaryEvidence`); recognition tuning keeps 38.5's floor, cap and direction but needs the posterior 80% sure of the majority and scales the step by the evidence; FDE ratios and Monte Carlo probabilities carry 95% credible intervals.
  - Opt-in per organisation (`PATCH /admin/inference-settings`, `org.inference.manage`), off by default: `simulation` (paths lacking observations simulated from beliefs combining stated lead times with observations, marked `inferred`, with the assumption stated on the run); `resolution` (unmatched records compared on the properties every system maps, a pair list proposed for a person to confirm, agreement rates learnt from earlier decisions); `links` (derivation proposes a link where a field's values are nearly all another object's identifiers, route origin `inferred`); `findings` (each finding carries how often its kind proved useful). Inferred matches and links are proposals; nothing merges or exists until a person confirms it.
- **Directory registration retry** (spec 55.1; D69): a person the directory did not hear about is kept and retried by auth's worker until the directory answers.
- **Cron execute authorisations** (spec 40.5, 40.6; D70): `automation_authorised` when given; an expired one returns the mutate action to propose mode; maintenance records each expiry once (`automation_authorisation_expired`).
- **Links re-pointed on revert** (spec 46.6): reverting a delete whose source gives the recreated record a new identifier re-points every dependent the delete's blast radius recorded with a writable key, in the same revert (shown in its diff as following the recreation, written after it, verified), records `action.id_remappings` and `id_remapped`, `link_repointed`, `link_not_repointed`, and names in the receipt any dependent it could not re-point. The recreated record keeps its object identity and commit log.
- **Scenario sharing** (spec 39.7): a failure scenario is shared as saved views are (the scenario arm of `workspace.view_shares`, within the sharing policy, view, run or copy); a shared scenario runs under the opener's own permissions; `listScenarios?filter=shared`, `copyScenario` under a copy share; `scenario_shared` for shares and revocations.
- **Removal and owned connections** (spec 55.7): removing a member hands each connection they own to the nearest admin above its owning scope, else a super admin (`connection_ownership_transferred`).
- **Blast radius across systems** (spec 43.7): a deleted record of a resolvable type has its links on other systems followed through its counterpart there, found by the type's match keys; the records holding the counterpart's key are reported as ontology links.
- **Lineage from the ontology** (spec 59.2): every type version on main records source field → property → type version (with the connection each field is read via), so a property inherits its fields' and connection's markings in lineage; a saved object set records what it is over.
- **AI FDE measurement** (spec 52.3, 54): band thresholds per proposal kind from the organisation's measured acceptance; time to first answer, conformance pass rate per transport, heal proposal accuracy and unconfirmed edge crossing rate from audit events; working time in the organisation's calendar time zone.
- **Canary sample per organisation** (spec 45.4; D66): `PUT /actions/settings/canary` with `mutation.policy` across the organisation sets the sample written and verified first (1 to 9,999 rows; null is the default of 100; `canary_sample_set`). The 10,000-row threshold is not a setting.
- **Notifications by email** (spec 42.6): `raiseNotification` takes `channels` (`in_app`, `email`), one item per channel; the email goes to the member's address with what the item is about and a link to it, never a value. An Action type's notification side effect names `channels: ['home', 'email']`.
- **Source-field markings** (spec 58.3, 58.4, 21.15; D67): a field is marked through its property mapping (`resource.type: 'property_mapping'`, ids from `GET /ontology/object-types/:id/mappings`), and the marking holds for that field of that connection in every type version. A reader not cleared is denied the field and every property that maps it; approval counts it among the markings a mutation touches.
- **Webhook payloads** (spec 20.4; D68): an Action type's webhook side effect may shape its body with JSONata over the executed Action (references, objects and parameters); queued deliveries are sealed to their row, and notify opens one only to post it.
- **Full updates and upserts** (spec 42.4, 42.5, 48.1): a manifest object may declare `updateFull` and `upsert` beside `create`, `update` and `delete`. An Action type's update is a partial update where the source offers one, else a full update (the whole record is sent, every field its prior state); its create is a create, else an upsert, which names its record (the rule gives the identifier a value). On SQL an upsert is `INSERT ... ON CONFLICT` (Postgres), `ON DUPLICATE KEY UPDATE` (MySQL) or `MERGE`. Revert restores through whatever the source offers. SQL updates and deletes carry their recorded prior state as a null-safe guard in the same statement, so a row changed since rolls the plan back (`write.prior_changed`).
- **Deprecation notices** (spec 25.7; D65): deprecating an ontology element tells the owner of every dependant in the dependency index (apps, saved views, object sets, Crons, scenarios, lenses) through notify (`element_deprecated`), and keeps a reminder for seven days before the retirement date, which ontology's hourly sweep sends (`element_retiring`) if the element is still deprecated with that date; retiring it first, or a rollback, cancels it. Notices are best effort and never undo the deprecation.
- **Outbound webhook side effects** (spec 20.4, 42.6; D64): a holder of `webhook.outbound.manage` at a connection's owning scope registers an HTTPS target on it (connect-registry), its HMAC-SHA256 secret generated and held by credential (purpose `outbound_webhook_secret`, a field of its own per target) and shown once; a target is declared `external` or `physical`. An Action type's webhook side effect names its target: the type is then at least external, or physical (two approvers) for a physical target. When the Action executes, actions queues one delivery in `action.webhook_deliveries` (references only; the receipt says `queued`, a delivery and not an effect); notify posts it signed (`silo-timestamp`, `silo-signature: v1=…`) with `<mutation>:<target>` as the idempotency key, retries with backoff for 24 hours, then fails it; a revoked target sends nothing more (`outbound_webhook_registered`, `_revoked`, `_delivered`, `_failed`).

## Live state: change-stream and state-plane

- **change-stream** (spec 18): a manifest's `changeStream` block declares webhooks (a CEL `verify`, a JSONata `decode`), CDC and polling per object. Webhooks arrive at the gateway (`/api/v1/hooks/changes/:organisationId/:token`) and are verified by the credential service in constant time, refusing replays; accepted changes are de-duplicated, published on bus-live where something holds the object live, and bump change epochs. A silent webhook falls back to polling.
- **state-plane** (spec 24, 30): the gateway's subscription source. A subscription resolves its object set, grants only properties visible with no field policy, snapshots through connect-runtime and then streams deltas per group (keyed by set and permission fingerprint), with the live bounds of spec 30.5 refused by name. A narrowed grant sends `projection_changed`; a revoked one ends the subscription within about a second.
- **Cache invalidation:** change epochs per connection and source object (`cep:` on redis-data) let the executor treat a cached result as stale; the executor does not read them yet.

## Clones: canvas-layout and studio

- **canvas-layout** (spec 28, 29, 31, 32): state rules (CEL over declared inputs, confirmed by a person; an input that is hidden or null gives `unknown`, never a guess), staleness thresholds (defaults from the source's cadence; loosening is audited), clone layouts, render records, layouts precomputed server side (positions kept 24 hours in redis-state), canvas views (re-resolved as the opener, shared under workspace's policy), and the estate map with snapshots and comparisons. Anything withheld is absent, with a statement.
- **studio** (spec 35): apps from a closed widget catalogue and closed effects, validated against the bound ontology version on every save, submit and approval. The author never approves; rollback goes through review. Opening re-resolves as the viewer: withheld columns are dropped, a widget needing a withheld field is unavailable. Edit is granted to named members only (open decision 35.13); publication to a scope follows the sharing policy.
  - `previewApp` validates a definition, a template's, or a layout's starting point and renders it for the caller, saving nothing: the AI FDE's check before it proposes, and the confirming person's preview under their own permissions.
  - Object view layouts (34.6): every type has a generated default (the primary first, then declaration order; a link group per link type and direction; then timeline, actions, findings, scenarios, Ask). A custom layout is an app of kind `object_view_layout`: one page bound to the selection variable `object` of its type. Approved, it is the type's one active layout (`workspace.object_view_layouts`); a later one supersedes it; archiving it brings the default back. `getObjectViewLayout` re-checks an active layout against main when the ontology has moved: one that no longer validates is marked invalid (`object_view_layout_invalidated`, Studio as the actor), its author is told (notification kind `object_view_layout_invalidated`), and the generated default is returned. A custom layout renders under the viewer's own permissions.
  - Only fde-orchestrator, applying a person's decision, may mark an app or a layout as generated by the AI FDE.

- **The 3D asset view** (29.5; D228): a model registered from an Import Silo file (checked as a self-contained glTF 2.0 binary, D208) is read by the browser in 4 MiB parts (`GET /api/v1/canvas/asset-models/:id/model?offset=`, clone.view, the model's markings checked at every part) and drawn with three.js; `POST /canvas/asset-models/:id/placements` names the node each object stands on (its own anchor, then the first predicate it matches). A view keeps its model under the 3D layout only; a purged one falls back to the next layout, saying so. Compressed meshes and textures (Draco, meshopt, KTX2) are decoded in the browser by three's own decoders, which the web build copies under `/three/`; pages therefore allow `'wasm-unsafe-eval'` (WebAssembly compiled, never JavaScript evaluated). An export that draws a site plan or a model carries that plan's or model's own markings with the file (files `carriedMarkingIds`). At registration (D249, `canvas-layout/meshLevels.service.ts`) the model is compressed with EXT_meshopt_compression where it has no mesh compression (and only where that makes it smaller) and simplified to up to two coarser levels (a half and about a seventh of its triangles, meshoptimizer), every node kept; each level is stored beside the model (`<id>.lod1`, `<id>.lod2`) and read with `?level=`. The browser draws the coarsest first, swaps in the full model once read, and a coarser one when the model is small on screen. Libraries: `@gltf-transform/core` and `@gltf-transform/extensions` (reading and writing glTF), `meshoptimizer` (simplifying and compressing); `@gltf-transform/functions` is not used, as it brings the native `sharp` image library. A Draco-compressed model is served as it came.

- **App branching and release** (beyond the spec; D229 to D231): branches of an app beside main, each with its own draft (optionally built on an ontology branch), merged into main's next draft by a structural three-way merge whose conflicts a person decides (`studio/appMerge.service.ts`, `branches.service.ts`); a version approved in stages reaches scopes one stage at a time, everyone else keeping what they open, and a release can be rolled back (`releases.service.ts`); an app moves to another organisation or cell as a package exported into Files and imported with its ontology references found by API name (`appPackage.service.ts`, `packages.service.ts`).

- **Workbooks** (beyond the spec; D232): spreadsheets over live object sets in the workspace service (`workspace/workbooks.service.ts`): typed cells and formulas in a closed language shared with the browser (`workspace/formula.service.ts`), live ranges read for whoever opens them and never stored, shares to open or copy, exports of computed values into Files (`render/xlsx.service.ts renderWorkbookXlsx`).
- **Reports** (beyond the spec; D233): documents of headings, text and live blocks (an object set's objects; a workbook's computed figures) read for whoever opens them (`workspace/reports.service.ts`), shared like workbooks through one module (`documentShares.service.ts`), exported into Files as a PDF (`render/pdf.service.ts renderReportPdf`).
- **Process mining** (beyond the spec; D234): saved analyses over an object set of events or a state property's captured history (`workspace/processes.service.ts`), mined by a pure module (`processMining.service.ts`) for whoever opens them.
- **Data pipelines** (beyond the spec; D235): object sets transformed by closed steps (`workspace/pipelineEngine.service.ts`, CEL through the expression evaluator) and written as CSV into an Import Silo source as the person (`pipelines.service.ts`); a run is refused unless the Silo carries every marking its inputs read. Scheduled (D241): `workspace.pipeline_schedules`, each with its own automation principal (policy grants it its inputs' connections and silo.import, bounded by the owner), run by the workspace's due sweep (`workers/workspace/pipelineDue.worker.ts`), the owner told of failures and the schedule paused after repeated ones.
- **AI agents** (beyond the spec; D236): a brief, object types and allowed Ask tools in the workspace service (`workspace/aiAgents.service.ts`), shared through `documentShares.service.ts`; the name and brief screened for value patterns when saved. An Ask thread made with one (`ask_threads.ai_agent_id`) re-checks it at every question and sends it to compile, which narrows the vocabulary to its types (`withinAiAgent`), sends the brief as documentation, and refuses a change or Cron its tools do not allow before charging. Named `ai_agent` because `agent` is the Silo Agent.
- **Media sets** (beyond the spec; D237): images, video, audio and PDFs kept in an Import Silo as Files uploads (`files/media.service.ts`), each with the facts its bytes give, read from its two ends by a pure parser (`siloes-import/mediaFacts.service.ts`); stored with `media: true` (content class `media`, what is not media refused first) and opened through `openMediaUpload` (only media files, only for files, the Silo's markings checked, not silo.import). Linked to objects by Silo id (D238, `files/mediaLinks.service.ts`): by a person on the object's page, or by the set's filename template (`{key}` and up to two `*`, never a regular expression) matched against a property through the executor's `runPlan` as the person.
- **Notebooks** (beyond the spec; D239): cells in the workspace service (`workspace/notebooks.service.ts`) computed in order for the caller, nothing stored: objects (as workbook live ranges), compiled questions (plan and binding kept, never the question; run unmetered), transforms (the pipeline engine), statistics and charts (`notebookEngine.service.ts`, pure). Shared through `documentShares.service.ts`; exported as a spreadsheet.
- **Machine learning models** (beyond the spec; D240): regression and classification over a saved set's properties (`workspace/mlModels.service.ts`), the arithmetic pure and library-free (`mlEngine.service.ts`: encoder, ridge, multinomial logistic, metrics, importance, drift). Versions keep headline figures in the clear and the fitted model sealed through the credential service; a version opens and predicts only for someone holding its markings; predictions are read as the caller and never stored.

## Recognition and simulation

- **recognition** (spec 38): detectors run over a type's population through the executor, as the runner: `disagreement`, `missing_value`, `outlier`, `duplicate_value` and `unmatched_record` (the last four are provisional names for federated detectors the spec counts but does not name). Findings hold Silo object ids and statistics, never values. Thresholds are derived from the population, then tuned only by organisation dispositions (at least five, majority direction, at most a quarter per move, audited). History detectors return `history_unavailable` until Siloes Capture exists. Ranking uses the model-gateway recognition role with the reader's own vocabulary.
- **simulation** (spec 39): a dependency graph derived from link types and confirmed edge by edge; deterministic runs walk it through the executor (hard edges fail, soft edges delay by lead time less buffer, a buffer absorbs), stopping at unconfirmed edges, at types the runner is not cleared for and at the fan-out bound. Probabilistic runs sample each observed edge's lead times (Monte Carlo, independence stated); a path with a stated edge is computed deterministically and says so. Runs are charged as `simulation` or `simulation_rerun` under the request's key.
  - **Scenario branches** (39.8): Actions staged in a branch, never executed. Staging asks actions to `checkMutation` (intent, resolve, the policy gate and the prior state of the touched fields, in check mode: a refusal is answered, never recorded) and is charged as a compile; the touched values are kept as the branch base, sealed under the organisation's key, with the parameters. Opening checks each staged Action three ways (clean, conflicted, already applied, orphaned; who changed a conflicted property is named where Silo wrote it, through `listRecentWrites`), applies its effect and walks the graph as a run of the branch, charged as a re-run. A person keeps staged, takes current, or re-stages each conflict. Two branches of a scenario compare. Promotion proposes each clean staged Action through `proposeMutation` with origin `scenario_promotion` (prior state and preview read afresh, the bulk guardrails counted across everything promoted together, the branch simulation attached by reference); it never approves, and approvals refuses to approve one at request. A closed branch's bases purge when its retention ends (maintenance). The executor and connect-runtime refuse any request naming a branch (`branch.middleware.ts`), and `tests/architecture/reachability.test.ts` checks that no path from simulation reaches execution.

## Scheduler, files and render

- **scheduler** (spec 40): Crons run saved views as their own automation service principal, which reads the Cron's recorded connections and never more than its owner. Standard five-field schedules in the organisation's time zone (a skipped daylight-saving hour never fires, a repeated one fires once), a 15-minute minimum interval, missed runs counted and never backfilled, overlapping runs skipped. Conditions on results, change and figures (figures sealed, change compared by keyed hash); actions notify, report (render to Files), escalate and mutate. An inactive owner, suspended billing or a halted connection pauses the Cron.
  - **Change triggers** (40.2): a Cron over a saved object set (filter or explicit, on a type) may watch it instead of running on a schedule: the properties watched and a window of at least 60 seconds. Every source object of the type must have a change stream (else it is refused, with a schedule offered); the Cron's streams are recorded in `connect.change_stream_subscriptions`. The scheduler's watch (deployed with redis-state and bus-live) keeps change interest registered so the streams deliver, takes the deltas as one queue group, and makes the Cron due a window after the first change that touches a watched field or brings an object in or out; later ones coalesce. The run evaluates current state, with trigger `change`. Changes during a run become one pending follow-up. A stream gone stale is reported once (`automation_change_gap`), never backfilled, and current state is evaluated once when it resumes. A service principal reads an object set as its owner.
  - **Mutate** (40.5, 43.11): attaching one needs `mutation.propose` (execute also `automation.execute`); the person attaching it is recorded as its authorising member (`automation.automation_authorisations`, with the connections it names). The Action type must be confirmed, over the question's own single-source type (its objects named by their key, which the question selects), and need no parameter value (a Cron stores none). Execute names a maximum row count, the properties, the connections and an expiry, within what the type may write and reach, and is never available for a physical type.
  - At a run, the Cron's principal proposes the type over every object the question returned (a partial answer fails the action, so a Cron never acts on part of what it found), on its authorising member's behalf; policy grants the principal `mutation.propose` and write access on the authorisation's connections while it is live, still bounded by the owner. In execute mode the mutation runs with no one present only inside every bound (data risk, not the generic edit, under 100 rows and no more than its maximum, property writes only, within its properties and connections); the authorisation is its approval (a chain with no steps), and the Cron's principal executes it. Anything else falls back to the approvals queue, where the authorising member stands as requester; 10,000 rows or more in execute mode is refused. The receipt names who authorised the Cron. A failed action stops later mutate actions, never later notifications.
- **files** (spec 41): exports with their lineage, inherited markings and frozen permissions written in one transaction; shares to members, scopes or the organisation; every open re-checks the share and the markings now. Downloads are base64 in JSON, capped at 5 MiB, because the object store is never exposed to the browser and access is checked at every open. Uploads come with Siloes.
- **render**: exports re-run as the caller, as CSV, a spreadsheet (`.xlsx`) or a PDF, each printing the same head (markings, computed at, coverage, what this reader may not see) and table (`services/render/document.service.ts`), masked and redacted columns stated. CSV quotes as RFC 4180 asks and escapes formula injection; the workbook writes text as inline strings, which a spreadsheet never evaluates, and prints the markings in every page header; the PDF (A4 landscape, standard Helvetica, nothing embedded) repeats the table header and prints the markings and page number on every page. The workbook and PDF are written by Silo's own code with no library, so rendering reads nothing but the answer. Cron reports take any of the three.
- **The base map** (29.3; D227): a Protomaps PMTiles archive of vector tiles in the `tiles` bucket (`OBJECT_BUCKET_TILES`), under `MAP_TILES_KEY` (default `basemap.pmtiles`), with its data's attribution in `MAP_TILES_ATTRIBUTION` (default `© OpenStreetMap contributors · Protomaps`). files reads it by byte ranges through whichever store the cell uses and serves one tile at a time through the gateway (`GET /api/v1/map-tiles` for its zooms and bounds, `GET /api/v1/map-tiles/:z/:x/:y` for a tile, both `clone.view`), so no tile provider sees a viewer and an air-gapped cell needs nothing outside it. The archive's header and directories are cached per process, so a new archive goes under a new key (and a restart), never over the old one. To make one: take a Protomaps basemap build (from OpenStreetMap; Ordnance Survey data built to the same layers also works) and cut the area the cell serves with `pmtiles extract <build> uk.pmtiles --bbox=-8.7,49.8,1.8,60.9`; upload it to the tiles bucket. Without an archive, a map layout says "base map unavailable" and draws a coordinate grid.
- **Canvas export** (29.10): canvas-layout draws a canvas view for its exporter (`file.export`), under their own access: the set run now, each object's state from the active rule, the layout computed as on screen, and a PDF in Files printed with when it was computed, the state age of each source (from the answer's read times), its markings, its flags and the count not placed. A list prints as a table. `files.file_provenance` names the canvas view.

## Building and maintaining connectors

- **schema-inference** (spec 16): from probe reads (records, fields to depth 3, types, identifiers, relationships by counted overlap, paging hints) or a SQL catalogue through the agent (`information_schema`, no dialect branching). Structure and counts only.
- **visual-builder**: a manifest step by step, each step checked on its own, YAML both ways, tried against a sandbox connection, then published into conformance.
- **connector-builder**: OpenAPI compiles with no model call; pasted documentation goes to the model's `connector_generation` role as structure only. The model chooses structure; every CEL and JSONata expression comes from Silo's templates. The live probe is the source of truth, conformance runs, and a person confirms. Graded against two hand-built reference connectors, record for record (`tests/services/builder.test.ts`).
- **A connector's author** may save later versions under `connector.build` (spec 16.6 gives `connector.edit` to the author).
- **connector-maintenance** (spec 17): a weekly re-check per active connection (conformance plus structure observed from a live sample), drift analysed per spec 17.3, halts first, then repairs as new manifest versions. A rename or a lost pushdown is applied once its sandbox run passes (spec 17.3); anything else needs `connector.heal_review`. A change of meaning halts the connection.
- **discovery** (spec 19): off by default; authorisations with explicit targets, bounded windows and an approval chain; every probe held to its authorisation and recorded (`host_probed`); findings reviewed and promoted into a draft connection and, optionally, an ontology derivation. Refuses to start in the sovereign build. The agent is an interface until the tunnel exists.

## Warehouse: provisioner, schema, sync, reconcile

The Warehouse (spec 69.12 to 69.23) is Silo's own BigQuery warehouse for an organisation that has none. It is not in the sovereign build: config refuses BigQuery there.

- **The adapter** (`src/infra/bigquery.infra.ts`) is the only file holding the BigQuery client, and it writes no SQL. Every statement comes from the warehouse generator (`src/services/warehouse-schema/generator/`) through the SQL builder: constant text, identifiers quoted by the dialect, every value bound, so audit logs of query text never hold a record value.
- **Create warehouse** (`silo.create`) asks for a purpose, a retention and the object types to hold, with their properties. In the creator's own request:
  - the Warehouse's automation principal is created, owned by the creator, and granted read on the connections those types are read through;
  - the Silo, its nominations, the project row and the Silo's lineage are written.

  The principal never reaches more than its owner can.
- **Provisioning** then runs as that principal, step by step, each step recorded:
  1. a dedicated project per organisation;
  2. a dataset in the cell's region;
  3. a customer-managed key in the same region;
  4. dataset access for the writer service accounts only;
  5. the tables;
  6. the backfill.

  Each step is idempotent. A failure names its step, and a retry (`silo.manage`) resumes from it.
- **Tables follow the ontology:**
  - `<type>` holds the current state. Each nominated property has its column, a `__disputed` flag and a `__sources` count (a disputed value is stored as null).
  - `<type>__history` holds one row per change.
  - `link__<link_type>` is created where both ends are held.

  Every row carries `_connection_ids`, `_connector_versions`, `_ontology_version` and `_observed_at`; they are lists because a merged object comes from several systems. A changed property type gets a versioned column (`<name>__v2`) rather than rewriting history.
- **Sync** reads each type through the executor as the Warehouse's principal, within its bounds and rate limits, so the source is never overloaded. A history row is written only when a value's hash changed: Silo's canonical value is compared, never BigQuery's rendering of it. A value the principal may see only masked or redacted is not stored. A failed run marks its table stale; a table is never shown as current after one.
- **Reconciliation** compares the sources' object count and a sample of their ids with each table. Drift is resynced, and an unreachable source marks the table stale. Both sync and reconciliation also run on a schedule.

## Import rows, the Object Index, metering and Warehouse access

Every statement of these services comes from the same generator folder as the Warehouse's (`import.generator.ts`, `index.generator.ts`), so the places allowed to build SQL did not grow.

- **import-loader** (spec 68.4, 68.6) holds the rows `siloes-import` extracts, one table per definition object (`obj__<object>`) in the Silo's dataset.
  - Rows go in by a batch load job, never a streaming insert, so a purge can delete them at once. The job is named from the request's idempotency key, so a retry never loads twice.
  - A field read near or inferred carries `<field>__method` and `<field>__extraction_id` beside its value; confirming it sets the method to `certain`.
  - Loading a file again replaces its rows: a new definition version replaces all of them, and the same version replaces rows with the same row refs, so a file sent in parts keeps its other parts.
  - A wrong value is refused by row and field, never quoted. Purging a file, the retention sweep and dropping the dataset are its other jobs.
- **index-builder** (spec 69.1 to 69.11) is the Object Index on the BigQuery baseline (the engine is still open decision 69.6).
  - Creating one (`silo.create`) makes the Silo, its own automation principal and its dataset. Types are nominated one at a time (`silo.manage`), with the properties to hold and a refresh schedule; a person who can't see the type or a property in full can't nominate it.
  - A refresh reads the nominated properties through the executor as the index's principal and writes one table per nomination. A disputed, masked or redacted value is held as null. Each entry carries the markings of its type, connections and Silo, and each property its own. An entry the refresh didn't see leaves the index.
  - Search asks the index for a type it holds with its title; otherwise it asks the sources as before. The index answers only what the reader may see: an entry with a marking the reader lacks is never matched, so no hit count gives it away. Every group names its route, and every index result its refresh time.
  - Still to come: refresh from change streams (it waits on the Capture queue), Explorer lists and facet counts from the index, and the latency measurements the engine decision needs.
- **bigquery-metering** (spec 69.7, 74.1) measures fixed windows (daily by default). Each window is recorded once, keyed by its end, so a repeat run or a slow relay never bills an interval twice.
  - Bytes held come from the dataset and bytes scanned from the window's jobs: an Import or Index Silo's own labelled jobs in the cell's siloes project, or every job in a Warehouse's own project, the customer's direct SQL included.
  - Costs are exact decimals at the region's configured prices (`BIGQUERY_PRICE_PER_TIB_SCANNED`, `BIGQUERY_PRICE_PER_GIB_MONTH_STORED`). The service won't start without them, so nothing is ever billed at a price of zero. Results go out as `storage_measured`, which metering records for billing.
- **warehouse-access** (spec 69.16, 69.17):
  - A super admin (`warehouse.sql_access`) gives a named Google identity read-only access: dataset reader plus job user.
  - It is refused while the Warehouse holds any marked data, because BigQuery can't enforce Silo's markings. A live grant is ended by the system (reason `marked_data`) within `WAREHOUSE_ACCESS_CHECK_SECONDS` of a marking arriving.
  - Exit is either a hand-over (`silo.purge`) or a Parquet export (`silo.manage` or org-export). A hand-over ends the grants, removes Silo's writers, moves the project under the customer's organisation and disables the Silo. The export writes each table, with `schema.json` and `lineage.json`, into object-files.
  - Open point: after a hand-over the dataset is still encrypted with the organisation's Warehouse key in Silo's KMS project, until the customer re-keys it. The key is not destroyed.

## Seats

Seats (spec 72) belong to auth; the rows are `billing.seats` and `billing.seat_allocations`.

- **Purchase:** seats follow the subscription. Seats bought arrive unassigned and are billed from purchase; a lower count releases spare seats, never one a member occupies.
- **Assignment:** an admin (`seat.allocate`) assigns a seat from a scope's pool, or from the organisation's own seats if they hold the permission organisation-wide. A member who joins by invitation, SSO or SCIM is given a free seat as they join; without one they join seatless.
- **Allowance:** every assignment creates the member's allowance, prorated, and the first one gives the 200-token onboarding grant (73.4). An unassigned seat accrues nothing.
- **Pools:** a scope's pool draws from its parent's free seats and can't exceed them.
- **Moving seats on:** suspension reclaims a seat for someone else; removal leaves it untouched. Unassigning frees a seat at once. Releasing (`seat.release`) takes it out of the billable count for good.
- **Directory:** `npm run provision` registers the organisation's slug in the directory when `DIRECTORY_MIGRATE_URL` is set, so sign-in can find it. It says plainly when it isn't set.

## Siloes: the switch, Capture, Import, retention and wipes

Siloes (spec 66 to 70) are optional storage, off by default. `docs/siloSpecCoverage.doc.md` records what of the whole spec is built.

- **The switch** (`silo.enable`, super admin only) is `iam.organisations.storage_enabled`. While it is off, no Silo service answers: every Silo entry point calls `requireSiloes` first, and search skips the Object Index. It turns off only once every Silo is disabled and purged.
- **siloes-capture** runs the Siloes page and the Silo lifecycle.
  - Every view carries its disclosure text, filled in from the Silo's configuration (70.6).
  - Capture Siloes take object types one at a time, with nothing cascading, and only from someone who can see them.
  - Retention: shortening needs `silo.purge` and lengthening `silo.manage`, and both are audited with both windows.
- **Capture** rides on answers and on change streams.
  - The executor queues the root objects' values (never awaiting it) into the Redis capture queue.
  - change-stream queues each accepted change too (30.7), never awaiting it, whether or not anyone watches the object live: for a single-source type its object id is computed from the record; a resolvable type's changes need resolution, which a stream does not run, so they are captured from answers only. A deletion is not an observation.
  - siloes-capture writes the queue every few seconds. The first sighting is a baseline; a change becomes a transition. Values are sealed with the organisation key.
  - `readHistory` returns a property's transitions through the reader's own access. It says `building` when the consumer's minimum isn't reached, and returns nothing then.
  - `readStateAt` (30.8) gives objects as Capture saw them at a past time: per captured property, the last value at or before it (else the value before its next change, else the baseline), with when it was observed. An object first seen after the time is not yet observed (baselines keep `first_seen_at`); a property not nominated is not captured, never its current value. It needs the type and properties visible and clearance on the Silo's markings, and states where history begins (the type's first capture or the retention edge) and its gaps (when the type was not captured).
  - canvas-layout's `getCloneStatesAt` is time scrubbing and compare for the Canvas: the type's active state rules evaluated over the captured values at the time (an input not captured makes the state unknown, saying so), and with a second time, the changed states, changed properties with both values, and objects present at only one time. Without Capture it is unavailable with the bar's reason.
- **Wipes** are distinct scopes: entity, file, object, index, concept, and the whole Silo.
  - Each drains the capture queue first.
  - It needs an approver holding `silo.purge` when the organisation has a default approval policy. Otherwise the requester is the approver.
  - It deletes from every store (Postgres through owner functions, object storage with every version, BigQuery, the index, the Warehouse project and key).
  - It leaves a receipt of counts and the capabilities that stop working; the preview states those first.
- **Retention** is swept daily for Capture, Import files and rows, and Object Index entries, each sweep audited with counts.
- **Capture's consumers** (67.1): recognition's history detectors read a property's transitions through `readHistory` (timing deviation: an unusually long stay in a state, finished or running; drift: a numeric property's latest values moved one way, far from the object's own past; recurrence: returns to an earlier state, far more often than the population; all by the modified z-score, thresholds derived and tuned like the others, no record value in a finding). A detector below its minimum baseline reports `accumulating_baseline` with how much there is and how much is needed. Simulation's `observeLeadTimes` (`graph.propose`) pairs upstream and downstream transitions over current links and proposes the median as a history lead time with its distribution, never from fewer than 30 observations.
- **A purge during a refresh** (70.2): an Object Index refresh checks its definition is still live before it creates its table and before each batch; purged meanwhile, it stops (`index.purged`) and drops what it wrote. Every wipe drains the queue first for each Silo it feeds: Capture, a Warehouse and an Object Index.
- **The Siloes page** (66.9, `getSiloesWeb`, `silo.manage`): every live Silo with what it holds (an Import Silo: the types its objects are mapped to), when it last took data in (a capture, a processed file, an index refresh or a Warehouse sync), size, retention and purpose; and the links between Siloes and why (`same_type`, `linked_types`). It asks for a list when nothing links.
- **siloes-import** handles Import Siloes, sources (upload and watched locations), versioned definitions, and the carve-out acknowledgement (`silo.enable`).
  - Files are stored under keys with no filename in them, and their type is sniffed from the bytes.
  - CSV and TSV are read column by column, every value certain, with no model involved. So are Excel workbooks (`workbook.service.ts`, no library): the first sheet in the workbook's order, its first non-empty row the header; shared, rich and inline strings, numbers, booleans and formula results as text; a number in a date field an Excel serial date (1900 or 1904 system). The zip is read from its central directory, each part inflated under a ceiling. Timestamps must be ISO 8601 (`Date.parse` alone reads "A-1" as a date).
  - A large file goes straight to storage (`beginUpload`, `completeUpload`, `silo.import`): a signed v4 resumable URL into the source's drop prefix, 15 minutes, at most the import bound, issued after the upload checks; completing re-checks, receives it like any upload under the upload's id, and removes the drop object. Only the GCS store signs; on the S3 adapter the request is refused and the client uploads through the API.
  - A definition can be drafted from one of the Silo's own tabular files (`draftDefinition`, `silo.manage`, 68.3): a field per column named from its header, the narrowest type every value reads as, a key-named column that is never empty or repeated as the identifier, probed against every row (counts only). No model: tabular import never invokes one. The person publishes it as route `ai`, or corrects it in the builder.
  - Documents go to the model gateway's document extraction. They are charged 6 tokens as they arrive, and each near or inferred value is flagged with its location and model score until a person confirms it.
  - The uploader must satisfy the Silo's markings.
  - An Import Silo is a source (66.5). Publishing a definition registers it with connect-registry (`registerSiloSource`, siloes-import only): a private connector of source route `silo`, a manifest version generated from every live definition object (latest per table; typed fields, `row_ref` and `received_at`, the declared identifier or the row reference; every filter, sort and aggregate pushed down), and one connection, provider `silo`, owned by the publisher in the root scope, active at once. The Silo's markings are its connection's. With it the Silo leaves `provisioning`.
  - Its objects are read by connect-runtime's SQL engine in the Silo store (manifest transport `store: { kind: 'silo', siloId }`): the cell's siloes project, the cell's own credentials, never an agent; each job labelled with the Silo (`silo_query`). Every read filters the table's partition column (`partitionColumn`). Writes, conformance and write classes are refused: a Silo holds a copy. Without BigQuery (the sovereign build) a Silo source is unreachable.
  - Derivation maps its objects to object types like any connector's (68.5).
  - A whole-Silo wipe halts the connection when it starts and revokes it when the Silo is disabled (`retireSiloSource`, siloes-capture only).
- **Metering** of every Silo store uses the same windows: Postgres for Capture, object storage for Import files, and BigQuery and the index for the rest. Each service refuses to start without its price.
- **Still to come:**
  - Capture from change streams (the state plane needs redis-data), and the history consumers: detectors, clone time scrubbing and lead times.
  - Siloes answering as a source (66.5), and mapping imported objects to object types.
  - drafting a document's fields with the model, and prebuilt definitions shipped in the catalogue (68.3);
  - signing uploads on the S3 adapter (it needs `@aws-sdk/s3-request-presigner`, not added without a decision).
  - The Siloes page's links between Siloes, the Action ledger, and Warehouse history retention.

## Platform: outbox relay, audit, maintenance, notify

- **outbox-relay** (a worker, no endpoints) publishes `platform.outbox` to bus-durable.
  - It claims only the head row of each ordering key, so order holds per key across replicas.
  - Each row's message must be listed in `OUTBOX_CATALOGUE` (`src/contracts/outbox-relay/catalogue.contract.ts`) and its payload must match; a producer adds its message there.
  - Every message travels as `{ organisationId, occurredAt, correlationId, payload }`, and the outbox row id is the bus event id consumers deduplicate on.
  - A failed publish backs off from 1 second to 5 minutes. After 7 days the database dead-letters the row, which alerts, and the key moves on.
- **audit** stores `auth_event` in `audit.auth_events` and `audit_event` in each organisation's hash chain in `audit.audit_events`, once per event id.
  - Every event a service raises is listed with its retention class in `AUDIT_EVENT_CATALOGUE` (`src/contracts/audit/auditEvent.contract.ts`). Connect and billing events are listed there too.
  - Daily chain heads close on the first write of a day and every 15 minutes, for every organisation of the cell.
  - Reads go through policy: `audit.read` for events (a scoped reader sees only their subtree), `audit.export` for a verified run of the chain and the seals.
- **maintenance** runs `maintain_partitions()`, alerts on unhealthy partitions, seals closed ledger partitions after 15 days' grace, and drops a partition only when it is sealed and still matches its seal.
  - Retention defaults: 7 years for audit, 400 days for high-volume events, 13 months for model calls, outbox days after 14 days once settled.
  - It sweeps expired reset links and sessions, closes expired invitations, and removes old live subscriptions and layout caches.
  - It connects with its own migration login (`MAINTENANCE_DATABASE_URL`), which config refuses in any process hosting other services. `npm run db:partitions` stays as a manual tool.
  - Expired OAuth flows are marked and their sealed PKCE verifier wiped; used or expired flows are deleted before the session sweep, so their sessions can go too.
  - A seal covers the rows the partition held when it was sealed, in id order. When retention checks it again, it covers that many rows, so rows a tenant migration later loads into a sealed partition (with later ids) leave the seal matching.
- **notify** sends reset and invitation emails through the cell's SMTP relay. The token rides in the link's fragment and is never stored or logged. Auth's deliveries call it; reset delivery isn't awaited, so a real account answers no slower than an unknown one.
  - It also raises, lists and marks in-product notifications.

## Tenancy: tenant migrations and the organisation export

**tenant-migrations** (spec 6.4, 6.7) moves an organisation from one cell to another. It runs in the platform workers' process with the migration login (`MAINTENANCE_DATABASE_URL`), beside maintenance and outbox-relay.

- **Asking.**
  - A super admin asks (`org.migration.request`) for a residency change or a promotion to a dedicated or sovereign cell. The request is their written instruction.
  - Silo proposes rebalancing (`proposeRebalancing`, admin-portal) with 30 days' notice. The customer may approve or object (`org.migration.approve`), and an objection stops it.
  - Silo's signatures come through admin-portal: the security officer for a residency change, the sovereign security officer (on the sovereign access list) for the sovereign cell, and the operator confirming the contract for a promotion. With every approval in, the migration is approved.
  - The operator then schedules the window with the destination's import key (`getTenantImportKey` on the destination).
  - One migration at a time. Placement never crosses residency; leaving the sovereign cell needs the customer's own request.
- **Read-only.** From the window, Actions (proposal and execution) and Crons (each firing skipped as `tenant_migration`) pause, in the source until the purge and in the destination until the directory moves.
- **Export.** It waits for the organisation's outbox to empty, then reads every tenant table as the application role under the organisation's context.
  - Each row travels as its jsonb text, less identity columns.
  - Each table's count and SHA-256 over its sorted rows goes into `tenant_migration_tables`.
  - Also included: the organisation's row, its members' users, the operators its rows name, and its stored files.
  - The bundle's key is fresh, sealed to the destination's import key (RSA-OAEP-SHA256 for Cloud KMS and Vault, X25519 for the local key). The bundle is written to object-backup at `cell/tenant-migrations/<id>/bundle` as it is read, never held whole:
    - each table's rows come through a cursor, `rowBatch` (500) at a time, in byte order of their text, and the table's checksum is worked out as they pass;
    - each stored file travels in 1 MiB chunks;
    - the payload is cut into segments of at most 1 MiB, each gzipped and sealed under AES-256-GCM with the header, its number and whether it is the last as associated data, so a segment altered, dropped, moved or added, or the bundle cut short, refuses to open;
    - the upload is a GCS resumable upload or an S3 multipart upload (`openUpload`), and the destination reads the bundle back by range.
- **Keys.**
  - The source's credential service seals each organisation key to the import key (`exportOrganisationKeys`).
  - The destination's credential service opens each in its KMS and wraps it under its own KEK (`importOrganisationKeys`). A key is never plaintext outside a credential service.
  - So every value sealed under the organisation's data key (receipts, prior states, captured values) moves as it is and opens in the destination.
- **What stays behind** (`STAYS_BEHIND`), each with its reason:
  - connection credentials, OAuth flows in progress and agent enrolment tokens;
  - identity provider configuration and the links to it;
  - the credential unwrap ledger;
  - sessions;
  - the outbox;
  - live subscriptions and layout caches.
- **Load (destination).**
  - The operator copies the bundle to the same key in the destination's object-backup; the stage sweep finds it there. No cell ever calls another.
  - The load is one transaction as `silo_migrate` with `session_replication_role = replica`, so history goes in as it was. It recomputes every table's count and checksum inside that transaction, and any difference refuses the whole load.
  - A refusal is written beside the bundle (`import-refused.json`) and the source carries on. Causes: a release mismatch, a person with another user in the destination, or a checksum.
- **Then (destination).**
  - The keys are wrapped here.
  - Active connections are halted with reason `tenant_migration` until someone re-authorises them, counted down in `connections_pending_reauthorisation`.
  - The directory moves the slug, and every member's address hash is registered for the destination.
- **Source purge.**
  - The source sees the directory move and holds read-only for 30 days.
  - It then deletes every row and file of the organisation, and its members' users who belong nowhere else, in one transaction.
  - Before the commit it writes `cell/tenant-migrations/<id>/purge-receipt.json`, with per-table counts.
  - Copied to the destination, the receipt completes the migration: `tenant_source_purged`, then `tenant_migration_completed` with the row counts at both ends and the bundle checksum.
- **Bootstrap.** `cell.bootstrap.sql` grants `silo_migrate` `SET` on `session_replication_role` (PostgreSQL 15+; on Cloud SQL, `cloudsqlsuperuser` grants it).
- **Configuration.** `KMS_IMPORT_KEY_URI` (credential service) and `TENANT_MIGRATIONS_TICK_SECONDS`. tenant-migrations also needs `PG_CONTROL_URL`, `MAINTENANCE_DATABASE_URL`, `OBJECT_BUCKET_BACKUP` and `OBJECT_BUCKET_FILES`. Without `SERVICE_URL_DIRECTORY` (a self-managed install may have none) it starts, and refuses to move an organisation.
- Rows load 5,000 to a statement.

**org-export** (spec 2.6) runs exit exports.

- **Asking.** A super admin (`org.export`) asks. Nothing is withheld: the export runs in any billing state, and records which state applied.
  - One runs at a time.
  - The requester's clearances are resolved when they ask, in their session, and stored (`cleared_marking_ids`). A policy decision for a member needs a live session, and the run happens later in the background.
- **The run.** The worker runs it as the application role under the organisation's context.
  - Connector manifests: every version the organisation wrote or its connections run, as YAML, with the manifest's JSON Schema.
  - Ontology: object types with every version, property, mapping and time field; link types, interfaces, shared properties, action types with parameters, functions with versions.
  - Resolution: per type, match keys (keyed hashes only) and field authorities, as CSV and JSON.
  - Apps, views (with their compiled manifest), Crons and scenarios.
  - Receipts as JSON Lines per Action type, documents opened, lineage references resolved.
  - Audit and sign-in events as JSON Lines per month, each row's own text, lineage resolved.
  - Siloes: captured transitions (values opened), imported files as they came with their extractions, and Object Index entries (read page by page through index-builder). Each is JSON Lines plus Parquet.
  - Every table drawn on has a JSON Schema generated from the release's catalogue.
- **Omissions.** An artefact carrying a marking the requester did not satisfy is omitted and named, with the marking. Markings come from object type markings, resource markings, and lineage artefact markings, direct or inherited. A receipt is omitted on its own.
  - An imported file whose stored object is gone is named as missing; the export goes on.
- **Output.** Written to object-files under `org/<organisation>/exports/<id>/`:
  - `bundle.tar.gz`, a POSIX tar holding every file and, last, `manifest.json`. It is uploaded as it is written, one artefact at a time, each file's parts in gzip members of their own (any gunzip or tar reads them as one stream);
  - `manifest.json`, with each file's path, SHA-256, size and rows, and each omission;
  - `receipt.json`, with the counts, the hashes, the omissions and the billing status.
  - Each is downloaded in parts of up to 4 MiB through `GET /org-exports/:id/content`.
- **Configuration.** `ORG_EXPORT_TICK_SECONDS` and `ORG_EXPORT_MAX_BYTES` (the largest one artefact may be, since each is built in memory; default 2 GiB). A run left by a stopped process is failed after an hour as `interrupted`, to be asked for again.

## The AI FDE: fde-orchestrator

**fde-orchestrator** (spec 49 to 54) runs an engagement through the ten onboarding stages. It works only through the services a person would use, under the same policy decisions, and proposes; a person decides.

- **Engagements.** A member holding `fde.engage` starts one with goals, a scope, a token budget, a provider-cost budget and limits (`DEFAULT_LIMITS` fill any not given). A supervisor may only lower a limit. Pause, resume, stop, close, and assigning a deployment engineer are routes of their own.
- **Principals.** Each of the seven roles is one service principal of kind `fde`, created at the start and revoked at stop, handover or close.
  - Its ceiling is its role's tool permissions, within the engager's own permissions, less the forbidden set (52.1).
  - The forbidden set is a database rule: constraint triggers on `iam.service_principal_roles` and `iam.role_permissions` refuse a role with a forbidden permission for any FDE principal, whichever side changes.
  - Policy resolves an FDE principal only while its engagement is active. Its clearances are the engager's, and its reach is read-only over the connections the engager owns or was granted.
  - It never authorises: a refusal at the ceiling is recorded as `fde_ceiling_refusal`.
- **Stages.** The orchestrator worker ticks every `FDE_TICK_SECONDS`. For each active engagement it checks the budgets, plans the current stage's tasks, runs what the limits allow, and checks the exit criteria.
  - A stage whose criteria are met waits for a holder of `fde.engage` to confirm its exit; stage 8 may be skipped. Stage 9 ends with handover.
  - A task that cannot verify what it found fails with the sub-stage and an error semantic, and proposes nothing. Three failures on one system in one stage raise an escalation.
- **The work built in this release.**
  - Stage 1: an estate entry per verified connection, for the administrator's scope list (markings and all); a connection whose connector is still being built is listed too, at medium confidence.
  - Stage 2, Integration: a builder draft in scope. A person drafts it from documentation and runs the probe in the builder (the probe moves the connection, runs conformance and versions the manifest: authority the AI FDE never holds); the task waits for it. A build that stopped names its stage. Then the reconciled manifest and each object's mapping (identifier, properties, links, confidence) are proposed; accepting a mapping confirms it in the builder as the person, with their corrections, which verifies the connection when they hold `connector.verify`.
  - Stage 3: ontology derivation per in-scope connection, an object type or link type proposal per decision.
  - Stage 4: a resolution run per resolvable type, a proposal for each pair it left undecided.
  - Stage 5, Integration: write enablement per in-scope connection whose manifest declares writes, proposed only from a passed write-verify-undo run on its current manifest version (`getWriteClassStatus`). A person nominates the test record and its values; no model invents them. No run, a failed run or a transport that does not write fails that system's task with the reason, and the connector stays read-only. A physical source is never cycled.
  - Stage 5, Action: one "Update" Action type per accepted type over the connections that have earned writes and declare an update. Each property is an optional parameter, kept as it is when not given; a physical source makes the type physical. It waits until each source's enablement is decided, and on acceptance is created and published as the person who decided, as they edited it.
  - Stage 6, Application: per in-scope type, a Studio app from a template (`inbox_detail` with the type's accepted Action type, otherwise `monitor`), a custom object view layout, and a dashboard (a saved view over the type's objects, favourited). The app and the layout are proposed only when Studio's `previewApp` validates them with no finding and they render for the role; accepted, each is a draft the person owns, marked `generatedBy: ai_fde` (`app_generated_by_fde`), published through Studio's review.
  - Stage 7: the model chooses which field each detector examines, from structure only. Its answer is validated against the schema, metered, and checked against the type before it becomes a proposal. A notify-only Cron per accepted dashboard (weekly, Monday 08:00, when the view's objects differ from the last run), never over a halted source and never with a mutate action; accepted, it is the person's, over their dashboard's object set (the AI FDE cannot open a person's saved view, so the question is checked as them on acceptance).
  - Stage 8: a dependency edge per link type. A person states its kind and lead time; it is never accepted without them.
  - Stage 9 and steady state, Reliability: per in-scope connection, a heal awaiting review becomes `heal_review` (accepting or rejecting it decides the repair, as the person); a halted heal, a failing weekly re-check, a stream silent or lagging while the source is otherwise healthy, and a field whose last two profiles moved (null rate, distinctness, type conformance, rows) become `reliability_finding`, acknowledged rather than applied. It re-profiles a connection whose newest profile is a week old, and looks again a day after its last look (`RELIABILITY_EVERY_MS`). A successor engagement watches its predecessor's systems.
  - A role proposes only its own kinds (49.3, `ROLE_PROPOSAL_KINDS`); anything else fails the task at the ceiling.
- **Proposals.** Each carries its evidence, a confidence band (high from 0.85, medium from 0.6) and the permission and markings needed to decide it.
  - Deciding needs `fde.confirm`, the permission the kind maps to (52.2), and every marking on the proposal.
  - The decider accepts, edits the fields a person may change, rejects with a reason, or defers.
  - An accepted proposal is applied through the target service as the decider, never as the AI FDE.
  - Group acceptance takes only high-band proposals, never kinds that always need a person, and checks the whole group before applying any of it. A deployment engineer decides technical kinds only.
- **Sessions and escalations.** Confirmation sessions (a workshop or a queue) work through the stage's pending proposals in a fixed order. Escalations are raised and resolved by a person holding `fde.engage` or `fde.supervise`.
- **Cost.** Model calls go through model-gateway on the `fde` route and are charged as `advanced_compile` against the engagement. Provider cost is priced from `FDE_PROVIDER_PRICE_INPUT_PER_MILLION` and `FDE_PROVIDER_PRICE_OUTPUT_PER_MILLION`. A spent token or provider-cost budget pauses the engagement.
- **Handover.** Accepting handover revokes every principal. Keeping Reliability starts a successor engagement at stage 9 with only that role and its own budget.
- **Metrics** (spec 54) are computed from the engagement's own records, each citing what it came from. Those that need other services' events are listed as not measured, with the reason.
- **Gateway routes** are in `src/contracts/gateway/fdeRoutes.contract.ts`.

## The admin portal: Silo staff and break-glass

**admin-portal** (spec 7 catalogue, 13.3 to 13.5, 63.6) is the Silo staff console. Staff have no standing access to a customer's data, and every action on a tenant is visible to that customer.

- **Its own listener.** Staff use `ADMIN_PORTAL_PUBLIC_PORT` under `/staff/v1`, never the customer gateway. It applies the gateway's security headers, cross-site rules and rate limits, with its own counters. The routes are data in `src/contracts/admin-portal/staffApi.contract.ts`; each names the staff capability it needs.
- **Signing in.** Only through the staff identity provider (one OIDC issuer per deployment, through the cell's egress, verified by openid-client as customer SSO is).
  - The ID token's `amr` must include every method in `ADMIN_PORTAL_IDP_REQUIRED_AMR` (default `hwk`, a hardware key), and every `ADMIN_PORTAL_DEVICE_CLAIMS` claim must hold its value. The sovereign build refuses to start without device claims (13.3).
  - The person is the active row of `platform.operators` whose `idp_subject` is the token's `sub`. In the sovereign cell they must also be UK-resident and on the sovereign access list.
  - Capabilities come from the provider's groups claim, mapped by `ADMIN_PORTAL_GROUP_CAPABILITIES`. Staff roles are managed in the provider (13.4).
  - A staff session is a random token in the `__Host-silo_staff` cookie, held hashed in redis-session: 15 minutes idle, 8 hours at most. The operator's row is read again on every request, so a suspension or removal signs them out at once.
- **Break-glass** (13.3):
  - flow: request (purpose, level, reason, ticket, minutes), then a second member of staff approves, then the customer approves where required, then the requester starts it;
  - customer approval is required when the organisation's policy says so (`org.operator_access.policy`) and always in the sovereign cell; the customer's approvers (`org.operator_access.approve`) are notified;
  - an emergency session takes two staff approvers instead of the customer, is disclosed at once (`operator_access_emergency` and a notification), and can never be `tenant_act`;
  - a session runs for the minutes asked, at most 4 hours, and the sweep expires it; the customer may revoke it at any moment;
  - only the requester uses it. Each request is counted and recorded in the customer's audit log (`operator_access_resource_touched`) before it is made, carries the session to the serving service, and that service checks the session itself (`services/admin-portal/sessionCheck.service.ts`);
  - reasons and scope notes are refused if they match a value pattern;
  - the session's recording is its audit events, kept at least 12 months (`recording_retained_until`).
- **What a session reaches** in this release: the audit log, the ontology manifest and an AI FDE engagement's cost (`metadata_read`); billing status and marketplace payout transfers (`tenant_act`, with `billing.status` or `payouts.transfer`).
- **The customer's side** (gateway, `src/contracts/gateway/operatorAccessRoutes.contract.ts`): list and read sessions, approve or deny, revoke, and require approval of every session.
- **Staff operations**, each calling the owning service with the operator's id from the session:
  - the catalogue review queue and trust tiers;
  - Silo's own OAuth clients;
  - Fleet releases, bundles, promotions and rollouts (approving an expedited promotion needs `fleet.release.expedite`; countersigning needs the sovereign access list);
  - status notices and the status page preview;
  - maintenance status;
  - an organisation's retention sweep and BigQuery measurement;
  - tenant migrations: rebalancing proposals, Silo's signatures, the window, aborts and the import key.
- **The operator directory** (13.4): `staff.manage` adds staff and corrects their clearance, residency and sovereign listing; `staff.review` records the quarterly review and suspends or removes. Nobody reviews, suspends or removes themselves, and removal is final.

## Gateway

The public edge (`src/routes/gateway/`), on its own listener under `/api/v1`.

- **Routes are data.** Each is an entry in `src/contracts/gateway/` naming the session it needs, its permission, the internal contract it forwards to and how the body maps. A full-session route has exactly one of a permission or `ownRecords` (a member's own notifications, allowance, linked identities: the service scopes to the session's membership), or it is refused when it loads. Routes exist for auth, SSO, policy administration and governance, audit, notifications, billing and metering, connect and the catalogue, and the ontology.
- **Each request:** security headers and no CORS; the cross-site check; a rate limit per client address; the session cookie resolved through auth (an MFA-pending session reaches only the MFA routes); a rate limit per session; the JSON body validated; `policy.authorise`; the forward, with context headers taken only from the resolved session; the reply validated.
- **Cookie:** `__Host-silo_session`, Secure, HttpOnly, SameSite=Strict, expiring with the session.
- **CSRF:** a request marked cross-site is refused, and every state-changing request needs an exact `Origin`, the `x-silo-csrf` header and a JSON body. A form can't add the header, and another site can't without a CORS preflight, which is always refused. The same Origin rule guards the WebSocket handshake.
- **Who decides:** a full-session route names a permission the gateway asks policy for, or reaches only the member's own records, or says why its service decides (`decidedByService`). The last is for rules policy can't state as one permission, such as "the connection's owner, or a permission at its owning scope": connection management after creation, OAuth flows, conformance runs, some governance reads and seat moves. Each such service checks for itself, and a test proves a member is refused through the gateway.
- **OAuth sign-in to a source:** the provider returns the browser to the client's return page (`/connect/oauth/`, which OAUTH_REDIRECT_URI names), which posts the state and code to `/api/v1/connect/oauth/callback`. The strict session cookie rides on that same-site post, and the flow completes only in the session that started it.
- **Idempotency keys** are forwarded as `<membershipId>.<key>`, so members never share a key.
- **Non-browser surfaces:** the payment provider's webhook (`POST /api/v1/hooks/payments`: no session, raw bytes forwarded unparsed with the signature header verbatim, any request carrying `Sec-Fetch-Site` refused), the SAML assertion endpoint, and SCIM at `/scim/v2` with its own bearer tokens.
- **WebSocket** (`/api/v1/live`): authenticated by the cookie; subscribe, unsubscribe, ack, resync and heartbeat messages are validated; deltas fan out from bus-live per subscription, coalesced over 250 ms. Subscribing counts as activity; deltas and heartbeats don't. A revoked session's sockets close within 15 seconds. Until the state plane exists, subscriptions are refused as `unavailable`.

## Connect

Protocols are code; connections are data (`docs/siloServiceCatalogue.doc.md`).

- **The manifest** (`src/contracts/connect/manifest.contract.ts`): only the protocol (`rest`, `sql`) and the auth strategy are closed sets. Records, computed fields and write bodies are JSONata; paging, pushdown patches, error rules, retries, value checks and request signing are CEL. Trust tier, owning scope and source route live on the rows, so promoting a connector doesn't change its hash.
- **expression-evaluator:** every block declares the names it may read, and `secret` is nameable only in request signing. Bounds are enforced from inside the evaluation: 10,000 steps and 10 ms (100,000 and 100 ms for the `records` block, which reshapes a whole page). Regular expressions, `$eval`, randomness and recursion are refused when the manifest is saved. The only clock is the injected one.
- **connect-registry:** connectors, immutable manifest versions, connections and their status moves, decided through policy. A manifest is saved only after the schema, every expression and the protocol engine's own checks pass.
- **credential** seals each connection secret with its own key, and writes an unwrap ledger row in the same transaction as `last_used_at`. The plaintext never leaves the service: it places the secret and sends the request itself, to the manifest's host only, over HTTPS, to public addresses, with redirects returned rather than followed. Revoking a connection revokes its credentials in the same transaction (a database trigger).
- **connect-runtime:** one engine for paging, pushdown, error meanings, retries, rate and concurrency limits, and bounds that refuse rather than truncate. REST is tested against a fake API; SQL generates one parameterised SELECT through `sqlBuilder` for seven dialects, tested against a throwaway Postgres. The agent is an interface until the tunnel exists.
- **pushdown-compiler** splits a plan step into what the source does natively and what runs after, from what the manifest declares.
- **oauth:** hashed state bound to the session, PKCE S256, the code exchange and refreshes inside the credential service, a refused missing scope, and refreshes serialised by a Redis lock so concurrent callers share one. An organisation without its own client falls back to Silo's registered one, held by the system organisation.
- **Parameters** (a tenant subdomain, a region) are plain data on `connect.connections.parameters`, checked against the manifest's declared names and anchored patterns; a pattern that could backtrack without bound is refused when the manifest is saved. A value used in the base URL's host must be one DNS label.
- **conformance** runs read, pagination, filter-pushdown and error-class tests through connect-runtime and records each outcome (never a value). Confirming a connection needs a completed run on its current manifest version with no failed read, pagination or error test, and a filter, sort or aggregate that failed is computed after the source from then on. A test that cannot run is recorded as not applicable, never as passed.
- **catalogue:** browsing connectors across trust tiers, offering a private connector for community use (needs a passing run), Silo staff review and tier promotion on their own migration login (`CATALOGUE_DATABASE_URL`), and installing Ed25519-signed connector releases whole or not at all.
- **GraphQL** protocol: queries built as a syntax tree and printed, values only in typed variables, and a 200 response with errors classified by its extension code, never treated as partial data.
- **Private links** (Enterprise, decision 2026-11-09): when an Enterprise customer's systems sit in its own cloud network, Silo can link that network to the cell's, VPC to VPC (VPC peering or a Private Service Connect endpoint), and its connections then reach those systems without the Silo Agent.
  - The network link is infrastructure. `connect.private_links` records which private ranges it carries. Silo staff add and remove them in the admin portal (`network.private_links`), and the organisation's admins see them at `GET /v1/connect/private-links` (`connection.manage`).
  - A range must be private (10/8, 172.16/12, 192.168/16, 100.64/10 or fc00::/7) and no wider than a /8 or /16. It may not touch the cell's own networks (`CONNECT_CELL_NETWORKS`, required in production for credential and connect-registry), and it may not overlap any other live link, whoever holds it: the database refuses an overlap, so a private address belongs to one organisation at most.
  - The credential service reads the organisation's live links with the connection on every request it places. The egress reaches a private address only inside one of them, never the cell's own networks or anything outside private space (loopback, link-local, the metadata server). Removing a link stops traffic on the next request.
  - Adding and removing are audited (`private_link_added`, `private_link_removed`) with the member of staff in the detail. Neither event is in spec chapter 77.

## Model gateway

The only service with model credentials or model egress (spec 7.8, 62).

- **Vocabulary calls** take typed parts only (object types, properties, actions, declared capabilities, counts, the question), so there is nowhere to put a record value. Every string, keys included, is scanned for value patterns; a match is refused, recorded with its category and never sent.
- **Document extraction** is a separate route for siloes-import only, which checks the Silo's carve-out for itself.
- **Routes** come from `MODEL_ROUTES_FILE`: zero retention and inside the residency, through a Vertex-style adapter or a self-hosted OpenAI-compatible one (`src/infra/modelProvider.infra.ts`). A route may name its provider's `pricing` (pounds per million input and output tokens); each call on it then records its `provider_cost`, which the margin calculator and the engagement cost report read. An unpriced route's calls stay unmeasured, never free.
- **Bounds:** concurrency per organisation and per cell (Redis leases), timeouts, output tokens and prompt size, each refused with the bound named.
- **Output** is checked against the caller's schema and refused, never repaired.
- **Ledger:** every call, allowed or refused, is a `platform.model_calls` row with its token usage message and audit event, in one transaction; never the prompt or the output.

## Metering and billing

- **metering:** token and simulation charges, keyed. Weights are fixed per operation. The onboarding grant pays first, then the allowance within the daily limit, then purchased tokens; one charge is one ledger row. A refusal names the bound, writes nothing, and notifies once a day. A cache hit and a rephrase within 10 minutes are never charged. AI FDE work draws on a contract allocation or the engaging member's purchased balance. Model usage from model-gateway is recorded for cost reporting (an FDE task's provider tokens, recomputed from `platform.model_calls`) and never charged: the operation's own charge step charges.
- **billing** refuses to start without the `stripe` capability, so it is compiled out of the sovereign cell. The payment provider is behind `src/infra/payments/` (a fetch client and its HMAC webhook check). Webhooks re-fetch the subscription, so duplicates and reordering converge; entitlements are versioned with no gap. Billing status is written through `silo_billing`, a role only billing's login holds.
- **Enterprise contracts** (71.3, 74.3 to 74.8), on the staff path from the admin portal: staff work on an organisation, not break-glass. The admin portal names the member of staff in the request context (`x-silo-operator-id`, set only by admin-portal; any other caller's is dropped), and `billing.contracts` refuses a write without it (`app.operator_id`, design D45).
  - **Quote → draft → active.** The margin floor calculator prices a quote over its term: seats × expected compiles × cost per compile, simulations, included storage, dedicated capacity, sovereign uplift, support load, and bundled AI FDE cost. Margin is (price − cost) / price. Every quote carries the spec's warning until fifty compiles are logged; after that the measured mean tokens per compile, from `platform.model_calls`, replace the estimate.
  - Below the floor (`BILLING_MARGIN_FLOOR`) a draft waits for sign-off (`contracts.manage`) by someone other than its author; the database refuses self-approval too. Activation needs the term to have started and the customer's signatory, and is Silo's countersignature. The contract's entitlements then apply (a new version; a self-serve subscription's stop applying while the contract is active), its seats exist (`plan_tier` enterprise), and the organisation's plan is Enterprise.
  - **Amendments and renewals** recompute the margin. Below the floor they need a member of staff other than the quote's author. Each writes a new entitlement version and moves seats: added at once, released only from unassigned ones.
  - **Term end** is an event: the sweep lapses an unrenewed contract (`contract_lapsed`). Its entitlements stand until staff renew it, so no customer is cut off by a date alone. A renewed contract's next renewal becomes upcoming `BILLING_RENEWAL_NOTICE_DAYS` before its term ends.
  - **Token allocation** is tokens per seat per month (73.3: "negotiated on Enterprise"), which entitlements carry. The term's allocation is that × seats × months. Overage (allowance and contract charges beyond the allocation to date) is reported when it grows (`overage_reported`) and never charged.
  - **Invoices.** A contract invoice is Stripe Invoicing without a subscription: its lines, payment terms (`net 30` gives 30 days), the purchase order as a field on the invoice. It is mirrored at once, and the webhook keeps it current. An invoice paid through a supplier portal is recorded manually and marked paid by staff holding `payments.record` (`payment_recorded_manually` names them).
  - **Overdue.** The sweep marks an open invoice past its due date overdue, and moves an active organisation to past due (`billing_status_changed`, source `overdue_invoice`). Paying the last overdue invoice lifts it. Suspension stays a staff decision.
  - The customer reads its contracts as signed (`GET /v1/billing/contracts`) and their usage, under `billing.view`, never the cost, margin or staff.

## Silo Agent (spec 10)

The agent itself is written in Go in `agent/` (decided 2026-11-16). The cell side:

- **Pools and tokens** (connect-registry, through the gateway at `/connect/agent-pools`): `agent.enrol` creates a pool and issues single-use enrolment tokens (24 hours, shown once, kept as a hash); `agent.view` lists pools with their agents' health, marking a production pool with fewer than two live agents; `agent.manage` revokes an agent and its service principal.
- **Enrolment** at agent.<cell> (connect-runtime, `AGENT_ENDPOINT_PORT`, TLS 1.3, behind a TCP pass-through load balancer): `POST /v1/enrol` with the token, a PKCS#10 request for the P-256 key the agent keeps, and its name, host, platform and version. The token is consumed, the cell's agent CA issues a 30-day client certificate, and an `agent` service principal and the agent are recorded with its fingerprint. A refused request does not spend the token.
- **Configuration:** `AGENT_ENDPOINT_HOST` (default `agent.<SILO_CELL_ID>.silohq.io`), `AGENT_ENDPOINT_PORT` (8443), `AGENT_ENDPOINT_TLS_CERT_FILE` and `AGENT_ENDPOINT_TLS_KEY`, `AGENT_CA_CERT_FILE` and `AGENT_CA_KEY` (P-256, from the deployment; the code never generates the key).
- **The tunnel** (`contracts/connect-runtime/agentTunnel.contract.ts`): the agent holds `POST /v1/tunnel` open with its client certificate, sending heartbeats up every 10 seconds and taking work down; it answers each piece of work on its own stream, `POST /v1/work/:id`. Frames are newline-delimited JSON. Three missed heartbeats mark an agent unhealthy and it gets no work; the next marks it recovered. Work goes to the least-loaded healthy agent of the pool, and only that agent may answer; with none connected it is refused at once, never queued. A revoked agent's tunnel closes at its next heartbeat. connect-runtime's SQL engine reads and writes through it.
- **The agent** (`agent/`, Go; its README): enrols, holds the tunnel, answers Postgres reads in a read-only transaction, runs writes only on signed execution grants, renews its certificate with a new key at 20 of 30 days (`POST /v1/renew`), and reads Postgres change data capture.
- **Change data capture** (Postgres logical replication; D126). The customer makes a publication for the tables and a replication login the agent holds (`replicationDsn`); they should also set `max_slot_wal_keep_size`, so a slot nobody reads cannot fill their disk.
  - The owner sets it up at `POST /connect/connections/:id/stream/capture` (stream.enable) with the slot name they were shown, the publication and `confirmed: true` (`cdc_slot_created` names them). One live capture per connection.
  - An agent of the pool takes the slot on a heartbeat (`cdc.start`, from the acknowledged position) and holds a 60-second lease its heartbeats renew. It makes the slot on first read and sends each committed transaction up `POST /v1/cdc/:slotId`. change-stream decodes it into deltas; only then is the position recorded and sent down (`cdc.ack`), and only acknowledged positions reach Postgres.
  - The agent stopping, or its stream ending, gives the lease up; another agent resumes from the acknowledged position, and repeats are dropped. A slot gone or invalidated is lost (`cdc_slot_lost`), never made again.
  - Dropping (`POST .../stream/capture/drop`, stream.manage) has an agent of the pool drop the slot and report it (`cdc_slot_dropped`).
  - The stream status shows the capture (reading or not, the acknowledged position), and the stream is stale with the reason while no agent reads it.
- **Across replicas** (D127): each connect-runtime replica says in redis-data (`tun:`) which agents it holds, their health and load, and its own address (`AGENT_RELAY_URL`). Work goes to the pool's least-loaded healthy agent wherever its tunnel is, relayed to the replica holding it. An agent no longer there, or a replica that cannot be reached, passes the work to the next agent, a write only when it cannot have reached the agent.
- **Store-and-forward** (D128): the agent's reader writes every change into an encrypted, bounded spool on its host (10 GB and 7 days by default), and an uploader sends it up in log order; a dropped tunnel or a slow cell pauses only the upload. At the bound the reader waits, since the source still holds the rest, unless the slot is about to be invalidated. The cell receipts every record, so a transaction larger than the spool passes through. On reconnecting the agent gets back the slots it still reads. What a spool drops or loses arrives as a gap record: audited (`agent_spool_gap`) and shown in the stream status (`capture.lastGap`). The capture lease is 30 seconds.
- **Execution grants** (D129, spec 10.4): a write through the agent runs only on a grant actions signs (Ed25519, `EXECUTION_GRANT_KEY`) naming the Action, connection, target and the SHA-256 of the exact statements. connect-runtime renders the statements first (`prepareWrites`), checks the grant before the write leaves the cell (`EXECUTION_GRANT_PUBLIC_KEY`), and gives the public key to every agent it enrols or renews. The agent checks the grant again and runs it once. Anything unsigned, mismatched, expired or replayed is refused and audited (`agent_write_grant_refused`). Conformance's write class gets its grants from actions too.
- **Discovery scans** (D130, spec 10.5, 19): a scan runs on the agent only on a scan discovery signs (Ed25519, `DISCOVERY_SCAN_KEY`, a key of its own) for one run of an approved authorisation, carrying the approved document's exact text. connect-runtime checks it (`DISCOVERY_SCAN_PUBLIC_KEY`) and gives it to the agent as `discovery.scan` work, on the replica holding the agent's tunnel. It then passes what the agent reports to discovery in numbered reports, at least every 5 seconds, and each answer says whether to go on. discovery takes each report once and in order, holds it to the authorisation, and logs every probe. Revoking the authorisation or switching discovery off stops the run, and the agent stops within seconds. A run whose reports stop for two minutes is ended as `agent_silent`. Sovereign agents carry no discovery.
- **Updates through Fleet** (D131, spec 10.7, 11.4):
  - **Into the cell.** Global fleet-control holds each agent binary by its SHA-256, put there by the build (`npm run fleet:agent-binary -- <binary>`). agent-stable takes a release only once every binary it names is there, whole. The cell's Fleet agent (fleet-control with `FLEET_ROLE=cell_agent`) pulls agent-stable every `FLEET_AGENT_POLL_MINUTES` (15). It checks the head and the release with the Silo release key (`FLEET_RELEASE_PUBLIC_KEY_FILE`), copies each binary into object-files by digest, and installs the release in connect-runtime. connect-runtime checks it all again, the binaries' bytes included.
  - **Waves.** The newest release rolls through the agents of automatic pools. Wave 0 is Silo's own organisations (`CONNECT_AGENT_FIRST_ORGANISATIONS`), then a stable 5% of agents, then 25%, then all. Each wave soaks `CONNECT_AGENT_WAVE_SOAK_HOURS` (24); a wave with no one in it passes at once.
  - **Gates.** The rollout halts if any of these happens:
    - heartbeat: an agent took the release and did not come back on it within 30 minutes, or stopped heartbeating within its first hour on it;
    - error rate: an agent failed more than 5% of at least 20 pieces of work itself, and twice its rate before;
    - an agent refused the release, or could not start it.

    When a rollout halts, the agents it updated are told to go back. A newer release supersedes a running rollout.
  - **Offers.** The agent asks `GET /v1/update` hourly; a pool's agents update one at a time.
    - An automatic pool takes the rolling release once the agent's wave has started.
    - A pinned pool takes its pin, and an approval pool takes the version someone with `agent.manage` approved (`PUT /connect/agent-pools/:id/update-policy`, `.../approved-version`). A pin or an approval overrides the waves. A version named must be one the cell received, and no older than the pool's agents run.
    - The agent downloads `GET /v1/update/binary/:sha256` and reports a refusal at `POST /v1/update/report`.
    - The agent checks everything itself with the release keys built into it, and keeps the binary before.
  - **Audit and versions.** `agent_updated` is raised when an agent heartbeats another version; `agent_update_refused` when it refuses or undoes one. An agent more than three minor releases behind those the cell received is outdated, and refused work 90 days later (it may still update). `GET /connect/agent-releases` lists the releases, the rollout and the floor.
  - **Sovereign agents** take no update through the tunnel yet: their releases come as countersigned bundles (phase 9).
- **Logins** (D132, spec 10.7, 6): a connection through the agent keeps its login in the cell by default (`credentialCustody: 'cell'`, fixed at creation), stored like any connection secret; its address is the connection's parameters (`host`, `port`, `database`, `sslmode`).
  - **Per piece of work:** the replica giving it to an agent asks credential (`sealAgentCredentials`) to open the login and seal it to that agent. The seal uses HPKE (RFC 9180, `src/utils/hpke.util.ts`, checked against Go's `crypto/hpke`) to the agent's own X25519 key (sent at enrolment, replaced at each renewal), bound to the organisation, agent, connection and work id, for two minutes. connect-runtime relays ciphertext only.
  - **On the agent:** it takes the login only for that work and only for a system its configuration's `targets` allow, and zeroes it after the call. Refusals come back as `login_refused`.
  - **Custody `agent`:** the login stays on the agent's host, the cell refuses to store it, and each use is recorded in the unwrap ledger as `held_by_agent`. Change capture's replication login is always the agent's own.
- **Databases** (D134, D135): Postgres, MySQL (MariaDB too), SQL Server and Oracle through the agent, reads and granted writes, with either login. The databases the agent's tests use (MySQL 8.4, SQL Server 2022, Oracle 23ai Free) start with `npm run sources:up` (docker-compose profile `sources`, about 3.5 GB of images); those tests skip without them.
- **MySQL change data capture** (D136): the agent reads the binary log as a replica named for the slot. Only the tables the manifest streams by capture leave the host, each named with its database (`stream.cdc_schema_required` otherwise). The server must log `ROW`, `FULL` row images and `FULL` row metadata (the dev MySQL does). A binlog capture takes no publication, and dropping it drops nothing on the server. A binary log purged before it was read loses the capture.
- **SQL Server change data capture** (D137): the agent polls change tracking each second in a snapshot transaction. As with binlog, only the manifest's tables are read and each names its schema. Rows carry their net change since the last read, and the source time is when the agent read them. The database must track changes and allow snapshot isolation. A source not logging what capture needs shows as `source_not_configured`, and the agent's log names the setting.
- **Still to come:** industrial transports.

## The web client at the gateway (D138)

- The gateway serves the web client (app/web) at its public origin, beside the API under `/api/v1`: set `GATEWAY_WEB_ROOT` to the client's export (`npm run build` in app/web writes `app/web/out`). Unset, the edge serves the API only. Pages allow connections to this origin only, plus `GATEWAY_UPLOAD_ORIGINS` (comma-separated object store origins, https in production) so a large upload goes straight to its signed URL.
- The export is loaded and indexed when the gateway starts; a root without `index.html` fails the start. Each page's Content-Security-Policy allows only its own inline scripts, by hash.
- **Home's briefing and following** (D139): `GET /api/v1/workspace/briefing` reads the five sections of spec 33.7 together; a section whose source failed says so. People follow another's Cron or object-set view (`/api/v1/workspace/follows`); Crons are shared as saved views are (`/api/v1/crons/:id/shares`), for their visibility and run history only.
- The client's calls are typed by the public route definitions: after adding or changing a public route, run `node src/scripts/webRoutes.script.ts` to regenerate `app/web/src/api/routes.generated.ts` (tests fail until it is current).

## Global tier: directory, status, fleet-control

These run outside every cell and hold no customer data.

- **directory** routes a login by a KMS-keyed hash of the normalised email and an organisation slug to its cell. Cells register cells, organisations, moves and identity hashes. A cell registers only itself and what it holds, a move is made from either end, and the shared directory refuses anything for a sovereign cell. The login page's public listener answers an unknown email with a stable decoy cell, so it never reveals whether an address is registered.
- **status** takes component snapshots from shared commercial cells and publishes a script-free status page; a cell that stops reporting shows as unknown. Dedicated and self-managed cells never appear.
- **fleet-control:** signed, immutable releases (Ed25519 behind a `Signer` interface), two-person promotion with the spec's soak rules, signed channel heads, wave rollouts that halt and roll back on a failing gate, and air-gapped bundles verified file by file. Silo Agent binaries are held in the artefact store by digest and read in parts by each cell's Fleet agent (`readAgentBinary`); an agent channel takes a release only once every binary it names is there.
- **The cell's Fleet agent** runs as fleet-control inside the cell (`FLEET_ROLE=cell_agent`; no database of its own). It carries the cell's agent channel to its Silo Agents (above) and, given the cell's Kubernetes API (`FLEET_KUBERNETES`: `in_cluster`, or the API server's URL), applies the cell's own releases (11.1 to 11.3):
  - Every `FLEET_RELEASE_POLL_MINUTES` (5) it asks which release of `FLEET_CHANNEL` (stable; sovereign in a sovereign cell) the cell runs, and checks it with the Silo release key: the manifest's digest, the cell's build target, capabilities the cell approves.
  - Going forward it runs the migrations as a Job from the release's own image, `node src/db/scripts/migrate.script.ts cell`, with `CELL_MIGRATE_URL` from the Secret `FLEET_MIGRATION_SECRET` (`silo-migrate`, key `url`), which only the Job mounts. `SILO_EXPECTED_MIGRATIONS` makes the script refuse unless the image's files are exactly the release's. Each migration is reported applied. Going back runs none (expand and contract).
  - The release's configuration, flags and model routing (put in fleet-control's store with `npm run fleet:release-document -- <file>` before the release is promoted; a cell channel refuses a release without them) are fetched by digest, checked and kept in the ConfigMaps `silo-release-configuration`, `silo-release-flags` and `silo-release-model-routing` (key `document`), which the services mount.
  - A release may carry the connector catalogue's release (`catalogueDigest`: the signed catalogue release, `{release, signature, keyId}`, put in the store the same way). Going forward the agent fetches it by digest and catalogue installs it, checking its signature with `CATALOGUE_RELEASE_PUBLIC_KEY_FILE`.
  - The images, `FLEET_IMAGE_REPOSITORY/<service>@sha256:<hex>`, roll over the Deployments labelled `silo.io/service`, one service at a time and one zone first (`topology.kubernetes.io/zone`), each until every replica is updated and available within `FLEET_ROLL_TIMEOUT_MINUTES` (15); fleet-control's own goes last.
  - What the cell runs is kept in the ConfigMap `silo-fleet-state`. A failed Job, a stalled roll or a bad document fails the release: recorded, reported as a failing verdict (the rollout halts and the cell goes back to the release before), and not tried again.
  - Its service account needs, in the cell's namespace: get, list and patch Deployments; create and get Jobs; get, create and patch ConfigMaps; list Pods.
  - Health gates (11.2). Every process in a cell whose Fleet agent it can reach (`SERVICE_URL_FLEET_CONTROL`) reports every half minute what its listener answered since it started (requests, refusals, errors, a latency histogram; counts only) under `SILO_RELEASE`, which the agent sets with each image; the outbox relay adds the backlog's oldest age. The agent keeps the latest of each process in memory, so it runs as one replica.
  - Once a release in a started wave has run `FLEET_GATE_WINDOW_MINUTES` (15), each pull judges it: errors at most 1%, a 95th percentile within 2.5 s (once 20 requests were timed), refusals no more than twice the release before's share (or a quarter with none to compare), no pod of it crash looping or restarted three times, the oldest unpublished event at most five minutes old. A missing signal fails. One failing gate is reported at once (the rollout halts and the cell goes back); a passing verdict carries every gate, so it waits on the synthetic question, subscription, Action and revert tests.
  - The synthetic tests (11.2; decision 2026-11-18): the cell's one synthetic organisation (Silo's, `iam.organisations.is_synthetic`, enterprise plan, no customer data, never in the directory or a login), made by auth at the agent's asking with two members whose sessions auth mints for the agent alone (they cannot sign in). The agent serves a fixture source of probes on `FLEET_SYNTHETIC_PORT`, exposed by the cell's ingress at `FLEET_SYNTHETIC_URL` (connect-runtime reaches it through its egress like any SaaS), and drives the cell through the gateway's public listener (`FLEET_GATEWAY_URL`, origin `FLEET_GATEWAY_ORIGIN`) as those two people. Setup, once and resumed from the ConfigMap `silo-fleet-synthetic`: a scope, the connector and connection through conformance, its write class and writes, its change stream (webhook and poll) through the change-stream class, the ontology proposed by one and approved by the other, a saved set, an Action type. Every `FLEET_SYNTHETIC_MINUTES` (10) a round under the release the cell runs: a structured question, a live subscription that must carry the Action's delta, the Action proposed and approved by the two, and its revert. The round's results are the four synthetic gates.
  - Reports (D199), every `FLEET_REPORT_SECONDS` (60), whether or not it applies releases: it registers the cell in the directory at start and hourly (kind, residency, hostname, `FLEET_CELL_STATUS`, active by default; never a sovereign cell); a shared commercial cell reports its eight status components, each judged on what its services answered since the last report; a dedicated cell carries its customer's change policy to fleet-control; a single-tenant cell (dedicated or self-managed) copies Fleet's events about it into its customers' audit logs, once each (`platform.copy_fleet_event`, by Fleet's sequence).
- **SBOM checks (11.1).** "A critical one in a reachable component blocks stable."
  - Each SBOM the manifest names is uploaded after registration (`PUT /staff/v1/fleet/releases/:id/sboms/:sha256`), refused unless its SHA-256 is the manifest's. CycloneDX 1.x and SPDX 2.x JSON; components are kept by package URL.
  - Advisories are a mirror of OSV's exports (`FLEET_ADVISORY_URL`, osv.dev's bucket by default; a UK mirror or a `file:` copy for the sovereign tier). Each ecosystem the live releases use is loaded whole once from `all.zip`, read by range, then kept in step daily from `modified_id.csv`.
  - A component is affected by OSV's evaluation, ordered per ecosystem (Semantic Versioning, PEP 440, dpkg, apk); a range that cannot be ordered counts as affected. Severity: a CVSS v3 score or the database's rating; malicious packages are critical; an unrated record takes the rating of records sharing its alias.
  - A critical finding blocks unless the security officer's VEX (OpenVEX or CycloneDX VEX, `fleet.release.expedite`) states the component not affected or fixed.
  - Promotion into stable, sovereign and the agent channels refuses on a missing SBOM, a feed older than `FLEET_ADVISORY_MAX_AGE_HOURS` (48), or a blocking finding. Findings: `GET /staff/v1/fleet/releases/:id/findings`; a sync now: `POST /staff/v1/fleet/advisories/sync`.
  - Configuration: `FLEET_ADVISORY_URL`, `FLEET_ADVISORY_SYNC_HOURS` (24), `FLEET_ADVISORY_MAX_AGE_HOURS` (48), `FLEET_ADVISORY_ECOSYSTEMS` (feeds kept whatever the releases hold).
- **Cells and their limits (6.3; D203).** A cell takes about 2,000 organisations and 50,000 connections. Each cell's Fleet agent reports its live connections with its registration, and sign-up placement skips a cell at either limit. Hourly, fleet-control records `cell_provisioning_needed` for a residency where no open shared cell is below 75% of both limits and none is being provisioned, and `cell_rebalancing_needed` for a cell past 110%, each once a day, for the cell template and a rebalancing migration. A new cell starts with `FLEET_CELL_STATUS=provisioning`; its agent opens placement (registers it active) after the first synthetic round in which all four lifecycles pass, remembered in the ConfigMap `silo-fleet-placement`.
- **Sovereign agent updates (D202).** A sovereign cell's agents update from agent-sovereign. A release reaches the sovereign tier only in a bundle that cleared staff countersigned, loaded by its own fleet-control, which then promotes it. The cell (its Fleet agent, then connect-runtime) and the sovereign agent build each take it only with the Silo release key's signature on the release and the sovereign key's on the head (`FLEET_SOVEREIGN_PUBLIC_KEY_FILE`; the agent is built with `-tags sovereign -ldflags "-X main.ReleaseKeys=... -X main.SovereignKeys=..."`).
- **Air-gapped bundles (11.4; D201).** On the media: `bundle.json` (the manifest of SHA-256 hashes), `signatures.json` (the Silo release key's, and the sovereign key's countersignature for a sovereign customer) and `artefacts/`: `release.json` (the release exactly as Silo signed it), `release-documents/<hex>`, `agent-binaries/<hex>`, images, SBOMs and model weights. In the install's own fleet-control, `npm run fleet:load-bundle -- <dir> <operator id> <approver id> [channel]` checks the whole bundle before loading anything and refuses it on any mismatch (recorded as `bundle_refused` with why); otherwise it loads the release (never signed again), its documents and binaries, records `bundle_verified` and makes the release the head of the install's channel, approved by a second person. The install's Fleet agent applies it and copies both events into the customer's audit log. The operator's tooling loads the images into the install's registry. The install's fleet-control trusts `FLEET_RELEASE_PUBLIC_KEY_FILE`.
- **Dedicated cells (11.2 wave 5, 11.5).** Stable's waves are the test, canary and shared regional cells. Once they pass, each dedicated cell gets a rollout of its own, one wave of that cell, gated and rolled back alone.
  - The customer is told in advance (`desiredRelease`'s `notice`): the release, the release before, the SBOM difference of the images, the earliest start (`FLEET_CHANGE_NOTICE_HOURS`, 72; a security fix at once) and what holds it.
  - It starts inside one of the customer's weekly windows, in their time zone, and not during a freeze, unless it is a security fix the named change authority approved for that freeze.
  - The policy arrives from the cell (`PUT /v1/cells/:cellId/change-policy`, from its Fleet agent, still to come). A newer release replaces one waiting for its window; a release a cell was rolled back from is not offered again.
  - In the cell, the customer sets it at `/admin/change-policy`: the windows, time zone and change authority (`org.change_window.manage`), freezes (`PUT .../freezes/:freezeId`, `.../end`), and the change authority's own approval of a security fix in a freeze (`POST .../exceptions`, theirs alone). Each freeze set, ended or excepted raises `change_freeze_set`. A shared cell has none. The agent reads it with `listChangePoliciesForFleet`.
- **Fleet's own events (11.6)** are kept in `fleet.events`, appended with each change and hash-chained: releases built, signed, promoted and expedited; rollouts started, failing a gate, rolled back and completed (a dedicated cell's own included); freezes arriving; migrations a cell's agent reports applied; bundles countersigned in the sovereign fleet-control. Staff read them at `GET /staff/v1/fleet/events` (by release or cell) and check the chain at `/staff/v1/fleet/events/verification`. A dedicated cell's agent will read its own (`listCellEvents`) into the customer's audit log.
- Status and fleet-control keep their state in the `status.*` and `fleet.*` tables of the directory database, written by their own roles (`status_writer`, `fleet_writer`), so several replicas agree; advisory locks order the writes two replicas could race on, and channel heads are numbered in sequence by a trigger.

## Running locally

```sh
npm run db:up && npm run infra:up      # Postgres + PgBouncer, Redis, NATS + JetStream, Vault, S3 (SeaweedFS),
                                        # the Pub/Sub emulator and fake-gcs-server
npm run db:bootstrap                    # then migrate: see src/db/README.md
cp .env.example .env                    # every variable a service reads, with local values
npm test                                # everything; needs both of the above
npm run test:unit                       # utils, config, schemas, contracts and architecture; no containers
```

To sign in locally, provision a cell, a key and a first organisation, then run credential and auth:

```sh
npm run provision -- cell --local
npm run provision -- key --provider local --key-uri local:dev        # KMS_LOCAL_KEY set in .env
PROVISION_PASSWORD='a long passphrase' npm run provision -- organisation \
  --slug acme --name "Acme Ltd" --email ada@acme.example --first-name Ada --last-name Lovelace
SILO_SERVICE=credential HTTP_PORT=8082 PG_CONTROL_URL=postgres://svc_credential:local@127.0.0.1:56432/silo_cell npm start
SILO_SERVICE=auth HTTP_PORT=8081 PG_CONTROL_URL=postgres://svc_auth:local@127.0.0.1:56432/silo_cell npm start
```

`npm run db:bootstrap` creates a login per service, password `local`: `svc_auth`, `svc_credential`, `svc_app`, `svc_audit`, `svc_model_gateway`, `svc_outbox_relay`, `svc_maintenance`, `svc_billing`, `svc_catalogue_migrate`, and in the directory database `svc_directory`, `svc_status` and `svc_fleet_control`. The app serves `/sso/callback` and `/sso/complete` for SSO. The gateway also needs `SERVICE_URL_AUTH` and `SERVICE_URL_POLICY`; its `__Host-` cookie needs HTTPS, or `localhost` in a browser.

What each external service is tested against:

| Service | Locally | Notes |
|---|---|---|
| bus-durable, commercial | Pub/Sub emulator | The Pub/Sub client reads `PUBSUB_EMULATOR_HOST`. |
| bus-durable, sovereign and self-managed | NATS JetStream | |
| Object storage, commercial | fake-gcs-server | Through `GCS_EMULATOR_ENDPOINT`, not `STORAGE_EMULATOR_HOST`: the client library uses that variable inconsistently, so either its JSON calls or its uploads miss the emulator. |
| Object storage, self-managed | SeaweedFS (S3) | |
| Keys, development | Vault in dev mode, under `vault/credential.policy.hcl` | The tests create keys and the policy with the root token, standing in for Terraform. |
| Cloud KMS | A dedicated throwaway project, in CI on main only | It has no emulator. `tests/infra/gcpKms.test.ts` skips unless `TEST_GCP_KMS_KEY` is set (and `TEST_GCP_KMS_MAC_VERSION` for the MAC tests). |
| PKCS#11 HSM | A fake module in the test, always; SoftHSM when given | `tests/infra/pkcs11.test.ts` drives the adapter against a fake that behaves as Thales documents a Luna in FIPS mode (or a generic module), and against a real module only when `TEST_PKCS11_MODULE` is set. A real Luna is proved at commissioning: the credential service wraps and unwraps under the profile before it starts. |

## Choices the spec leaves open

Each one is configuration or a single constant, so a later decision changes one place.

Decided 29 October 2026 unless marked otherwise.

- **Argon2id:** 64 MiB memory, 3 passes, 1 lane, 16-byte salt and 32-byte hash, stored in PHC form so a parameter change triggers a rehash at login (spec 55.3).
  - At most 4 hashes run at once per process and 32 wait (`ARGON2_MAX_CONCURRENT`, `ARGON2_MAX_QUEUED`). Past that, a login is refused with a retry time, so the endpoint cannot be used to exhaust memory.
  - `PasswordHasher` reports each hash's duration, for the auth service to log on the reference server.
- **Passwords:** at least 12 characters, checked against the in-cell Pwned Passwords dataset when set (`BREACH_LIST_DIR`).
- **Rate limits:** per 10 minutes, 30 login attempts per client address, 10 per email address, and 10 MFA codes per session; 5 reset requests per email address an hour.
- **Sessions and accounts:**
  - Sessions expire after 30 minutes idle or 12 hours in total. An organisation may shorten either (`iam.organisations.session_idle_minutes`, `session_absolute_minutes`) but never lengthen it.
  - Only what the person does counts as activity: requests and messages from their client. Live WebSocket deltas and heartbeats do not.
  - Reset links last 30 minutes and invitations 7 days, both single use.
  - An account locks for 15 minutes after 10 failed logins.
- **Tokens:**
  - 256 random bits as `silo_<kind>_<base64url>`, stored only as SHA-256. The prefix lets the redaction scan recognise a leaked token.
  - SCIM tokens are `<organisation_id>.<random>`.
- **TOTP:** the RFC 6238 defaults: SHA-1, 6 digits, 30-second steps, one step of drift either side. Reuse inside the window is refused: the auth service accepts a code only by moving `iam.mfa_factors.last_used_step` forward with a compare-and-set, so two logins racing with one code cannot both succeed.
- **Audit hash chain:** the exact construction is in `src/utils/auditChain.util.ts` and the design doc (`audit.audit_events.row_hash`).
- **Executor bounds:** 100,000 rows per source step (`maxRowsPerSourceStep`) and 50,000 rows in the merged result a person receives (`maxResultRows`), 256 MB per local step, 60 seconds wall time, 1,000 fan-out per hop, 16 concurrent plans per organisation. The spec names the bounds but not their values.
- **Wire details of the service shell:**
  - **Headers:** `Idempotency-Key` (the IETF draft name), `x-correlation-id`, and W3C `traceparent` for traces.
  - **Errors:** every error is one body, `{ error: { category, code, message, retryable, retryAfterSeconds?, details?, issues? } }`, with `Retry-After` whenever a refusal names a wait.
  - **Workload identity:** `spiffe://<cell id>/service/<name>`.
  - **Defaults:** 1 MiB request bodies, a 30-second request timeout, a 5-second drain, a 25-second shutdown, 3 attempts for safe calls.
- **Log redaction:** an allowlist of fields, the spec's target (open decision 60), with key-name redaction (`redactKeys`) available for structures.
- **Gateway limits** (2 November 2026): 3,000 requests a minute per client address and 600 per session, 8 sockets per session per pod, a 15-second heartbeat and session check, 20 client messages a second.
- **Metering** (2 November 2026): a 10-minute rephrase window, a simulation re-run at 0.5 of a run (open decision 73.7), and allowance periods by calendar month in the organisation's time zone. Storage included per plan is 0 until open decision 74.2.
- **Expression bounds** (2 November 2026): 10,000 steps and 10 ms per expression; the `records` block gets 100,000 steps and 100 ms.
- **Query** (2 November 2026): at most 4 hops per plan (open decision), and a plan of more than 2 hops is an advanced compile. The compile charge is taken before execution, as spec 26 orders it, so a run refused at execution leaves the compile charged; spec 26.9 says refusals cost nothing (to confirm).
- **Lineage and live state** (2 November 2026): lineage reads to depth 32 and 2,000 nodes by default; propagation walks to depth 256 with a 60-second second pass; live bounds of 100,000 objects per subscription, 250,000 and 20 subscriptions per user, 1,000,000 live objects per organisation, 64 watched properties.
- **Scenario branches** (10 November 2026, to confirm): a closed branch keeps its bases 730 days by default, as receipts are (open decision 39.14), and the creator may choose 0 to 3,650. A staged Action's effect in the walk: a delete makes its target unavailable, a date or instant moved later delays it by the largest move, and anything else propagates nothing (the branch says why). A decision on a conflict holds until the staged Action is re-staged; the proposal still reads prior state afresh and shows the approver the diff. Staging on a record an earlier staged Action creates is refused (open decision 39.14).
- **Write-back** (2 November 2026): receipts kept 730 days (open decision); bulk approval defaults of one approver, two at 100 rows; mutations of 10,000 rows or more refused until the canary exists.
- **Recognition thresholds** (2 November 2026): outlier 3.5 (5 under 30 objects), missing value the larger of 0.5 and 1 − 3/√N, duplicate value 2, disagreement 1; one notification per run that raised anything.
- **Scheduler and files** (2 November 2026): `SCHEDULER_MIN_INTERVAL_MINUTES` 15 (open decision 40.12), `SCHEDULER_CONCURRENCY` 4, escalations acknowledged within 72 hours, `FILES_MAX_EXPORT_BYTES` 5 MiB, export retention unset (indefinite) unless `FILES_EXPORT_RETENTION_DAYS` is set.
- **Connector maintenance** (2 November 2026): a rename or a lost pushdown is repaired without review once its sandbox run passes, as spec 17.3 says (to confirm).
- **Admin portal** (7 November 2026, to confirm): staff sessions last 15 minutes idle and 8 hours at most (the spec gives only break-glass sessions' 4 hours); customer approval comes after the staff approval, and an emergency session reads only; a session's recording is its audit events; changing the approval policy raises `operator_access_policy_changed`, which chapter 77 does not list.
- **AI FDE** (7 November 2026, to confirm): a holder of `fde.engage` confirms a stage's exit (50.1 says only "a person"); confidence bands are high from 0.85 and medium from 0.6 for every kind until measured acceptance sets them per kind (52.3); working days are Monday to Friday in UTC (chapter 54 does not define them); the orchestrator ticks every 15 seconds.
- **Policy** (2 November 2026, to confirm): administration events go to `audit.audit_events`, so a scope admin reads their subtree's administration (spec 63.5); declaring a purpose needs eligibility only; a field policy aimed at a marking applies to readers who lack it; a connection's owner reaches it with write access and grants it within the owning scope; a super admin gets no data access implicitly; defining roles needs `admin.delegate` organisation-wide and field policies `marking.manage`; the seeded Admin role carries `marking.manage` (spec 58.10).

## Not built yet

- **A PKCS#11 HSM adapter.** The sovereign provider is undecided (spec 6.5, open decision 5), so configuring one refuses to start. Fleet-control refuses a signing key file in production for the same reason. The sovereign cell stays off US-owned clouds (confirmed 2026-11-09), so it does not use Cloud KMS.
- **Private links, still to come:** OAuth token endpoints and customer SSO providers reached through a private link (connector requests are); resolving private hostnames is DNS infrastructure (Cloud DNS peering), not this repository.
- **Cloud KMS runs untested until CI exists.** Its test is written and skips locally; there is no CI configuration in this repo yet to run it on main against the throwaway project.
- **Every Node service of the catalogue is built:** `src/app.ts` lists all 61. `silo-agent` is a separate program, not in this repository. `docs/siloSpecCoverage.doc.md` is the chapter-by-chapter check against the whole spec.
- **Admin portal, still to come:**
  - `tenant_read`: reading a tenant's record values through the reporting replica in a recorded session (7.1). A session can be granted at this level, and reaches what `metadata_read` does;
  - more of the tenant reads whose contracts already list admin-portal as a caller (lineage, policy administration and governance reads, resolution, change-stream management); each needs its service to accept a running session, as audit, ontology and metering do;
  - the payout calculation run (chapter 71, 75);
  - provisioning organisations, which a script does today (it registers them with the directory);
  - the AI FDE cell-wide metrics view;
  - the staff console's screens (this repository is the server).
- **AI FDE, still to come:**
  - drafting a connector from a specification URL or documentation the engagement itself holds (stage 2 takes a builder draft a person started);
  - time to first live Clone and first app, and the post-handover reversal rate (the state plane's subscription events, Studio's open events and the tie from an engagement's artefacts to their revisions are not raised or recorded yet);
  - which days are working days (Monday to Friday in the organisation's time zone; the spec does not say).
- **Endpoints with no caller yet:** `tests/architecture/reachability.test.ts` lists each one and why (invariant 12). Most wait for the cell-side Fleet agent; `reportSourceDrift` waits for connect-runtime and the executor, and `registerOrganisation` for organisation provisioning outside the script.
- **Tenant migrations, still to come:**
  - carrying Silo contents held in BigQuery (Warehouse, Object Index and Import tables live in the source cell's projects; the per-organisation Warehouse project can be re-parented with `moveProject`, the rest rebuilt from sources and the moved files);
  - removing the directory's identity entries for people the source purge deleted (login still routes, by asking which organisation);
  - telling the customer of a rebalancing notice by notification, beyond the audit event;
  - the gateway refusing every write during the window: today Actions and Crons pause, as the spec says, but an edit made in the source between the export and the directory move is not carried.
- **Organisation export, still to come:** artefacts built as streams (each is built in memory, bounded by `ORG_EXPORT_MAX_BYTES`), and Workspace files (spec 41), which 2.6 does not list.
- **Seats, still to come:** sending seat releases to the payment provider at the period's end. Contract seats are built.
- **Warehouse and Object Index between syncs:** a change stream's observations reach both through Capture's queue (a Warehouse Silo's nominations and an Object Index's definitions are queued too; their drains take change-stream observations only). warehouse-sync (`applyWarehouseObservations`) updates the current row's changed columns and adds a history row per change, by hash; index-builder (`applyIndexObservations`) sets an existing entry's value and clears its row hash for the next refresh, an unindexed object waiting for it. Link tables are written whole after their from-type's sync. The retention sweep (`sweepWarehouse`) deletes history observed before the window and drops a retired column (`warehouse_tables.retired_columns`) once the window has passed since its property left.
- **Warehouse, still to come:**
  - query routing to the Warehouse or an Object Index as sources (an Import Silo answers as one: see siloes-import);
  - writing a ledger copy again after its write failed;
  - re-keying after a hand-over is the customer's own step: an open point, not Silo's.
  - The executor's result bound caps the size of a type it can backfill, and of a type the Object Index can refresh.
- **BigQuery metering, still to come:** it lists a shared project's jobs once per Silo; one listing per pass would scale better. GCS bytes for Import files come with siloes-import.
- **Object Index markings:** an entry carries its type's, connections', Silo's and properties' markings. Markings on individual property mappings are not yet carried.
- **Wiring, still to come:** connect-runtime calling `reportSourceDrift` (the executor reports type mismatches and auth, missing-object and validation refusals, never awaited).
- **Policy, still to come:** approval-needing purposes, a membership named for a marking as its declassifier, caching principal decisions, purpose definitions passing to a super admin on removal (a purpose definition records only who created it).
- **Auth, still to come:** SCIM Groups (how a group maps to roles and scopes is not specified), SP-signed AuthnRequests, encrypted assertions, single logout and SP metadata (they need an SP certificate: from the deployment, or an X.509 library); unlinking an identity (not specified); registering organisations with the directory outside the provisioning script (self-serve sign-up is not specified).
- **Gateway, still to come:** the live bounds of spec 30.5, and API clients on the live WebSocket.
- **Ontology, still to come:** entity resolution and field authorities (with the query engine), markings on elements, field aliases, action types (with actions), value overlap (22.4), concept templates, description embeddings, and system-triggered derivation. Ontology reads a connection's manifest from Connect's tables directly (read-only, under row-level security) rather than through connect-registry's contracts.
- **Connect, still to come:** the change-stream conformance class, SOAP and the other protocols, GraphQL introspection and mutations, CDC through the agent, dynamic client registration, repairing catalogue connectors, and observing SQL and GraphQL structure.
- **Clones, still to come:** object view layouts, AI-generated apps; for the 3D asset view, mesh compression and levels of detail generated at upload (29.5 targets: they need a mesh library, not yet approved), and a saved camera (29.6, every layout).
- **Recognition and simulation, still to come:** the two unnamed federated detectors, association analysis and investigations, lens sharing (its coverage needs a decision made for the recipient, which policy gives only with their own session), resource edges and reduced capacity, the unavailable-for-a-period form, the Clone Canvas overlay of a branch (the web client), and purging branch bases when a connection is purged (no connection purge exists yet).
- **Scheduler, files and render, still to come:** finding conditions, ending a deleted Cron's stream subscriptions, Crons that mutate a resolvable type or set parameter values, uploads (with Siloes), and 3D canvas exports to PDF (refused, saying so; a PNG of the 3D view is the exporter's browser's). A PDF of a map prints no base map, and says so; a PNG, drawn by the exporter's browser, prints the base map it shows with its attribution.
- **Query, still to come:** partial aggregate pushdown for a resolvable type (it needs the partition of objects across sources known to be disjoint), computed properties that read linked objects, a compiled plan over an interface (sets over one are run), branch compile, and a CI gate that each test fails against a seeded defect (spec 26.13).
- **Write-back, still to come:** recreating cascade-deleted records on revert (their full prior records are not captured yet), a redirect from the recreated record's new derived id to the identity it keeps, posting a webhook through the agent for a private target (the Fleet agent), a declared status endpoint that lets a webhook's receipt record effect, and mobile push for side effect notifications (it needs a push provider).
- **Live state, still to come:** CDC, source coalescing over 1,000 changes a second, and resolvable types, traversals and saved views as live sets.
- **Notify, still to come:** mobile push (a push provider is not chosen), live push, a send queue, and retrying an email the relay refused three times (the item stays undelivered and is logged).
- **Billing, still to come:** auto top-up, seat sync to the provider, provider cost in pounds (needs a price per model route; the margin calculator uses `BILLING_COMPILE_PRICE_PER_MILLION_TOKENS` until then), Silo storage invoiced at cost plus 10% (74.1), early termination of a contract (staff can amend its term end), telling staff of an upcoming renewal, and contracts in the sovereign cell, where billing is compiled out with the payment capability (6.5 has entitlements from the contract and payment on the manual path).
- **Global tier:** the rest of the cell-side Fleet agent (cell releases, migrations, gates, change policy), the hosted status page and artefact buckets, change windows, purging old notices.
- **Redis operations owned by later services.** Their keyspaces and bounds are declared now:
  - capture queue streams from the state plane (the executor produces and siloes-capture consumes already);
  - live object fields (state-plane);
  - the deprovisioning script over sessions and permission sets (auth);
  - result-cache invalidation on change-stream events (executor, spec 24.6).

## Operations (D250 to D253)

- **Load shedding and quotas** (12.4): `SHED_START_MS` and `SHED_STEP_MS` set where each process starts refusing work, lowest class first (`SHED_ORDER`); a contract names its class with `shed`. `GATEWAY_REQUESTS_PER_ORGANISATION` bounds one organisation's requests a minute; change events are bounded per organisation and per connection a second.
- **Backups and restores** (8.2, 12.5): run `node src/scripts/restore.script.ts manifest` with each backup, and after a restore `check <manifest key>` then `replay <restore point>` before opening the gateway. The purge ledger the replay reads is written by every purge and delivered to object-backup by the outbox relay, which needs object storage for it.
- **Paging signals** (13.2): `redis_*_keys_without_ttl` and `credential_unwraps_5m` beside the outbox and request signals. The full operations handbook is `docs/siloOperations.doc.md`.
