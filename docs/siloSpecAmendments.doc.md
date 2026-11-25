# Silo specification: amendments

For the specification's owner, to bring the master specification (28 October 2026) into line
with the decisions taken since and with what is built. Each entry names the section, the change,
and wording to paste where wording is needed. Design decisions are in
`docs/siloDatabaseDesign.doc.md` (the D numbers); `docs/siloSpecCoverage.doc.md` records the
build against each chapter. Settled 23 November 2026.

## Wording to add or replace

### 10: Silo Agent, the private-link exception

Chapter 10's opening says the agent "is the only Silo component that reaches systems the
internet cannot". End that sentence with the words below, and add the rest as a new subsection,
10.x Private links (decision 9 November 2026; D44).

> …and it is the only Silo component that reaches systems the internet cannot, but for an
> Enterprise organisation's private link (10.x).
>
> **10.x Private links.** An organisation on the Enterprise plan may connect its own network to
> its cell by a VPC-to-VPC link: VPC peering, or a Private Service Connect endpoint in the cell's
> network. The customer and Silo set up the link between the two networks; then a member of Silo
> staff holding `network.private_links` records each private address range the link carries,
> and removes it when the link ends. A range is private address space only (10/8, 172.16/12,
> 192.168/16, 100.64/10 or fc00::/7), no wider than a /8 (IPv4) or a /16 (IPv6). It never
> overlaps the cell's own networks, and no two live ranges overlap, whichever organisations hold
> them, so a private address belongs to one organisation at most. The cell's egress reaches a
> private address only for a request of the organisation whose live link carries it. Everything
> else in this chapter holds: the agent remains the way to reach systems no link carries, and the
> sovereign build has no private links (6.5). Adding and removing a range are audited
> (`private_link_added`, `private_link_removed`).

### 13.3 and 63.6: staff access

Decided 23 November 2026: the audit trail is the record of a staff session. In 13.3, replace
"Every request is tagged with the session; terminal sessions are recorded and kept 12 months."
with the paragraph below, and read "recorded session" in the session's steps as this:

> Every request is tagged with the session and is an audit event, written before the request is
> made and kept for at least 12 months. Staff have no terminal and no database login, so the
> audit trail is the session's recording; no separate recording is kept.

In 63.6's data model, `access_level` reads "metadata_only, connection_diagnostics. No level reads
record values". Replace it with 13.3's levels `metadata_read`, `tenant_read` and `tenant_act`,
and say what `tenant_read` reads:

> `tenant_read` reads any tenant table the reporting role may read, on the reporting replica,
> never a sealed column; each read is recorded in the customer's audit log, naming the table.

Also say, in 13.3 or 63.6, which of the two approval orders applies when. In a normal session
the customer approves after the staff approval, where the customer's policy requires it. An
emergency session is approved by a second member of staff instead of the customer, is disclosed
to the customer at once, and is never `tenant_act`.

### 77: the audit event catalogue

- **Remove** `subscription_refused_bounds` (24.9's spelling) and use `subscription_refused_bound`
  in 24.9, as chapter 30 does and the code raises.
- **Remove** `connector_promotion_requested`, `connector_promotion_reviewed` and
  `trust_tier_promoted`: the marketplace is dropped (decision 23 November 2026; D224).
- **Add** these 130 events, which the code raises. Each is standard retention (seven years)
  unless marked high volume (400 days).

- **Connections, connectors and agents (chapters 10, 14 to 20):** `connection_parameters_changed`, `connection_probing`, `connection_verified`, `connection_activated`, `connection_renamed`, `connection_version_changed`, `private_link_added`, `private_link_removed`, `outbound_webhook_revoked`, `industrial_endpoint_verified`, `agent_target_refused`, `agent_update_policy_set`, `agent_update_approved`, `inference_settings_changed`, `stream_paused`, `stream_resumed`, `polling_fallback_enabled`, `polling_fallback_disabled`.
- **Governance: scopes, roles, purposes, declassifiers, principals (56 to 58):** `operator_access_policy_changed`, `scope_renamed`, `role_defined`, `role_changed`, `role_retired`, `purpose_retired`, `purpose_session_approved`, `declassifier_granted`, `declassifier_approved`, `declassifier_revoked`, `service_principal_role_removed`.
- **Ontology and resolution (21 to 25):** `ontology_change_committed`, `resolution_run_started`, `resolution_run_completed`.
- **Actions, actuation and Siloes (42 to 48, 66 to 70):** `generic_edit_policy_set`, `canary_sample_set`, `purge_rejected`, `allowlist_entry_requested`, `allowlist_entry_rejected`, `physical_dry_run_policy_set`, `purge_failed`.
- **Billing and sovereign terms (6.5, 71 to 75):** `sovereign_terms_entered`, `sovereign_terms_approved`, `sovereign_terms_rejected`, `silo_charges_invoiced`, `silo_charges_not_billed`.
- **Workspace, Crons and Files (33 to 41):** `view_archived`, `automation_run_completed`, `automation_run_condition_indeterminate`, `automation_escalation_acknowledged`, `automation_shared`, `file_renamed`, `folder_created`, `folder_moved`, `detector_configured`, `canvas_view_updated`, `canvas_view_archived`, `clone_layout_set`.
- **Studio apps: branches, releases, packages (35; beyond the spec, D229 to D231):** `app_branch_opened`, `app_branch_merged`, `app_branch_abandoned`, `app_release_started`, `app_release_stage_released`, `app_release_completed`, `app_release_rolled_back`, `app_package_exported`, `app_package_imported`, `app_opened` (high volume).
- **Workbooks, reports, process analyses (beyond the spec, D232 to D234):** `workbook_created`, `workbook_saved`, `workbook_archived`, `workbook_shared`, `workbook_share_revoked`, `workbook_exported`, `report_created`, `report_saved`, `report_archived`, `report_shared`, `report_share_revoked`, `report_exported`, `process_analysis_created`, `process_analysis_saved`, `process_analysis_archived`, `process_shared`, `process_share_revoked`, `process_analysis_exported`.
- **Pipelines and their schedules (beyond the spec, D235, D241):** `pipeline_created`, `pipeline_saved`, `pipeline_archived`, `pipeline_run_started`, `pipeline_run_completed`, `pipeline_run_failed`, `pipeline_schedule_set`, `pipeline_schedule_removed`, `pipeline_schedule_paused`, `pipeline_schedule_resumed`, `pipeline_run_skipped`.
- **AI agents (beyond the spec, D236):** `ai_agent_created`, `ai_agent_saved`, `ai_agent_archived`, `ai_agent_shared`, `ai_agent_share_revoked`.
- **Media sets and media links (beyond the spec, D237, D238):** `media_set_created`, `media_set_saved`, `media_set_archived`, `media_set_shared`, `media_set_share_revoked`, `media_item_added`, `media_item_removed`, `media_link_rule_set`, `media_links_applied`, `media_item_linked`, `media_item_unlinked`.
- **Notebooks (beyond the spec, D239):** `notebook_created`, `notebook_saved`, `notebook_archived`, `notebook_shared`, `notebook_share_revoked`, `notebook_exported`, `notebook_question_compiled`.
- **Machine learning models (beyond the spec, D240):** `ml_model_created`, `ml_model_saved`, `ml_model_archived`, `ml_model_shared`, `ml_model_share_revoked`, `ml_model_trained`, `ml_model_training_failed`, `ml_model_published`, `ml_model_predicted`.
- **AI FDE (49 to 54):** `fde_owner_named`, `fde_system_listed`, `fde_system_withdrawn`.

## Sections to bring into line with decisions already taken

Short notes only; each has its decision and design entry.

- **6.4 (tenant migration).** The window is read-only for every write, not only Actions and Crons.
  From the window until the directory moves the organisation, every write is refused to people
  and API clients alike. SCIM changes are refused as temporarily unavailable. Scheduled
  pipelines wait. The export starts 11 minutes after the window opens (D244).
- **16.5 (marketplace).** Remove. A connector an organisation builds stays its own
  (decision 23 November 2026; D224).
- **20.3 and 47.7 (OPC UA methods).** A method's input arguments are declared in the manifest
  and bounded in its allow-list entry: a number's range, text's allowed values. They are checked
  at intent and by the agent against the method's own declaration. The data model gains
  `actuation_allowlists.arguments` (D245).
- **21.8 (link routes).** A route may read its referenced end in another system than its key.
  The data model gains `link_type_routes.referenced_connection_id` and `referenced_object`. This
  is how 66.9's links between Siloes are made (D248).
- **29.5 (3D asset view).** Close the open decision: the 3D view is in the first release (D228).
  Compression and levels of detail are generated at upload (D249).
- **29.10 (canvas export).** A PNG is drawn by the exporting person's own browser and filed as
  their export (decision 23 November 2026; D225).
- **41.4 (opening an upload).** Opening a Files upload or a media item needs the file's own
  access (or the set's share) and every marking on its Silo, but not `silo.import`
  (decision 23 November 2026; D243).
- **68 (who uploads into an Import Silo).** A person, or a scheduled pipeline's own principal
  bounded by its owner; no other principal, whatever role it holds (decision 23 November 2026;
  D243).

- **33.2 to 33.5 (the workspace, rebuilt 24 November 2026).** The web client was rebuilt from
  the design of 24 November (`docs/siloWebClient.doc.md`). Bring chapter 33 into line:
  - **33.2.** The top bar becomes the header. On its left: the search field, a + menu for making
    anything, and the Lens selector (38.9). On its right, from the outside in: the person's
    profile menu at the edge, then support tickets, the help centre, notifications and Settings.
    The organisation and cell move from the top bar to the head of the left sidebar, where the
    organisation is switched.
  - **33.3.** The rail becomes the sidebar. It keeps the eleven items in their fixed order; each
    opens into its sections (Connect into Connections, Connector builder, Agents and so on), and
    a section the person may not use is shown disabled with the permission it needs, as an item
    is. It still collapses to icons; collapsed, an item opens its sections beside it.
  - **33.4.** Settings moves from the rail's foot to the header. What it holds is unchanged,
    grouped as Organisation, People, Sign-in, Security, Approvals and change, Sharing, Data and
    Billing. The person's own settings (password, second factors, devices, allowance,
    organisations) are account pages, reached from the profile menu.
  - **33.5.** Search opens with `/` as well as Cmd-K. Its list also finds every page and setting by
    name and by what it does, and everything the + menu makes; the rest of 33.5 holds, with "Ask:
    typed text" last and object search still a typed filter.
  - **New: help centre and support tickets.** The help centre ships with the client, so it works
    the same on sovereign and air-gapped cells: what each page is for and what can be done on it,
    guides, keyboard shortcuts. Support tickets are raised and followed inside Silo; a ticket
    holds references, never record values (8.5), and a Silo staff access request (13.3) names
    the ticket it serves.

## A new part: features beyond the specification

The specification has no chapter for the eight features built on 23 November 2026 at the owner's
request. Each is designed in the design doc, and each Studio or Files feature adds a `*.save`
permission to chapter 76:

- app branches, staged releases and app packages (D229 to D231);
- workbooks and reports (D232, D233);
- process mining (D234);
- data pipelines and their schedules (D235, D241);
- customer-built AI agents (D236);
- media sets and media linked to objects (D237, D238);
- notebooks, with predictions from models (D239, D242);
- machine learning models (D240, D246).

The coverage doc's "Beyond the spec" section summarises each, and is the starting point for that
part.
