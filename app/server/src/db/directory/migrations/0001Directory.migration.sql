-- Directory 0001: routes a login to the cell that holds the organisation or user.
-- Separate database: the global tier for hosted cells, or the local directory of a
-- self-managed install (review D6). No customer data: no plaintext email, no
-- organisation name, no logo. Runs as directory_migrate.
-- Design: docs/siloDatabaseDesign.doc.md, directory database (spec 55.1), review R1.

do $$
begin
  if current_user <> 'directory_migrate' then
    raise exception 'directory migrations run as directory_migrate, not %', current_user;
  end if;
end
$$;

alter default privileges for role directory_migrate revoke execute on functions from public;

create schema if not exists directory;
revoke all on schema directory from public;
grant usage on schema directory to directory_reader, directory_writer;
revoke all on table directory.schema_migrations from public;

create function directory.set_updated_at() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- The directory's copy of the cell registry (platform.cells holds the same shape).
create table directory.cells (
  id         text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  kind       text not null check (kind in ('commercial', 'sovereign', 'dedicated', 'self_managed')),
  residency  text not null check (residency in ('uk', 'eu', 'us')),
  hostname   text not null unique,
  status     text not null default 'provisioning'
               check (status in ('provisioning', 'active', 'closed_to_placement', 'draining', 'retired')),
  placement_open     boolean not null default false,
  organisation_count integer not null default 0 check (organisation_count >= 0),
  connection_count   integer not null default 0 check (connection_count >= 0),
  counts_at          timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on column directory.cells.placement_open is 'Whether new organisations may be placed here (spec 6.2): active and below both limits, kept by fleet-control''s hourly capacity check (D207).';
comment on column directory.cells.organisation_count is 'As the cell last reported it, at counts_at; for placement.';
create trigger set_updated_at before update on directory.cells
  for each row execute function directory.set_updated_at();

-- Routes an organisation slug to its cell. cell_id changes only when a tenant
-- migration reaches its directory_updated stage (spec 6.4); the slug never changes.
create table directory.organisation_directory (
  organisation_slug citext primary key check (organisation_slug::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  cell_id           text not null references directory.cells (id),
  status            text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index organisation_directory_cell on directory.organisation_directory (cell_id);
create trigger set_updated_at before update on directory.organisation_directory
  for each row execute function directory.set_updated_at();

create function directory.freeze_slug() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.organisation_slug::text <> old.organisation_slug::text then
    raise exception 'organisation slug cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger organisation_directory_slug_frozen before update on directory.organisation_directory
  for each row execute function directory.freeze_slug();

-- Routes a login email to the cell holding the user, without storing the email.
-- email_hash is HMAC-SHA-256 of the trimmed, lower-cased email under a key held in
-- the directory's KMS, never in the database. One person has one user per cell, so
-- an email can route to several cells; the login then asks for the organisation.
create table directory.identity_routing (
  email_hash       bytea not null check (octet_length(email_hash) = 32),
  cell_id          text not null references directory.cells (id),
  hash_key_version smallint not null check (hash_key_version >= 1),
  created_at       timestamptz not null default now(),
  primary key (email_hash, cell_id)
);
create index identity_routing_cell on directory.identity_routing (cell_id);

-- Closing an organisation sets its status; cells are retired, never deleted. An
-- identity route is deleted when the person leaves the cell, changes address or asks
-- for erasure, and when a key rotation retires its hash.
grant select on directory.cells, directory.organisation_directory, directory.identity_routing
  to directory_reader, directory_writer;
grant insert, update on directory.cells, directory.organisation_directory, directory.identity_routing
  to directory_writer;
grant delete on directory.identity_routing to directory_writer;

-- ===========================================================================
-- status: the public status page's state (spec 7.2, 13.2). Global tier only.
-- ===========================================================================
-- The latest report from each cell's Fleet agent and the incident and maintenance
-- notices, so every status replica reads and writes the same state. Written by
-- status_writer (the status service's login). No customer data: component states,
-- operator identifiers and the notices' own words.

create schema if not exists status;
revoke all on schema status from public;
grant usage on schema status to status_writer, directory_reader;
grant usage on schema directory to status_writer;
grant select on directory.cells to status_writer;

create table status.cell_reports (
  cell_id     text primary key references directory.cells (id),
  reported_at timestamptz not null,
  updated_at  timestamptz not null default now()
);
comment on table status.cell_reports is
  'The latest report from each cell: the whole state of its components at one moment, by the cell''s clock.';
comment on column status.cell_reports.reported_at is 'A report no newer than this is ignored.';
create trigger set_updated_at before update on status.cell_reports
  for each row execute function directory.set_updated_at();

create table status.component_states (
  cell_id   text not null references status.cell_reports (cell_id),
  component text not null check (component in ('app', 'login', 'questions', 'live_clones', 'actions', 'connections',
                                                'files', 'notifications')),
  state     text not null check (state in ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance')),
  since     timestamptz not null,
  primary key (cell_id, component)
);
comment on table status.component_states is
  'Each component the cell''s last report named. One the report left out has no row and shows unknown.';
comment on column status.component_states.since is 'When the component entered this state; repeating it keeps the time.';

create table status.notices (
  id               uuid primary key,
  kind             text not null check (kind in ('incident', 'maintenance')),
  severity         text check (severity in ('sev1', 'sev2', 'sev3')),
  title            text not null check (length(btrim(title)) between 1 and 120),
  cell_ids         text[] not null check (cardinality(cell_ids) between 1 and 20),
  components       text[] not null default '{}'
                     check (components <@ array['app', 'login', 'questions', 'live_clones', 'actions', 'connections',
                                                'files', 'notifications']::text[]),
  state            text not null,
  started_at       timestamptz not null,
  resolved_at      timestamptz,
  window_starts_at timestamptz,
  window_ends_at   timestamptz,
  posted_by        uuid not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((kind = 'incident') = (severity is not null)),
  check ((window_starts_at is null) = (window_ends_at is null)),
  check (window_ends_at is null or window_ends_at > window_starts_at),
  check (kind <> 'maintenance' or window_starts_at is not null),
  check ((kind = 'incident' and state in ('investigating', 'identified', 'monitoring', 'resolved'))
         or (kind = 'maintenance' and state in ('scheduled', 'in_progress', 'completed'))),
  check ((state in ('resolved', 'completed')) = (resolved_at is not null))
);
comment on table status.notices is
  'Incident and maintenance notices. Cells named are ones the page shows (checked by the service: an array '
  'cannot reference). Retained on the page for STATUS_NOTICE_RETENTION_DAYS after they close.';
comment on column status.notices.posted_by is 'The incident commander, as admin-portal authenticated them. Never published.';
create index notices_recent on status.notices (resolved_at desc nulls first, started_at desc);
create trigger set_updated_at before update on status.notices
  for each row execute function directory.set_updated_at();
-- A notice keeps its kind and its start.
create function status.freeze_notice() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'a notice keeps its kind and start' using errcode = 'insufficient_privilege';
end
$$;
create trigger notices_kind_frozen before update on status.notices
  for each row when (old.kind is distinct from new.kind or old.started_at is distinct from new.started_at)
  execute function status.freeze_notice();

create table status.notice_updates (
  id        uuid primary key,
  notice_id uuid not null references status.notices (id),
  state     text not null check (state in ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled',
                                           'in_progress', 'completed')),
  message   text not null check (length(btrim(message)) between 1 and 2000),
  posted_at timestamptz not null,
  posted_by uuid not null
);
comment on table status.notice_updates is 'The updates posted to a notice, in order. Never changed once posted.';
create index notice_updates_by_notice on status.notice_updates (notice_id, posted_at);

grant select on status.cell_reports, status.component_states, status.notices, status.notice_updates
  to status_writer, directory_reader;
grant insert, update on status.cell_reports, status.component_states, status.notices to status_writer;
-- A report replaces the cell's component states: the ones it leaves out are deleted.
grant delete on status.component_states to status_writer;
grant insert on status.notice_updates to status_writer;

-- ===========================================================================
-- fleet: fleet-control's release registry, channels, promotions and rollouts (spec 11)
-- ===========================================================================
-- Every replica of fleet-control reads and writes the same state; changes take one
-- transaction-scoped advisory lock, so promotions, verdicts, halts and the rollout
-- worker apply one at a time across replicas. Signed documents (release manifests,
-- channel heads, bundle manifests) are kept exactly as signed, in jsonb; the artefact
-- store holds the published copies. A sovereign fleet-control keeps its own (the
-- sovereign cell's local directory database), holding only the bundles it countersigned.
-- Times are fleet-control's clock, so soaks and waves are measured on one clock.

create schema if not exists fleet;
revoke all on schema fleet from public;
grant usage on schema fleet to fleet_writer, directory_reader;
grant usage on schema directory to fleet_writer;
grant select on directory.cells to fleet_writer;
-- fleet-control keeps whether placement is open from each cell's status and limits (spec 6.3; D207).
grant update (placement_open) on directory.cells to fleet_writer;
-- Each cell's live organisations, for the capacity watch (spec 6.3; D203): which cell, and whether
-- closed. Never the slugs.
grant select (cell_id, status) on directory.organisation_directory to fleet_writer;

create table fleet.releases (
  release_id      text primary key check (release_id ~ '^[A-Za-z0-9._+-]{1,128}$'),
  target          text not null check (target in ('commercial', 'sovereign')),
  manifest        jsonb not null
                    check (jsonb_typeof(manifest) = 'object' and manifest ->> 'releaseId' = release_id
                           and manifest ->> 'target' = target),
  manifest_digest text not null check (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  signatures      jsonb not null check (jsonb_typeof(signatures) = 'array'),
  registered_by   uuid not null,
  registered_at   timestamptz not null
);
comment on table fleet.releases is
  'The release registry (spec 11.1): each release''s manifest and signatures exactly as signed. Immutable.';
comment on column fleet.releases.registered_by is 'The release engineer, as admin-portal authenticated them.';

create table fleet.promotions (
  id           uuid primary key,
  release_id   text not null references fleet.releases (release_id),
  channel      text not null check (channel in ('dev', 'canary', 'stable', 'sovereign', 'agent-stable', 'agent-sovereign')),
  expedite     boolean not null default false,
  state        text not null default 'pending' check (state in ('pending', 'applied')),
  requested_by uuid not null,
  requested_at timestamptz not null,
  approved_by  uuid,
  applied_at   timestamptz,
  sequence     integer check (sequence is null or sequence >= 1),
  rollout_id   uuid,
  check (approved_by is null or approved_by <> requested_by),
  check ((state = 'applied') = (applied_at is not null)),
  check ((state = 'applied') = (sequence is not null)),
  check (state = 'applied' or (approved_by is null and rollout_id is null)),
  check (channel = 'dev' or state = 'pending' or approved_by is not null)
);
comment on table fleet.promotions is
  'Promotion between channels (spec 11.2): two-person except into dev. Applied once; never deleted.';
create index promotions_by_release on fleet.promotions (release_id, channel);

create table fleet.rollouts (
  id                  uuid primary key,
  channel             text not null check (channel in ('dev', 'canary', 'stable', 'sovereign')),
  release_id          text not null references fleet.releases (release_id),
  previous_release_id text references fleet.releases (release_id),
  sequence            integer not null check (sequence >= 1),
  status              text not null default 'running' check (status in ('running', 'halted', 'completed', 'superseded')),
  started_at          timestamptz not null,
  ended_at            timestamptz,
  halt_reason         text check (halt_reason in ('gate_failed', 'signal_missing', 'manual')),
  halted_by           uuid,
  cell_id             text references directory.cells (id),
  noticed_at          timestamptz,
  notice              jsonb check (notice is null or jsonb_typeof(notice) = 'object'),
  check ((status = 'running') = (ended_at is null)),
  check ((status = 'halted') = (halt_reason is not null)),
  check (halted_by is null or halt_reason = 'manual'),
  check (cell_id is null or (channel = 'stable' and noticed_at is not null and notice is not null))
);
comment on table fleet.rollouts is 'A channel head''s rollout to the cells, in waves gated on health (spec 11.2).';
comment on column fleet.rollouts.cell_id is
  'A dedicated cell''s own rollout of stable''s head, once the shared waves passed: one wave of that cell, started in the '
  'customer''s window and not in their freeze (spec 11.5). Null for a channel''s rollout.';
comment on column fleet.rollouts.notice is
  'What the customer was told in advance (spec 11.5: "notified in advance with its SBOM difference"), and noticed_at when.';
comment on column fleet.rollouts.previous_release_id is
  'The last good release on the channel: what the cells go back to if this rollout halts.';
-- A channel rolls out one release at a time; an expedited fix supersedes the running one first.
create unique index rollouts_one_running on fleet.rollouts (channel) where status = 'running' and cell_id is null;
-- A dedicated cell takes one release at a time; a newer one waiting for its window replaces the older.
create unique index rollouts_one_running_per_cell on fleet.rollouts (cell_id) where status = 'running' and cell_id is not null;
create index rollouts_by_cell on fleet.rollouts (cell_id, started_at) where cell_id is not null;
create index rollouts_by_release on fleet.rollouts (release_id, channel);

alter table fleet.promotions add constraint promotions_rollout_fkey foreign key (rollout_id) references fleet.rollouts (id);

create table fleet.rollout_waves (
  rollout_id uuid not null references fleet.rollouts (id),
  position   smallint not null check (position >= 0),
  cells      text[] not null check (cardinality(cells) >= 1),
  soak_hours integer not null check (soak_hours >= 0),
  started_at timestamptz,
  passed_at  timestamptz,
  primary key (rollout_id, position),
  check (passed_at is null or started_at is not null)
);
comment on table fleet.rollout_waves is
  'The waves of a rollout, in order: a wave passes after its soak with a passing verdict from every cell in it.';

create table fleet.verdicts (
  rollout_id   uuid not null references fleet.rollouts (id),
  cell_id      text not null references directory.cells (id),
  release_id   text not null references fleet.releases (release_id),
  verdict      text not null check (verdict in ('pass', 'fail')),
  failed_gates text[] not null default '{}',
  reported_at  timestamptz not null,
  primary key (rollout_id, cell_id),
  check ((verdict = 'pass') = (cardinality(failed_gates) = 0))
);
comment on table fleet.verdicts is 'Each cell''s latest health-gate verdict for a rollout; a later one replaces it.';

create table fleet.channel_heads (
  channel      text not null check (channel in ('dev', 'canary', 'stable', 'sovereign', 'agent-stable', 'agent-sovereign')),
  sequence     integer not null check (sequence >= 1),
  release_id   text not null references fleet.releases (release_id),
  promotion_id uuid not null unique references fleet.promotions (id),
  rollout_id   uuid references fleet.rollouts (id),
  promoted_at  timestamptz not null,
  document     jsonb not null
                 check (jsonb_typeof(document) = 'object' and document ->> 'channel' = channel
                        and document ->> 'sequence' = sequence::text and document ->> 'releaseId' = release_id),
  signatures   jsonb not null check (jsonb_typeof(signatures) = 'array'),
  primary key (channel, sequence)
);
comment on table fleet.channel_heads is
  'Every head each channel has had, signed; the sequence only grows, so a cell refuses an older head. Immutable.';

-- The sequence grows by one: a gap or a repeat would let a cell be shown an older head as new.
create function fleet.channel_heads_sequence() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  latest integer;
begin
  select max(sequence) into latest from fleet.channel_heads where channel = new.channel;
  if new.sequence <> coalesce(latest, 0) + 1 then
    raise exception 'channel % is at sequence %; the next head is %', new.channel, coalesce(latest, 0), coalesce(latest, 0) + 1
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger channel_heads_sequence before insert on fleet.channel_heads
  for each row execute function fleet.channel_heads_sequence();

create table fleet.bundles (
  id              uuid primary key,
  release_id      text not null check (release_id ~ '^[A-Za-z0-9._+-]{1,128}$'),
  from_release_id text check (from_release_id is null or from_release_id <> release_id),
  bundle          jsonb not null
                    check (jsonb_typeof(bundle) = 'object' and bundle ->> 'bundleId' = id::text
                           and bundle ->> 'releaseId' = release_id),
  signatures      jsonb not null check (jsonb_typeof(signatures) = 'array'),
  created_at      timestamptz not null
);
comment on table fleet.bundles is
  'Air-gapped bundle manifests as signed (spec 11.4). No foreign key to releases: a sovereign fleet-control '
  'countersigns bundles of releases registered by the shared one. Immutable.';

grant select on fleet.releases, fleet.promotions, fleet.rollouts, fleet.rollout_waves, fleet.verdicts,
  fleet.channel_heads, fleet.bundles to fleet_writer, directory_reader;
-- Releases, channel heads and bundles are written once and never changed.
grant insert on fleet.releases, fleet.channel_heads, fleet.bundles to fleet_writer;
grant insert, update on fleet.promotions, fleet.rollouts, fleet.rollout_waves, fleet.verdicts to fleet_writer;

-- SBOM checks (spec 11.1): "SBOMs are checked for vulnerabilities daily; a critical one in a
-- reachable component blocks stable." Each release's SBOMs arrive after it is registered
-- (their digests are in the signed manifest) and are read into components by package URL.
-- Advisories are a mirror of OSV records (osv.dev's exports, or a copy of them for the
-- sovereign tier), synced per ecosystem: whole from all.zip the first time, then from
-- modified_id.csv. A finding is a component a live advisory affects; it blocks stable when
-- the advisory is critical and no VEX statement for the release says the component is not
-- affected or fixed. Promotion into stable, sovereign and their agent channels checks these.

create table fleet.release_sboms (
  release_id  text not null references fleet.releases (release_id),
  digest      text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  format      text not null check (format in ('spdx', 'cyclonedx')),
  subject     text not null check (subject ~ '^(image|agent):[a-z0-9_-]{1,64}$'),
  components  integer not null check (components >= 0),
  without_purl integer not null check (without_purl >= 0),
  received_by uuid not null,
  received_at timestamptz not null,
  primary key (release_id, digest)
);
comment on table fleet.release_sboms is
  'Each SBOM the release manifest names, once received: its digest matches the manifest''s, so it is the signed one.';
comment on column fleet.release_sboms.subject is 'What it describes: image:<service> or agent:<platform>.';
comment on column fleet.release_sboms.without_purl is 'Components listed without a package URL (or a version), which nothing can match.';

create table fleet.release_components (
  release_id  text not null,
  sbom_digest text not null,
  purl        text not null check (purl like 'pkg:%'),
  ecosystem   text,
  name        text not null,
  version     text not null,
  primary key (release_id, sbom_digest, purl),
  foreign key (release_id, sbom_digest) references fleet.release_sboms (release_id, digest)
);
comment on table fleet.release_components is
  'The components an SBOM lists, by package URL. ecosystem and name are OSV''s, null where the package type has none to match.';
create index release_components_by_package on fleet.release_components (ecosystem, name) where ecosystem is not null;

create table fleet.advisories (
  id         text primary key check (length(id) between 1 and 200),
  feed       text not null,
  modified   timestamptz not null,
  withdrawn  timestamptz,
  aliases    text[] not null default '{}',
  summary    text,
  severity   text not null check (severity in ('critical', 'high', 'medium', 'low', 'none', 'unrated')),
  score      numeric(3, 1) check (score is null or score between 0 and 10),
  affected   jsonb not null check (jsonb_typeof(affected) = 'array'),
  fetched_at timestamptz not null
);
comment on table fleet.advisories is
  'The advisory mirror: OSV records as fetched, reduced to what matching needs. A newer modified replaces an older one.';
comment on column fleet.advisories.feed is 'The export it came from: an OSV ecosystem without its release (npm, PyPI, Debian, Alpine).';
comment on column fleet.advisories.severity is
  'The highest rating the record gives: a CVSS v3 vector''s score, or the database''s own rating. Malicious packages are critical.';
create index advisories_by_alias on fleet.advisories using gin (aliases);

create table fleet.advisory_packages (
  ecosystem   text not null,
  name        text not null,
  advisory_id text not null references fleet.advisories (id) on delete cascade,
  primary key (ecosystem, name, advisory_id)
);
comment on table fleet.advisory_packages is 'Which packages each advisory names, for matching components to advisories.';
create index advisory_packages_by_advisory on fleet.advisory_packages (advisory_id);

create table fleet.advisory_feeds (
  feed           text primary key check (feed ~ '^[A-Za-z0-9._-]{1,64}$'),
  synced_through timestamptz,
  last_synced_at timestamptz,
  advisories     integer not null default 0 check (advisories >= 0),
  last_error     text,
  lease_until    timestamptz,
  check ((synced_through is null) = (last_synced_at is null))
);
comment on table fleet.advisory_feeds is
  'Each advisory export kept in step. synced_through: every record modified before it is held. lease_until: a replica is syncing it.';

create table fleet.vex_statements (
  id               uuid primary key,
  release_id       text not null references fleet.releases (release_id),
  vulnerability    text not null check (length(vulnerability) between 1 and 200),
  purl             text not null check (purl like 'pkg:%'),
  status           text not null check (status in ('not_affected', 'affected', 'fixed', 'under_investigation')),
  justification    text check (justification in ('component_not_present', 'vulnerable_code_not_present',
                     'vulnerable_code_not_in_execute_path', 'vulnerable_code_cannot_be_controlled_by_adversary',
                     'inline_mitigations_already_exist')),
  impact_statement text check (length(impact_statement) <= 4000),
  document_digest  text not null check (document_digest ~ '^sha256:[0-9a-f]{64}$'),
  stated_by        uuid not null,
  stated_at        timestamptz not null,
  check (status <> 'not_affected' or justification is not null or impact_statement is not null)
);
comment on table fleet.vex_statements is
  'VEX statements about a release (OpenVEX or CycloneDX VEX), as the security officer gave them. The latest for a '
  'vulnerability and component applies. purl is without qualifiers; without a version it covers every version.';
create index vex_statements_by_release on fleet.vex_statements (release_id, vulnerability);

create table fleet.release_findings (
  release_id       text not null references fleet.releases (release_id),
  advisory_id      text not null references fleet.advisories (id),
  purl             text not null,
  subject          text not null,
  severity         text not null check (severity in ('critical', 'high', 'medium', 'low', 'none', 'unrated')),
  score            numeric(3, 1),
  resolution       text not null check (resolution in ('affected', 'unresolved')),
  vex_statement_id uuid references fleet.vex_statements (id),
  blocking         boolean not null,
  first_found_at   timestamptz not null,
  last_seen_at     timestamptz not null,
  cleared_at       timestamptz,
  primary key (release_id, advisory_id, purl, subject),
  check (not (blocking and cleared_at is not null))
);
comment on table fleet.release_findings is
  'Components of a release a live advisory affects. unresolved: the version could not be placed in the range, so it counts as '
  'affected. Cleared once no longer matched (the advisory withdrawn or narrowed). Blocking: critical and not stated not affected or fixed.';
create index release_findings_blocking on fleet.release_findings (release_id) where blocking;

create table fleet.sbom_checks (
  release_id text primary key references fleet.releases (release_id),
  checked_at timestamptz not null,
  components integer not null check (components >= 0),
  unmatched  integer not null check (unmatched >= 0),
  findings   integer not null check (findings >= 0),
  blocking   integer not null check (blocking >= 0)
);
comment on table fleet.sbom_checks is 'The latest check of each release against the advisory mirror.';
comment on column fleet.sbom_checks.unmatched is 'Components with no ecosystem advisories name packages in, which no advisory can match.';

create table fleet.cell_change_policies (
  cell_id                        text primary key references directory.cells (id),
  organisation_id                uuid not null,
  time_zone                      text not null check (length(time_zone) between 1 and 64),
  windows                        jsonb not null check (jsonb_typeof(windows) = 'array'),
  change_authority_membership_id uuid,
  freezes                        jsonb not null check (jsonb_typeof(freezes) = 'array'),
  exceptions                     jsonb not null check (jsonb_typeof(exceptions) = 'array'),
  reported_at                    timestamptz not null
);
comment on table fleet.cell_change_policies is
  'A dedicated cell''s change windows, freezes, named change authority and that authority''s approvals of security fixes '
  'during a freeze (spec 11.5), as the customer set them in their cell and its Fleet agent last reported them. Replaced whole.';

grant select on fleet.release_sboms, fleet.release_components, fleet.advisories, fleet.advisory_packages, fleet.advisory_feeds,
  fleet.vex_statements, fleet.release_findings, fleet.sbom_checks to fleet_writer, directory_reader;
-- SBOMs, their components and VEX statements are written once and never changed.
grant insert on fleet.release_sboms, fleet.release_components, fleet.vex_statements to fleet_writer;
grant insert, update, delete on fleet.advisories, fleet.advisory_packages to fleet_writer;
grant insert, update on fleet.advisory_feeds, fleet.release_findings, fleet.sbom_checks to fleet_writer;
grant select on fleet.cell_change_policies to fleet_writer, directory_reader;
grant insert, update on fleet.cell_change_policies to fleet_writer;

-- Concept templates (spec 22.7; D210): the one cross-tenant mechanism in Silo, authored by Silo
-- staff in the global tier, readable only once a second person has reviewed it, and
-- distributed to every cell by Fleet as a signed set (each cell's catalogue verifies it and
-- writes ontology.concept_templates). A name and field names: never a schema, never values.
-- A reviewed template is never edited (a change is a new revision with a fresh review), and
-- templates are withdrawn, never deleted.
create table fleet.concept_templates (
  id           uuid primary key,
  name         text not null check (length(btrim(name)) between 1 and 200),
  field_names  text[] not null check (cardinality(field_names) between 1 and 200),
  revision     integer not null default 1 check (revision >= 1),
  authored_by  uuid not null,
  reviewed_by  uuid,
  reviewed_at  timestamptz,
  withdrawn_by uuid,
  withdrawn_at timestamptz,
  status       text not null default 'draft' check (status in ('draft', 'reviewed', 'withdrawn')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (reviewed_by is null or reviewed_by <> authored_by),
  check ((reviewed_by is null) = (reviewed_at is null)),
  check (status = 'draft' or reviewed_by is not null or status = 'withdrawn'),
  check ((withdrawn_by is null) = (withdrawn_at is null)),
  check ((status = 'withdrawn') = (withdrawn_at is not null))
);
comment on table fleet.concept_templates is
  'Silo-authored concept templates (spec 22.7): names and field names, reviewed by a second person, distributed to every cell as a signed set.';
create unique index concept_templates_live_name on fleet.concept_templates (lower(name)) where status in ('draft', 'reviewed');
grant select, insert, update on fleet.concept_templates to fleet_writer;
grant select on fleet.concept_templates to directory_reader;

-- Fleet's own events (spec 11.6), appended in the transaction that made the change, under
-- fleet-control's lock, so they have one order. Each hash covers the previous event's hash
-- and this event's content: an event altered, removed or put out of order breaks the chain.
-- Never updated or deleted.
create table fleet.events (
  seq           bigint generated always as identity primary key,
  event         text not null check (event in ('release_built', 'release_signed', 'release_promoted', 'release_expedited',
                  'rollout_started', 'rollout_gate_failed', 'rollout_rolled_back', 'rollout_completed', 'migration_applied',
                  'bundle_verified', 'bundle_refused', 'sovereign_release_countersigned', 'change_freeze_set',
                  -- Spec 6.3 (D203): a residency's open cells near their limits; a cell's tenants past them.
                  'cell_provisioning_needed', 'cell_rebalancing_needed', 'cell_created', 'cell_placement_closed',
                  -- Spec 22.7 (D210): a concept template reviewed by a second person, or withdrawn.
                  'template_reviewed', 'template_withdrawn')),
  occurred_at   timestamptz not null,
  release_id    text,
  rollout_id    uuid,
  cell_id       text,
  channel       text,
  operator_id   uuid,
  detail        jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  previous_hash bytea check (previous_hash is null or length(previous_hash) = 32),
  hash          bytea not null unique check (length(hash) = 32)
);
comment on table fleet.events is
  'Fleet''s own events (spec 11.6): what a release, a promotion, a rollout, a migration, a bundle or a freeze did, '
  'hash-chained in sequence order. Events about one dedicated cell carry it, for its Fleet agent to copy into the '
  'customer''s audit log. Append only.';
create index events_by_cell on fleet.events (cell_id, seq) where cell_id is not null;
create index events_by_release on fleet.events (release_id, seq) where release_id is not null;
create unique index events_migration_once on fleet.events (cell_id, release_id, (detail ->> 'database'), (detail ->> 'version'))
  where event = 'migration_applied';
grant select on fleet.events to fleet_writer, directory_reader;
grant insert on fleet.events to fleet_writer;
