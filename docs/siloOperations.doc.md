# Silo operations: service levels, on-call, incidents and recovery

For Silo's operations staff and on-call engineers. It turns chapters 12 and 13 of the master
specification into how a cell is run: what is measured, what pages someone, what they do, and how
a cell is backed up, restored and tested. The code these procedures rely on is named; the
deployment (the cloud projects, the monitoring backend, the paging tool, the status page) is
configured outside this repository and must match what is written here.

Settled 23 November 2026 (design D250 to D253).

## 1. Service level objectives (12.1)

Every figure is a target until a cell has run for a month and the target is checked against what
it measured. A refusal (a bound, shedding, an unreachable source) is a correct answer, not a
failure; source latency is excluded and reported per connection.

| Indicator | Target | Measured from |
|---|---|---|
| API availability | 99.9% monthly in commercial cells; 99.95% where contracted (dedicated, sovereign) | Gateway public routes: requests answered without a 5xx that is not a refusal (`capacity`, `bounds`, `source_unreachable` are refusals), over all requests. The process signals (`requests.total`, `requests.errors`) and the HTTP spans give the same count. |
| Login availability | 99.95% monthly | The same, for `gateway.signIn`, the SSO return routes and `auth.login`. |
| Live clone delta latency | p50 under 500 ms, p99 under 2 s, source event to client | The change-stream intake span to the gateway's live socket send, by correlation id. |
| Compile latency | Standard p50 under 3 s, p95 under 8 s; advanced p95 under 20 s | Span `compile.compileQuestion`, split by plan class. |
| Query band A (fully pushed down) | Silo overhead p95 under 300 ms | Span `executor.runPlan` less its source-step spans. |
| Query band B (local merge or aggregate) | Silo overhead p95 under 1.5 s | As band A. |
| Query band C (traversal across three or more sources) | End to end p95 under 10 s, else refused at the wall-time bound | Span `executor.runPlan` for plans with three or more sources. |
| Action execution | p95 under 30 s from approval to receipt, excluding source time | Spans `actions.executeMutation` to the receipt write, less connect-runtime's source spans. |
| Audit durability | No committed change without its audit event | By construction (the event is written in the change's transaction, through `platform.outbox`); the outbox backlog page (below) watches delivery. |

Each SLO is defined in the monitoring backend with multi-window burn-rate alerts: page when the
error budget burns 14.4 times too fast over both one hour and five minutes, or 6 times over both
six hours and thirty minutes; open a ticket at 1 time over three days.

## 2. What pages (13.2)

Primary and secondary on-call at all times for commercial cells. The sovereign cell has its own
UK-resident, SC-cleared rota, which no one else can be paged into. Every page names its runbook
(section 4).

| Page | Signal | Fires when |
|---|---|---|
| SLO burn | The SLOs above | The burn-rate alerts in section 1. |
| Release gate failure | The cell's Fleet agent verdicts (D197) | A gate fails during a rollout: the agent has already stopped the rollout and taken the cell back. |
| Audit backlog | `audit_outbox_oldest_seconds`, `audit_outbox_pending` (outbox relay gauges); `silo.outbox.dead_lettered` | The oldest unpublished event is over 5 minutes old, or any row is dead-lettered. |
| Redis keys without a TTL | `redis_session_keys_without_ttl`, `redis_data_keys_without_ttl` (auth), `redis_state_keys_without_ttl` (state plane): each instance's key audit, at most every ten minutes (D252) | Any is above 0. |
| Redaction match | `redactions` in the process signals; `silo.redaction_violations` (13.1; D209) | Any. A redaction match is a security incident (SEV1 until shown otherwise). |
| Unwrap anomaly | `credential_unwraps_5m` (credential service, D252); the ledger `iam.credential_unwraps` | Over three times the same hour's median of the previous four weeks, or any unwrap outside a request (no correlation id in the ledger). |

## 3. Incidents (13.2)

| Severity | Definition | Response |
|---|---|---|
| SEV1 | Cell unavailable, wrong answers served, cross-tenant exposure, or a record value outside 8.5 | Incident commander in 15 minutes; status page in 30; security notices within contract terms, and within 72 hours of awareness where personal data is involved |
| SEV2 | Major feature unavailable, or an SLO breach for a cell | Incident commander in 30 minutes; status page in 1 hour |
| SEV3 | Degradation for some organisations | Owner in working hours |

A wrong answer that looks right is the failure Silo is designed against, so it is SEV1.

Roles: the incident commander decides and owns the timeline; a communications lead owns the
status page and customer notices; a scribe keeps the record. One person may hold two roles for a
SEV2 or SEV3, never for a SEV1.

Steps:
1. Declare, with the severity. The first page's responder is incident commander until handed over.
2. Stop the harm first. Halt a rollout (Fleet), halt a connection, or shed load (`SHED_START_MS`
   lowered on the affected services). For exposure, revoke the sessions or grants involved.
3. Post to the status page. It reports each cell's components separately, names no customer, and
   is hosted apart from every cell. The sovereign cell has its own page.
4. Fix or roll back. Database changes go forward only; a release is rolled back through Fleet.
5. Close, and write the review within 10 working days for SEV1 and SEV2. Send affected customers
   a summary.

Access to a customer's tenant during an incident is only through a break-glass session (13.3).
Purpose `incident_response`, level `metadata_read` unless the incident needs more. Two staff
approvals are needed, and the customer approves where contracted, and always on the sovereign
cell. An emergency session is approved by a second member of staff instead, disclosed to the
customer at once, and is never `tenant_act`.

## 4. Runbooks

- **SLO burn.** Find the failing indicator on the cell's dashboard.
  - If it began with a release, the Fleet agent's gates should already have caught it; if not,
    halt the rollout.
  - If it is one source's latency, it is not Silo's budget: check that the connection's own
    report shows it.
  - If it is load, check the shed level (event-loop delay per process) and scale the service.
- **Release gate failure.** The agent has taken the cell back. Read the verdict (which gate, which
  processes) and keep the release out of the cell until its cause is fixed.
- **Audit backlog.**
  1. Check that the outbox relay is running and reaching bus-durable, then look at
     `last_error_category` on the oldest rows.
  2. A `schema_mismatch` or `unregistered_message` row holds its key until fixed. Fix the producer
     and redeploy; never delete the row.
  3. A dead-lettered row is a lost audit event or a lost purge-ledger entry. Raise a SEV2, and
     recover the event from the producing change.
- **Redis keys without a TTL.** Run the key audit on the instance (`RedisStore.auditKeys` with
  `match` narrowed to the prefix in the samples), then fix the writer. A key without a TTL in
  redis-session or redis-state breaks the guarantee that those stores hold nothing past their
  lifetime (8.3).
- **Redaction match.** Treat as SEV1 (a value may be in telemetry).
  1. The signal names the organisation and the pattern kinds, never the value.
  2. Find the log lines by organisation and time, and delete them from the telemetry store.
  3. Fix the code path and add its field to the redaction list.
  4. Notify the customer within contract terms.
- **Unwrap anomaly.**
  1. Read `iam.credential_unwraps` for the window: which connections and which callers.
  2. A spike that matches a customer's load (a large sync) is expected. Unwraps with no request
     behind them, or from a caller with no reason to unwrap, are a security incident.
  3. Rotate the affected credentials, and revoke the service's identity if it is compromised.

## 5. Backups and recovery (8.2, 12.2, 12.3)

| Store | RPO | RTO | Method |
|---|---|---|---|
| pg-control, zone loss | 0 | 2 minutes | Synchronous standby failover (automatic) |
| pg-control, region loss | 5 minutes | 4 hours | Restore in the standby site of the same residency |
| pg-capture | 5 minutes | 8 hours | As above |
| Redis stores | Not applicable | Minutes | Rebuilt: sessions from Postgres, queries retry, live groups resnapshot |
| object-files | 0 for committed objects | 1 hour | Object versions, or object-backup |
| bq-siloes, gcs-siloes | Provider durability | Provider-dependent | Provider recovery in the same location |
| object-index | Not applicable | Hours | Rebuilt from the sources |
| bus-durable | 0 for published messages | Minutes | Provider redundancy; the outboxes republish |

Backups: point-in-time recovery for 35 days and monthly snapshots for 12 months, written to
object-backup under write-once retention. With every snapshot, the backup job runs:

    node src/scripts/restore.script.ts manifest

This keeps every pg-control table's row count, from one database snapshot, in object-backup
(`cell/row-counts/<taken at>.json`) and prints the key. The job records the key beside the backup.

The purge ledger (D251): every purge writes a ledger entry in the transaction that completes it,
and the outbox relay delivers it to object-backup (`cell/purge-ledger/<yyyy>/<mm>/<dd>/`).
Purges of a moved organisation are covered by its purge receipt (`cell/tenant-migrations/`). A
restore of pg-control does not rewind any of these.

**Restoring a cell after a region loss** (12.3: never across a cell boundary; the sovereign cell
only into a second UK sovereign site under the same staffing and key rules):
1. Restore pg-control, then pg-capture, from object-backup into the standby site, from the cell
   template, with the cell's keys available there. The cell keeps its identifier and hostnames,
   so agents and OAuth callbacks need no change.
2. Keep the gateway closed to traffic.
3. Check the restore against the manifest it was restored to. Every table must match; a
   difference is investigated before going on:

       node src/scripts/restore.script.ts check <manifest key>

4. Replay the purge ledger from the restore point. This must finish without error before step 5:

       node src/scripts/restore.script.ts replay <restore point, ISO 8601>

   Each purge made since is done again by the service that owns it: Silo wipes, receipt values,
   Files deletions, plans and models, and moved organisations. Each only deletes, so running it
   twice is safe.
5. Open the gateway. Redis rebuilds itself; live clients resubscribe and resnapshot.
6. Write the recovery into the incident review, with the RPO and RTO achieved.

## 6. Recovery testing (12.5)

- **Monthly, every cell:** an isolated restore of pg-control from the latest snapshot into a
  throwaway instance that nothing routes to. Then:
  - run `check` against that snapshot's manifest;
  - run `replay` from the snapshot's time, and record the counts it gives back.
  The test passes when every table matches and the replay finishes. Destroy the instance
  afterwards.
- **Quarterly:** a zone failure exercise per cell. Fail the primary zone's database and one
  zone's nodes, and measure failover against the 2-minute RTO.
- **Annually:** a regional recovery per cell, sovereign included, following section 5 end to end
  in the standby site.

Results go to sovereign customers as a standing report, and to Enterprise customers on request.

## 7. Capacity, quotas and load shedding (12.4; D250)

- **Shedding.** Each process measures its event loop's delay (p99, each second). From
  `SHED_START_MS` (default 200 ms), each further `SHED_STEP_MS` (default 50 ms) refuses the next
  class of work. The order, first to last: recognition runs, index rebuilds, simulations, export
  rendering, new subscriptions, new compiles, saved view runs, Crons, Action execution, session
  authentication.
  - Approvals, revert and audit are never shed.
  - A shed request is refused as `capacity.shed` with a retry time.
  - A shed Cron records a missed run (`automation_run_skipped`, reason `capacity`) and is not
    backfilled.
  - Index refreshes, organisation exports and pipeline schedules wait for a later tick.
- **Quotas per organisation.**

  | Quota | Default | Setting |
  |---|---|---|
  | Requests at the gateway | 30,000 a minute | `GATEWAY_REQUESTS_PER_ORGANISATION` |
  | Concurrent plans | 16 | `EXECUTOR_CONCURRENT_PLANS_PER_ORGANISATION` |
  | Model calls in flight | 8 | `MODEL_PER_ORGANISATION_CONCURRENCY` |
  | Live objects | 1,000,000, or the contract's | |
  | Change events | 5,000 a second (and 1,000 per connection) | |

  A change delivery over its quota is refused whole, so a provider retries its webhook and the
  agent keeps the changes in its spool.
- **Capacity.** Each cell tracks organisations, connections, agents, WebSockets, live objects,
  executor concurrency, model tokens and pg-control size weekly. At 75% of tested capacity a
  capacity action opens. Tested capacity comes from load tests in a dedicated load cell before
  general availability and after every hot-path change.

## 8. Staff and access (13.3, 13.4)

- Staff have no standing access to customer data. The audit trail is the record of a staff
  session (decision 23 November 2026): every request is an event, written before it is made and
  kept at least 12 months.
- Staff access is reviewed quarterly and removed on departure.
- Personnel vetting (65.4):
  - BPSS for everyone with production access;
  - SC for sovereign operators and anyone with Fleet deployment rights to the sovereign cell;
  - DV where a contract requires it.

## 9. Key management: commissioning the HSM (61; D90, D206)

Commercial cells keep their keys in Cloud KMS at the HSM protection level (Cloud HSM, europe-west2).
The sovereign cell, and a customer's own installation where it uses an HSM, keep them in an HSM
reached over PKCS#11. The sovereign cell's HSM is a Thales Luna. Keys never leave the HSM, and Silo
never creates, changes or deletes one: it finds each key by its label, and fails if a key is
missing or cannot do its job.

**What the partition must hold.** The partition's Crypto Officer creates these, in the HSM, before
Silo is deployed:

| Key | Type | Used for | Named in Silo by |
|---|---|---|---|
| Wrapping key | AES, secret, able to encrypt and decrypt | Wrapping every data key that seals a secret (envelope encryption; AES-GCM with the row's binding as additional data) | `pkcs11:object=<label>`, registered as the cell's key version (below) |
| Directory key | Secret key able to sign with SHA256-HMAC | Hashing email addresses for routing in the directory | `KMS_DIRECTORY_KEY_URI` |
| Import key pair | RSA 3072 or 4096 bits, both halves under one label | Customers bringing their own key material (RSA-OAEP with SHA-256; only the public half leaves the HSM) | `KMS_IMPORT_KEY_URI` |

**Settings** (validated at start-up; a missing one refuses the start):
- `KMS_PROVIDER=pkcs11_hsm`.
- `PKCS11_MODULE_PATH`: the vendor's PKCS#11 library, installed with Thales's Luna client on each
  host that runs the credential and directory services.
- `PKCS11_PROFILE=luna` (required for a sovereign cell; `generic` for any other HSM).
- `PKCS11_TOKEN_LABEL`: the partition's label. Required with the Luna profile; a slot number is not
  accepted, because Luna's slot numbers move with the client configuration and HA groups.
- `PKCS11_PIN`: the partition's **Crypto User** PIN, supplied as a secret. Silo logs in as the Crypto
  User, which can use keys and can never create or change them; never give it the Crypto Officer's.

**Commissioning, in order:**
1. Install the Luna client on the hosts, connect it to the HSM (or the HA group) and confirm the
   partition is visible by its label.
2. Create the three keys above in the partition as its Crypto Officer.
3. Deploy with the settings above. At start-up the credential service checks every key it may use
   and, with the Luna profile, wraps and unwraps a test value in the HSM, so a key that is missing,
   cannot do its job, or behaves differently from what the profile expects stops the start with
   `startup_refused_no_kms_key` and the reason. The directory service checks its key computes a MAC.
4. Register the wrapping key as the cell's key version: a member of Silo staff holding
   `key.rotate` starts a key rotation naming `pkcs11:object=<label>` (staff API, credential
   `startKeyRotation`). It is verified in the HSM first.
5. Run the real-hardware test once against the partition, under the Luna profile, and keep its
   output with the commissioning record:
   `TEST_PKCS11_MODULE=<client library> TEST_PKCS11_PROFILE=luna TEST_PKCS11_TOKEN_LABEL=<partition>
   TEST_PKCS11_PIN=<Crypto User PIN> TEST_PKCS11_WRAP_LABEL=<wrap key> TEST_PKCS11_MAC_LABEL=<directory key>
   TEST_PKCS11_IMPORT_LABEL=<import key pair> node --test tests/infra/pkcs11.test.ts` (in app/server).
   It logs in as the Crypto User, wraps and unwraps with the HSM's own IVs, refuses an unwrap under
   the wrong binding, computes a MAC, and reads the import key's public half.

**Rotation.** A new wrapping key is created in the HSM, then registered by starting a key rotation
as in step 4: it becomes active, the old version decrypt-only, and a sweep re-wraps each data key
inside the HSM without opening any ciphertext. The old version is retired once nothing references
it. Every organisation's audit log records the rotation.

**Failover.** If a networked HSM drops the session (an HA failover, a lost link), Silo opens a new
session and logs in again once before an operation fails.

**Not yet proven on real hardware.** The Luna profile was built from Thales's documentation and
tested against a simulated Luna in FIPS mode, at firmware before and from 7.9.3. Two details have
not run against a real Luna: the Crypto User's login type, and the form in which Luna returns the
IV it generates. Step 3 and step 5 prove both. A mismatch fails safe (the service does not start,
and says why) and is a small change to the adapter. Run them before the sovereign cell takes
customer data.

## 10. Behind the customer's own ingress on 443 (self-managed and on-premises)

Where Silo is installed in a customer's network, it sits behind their existing load balancer or
reverse proxy on TCP 443, so their front door stays the one place traffic enters. The ingress routes
by the TLS server name (SNI) to two hostnames, for example:

| Hostname | Goes to | How the ingress treats it |
|---|---|---|
| `silo.<customer domain>` | the gateway's public listener (`GATEWAY_PUBLIC_PORT`) | Ends TLS with the public certificate, adds the client's address to `X-Forwarded-For`, and re-encrypts to the gateway, which keeps its own certificate (production requires one). WebSocket upgrades pass through (the live socket, `/api/v1/live`). |
| `agent.<customer domain>` | the agent endpoint (`AGENT_ENDPOINT_PORT`) | **Passes the TCP stream through untouched** (SNI passthrough, no decryption). The agent's mutual TLS must end at Silo. |

**Settings:**
- `GATEWAY_PUBLIC_ORIGIN=https://silo.<customer domain>`: the one origin the web client is served
  from; state-changing requests and WebSocket handshakes must come from it.
- `TRUST_PROXY_HOPS`: the number of proxies that append to `X-Forwarded-For` in front of the gateway
  (1 for one ingress). The gateway takes the client's address that many hops from the right, so a
  client cannot choose its own address; per-address rate limits and sign-in protection depend on it.
- Each agent's configuration: `endpoint` is the ingress (`agent.<customer domain>:443`), and
  `serverName` defaults to that hostname, which is what the ingress routes by. Agents reach it
  through a corporate HTTP CONNECT proxy if they have to (`proxy`).

**What not to do:** do not let the ingress, or any proxy between the agent and it, decrypt the
agent's hostname. A TLS-inspecting proxy breaks mutual TLS by design: the agent refuses the
connection and its error names the issuer of the certificate it was shown, so the network team can
exempt the hostname from inspection. Do not pass the gateway through untouched either: the gateway
would then see every client as the ingress's own address, and the per-address limits would count
everyone as one client.

**Proved by** `tests/services/ingress.test.ts`: one front port routing by server name; the Go agent
binary enrols and holds its tunnel through the passthrough; an ingress decrypting the agent's
hostname is refused and named; two clients are counted apart by the gateway while a client's own
`X-Forwarded-For` is ignored; the live WebSocket upgrades through it. A customer's actual ingress
(F5, HAProxy, NGINX, a cloud load balancer) still needs its own check at installation: an agent
enrols, a person signs in, and Home's live updates arrive.

## 11. Owned outside the code

These are the company's to stand up, and each must match this document:
- the paging tool and the two rotas;
- the monitoring backend's SLOs and alerts (section 1);
- the status pages (one for the commercial cells and one for the sovereign cell, each hosted
  apart from every cell);
- the backup jobs (section 5) and the recovery exercises (section 6);
- the load cell;
- the vetting programme;
- the HSM: the Luna hardware or service, its partition, its three keys and the commissioning
  record (section 9).
