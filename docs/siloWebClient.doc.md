# Silo web client

The web client was rebuilt from scratch from 24 November 2026, on Tommy's instruction: "go
through it from scratch. remember you are trying to build the most important data operating
system ever so it must be robust". The design it builds is the canvas published on 24 November
(the workspace prototype and the capability map). This document is the client's design record:
what it must guarantee, how it is built, and the order the work is done in.

## What the client guarantees

1. **Every capability has one home and a path to it.** Every public route a browser may call is
   called from the client, or is listed with the reason no page calls it. A test fails
   otherwise (`tests/coverage.test.ts`). Each capability lives in exactly one sidebar section;
   search finds it by name; anything that can be created is in the + menu.
2. **Nothing is hidden for lack of permission.** A control the person cannot use is shown
   disabled, naming the permission it needs (spec 33.3). The client learns what the person
   holds once per session; the server still decides every request.
3. **A failure never loses work or leaves a blank page.** Each region has its own error
   boundary. A failed read says what failed, offers a retry, and quotes the correlation id for
   support. A failed write keeps the form as it was. Reads that the server sheds (429, 503) are
   retried after the time it gives; writes are never retried blindly, and a keyed write reuses
   its idempotency key on every retry of one intent.
4. **The session is handled once, centrally.** A session that ends (expiry, revocation, sign-out
   in another tab) sends the person to sign in and back to the same page. Signing out in one tab
   signs out every tab.
5. **The organisation's state is always visible.** A migration window (writes paused), an active
   Silo staff session, being offline, and the server shedding load each show a banner, and
   writes are disabled while paused, before the person tries.
6. **Everything is linkable.** Every page, tab, filter and selected item is in the URL, so any
   view can be bookmarked, shared and reopened.
7. **Keyboard and screen reader first.** Every control is reachable and operable by keyboard;
   landmarks, labels and live regions are correct; colour pairs meet WCAG AA in both themes
   (`tests/contrast.test.ts`); motion respects reduced-motion. Every page is opened in a browser
   and checked (`tests/accessibility.test.ts`): one main landmark and one page heading; every
   control, link, button and table named; images with alternative text; no id used twice; no
   ARIA reference to an id that is not there; no positive tabindex.
8. **No inline styles, no inline script.** The gateway's CSP allows neither. Layout that depends
   on runtime values is set through the CSSOM after render, never as a style attribute.
9. **No values where they must not be.** Support tickets carry references, never record values
   (spec 8.5). Nothing customer-specific is kept in browser storage beyond conveniences (theme,
   sidebar state, drafts of the person's own text).

## How it is built

The client is a Next.js static export (spec 29.8) served by the gateway, with no server of its
own: the same files hosted and self-managed. Pages render in the browser; ids travel in the
query string.

| Folder | Layer | Holds |
|---|---|---|
| `src/app/` | Next routes | `page.tsx` and `layout.tsx` only (names Next requires). Each page renders one view. |
| `src/api/` | `.api.ts` | The typed client and the generated route table. |
| `src/data/` | `.data.ts` | The query cache, queries, mutations, invalidation, session and permission state. |
| `src/components/` | `.component.tsx` | The design system: every control, overlay, table, form field and state. |
| `src/shell/` | `.shell.tsx` | The header, sidebar, panels, Ask panel, banners and status line. |
| `src/navigation/` | `.navigation.ts` | The information architecture as data: areas, sections, settings, account, create, commands. |
| `src/views/<area>/` | `.view.tsx` | Each page's content, grouped by area. |
| `src/help/` | `.help.ts` | The help centre's guides, shipped with the client (sovereign and air-gapped cells have no outside help site). |
| `src/utils/` | `.util.ts` | Pure helpers: formatting, safe redirects, ids. |
| `tests/` | `.test.ts`, `.helper.ts` | Unit, coverage, contrast and browser tests. |

Styles sit beside their file as `name.layer.module.css`.

**The route table** (`src/api/routes.generated.ts`) is generated from the gateway's public
routes by `node src/scripts/webRoutes.script.ts` in `app/server`. For each route it carries the
method, path, whether the call is keyed, the session it needs, the permission the gateway checks
(or that the route reaches only the person's own records, or that its service decides), and
whether it writes. The client uses these to disable writes during a migration window and to
gate controls before they are used.

**The data layer** is written here, not taken from a library. A query is keyed by route and
input. Concurrent reads of one key share one request. Results are kept, shown at once when the
same page is reopened, and refreshed in the background (stale-while-revalidate). A query is
read again when the window regains focus or the network returns. A mutation names the routes it
makes stale, which are read again. Requests are aborted when nothing still wants them. Every
failure is an `ApiError` with its category, code, retryability and correlation id.

**Permissions** come from `readMyPermissions`: each catalogue permission the person holds, and
whether at the organisation or only in some scopes. A control for a route whose permission is not
held anywhere is disabled with the permission's description. A permission held only in some
scopes leaves the control enabled; the server decides on the scope acted on.

## The workspace

- **Header, left to right:** search (`/` or Cmd-K), the + menu, the Lens chip (spec 38), then on
  the right Settings, Notifications, Help, Tickets and Profile, Profile at the right edge.
- **Sidebar:** the organisation and cell switcher at the top; spec 33.3's eleven areas in their
  fixed order, each opening into its sections; collapses to icons; the state is kept per person
  (`updatePreferences`).
- **Ask panel** on the right of every page, scoped to it (spec 33.6); collapses to a strip.
- **Status line** at the foot: the page's freshness and incompleteness.
- **Banners** above the page: migration window, staff access, offline, load shedding.

Departures from spec 33, recorded in `siloSpecAmendments.doc.md`: Settings moves from the rail's
foot to the header; the organisation and cell move from the top bar to the sidebar's head; `/`
opens search as well as Cmd-K; support tickets and a help centre are added.

## Order of work

| Stage | Scope |
|---|---|
| U1 | Foundations: route metadata, `readMyPermissions`, the API client, the data layer, the design system, the navigation registry, the coverage test. |
| U2 | The shell: header, sidebar, search over every page, setting and command, the + menu, Lens chip, panels, banners, Ask panel, status line. |
| U3 | Before sign-in: sign in, MFA, sign-up, password reset, accepting an invitation, SSO returns. |
| U4 | Support tickets (server and client, references only) and the help centre. |
| U5 | Home, notifications and the account pages. |
| U6 | Explorer: types, search, object view, object sets, findings, Lenses. |
| U7 | Ask: threads, saved views, dashboard, the side panel. |
| U8 | Connect: connections, connector builder, agents, discovery, industrial, webhooks, OAuth apps, AI FDE. |
| U9 | Ontology: model, Action types, resolution, derive, detectors, proposals, branches, versions, aliases. |
| U10 | Governance: approvals, changes, Crons, lineage, purposes, declassifications, audit, staff access. |
| U11 | Clones: canvas, saved canvases, estate map, state rules, site plans and models. |
| U12 | Studio: apps, workbooks, reports, notebooks, processes, pipelines, AI agents, ML models, layouts. |
| U13 | Scenarios: scenarios, branches, dependency graph, lead times. |
| U14 | Files and Siloes. |
| U15 | Settings, every group. |
| U16 | Closure: the coverage allow-list down to routes no browser calls, an accessibility pass over every page, the full browser suite, the old client removed. |
| U17a | Results as chapter 31 says: prose, view and data from one result object; the ten archetypes chosen by deterministic precedence, alternatives offered, an override recorded, each person's choice kept per view; the three moves; flags in every representation; tiles at their archetype with its minimum legible size, falling back and saying so. |
| U17b | Analysis chains on the server (37.8): time buckets in plans; chains of typed, bounded steps saved as analysis manifests; run step by step, a refused step naming the step, the bound and the count, earlier steps kept. |
| U17c | The analysis builder in the client: from Explorer, an object view's link group, an Ask answer or a Studio chart; every step's output viewable; refusals shown and recorded. |

Each stage ends with the web suite and, where the server changed, the server suite green.

## Progress

- **U1, 24 November 2026.** The route table carries each route's session, access and whether it
  writes; `readMyPermissions` (policy `listMyPermissions`) says which catalogue permissions the
  person holds anywhere. The API client, read cache, hooks, status store, design system and
  navigation registry are built and unit-tested. All 724 browser routes have exactly one home
  across 96 places (`tests/navigation.test.ts`); 340 are called, 384 are pending
  (`tests/coverage.test.ts`).
- **U2, 24 November 2026.** The workspace frame replaced the earlier shell: the sidebar with the
  organisation switcher and two-level areas, the header in the designed order, search (`/`,
  Cmd-K) over objects, types, saved work, every page and setting, the + menu and commands, the
  Lens chip, notifications, the help panel and help centre page, the profile menu, banners
  (migration pause, staff access, offline, load, session ending), the status line and the Ask
  panel's frame. Every place has a page: the earlier client's view where one exists, otherwise
  what the place will hold and the stage that builds it. Old area addresses
  (`/governance/?tab=crons`) redirect to their sections. Found and fixed on the way: a stale
  "session ended" state from the sign-in page sent a freshly signed-in person back to sign in.
- **U3, 24 November 2026.** Sign in (organisation, credentials or single sign-on, second factor or
  setting one up), sign-up and its emailed confirmation, password reset (asking, and the emailed
  link), accepting an invitation, and the single sign-on return pages, on the new components.
  Fixed on the way: the emails linked to per-organisation paths a static export cannot serve
  (D255).
- **U4, 24 November 2026.** Support tickets (D254): raised from the header's ticket panel or the
  support page, with the failure being looked at and the page attached; values warned of as the
  person types (the same patterns the server refuses, checked by a parity test); replies, closing,
  and a count on the header icon of tickets waiting on the person. Staff answer from the staff
  console; a reply notifies the raiser in the product and by email. The help centre has its
  guides (`src/help/guides.help.ts`, checked against the registry).
- **U5, 24 November 2026.** Home as the briefing; the notifications page that emailed and pushed
  links open (D255); the account pages: profile and password, second factors and security keys,
  linked identities, notification devices, allowance, organisations. The organisation's directory
  (D256) names people everywhere.
- **U6, 24 November 2026.** Explorer: object types with facets and counts that filter in the
  address, the bound stated where a type is too large, saving a result as an object set; object
  sets read as the person (D258); search across types with every source not searched named;
  findings and their dispositions (D257); Lenses; the object page.
- **U7, 24 November 2026.** Ask threads (two-pane, search, AI agents, rename, rescope,
  archive), the thread view shared with the Ask side panel (answers paged and re-run when
  expired), the dashboard, and saved views with the sharing dialog.
- **U8, 24 November 2026.** Connect: connections (list, the catalogue and a new connection, then
  each connection's overview and moves, settings and credentials with OAuth sign-in, tests and
  the write test that earns writes, health with repairs and re-checks, its change stream with the
  webhook, change capture, polling fallback and stream tests, and who may use it); agents (pools,
  enrolment, releases and update policy); webhooks (events out and Action targets); OAuth apps;
  industrial endpoints, writable points and the actuation allow-list (with an object picker, so
  nobody pastes an id); discovery (scans, their runs, findings and promotion); the connector
  builder (from documentation, stage by stage, or by hand with the manifest editor, try and
  publish); and the AI FDE (engagements, stages and exits, systems and tasks, proposals with
  evidence, sessions, escalations, cost and measures, hand-over). Backend gaps found and closed:
  OAuth clients could not be listed (D260), nor scan runs (D261), nor a draft connector's
  document opened in the editor (D262), nor confirmation sessions (D263); browsing the
  catalogue asked the builder's permission rather than connection creation's (D260).

- **U9, 24 November 2026.** Ontology: types and links (main read-only with deprecation and
  retirement; every element kind edited on a branch with a structured editor), branches (changes
  by class, rebase with a choice per conflict, propose, abandon), proposals (changes, impact,
  derivation decisions accepted, corrected or rejected with follow-ups, approval and merge),
  versions and rollback, derive with field profiles, field aliases per column, Action types with
  their write settings, resolution (runs, proposals previewed live, pairs proposed with an object
  picker, merges undone, field authorities), detectors.
- **U10, 24 November 2026.** Governance: approvals that open each subject and quote its hash
  (D264), changes (exact writes, blast radius, physical nodes, canary confirmation, execution,
  verification, webhook deliveries, receipts with reverts decided conflict by conflict (D265) and
  purges, an object's commits), Crons (create with subject, trigger, condition, actions and
  failure policy; runs, escalations, sharing), lineage, purpose sessions, declassifications,
  the audit log with its integrity, and Silo staff access.
- **U11, done 24 November 2026.** The canvas engine moved to `src/canvas` (deck.gl and three.js
  drawing, layouts in a worker, live subscription, base map, image export) and the Clone Canvas
  page ported onto the new components: past 10,000 objects the cell computes the layout (keyed by
  the hash of the set's canonical definition), what is drawn is recorded for audit, and each
  person's layout and detail settings are kept. Saved canvases (filters, favourites, sharing,
  archive), the estate map, state rules (propose, decide, preview) and spatial assets (site plans
  and models, placements, georeferencing). Silo staff access gained the organisation's policy
  switch (ask before staff may see or act; fixed on where the cell requires it). 132 routes
  pending.
- **U12, done 24 November 2026.** Studio rebuilt in `src/views/studio`: a shared kit (directories
  of one's own, shared and archived things; names; shares listed with why a share grants nothing;
  a draft that a stale read never overwrites and that says when someone else saved), the app
  runtime and its widgets, the editor's design, versions (approve, approve in stages, return, put
  up again, compare), branches (compare, merge with each conflict decided), release (rollout,
  publications and withdrawal, package export), object view layouts, workbooks, reports, notebooks,
  processes, pipelines (build, preview, schedule, runs; a failed run's notification opens it) and
  AI agents and ML models. Backend gaps closed: D266 app publications, D267 layouts in force, D268
  a pipeline run by id. Shared fix: a blocked button's reason no longer joins its accessible name.
  The old client's `src/studio`, `src/workbooks`, `src/ask` and `src/objects` are deleted. A pipeline
  run's output links to `/siloes/import/?file=`, which U14 must honour. 122 routes pending.
- **U13, done 24 November 2026.** Scenarios rebuilt in `src/views/scenarios`: the list with a new
  failure scenario; a scenario's page with its latest run (and whether the graph moved since), its
  runs listed and any two compared (D269), sharing, copying and its branches; the branches page
  (every branch of the scenarios a person holds; a branch opened and checked against the record,
  Actions staged on an object through the object view's own Action form, staged again, conflicts
  decided, compared, promoted into the mutation path, closed); the dependency graph (proposed from
  the model, stated, confirmed with a resource's capacity, revised, retired); lead times observed
  from Capture's history. A run a notification names opens on its scenario. 111 routes pending.
- **U14, done 24 November 2026.** Files (`src/views/files`): all files, folders and shared files with
  one file drawer; upload in one request or on a signed transfer; a saved view exported to Files;
  media sets and an object's media. Siloes (`src/views/siloes`): the overview and a Silo's page,
  Capture, Import (sources listed, D271), the Object Index, the Warehouse, purges with their
  receipts (listed, D270) and charges. The old `src/files` and `src/siloes` are deleted. Every
  route outside Settings is now called: 74 pending, all Settings.
- **U15, done 24 November 2026.** Settings (`src/views/settings`): every page of the spec's groups,
  each a registered view with its own address: organisation, people, access, sign-in, security,
  approvals and change, sharing, data and billing. Four reads the pages needed were added (D272
  scope members, D273 purpose eligibility, D274 the web context policy, D275 automatic top-up).
  Single sign-on sign-out ends the provider's session; the organisation's logo shows in the
  switcher; Cmd-K records which command ran. The old `src/settings` and the legacy frame are
  deleted. No route is pending: the coverage test's only exception is `registerPushDevice`.
  Still owed by the client (U16): a dashboard tile records `dashboard_tile_fallback` only once
  tiles draw a view's own representation, and `analysis_step_refused` needs a run's refusal to
  name the step, the bound and the count (spec 37.10), which `runView` does not yet carry.
- **U16, done 24 November 2026.** The old client is gone: the `src/api/client.ts` shim, `src/ui`,
  `src/explorer`, `src/governance` and the legacy frame; every file now follows the layout. The
  coverage test has no pending list. `tests/accessibility.test.ts` opens home and every section,
  settings and account page and audits it (guarantee 7); it found and the client now fixes: the
  sidebar's disclosure buttons, closed dialogs and unselected tabs pointed ARIA at elements not on
  the page, and fourteen lists filtered by tabs had no tab panel (`TabPanel` now wraps each, with
  `group` keeping two tab lists' ids apart and `untabbed` for an app with one page). Opening Silo
  says why it is waiting when it is offline or asked to wait.
- **Found missing at U16 (U17).** Analysis over object sets (spec 37.8) is not built: the
  `analysis_steps` table and its repository exist, but no service builds a chain by hand (filter,
  traverse, group, pivot, compare, time series, derive, select, each with its bound), runs it step
  by step with a refused step naming the step, the bound and the count while earlier steps stay
  viewable, or saves it as a view of kind analysis; nothing makes an analysis manifest. Saved views
  and dashboard tiles draw a result as a figure, bars or a table, not the view's chosen archetype
  with its minimum legible size (37.6). Until both exist the client cannot honestly record
  `analysis_step_refused` or `dashboard_tile_fallback`.
- **U17 plan (24 November 2026).** What exists: the executor's refusals already carry the bound
  and the observed count; object sets run under the reader's access; canvas-layout records a
  result's render choice (`recordRenderSelection`, surface view: structure as counts and booleans,
  chosen, alternatives, override) and keeps each person's representation per saved view
  (`setViewPreference`); the `analysis_steps` table and repository. What is built:
  - U17a (client): `src/results/` with the 31.4 signals read from the result object, the
    precedence Comparison → Chain → Hierarchy → Network → Series → Distribution → Ranking →
    Composition → Figure → Table with every fitting archetype offered, SVG renderers drawn
    through the CSSOM (no style attributes), prose assembled from the result alone, the Prose /
    View / Data switch, selection carried across with lineage, drill-in and Actions, and the three
    flags everywhere. Used by Ask answers, saved views, dashboard tiles and Studio widgets. Each
    archetype declares its minimum legible size; a tile below it falls back to Figure (one row,
    one measure) or Table and records `dashboard_tile_fallback`.
  - U17b (server): `aggregate.groupBy` may bucket a time property by a calendar unit in the
    organisation's calendar; a workspace analysis service makes an analysis manifest from typed
    steps (filter, traverse, group, pivot, compare, time series, derive, select), each with its
    bound and inputs at earlier positions only; each object-set step compiles to a plan rooted at
    its type with the earlier steps as the linked constraint (the executor narrows a parent to the
    objects reaching a filtered node), each result step adds the aggregate; a run goes step by
    step, stops at a refused step naming it, its bound and the count, and keeps the steps before
    it viewable; saved as a view of kind analysis, run free, built by hand unmetered.
  - U17c (client): the builder and `analysis_step_refused`.
- **U17a, done 24 November 2026.** Results as chapter 31 says (`src/results`): the signals and
  precedence (`structure.result.ts`, with each archetype's minimum legible size at tile size),
  prose from the result alone (`prose.result.ts`), the ten archetypes in SVG (`charts.result.tsx`),
  and `ResultView` / `ResultByRef` (`result.result.tsx`) with Prose, View and Data, the
  alternatives that fit, the render record and each person's choice kept per view, flags in every
  representation and the three moves on a selection. Two reads were added (D276 `readResult`, the
  header with the first page; D277 `readViewPreference`). A picture is drawn only from the whole
  result; an answer of more than one page is a table, and says why. Tests: `tests/results.test.ts`
  (signals, precedence, fallbacks, prose) and the storage browser test (representations kept, a
  grouped answer as a ranking, overridden, a bar followed to its objects and found in Data).
- **U17b design (25 November 2026).** Ownership as the catalogue says: compile keeps manifests,
  workspace writes `analysis_steps`.
  - Plans: `aggregate.groupBy` takes an optional `bucket` (a calendar unit) on a date or
    timestamp property; the key is the start of the period in the organisation's calendar (the
    planner's own period arithmetic, financial years included); a bucketed group is aggregated by
    the engine, never pushed down; anything else is refused naming the property.
  - Steps: filter (a fresh set of a type, or more filters on an earlier set), traverse (a link
    type from an earlier set), derive (an earlier set with a computed property evaluated by the
    engine), select (the objects behind one group of an earlier group step), group, time series,
    pivot (two keys, reshaped in the client) and compare (one measure over two earlier sets, each
    run separately). Every object-set step compiles to a plan rooted at its type with the earlier
    steps as linked, filtered nodes, so a set is always "the objects of this type reaching those";
    a result step adds the aggregate. Inputs name earlier positions only; at most four traversals.
  - compile `compileAnalysis` checks every step's plan against the reader's vocabulary and bounds
    and keeps the analysis manifest (each step with its plan) and its values sealed in a binding;
    a step that cannot be planned is refused naming its position. compile `runAnalysis` runs the
    steps in order, each under its own bound (members for a set, groups for a result), and stops at
    the first refused step, naming the step, the bound and the count; earlier steps keep their
    results. Building by hand is never metered.
  - workspace `createAnalysis`, `readAnalysis`, `runAnalysis`; a view of kind analysis runs
    through it, its refusal carrying the step and the bound (spec 37.8, 37.10).
- **U17b, done 25 November 2026.** Analysis chains on the server (D278 time buckets and required
  links in plans; D279 compile and workspace analyses, analysis views and their refusals).
  Tests: query (buckets, required links) and `tests/services/analysis.test.ts` (a six-step chain,
  values only to their maker, a step over its bound, a view of kind analysis, planning refusals).
- **U17c, done 25 November 2026.** The builder (`src/views/explorer/analysis.view.tsx`, drafts in
  `chain.view.ts`): steps in order, each with its input, editor, bound and output; a group's
  selection continues as the objects behind it; refusals shown and recorded; saved as a view.
  Explorer's types have Analyse; a saved analysis opens in Analysis. Tests: `tests/chain.test.ts`
  and the storage browser test (a chain built, followed back, saved, and refused at its bound).
- **Since U17c (25 November 2026).** An analysis also begins from an object view's link group
  (Analyse these: the object named by its identifying property, D280) and from an Ask answer
  (Analyse further: its plan made steps with its values, D281), from a Studio chart (the chart
  widget's Analyse, D282), and from a harder question in Ask compiled straight into a chain (D283:
  the answer says it was answered in steps and opens in Analysis). Starting from an answer or a
  chart says first what the steps do not keep (`src/views/explorer/start.view.tsx`).

