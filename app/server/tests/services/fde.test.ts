// The AI FDE end to end (spec 49 to 54), in a cell with two live systems and an ontology:
// one engagement taken through all ten stages to handover, and a second stopped.
//
// What it shows: one principal per role, executing and never authorising, refused outside
// its ceiling (fde_ceiling_refusal) and unable even to be given a forbidden permission;
// proposals with evidence and the decider's permission, markings and band; acceptance applied
// through each system's own path as the person who decided; edits recorded; deferral;
// group acceptance only where 52.3 allows; a deployment engineer kept to technical kinds;
// model calls through the gateway, validated and metered against the engagement; stage
// exits confirmed by a person; handover with Reliability kept; the stop button; a budget pause.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { getConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { draftConnector, probeBuild } from '../../src/contracts/connector-builder/build.contract.ts';
import * as f from '../../src/contracts/fde-orchestrator/engagement.contract.ts';
import { getManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { authorise } from '../../src/contracts/policy/decision.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { listConfigurations } from '../../src/contracts/recognition/detector.contract.ts';
import { listEdges } from '../../src/contracts/simulation/graph.contract.ts';
import { deleteCron, getCron } from '../../src/contracts/scheduler/cron.contract.ts';
import { approveVersion, getApp, openApp, shareApp, submitForReview } from '../../src/contracts/studio/app.contract.ts';
import { listViews } from '../../src/contracts/workspace/view.contract.ts';
import { loadConfig } from '../../src/config/index.config.ts';
import { openDatabases, type Databases } from '../../src/infra/postgres.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createChangeStreamService } from '../../src/routes/change-stream/index.route.ts';
import { service as conformanceService } from '../../src/routes/conformance/index.route.ts';
import { createConnectorMaintenanceService } from '../../src/routes/connector-maintenance/index.route.ts';
import { service as builderService } from '../../src/routes/connector-builder/index.route.ts';
import { createFdeOrchestratorService } from '../../src/routes/fde-orchestrator/index.route.ts';
import { service as inferenceService } from '../../src/routes/schema-inference/index.route.ts';
import { createSchedulerService } from '../../src/routes/scheduler/index.route.ts';
import { service as studioService } from '../../src/routes/studio/index.route.ts';
import { createWorkspaceService } from '../../src/routes/workspace/index.route.ts';
import { service as recognitionService } from '../../src/routes/recognition/index.route.ts';
import { service as simulationService } from '../../src/routes/simulation/index.route.ts';
import { createAuditWriter, type AuditWriter } from '../../src/services/audit/writer.service.ts';
import { createOrchestrator } from '../../src/services/fde-orchestrator/orchestrator.service.ts';
import { recordSubscription } from '../../src/services/state-plane/deps.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { quiet } from './connect.helper.ts';
import { startRecognitionCell, type RecognitionCell } from './recognition.helper.ts';

let r: RecognitionCell;
let databases: Databases;
let services: ServiceClient;
let orchestrator: ReturnType<typeof createOrchestrator>;
let successorId = '';
let auditDatabases: Databases;
let writer: AuditWriter;
/** Stage 6's accepted app and stage 7's accepted Cron, for what happens to them after handover. */
let supplierWatch = '';
let notifyCron = '';
let gateway: RecognitionCell['gateway'];
let engagement: f.EngagementView & { principals: { role: string; servicePrincipalId: string }[]; stages: { stageNumber: number; status: string }[] };

const sql = (text: string, values: unknown[] = []) => inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(text, values));
const events = async (name: string) => (await sql(
  `select payload -> 'detail' as detail, payload -> 'actor' as actor from platform.outbox where organisation_id = $1 and payload ->> 'event' = $2`,
  [r.cell.org, name])).rows as { detail: Record<string, unknown>; actor: Record<string, unknown> }[];
const asRoot = () => r.cell.as(r.root);
/** The relay's and the audit service's part, here: the organisation's outbox written to its audit ledger (the metrics read it, 54.3). */
const drainAudit = async () => {
  const { rows } = await r.cell.migrate.query(
    `select id, created_at, correlation_id, payload from platform.outbox where organisation_id = $1 and event = 'audit_event' order by seq`, [r.cell.org]);
  for (const row of rows) {
    await writer.handle({ eventId: row.id, name: 'audit_event', version: 1,
      data: Buffer.from(JSON.stringify({ organisationId: r.cell.org, occurredAt: row.created_at, correlationId: row.correlation_id, payload: row.payload })) });
  }
};
const step = () => orchestrator.step(r.cell.org, engagement.id);
const get = () => gateway.call(f.getEngagement, { params: { engagementId: engagement.id } }, asRoot());
const pending = async (kind?: string) => (await gateway.call(f.listProposals, {
  params: { engagementId: engagement.id }, query: { status: 'pending', ...(kind ? { kind: kind as never } : {}) },
}, asRoot())).proposals;
const decide = (proposalId: string, body: Parameters<typeof gateway.call<typeof f.decideProposal>>[1]['body']) =>
  gateway.call(f.decideProposal, { params: { proposalId }, body }, asRoot());
const exit = (stageNumber: number, skip = false) =>
  gateway.call(f.confirmStageExit, { params: { engagementId: engagement.id, stageNumber }, body: { skip } }, asRoot());
const principalOf = (role: string) => engagement.principals.find((p) => p.role === role)!.servicePrincipalId;

before(async () => {
  r = await startRecognitionCell([
    { definition: recognitionService, name: 'recognition' },
    { definition: simulationService, name: 'simulation' },
    // Write enablement's and Reliability's inputs (51.7, 51.11), started before the orchestrator that calls them;
    // the weekly re-check's first pass runs before any connection exists.
    { definition: conformanceService, name: 'conformance' },
    { definition: createConnectorMaintenanceService({ weekly: { intervalMs: 3_600_000 } }), name: 'connector-maintenance' },
    { definition: createChangeStreamService({ tickMs: 3_600_000 }), name: 'change-stream',
      env: { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl } },
    { definition: createWorkspaceService(), name: 'workspace' },
    { definition: studioService, name: 'studio' },
    { definition: createSchedulerService({ sweep: false }), name: 'scheduler' },
    { definition: inferenceService, name: 'schema-inference' },
    { definition: builderService, name: 'connector-builder' },
    { definition: createFdeOrchestratorService({ schedule: false }), name: 'fde-orchestrator' },
  ]);
  gateway = r.gateway;
  // The AI FDE is Enterprise onboarding: the organisation holds a contract's entitlements, which
  // carry the connector builders (D76), in place of the helper's self-serve one.
  const operator = uuidv7();
  const contract = uuidv7();
  await r.cell.migrate.query(`insert into platform.operators (id, idp_subject, display_name, clearance, uk_resident) values ($1, $2, $2, 'sc', true)`,
    [operator, `op-${operator}`]);
  await r.cell.migrate.query(
    `insert into billing.contracts (id, organisation_id, status, platform_fee, seat_count, seat_rate, token_allocation, daily_token_limit,
       simulation_allocation, storage_included_bytes, capabilities, term_start, term_end, payment_terms, created_by)
     values ($1, $2, 'draft', 0, 10, 0, 1000, 40, 5, 0, '{sso}', current_date, current_date + 365, 'Net 30', $3)`, [contract, r.cell.org, operator]);
  await r.cell.migrate.query(`update billing.entitlements set effective_to = now() where organisation_id = $1 and effective_to is null`, [r.cell.org]);
  await r.cell.migrate.query(
    `insert into billing.entitlements (id, organisation_id, seats, tokens_per_seat_period, simulations_per_seat_period, daily_token_limit,
       storage_included_bytes, capabilities, source, contract_id, effective_from)
     values ($1, $2, 10, 1000, 5, 40, 0, '{sso,ai_connector_builder,nocode_connector_builder}', 'contract', $3, now())`, [uuidv7(), r.cell.org, contract]);
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'expression-evaluator', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', PG_CONTROL_URL: r.cell.h.url('test_app'),
  });
  databases = openDatabases(config.postgres, 'fde-orchestrator', ['control']);
  auditDatabases = openDatabases(loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'expression-evaluator', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', PG_CONTROL_URL: r.cell.h.url('test_audit'),
  }).postgres, 'audit', ['control']);
  writer = createAuditWriter({ databases: auditDatabases, logger: quiet });
  services = createServiceClient({ caller: 'fde-orchestrator', http: { ...config.http,
    serviceUrls: Object.fromEntries(Object.entries(r.cell.ports).map(([n, p]) => [n, `http://127.0.0.1:${p}`])) } });
  orchestrator = createOrchestrator({ databases, services, logger: quiet, cellId: CELL_ID, providerPrice: { inputPerMillion: 3, outputPerMillion: 15 } });
  // The engaging administrator's purchased tokens pay for the engagement's model calls (52.6, 73.5).
  await r.cell.migrate.query('update billing.token_balances set purchased_remaining = 1000 where membership_id = $1', [r.root.membershipId]);
});

after(async () => {
  services?.close();
  await databases?.close();
  await auditDatabases?.close();
  await r?.close();
});

describe('the AI FDE (spec 49 to 54)', () => {
  test('an engagement starts with one principal per role, which executes inside its ceiling and never authorises', async () => {
    engagement = await gateway.call(f.startEngagement, {
      body: { name: 'Acme deployment', goals: 'See supplier risk and act on late orders', engagementClass: 'enterprise', tokenBudget: 500,
        providerCostBudget: '25.00', rateLimits: { attemptsPerTask: 1 } },
    }, r.keyed(r.root)) as typeof engagement;
    assert.equal(engagement.principals.length, 7);
    assert.deepEqual(engagement.stages.map((s) => [s.stageNumber, s.status]), [[0, 'running']]);
    assert.equal((await events('fde_principal_created')).length, 7);

    const asSurvey = { request: { organisationId: r.cell.org, servicePrincipalId: principalOf('survey') } };
    assert.equal((await services.call(authorise, { body: { permission: 'estate.view' } }, asSurvey)).decision, 'allow', 'a tool permission the administrator holds');
    const refused = await services.call(authorise, { body: { permission: 'mutation.approve' } }, asSurvey);
    assert.deepEqual([refused.decision, refused.reason], ['deny', 'principal_never_authorises']);
    assert.equal((await services.call(authorise, { body: { permission: 'connection.grant' } }, asSurvey)).decision, 'deny');
    const ceiling = await events('fde_ceiling_refusal');
    assert.ok(ceiling.length >= 2 && ceiling.every((e) => e.detail['role'] === 'survey'), 'every attempt outside the ceiling is recorded');

    // 52.1: impossible, not merely refused: a role holding a forbidden permission cannot be put on an FDE principal.
    const { rows: [superAdmin] } = await sql(`select id from iam.roles where organisation_id = $1 and name = 'Super admin'`, [r.cell.org]);
    await assert.rejects(inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
      'insert into iam.service_principal_roles (organisation_id, service_principal_id, role_id, granted_by) values ($1, $2, $3, $4)',
      [r.cell.org, principalOf('ontology'), superAdmin.id, r.root.membershipId])), /forbidden permission|never authorise/);
  });

  test('stages 0 to 2: the first connection starts the clock; the scope list is the administrator\'s, markings and all', async () => {
    await step();
    let e = await get();
    assert.equal(e.stages[0]!.status, 'awaiting_confirmation');
    assert.ok(e.agentInstalledAt !== null);
    await exit(0);

    // A marking on one system: its estate entry needs a decider cleared for it.
    const marking = (await gateway.call(createMarking, { body: { name: 'ERP restricted', kind: 'compartment' } }, asRoot())).id;
    await gateway.call(applyMarking, { body: { markingId: marking, resource: { type: 'connection', id: r.erp } } }, asRoot());
    await step();
    const entries = await pending('estate_entry');
    assert.equal(entries.length, 2);
    assert.ok(entries.every((p) => p.confidenceBand === 'high' && p.requiredPermission === 'fde.engage' && p.evidence.length > 0));
    const erpEntry = entries.find((p) => p.payload['connectionId'] === r.erp)!;
    assert.deepEqual(erpEntry.markings, [marking]);
    await assert.rejects(gateway.call(f.acceptProposalGroup, { params: { engagementId: engagement.id }, body: { proposalIds: entries.map((p) => p.id), count: 2 } },
      asRoot()), { code: 'fde.marking_unsatisfied' });
    await gateway.call(grantClearance, { body: { markingId: marking, holder: { kind: 'membership', id: r.root.membershipId } } }, asRoot());
    const group = await gateway.call(f.acceptProposalGroup, { params: { engagementId: engagement.id }, body: { proposalIds: entries.map((p) => p.id), count: 2 } }, asRoot());
    assert.ok(group.accepted.every((p) => p.status === 'accepted' && p.decidedBy === r.root.membershipId), 'each recorded alone, with its decider');
    assert.equal((await events('fde_proposals_group_accepted')).length, 1);

    await step();
    await exit(1);
    await step();
    e = await get();
    assert.equal(e.stages.find((s) => s.stageNumber === 2)!.status, 'awaiting_confirmation', 'both systems in scope are live');
    await exit(2);
  });

  test('stage 3: derived types are proposed with their evidence, and applied through the ontology as the person who decided', async () => {
    await step();
    const types = await pending('object_type');
    const links = await pending('link_type');
    assert.ok(types.length >= 6 && links.length >= 3, 'every object and declared key of both systems');
    assert.ok([...types, ...links].every((p) => p.requiredPermission === 'ontology.confirm' && p.evidence.length > 0));
    assert.ok(links.every((p) => p.evidence.some((x) => x.type === 'foreign_key')), 'links only from declared keys');

    // A deployment engineer decides technical kinds only (53.2).
    await gateway.call(f.assignEngineer, { params: { engagementId: engagement.id }, body: { membershipId: r.editor.membershipId } }, asRoot());
    const vendors = types.find((p) => p.payload['apiName'] === 'vendors')!;
    await assert.rejects(gateway.call(f.decideProposal, { params: { proposalId: vendors.id }, body: { decision: 'accept' } }, r.cell.as(r.editor)),
      { code: 'fde.engineer_not_permitted' });
    await assert.rejects(gateway.call(f.assignProposals, { params: { engagementId: engagement.id }, body: { proposalIds: [vendors.id], membershipId: r.editor.membershipId } },
      asRoot()), { code: 'fde.engineer_not_permitted' });
    await gateway.call(f.removeEngineer, { params: { engagementId: engagement.id } }, asRoot());

    // A confirmation session works through the stage's pending proposals, and is found again to end it (D263).
    const session = await gateway.call(f.startSession, { params: { engagementId: engagement.id }, body: { mode: 'workshop', participantMembershipIds: [r.root.membershipId] } }, asRoot());
    assert.equal(session.stageNumber, 3);
    assert.ok(session.agenda.flatMap((a) => a.proposalIds).includes(vendors.id), 'the pending proposals, in order');
    const listed = (await gateway.call(f.listSessions, { params: { engagementId: engagement.id } }, asRoot())).sessions;
    assert.deepEqual(listed.map((x) => [x.id, x.endedAt]), [[session.id, null]]);

    const accepted = await decide(vendors.id, { decision: 'accept' });
    assert.equal(accepted.status, 'accepted');
    const ended = await gateway.call(f.endSession, { params: { sessionId: session.id } }, asRoot());
    assert.ok(ended.endedAt !== null);
    assert.ok((await gateway.call(f.listSessions, { params: { engagementId: engagement.id } }, asRoot())).sessions[0]!.endedAt !== null, 'listed as ended');
    await assert.rejects(gateway.call(f.endSession, { params: { sessionId: session.id } }, asRoot()), { code: 'fde.session_closed' });
    const manifest = await gateway.call(getManifest, { query: {} }, asRoot());
    const vendorsType = manifest.objectTypes.find((t) => t.apiName === 'vendors')!;
    assert.ok(vendorsType, 'merged into the ontology');
    assert.equal(accepted.appliedRef, vendorsType.id);

    const deliveries = types.find((p) => p.payload['apiName'] === 'deliveries')!;
    const definition = { ...(deliveries.payload['definition'] as Record<string, unknown>), displayName: 'Delivery note' };
    const edited = await decide(deliveries.id, { decision: 'accept', edits: { definition } });
    assert.equal(edited.status, 'accepted_edited');
    assert.ok(edited.editDiff !== null && 'definition' in edited.editDiff);
    assert.equal((await gateway.call(getManifest, { query: {} }, asRoot())).objectTypes.find((t) => t.apiName === 'deliveries')?.displayName, 'Delivery note');

    const events_ = types.find((p) => p.payload['apiName'] === 'events')!;
    assert.equal((await decide(events_.id, { decision: 'reject', reason: 'not_needed' })).status, 'rejected');
    for (const p of [...await pending('object_type'), ...await pending('link_type')]) await decide(p.id, { decision: 'defer' });
    await step();
    await exit(3);
  });

  test('stages 4 to 6: resolution as the ontology proposes it; empty stages wait on the platform and a person', async () => {
    for (let i = 0; i < 20 && (await get()).stages.find((s) => s.stageNumber === 4)?.status === 'running'; i += 1) {
      await step();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const p of await pending('resolution_pair')) await decide(p.id, { decision: 'defer' });
    await step();
    await exit(4);
    // Stage 5 looks at every in-scope type, four at a time; no connection here has earned
    // writes or declares an update, so no Action type is proposed and nothing waits on a person.
    for (let i = 0; i < 5 && (await get()).stages.find((s) => s.stageNumber === 5)?.status !== 'passed'; i += 1) {
      await step();
      await exit(5).catch((error: { code?: string }) => { if (error.code !== 'fde.criteria_unmet') throw error; });
    }
    assert.equal((await get()).stages.find((s) => s.stageNumber === 5)?.status, 'passed');
    assert.deepEqual(await pending('action_type'), [], 'a read-only connector is offered no Action type');

    // Stage 6: an app and a dashboard per type, the app validated by Studio before it is proposed.
    const drafting = async () => (await sql(`select count(*)::int as n from fde.fde_tasks where engagement_id = $1 and kind = 'draft_type_views'
      and status in ('queued', 'running')`, [engagement.id])).rows[0].n as number;
    await step();
    for (let i = 0; i < 5 && await drafting() > 0; i += 1) await step();
    const apps = await pending('studio_app');
    assert.ok(apps.length >= 1 && apps.every((p) => p.payload['template'] === 'monitor' && p.requiredPermission === 'app.publish'),
      'no type has an Action type here, so each is a monitor');
    assert.ok(apps.every((p) => p.evidence.some((e) => e.type === 'probe' && String(e['detail']).includes('no finding'))));
    const appOf = await decide(apps[0]!.id, { decision: 'accept', edits: { name: 'Supplier watch' } });
    const appId = (await sql(`select app_id from fde.fde_proposal_targets where proposal_id = $1`, [appOf.id])).rows[0].app_id as string;
    supplierWatch = appId;
    const created = await gateway.call(getApp, { params: { appId } }, asRoot());
    assert.deepEqual([created.app.name, created.app.generatedBy, created.app.ownerMembershipId], ['Supplier watch', 'ai_fde', r.root.membershipId],
      'the person owns it; it is marked as generated');
    assert.equal((await events('app_generated_by_fde')).length, 1);
    const layouts = await pending('object_view_layout');
    assert.equal(layouts.length, apps.length, 'a layout per type');
    const layoutOf = await decide(layouts[0]!.id, { decision: 'accept' });
    const layoutApp = (await sql(`select app_id from fde.fde_proposal_targets where proposal_id = $1`, [layoutOf.id])).rows[0].app_id as string;
    const layoutCreated = await gateway.call(getApp, { params: { appId: layoutApp } }, asRoot());
    assert.deepEqual([layoutCreated.app.kind, layoutCreated.app.generatedBy, layoutCreated.app.ownerMembershipId, layoutCreated.app.draft?.findings],
      ['object_view_layout', 'ai_fde', r.root.membershipId, 0], 'a valid draft the person owns, published through review');
    const boards = await pending('dashboard');
    assert.equal(boards.length, apps.length);
    const board = await decide(boards[0]!.id, { decision: 'accept' });
    const viewId = (await sql(`select saved_view_id from fde.fde_proposal_targets where proposal_id = $1`, [board.id])).rows[0].saved_view_id as string;
    const favourites = (await gateway.call(listViews, { query: { set: 'favourited' } }, asRoot())).views;
    assert.deepEqual(favourites.map((v) => [v.id, v.kind, v.ownerMembershipId]), [[viewId, 'object_set', r.root.membershipId]], 'on the person\'s dashboard');
    for (const p of [...await pending('studio_app'), ...await pending('object_view_layout'), ...await pending('dashboard')]) await decide(p.id, { decision: 'defer' });

    await step();
    await assert.rejects(exit(6), { code: 'fde.criteria_unmet' }, 'no app is published yet');
    // A published app, as Studio would leave one.
    const [app, version] = [uuidv7(), uuidv7()];
    await r.cell.migrate.query(`insert into workspace.apps (id, organisation_id, owner_membership_id, name, kind, visibility) values ($1, $2, $3, 'Late orders', 'app', 'published')`,
      [app, r.cell.org, r.root.membershipId]);
    await r.cell.migrate.query(`insert into workspace.app_versions (id, organisation_id, app_id, version, state, definition, schema_version, ontology_version,
      authored_by, reviewed_by, reviewed_at, published_at) values ($1, $2, $3, 1, 'published', '{}', '1', 1, $4, $5, now(), now())`,
    [version, r.cell.org, app, r.root.membershipId, r.editor.membershipId]);
    await r.cell.migrate.query(`insert into workspace.app_publications (id, organisation_id, app_id, app_version_id, scope_id, published_by, published_at)
      values ($1, $2, $3, $4, $5, $6, now())`, [uuidv7(), r.cell.org, app, version, r.cell.scopes['engineering'], r.root.membershipId]);
    await step();
    await exit(6);
  });

  test('stage 7: the model names the fields from structure only; its answer is validated, metered and verified', async () => {
    const asked = r.modelRequests.length;
    for (let i = 0; i < 30; i += 1) {
      r.modelReplies.push({ configurations: [
        { detector: 'outlier', properties: ['rating'], confidence: 0.9, reason: 'rating is numeric' },
        { detector: 'missing_value', properties: ['email'], confidence: 0.7, reason: 'email is sometimes empty' },
        { detector: 'duplicate_value', properties: ['no_such_field'], confidence: 0.5, reason: 'not a property' },
      ] });
    }
    await step();
    for (let i = 0; i < 10 && (await pending('detector_configuration')).length === 0; i += 1) await step();
    const configs = await pending('detector_configuration');
    const supplier = r.type('supplier');
    const forSupplier = configs.filter((p) => p.payload['objectTypeId'] === supplier.id);
    assert.deepEqual(forSupplier.map((p) => p.payload['detector']).sort(), ['missing_value', 'outlier'], 'a property the type lacks is never proposed');
    const sent = r.modelRequests.slice(asked).map((m) => JSON.stringify(m.body));
    assert.ok(sent.length > 0 && sent.every((b) => !b.includes('Acme Supplies') && !b.includes('@')), 'structure only: no record value reaches the model');
    const charged = (await sql(`select count(*)::int as n, sum(weight)::int as w from billing.token_transactions where engagement_id = $1`, [engagement.id])).rows[0];
    assert.ok(charged.n > 0 && charged.w === charged.n * 3, 'advanced compile, 3 tokens a call, against the engagement');
    const e = await get();
    assert.equal(Number(e.tokensConsumed), charged.w);
    assert.ok(Number(e.providerCostConsumed) > 0, 'provider cost measured in pounds');
    assert.ok((await events('fde_model_call')).every((x) => typeof x.detail['input_tokens'] === 'number' && !('prompt' in x.detail)));

    const outlier = forSupplier.find((p) => p.payload['detector'] === 'outlier')!;
    const applied = await decide(outlier.id, { decision: 'accept' });
    const { configurations } = await gateway.call(listConfigurations, { params: { objectTypeId: supplier.id } }, asRoot());
    assert.equal(applied.appliedRef, configurations.find((c) => c.detector === 'outlier')!.id);
    for (const p of await pending('detector_configuration')) await decide(p.id, { decision: 'reject', reason: 'not_needed' });

    // A notify-only Cron over the dashboard the person accepted in stage 6, owned by whoever accepts it.
    const crons = await pending('cron_notify');
    assert.equal(crons.length, 1);
    assert.deepEqual([crons[0]!.payload['schedule'], crons[0]!.requiredPermission], ['0 8 * * 1', 'automation.create']);
    const cronOf = await decide(crons[0]!.id, { decision: 'accept', edits: { schedule: '0 7 * * 1' } });
    const cronId = (await sql(`select automation_id from fde.fde_proposal_targets where proposal_id = $1`, [cronOf.id])).rows[0].automation_id as string;
    notifyCron = cronId;
    const cron = await gateway.call(getCron, { params: { cronId } }, asRoot());
    assert.equal(cron.ownerMembershipId, r.root.membershipId, 'it outlives the engagement');
    assert.deepEqual(cron.actions.map((a) => a.kind), ['notify'], 'never a mutate action');
    assert.equal(cron.schedule, '0 7 * * 1', 'as the person set it');
    await step();
    await exit(7);
  });

  test('stage 8: an edge is accepted only with the kind and lead time a person states; then handover keeps Reliability', async () => {
    await step();
    const edges = await pending('dependency_edge');
    assert.ok(edges.length >= 3 && edges.every((p) => p.confidenceBand === 'low'));
    await assert.rejects(gateway.call(f.acceptProposalGroup, { params: { engagementId: engagement.id }, body: { proposalIds: edges.slice(0, 2).map((p) => p.id), count: 2 } },
      asRoot()), { code: 'fde.group_not_high' });
    await assert.rejects(decide(edges[0]!.id, { decision: 'accept' }), { code: 'fde.edge_needs_kind_and_lead_time' });
    const confirmed = await decide(edges[0]!.id, { decision: 'accept', edits: { kind: 'hard', leadTime: { value: 2, unit: 'days' }, reason: 'orders ship within two days' } });
    assert.equal(confirmed.status, 'accepted_edited');
    const live = (await gateway.call(listEdges, { query: { status: 'confirmed' } }, asRoot())).edges;
    assert.equal(live.find((x) => x.id === confirmed.payload['edgeId'])?.confirmedBy, r.root.membershipId, 'confirmed as the person who decided');
    for (const p of await pending('dependency_edge')) await decide(p.id, { decision: 'defer' });
    await step();
    await exit(8);

    const handover = await gateway.call(f.getHandover, { params: { engagementId: engagement.id } }, asRoot());
    assert.ok(handover.artefacts.length >= 6 && handover.artefacts.every((a) => a.decidedBy === r.root.membershipId));
    assert.ok(handover.deferred.length > 0 && handover.rejected.length > 0);
    const handed = await gateway.call(f.acceptHandover, { params: { engagementId: engagement.id },
      body: { keepReliability: true, reliabilityTokenBudget: 50, reliabilityProviderCostBudget: '5.00' } }, asRoot());
    assert.equal(handed.status, 'handed_over');
    const after_ = await get();
    assert.ok(after_.principals.every((p) => p.revokedAt !== null), 'every principal of the engagement revoked');
    successorId = handed.successorEngagementId!;
    const successor = await gateway.call(f.getEngagement, { params: { engagementId: successorId } }, asRoot());
    assert.deepEqual(successor.principals.map((p) => [p.role, p.revokedAt]), [['reliability', null]]);
    const asSurvey = { request: { organisationId: r.cell.org, servicePrincipalId: principalOf('survey') } };
    assert.equal((await services.call(authorise, { body: { permission: 'estate.view' } }, asSurvey)).reason, 'principal_inactive');

    // After handover: the accepted app published and opened, by its confirmer and then by someone else; the accepted Cron deleted.
    const draft = (await gateway.call(getApp, { params: { appId: supplierWatch } }, asRoot())).versions.find((v) => v.version === 1)!;
    const submitted = await gateway.call(submitForReview, { params: { appId: supplierWatch, version: 1 }, body: { lockVersion: draft.lockVersion } }, asRoot());
    await gateway.call(approveVersion, { params: { appId: supplierWatch, version: 1 }, body: { lockVersion: submitted.lockVersion, scopeId: r.cell.scopes['engineering']! } },
      r.cell.as(r.editor));
    await gateway.call(shareApp, { params: { appId: supplierWatch }, body: { grantee: { kind: 'membership', membershipId: r.editor.membershipId }, access: 'view' } },
      asRoot());
    await gateway.call(openApp, { params: { appId: supplierWatch }, query: {} }, asRoot());
    await gateway.call(openApp, { params: { appId: supplierWatch }, query: {} }, r.cell.as(r.editor));
    await gateway.call(deleteCron, { params: { cronId: notifyCron } }, asRoot());
    await drainAudit();

    const metrics = await gateway.call(f.getMetrics, { params: { engagementId: engagement.id } }, asRoot());
    const calibration = metrics.metrics.filter((m) => m.metric === 'calibration');
    assert.ok(calibration.length > 0 && calibration.every((m) => m.numerator !== null && m.denominator !== null), 'every ratio with its sample');
    // A posterior interval need not hold an extreme observed rate (three of three is not certainty), but it is a range within [0, 1].
    assert.ok(calibration.every((m) => m.interval !== null && m.interval[0] >= 0 && m.interval[0] < m.interval[1] && m.interval[1] <= 1), 'and its credible interval');
    assert.ok(metrics.metrics.some((m) => m.metric === 'tokens_per_engagement' && Number(m.value) > 0));
    assert.deepEqual(metrics.notMeasured, [], 'every metric of 54.1 cites its events now');
    const firstApp = metrics.metrics.find((m) => m.metric === 'time_to_first_app');
    assert.ok(firstApp !== undefined && firstApp.unit === 'working_days' && Number(firstApp.value) >= 0, 'opened by someone other than the person who accepted it');
    const reversal = metrics.metrics.find((m) => m.metric === 'post_handover_reversal_rate');
    assert.ok(reversal !== undefined && Number(reversal.denominator) >= 4, 'over the artefacts the engagement created');
    assert.equal(reversal.numerator, '1', 'the Cron deleted after handover; the app\'s first publication is no revision');
    assert.ok(metrics.metrics.filter((m) => m.metric === 'conformance_pass_rate').every((m) => m.numerator !== null && Number(m.denominator) > 0));
  });

  test('stage 9: Reliability watches the systems in scope under the successor; a heal awaiting review is the person\'s; it looks again a day later', async () => {
    const manifestId = (await sql('select manifest_id from connect.connections where id = $1', [r.crm])).rows[0].manifest_id as string;
    const healId = uuidv7();
    await r.cell.migrate.query(`insert into connect.heal_proposals (id, organisation_id, connection_id, from_manifest_id, change_kind, proposed_diff, disposition)
      values ($1, $2, $3, $4, 'new_field', $5, 'awaiting_review')`, [healId, r.cell.org, r.crm, manifestId, JSON.stringify({
      changes: [{ op: 'add_field', object: 'suppliers', field: 'tier', type: 'string', path: 'tier' }],
      drift: [{ kind: 'new_field', object: 'suppliers', field: 'tier', detail: 'present in 40 of 40 sampled' }], candidateManifestId: null,
    })]);
    const tasks = async () => (await sql(`select connection_id, status from fde.fde_tasks where engagement_id = $1 and kind = 'watch_reliability'`, [successorId]))
      .rows as { connection_id: string; status: string }[];
    const settled = async () => { const all = await tasks(); return all.length > 0 && all.every((t) => t.status !== 'queued' && t.status !== 'running'); };
    for (let i = 0; i < 3 && !await settled(); i += 1) await orchestrator.step(r.cell.org, successorId);
    const first = await tasks();
    assert.deepEqual(first.map((t) => t.connection_id).sort(), [r.crm, r.erp].sort(), 'the predecessor\'s systems in scope');
    assert.ok(first.every((t) => t.status === 'succeeded'));

    const reviews = (await gateway.call(f.listProposals, { params: { engagementId: successorId }, query: { status: 'pending' } }, asRoot())).proposals;
    assert.deepEqual(reviews.map((p) => [p.kind, p.payload['healProposalId'], p.payload['changeKind'], p.requiredPermission]),
      [['heal_review', healId, 'new_field', 'connector.heal_review']], 'a new field is proposed, never applied silently');
    await decide(reviews[0]!.id, { decision: 'reject', reason: 'not_needed' });
    const heal = (await sql('select disposition, reviewed_by from connect.heal_proposals where id = $1', [healId])).rows[0];
    assert.deepEqual([heal.disposition, heal.reviewed_by], ['rejected', r.root.membershipId], 'the repair decided by the person, not the principal');

    await orchestrator.step(r.cell.org, successorId);
    assert.equal((await tasks()).length, 2, 'nothing more until a day has passed');
    const later = createOrchestrator({ databases, services, logger: quiet, cellId: CELL_ID, providerPrice: { inputPerMillion: 3, outputPerMillion: 15 },
      now: () => new Date(Date.now() + 25 * 3_600_000) });
    await later.step(r.cell.org, successorId);
    assert.equal((await tasks()).length, 4, 'a day later it looks again');
    assert.deepEqual((await gateway.call(f.listProposals, { params: { engagementId: successorId }, query: { status: 'pending' } }, asRoot())).proposals, [],
      'the same heal is not proposed twice');
  });

  test('only the named engagement owner confirms a stage exit, never the supervising engineer (decision 2026-11-14)', async () => {
    const owner = await r.cell.member('fde-owner@acme.example', 'Admin');
    const started = await gateway.call(f.startEngagement, {
      body: { name: 'Owned', goals: 'Owner rules', tokenBudget: 10, providerCostBudget: '1.00' },
    }, r.keyed(r.root));
    assert.equal(started.ownerMembershipId, r.root.membershipId, 'the engaging administrator until one is named');
    const named = await gateway.call(f.nameEngagementOwner, { params: { engagementId: started.id }, body: { membershipId: owner.membershipId } }, asRoot());
    assert.equal(named.ownerMembershipId, owner.membershipId);
    assert.equal((await events('fde_owner_named')).length, 1);
    await assert.rejects(gateway.call(f.confirmStageExit, { params: { engagementId: started.id, stageNumber: 0 }, body: { skip: false } }, asRoot()),
      { code: 'fde.not_engagement_owner' });
    await assert.rejects(gateway.call(f.assignEngineer, { params: { engagementId: started.id }, body: { membershipId: owner.membershipId } }, asRoot()),
      { code: 'fde.engineer_is_owner' });
    // The owner passes the owner check; the stage's own criteria still decide.
    await assert.rejects(gateway.call(f.confirmStageExit, { params: { engagementId: started.id, stageNumber: 0 }, body: { skip: false } }, r.cell.as(owner)),
      (error: { code?: string }) => error.code !== 'fde.not_engagement_owner');
    await gateway.call(f.stopEngagement, { params: { engagementId: started.id }, body: { reason: 'test over' } }, asRoot()).catch(() => undefined);
  });

  test('the stop button revokes, withdraws and cancels at once; a spent budget pauses', async () => {
    const second = await gateway.call(f.startEngagement, {
      body: { name: 'Second look', goals: 'A second pass', tokenBudget: 100, providerCostBudget: '5.00' },
    }, r.keyed(r.root));
    engagement = second as typeof engagement;
    await step();
    await exit(0);
    await step();
    assert.ok((await pending('estate_entry')).length > 0);
    const stopped = await gateway.call(f.stopEngagement, { params: { engagementId: second.id }, body: { reason: 'wrong scope' } }, asRoot());
    assert.equal(stopped.status, 'stopped');
    // engagement_cost_reported (73.5, 73.9): the cost report as it stood when it ended.
    const reported = (await events('engagement_cost_reported')).filter((e) => e.detail['reason'] === 'stopped');
    assert.equal(reported.length >= 1, true);
    const last = reported.at(-1)!.detail;
    assert.match(String(last['tokens_charged']), /^\d+(\.\d+)?$/);
    assert.equal(typeof last['model_cost_measured'], 'boolean');
    const view = await get();
    assert.ok(view.principals.every((p) => p.revokedAt !== null));
    assert.equal(view.proposals.pending ?? 0, 0);
    assert.ok((view.proposals.withdrawn ?? 0) > 0);
    await assert.rejects(gateway.call(f.resumeEngagement, { params: { engagementId: second.id } }, asRoot()), { code: 'fde.not_paused' });
    const asSurvey = { request: { organisationId: r.cell.org, servicePrincipalId: principalOf('survey') } };
    assert.equal((await services.call(authorise, { body: { permission: 'estate.view' } }, asSurvey)).reason, 'principal_inactive');

    const third = await gateway.call(f.startEngagement, { body: { name: 'Budgeted', goals: 'A bounded pass', tokenBudget: 3, providerCostBudget: '1.00' } }, r.keyed(r.root));
    await r.cell.migrate.query('update fde.fde_engagements set tokens_consumed = 3 where id = $1', [third.id]);
    await orchestrator.step(r.cell.org, third.id);
    const paused = await gateway.call(f.getEngagement, { params: { engagementId: third.id } }, asRoot());
    assert.equal(paused.status, 'paused');
    assert.ok((await events('fde_limit_reached')).some((x) => x.detail['engagement_id'] === third.id));
    await assert.rejects(gateway.call(f.resumeEngagement, { params: { engagementId: third.id } }, asRoot()), { code: 'fde.limit_reached' });
    await gateway.call(f.setEngagementLimits, { params: { engagementId: third.id }, body: { tokenBudget: 50 } }, asRoot());
    assert.equal((await gateway.call(f.resumeEngagement, { params: { engagementId: third.id } }, asRoot())).status, 'active');
  });

  test('stage 2: a system whose connector a person drafted and probed: its manifest and mappings go to a person, whose acceptance verifies it', async () => {
    // The administrator gives the builder the system's documentation (a specification), as a person does.
    const openapi = {
      openapi: '3.0.3', info: { title: 'Ops', version: '1.0.0' }, servers: [{ url: r.apiUrl }], security: [{ token: [] }],
      paths: { '/v1/events': { get: { summary: 'List events', responses: { 200: { description: 'Events', content: { 'application/json': {
        schema: { type: 'object', properties: { results: { type: 'array', items: { $ref: '#/components/schemas/Event' } } } } } } } } } } },
      components: { securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
        schemas: { Event: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, kind: { type: 'string' } } } } },
    };
    const build = await gateway.call(draftConnector, { body: {
      name: 'Ops', slug: 'ops', provider: 'Example', baseUrl: r.apiUrl, documentation: { kind: 'openapi', text: JSON.stringify(openapi) },
      sandbox: { name: 'Ops', owningScopeId: r.cell.scopes['engineering']! },
    } }, r.keyed(r.root));
    await gateway.call(setConnectionSecrets, { params: { connectionId: build.connectionId }, body: { values: { token: 'tok_valid' } } }, r.cell.as(r.root));
    await gateway.call(probeBuild, { params: { connectionId: build.connectionId } }, r.keyed(r.root));

    const third = await gateway.call(f.startEngagement, { body: { name: 'Ops system', goals: 'Bring the ops system in', tokenBudget: 100, providerCostBudget: '5.00' } },
      r.keyed(r.root));
    engagement = third as typeof engagement;
    await step();
    await exit(0);
    await step();
    const entries = await pending('estate_entry');
    const building = entries.find((p) => p.payload['connectionId'] === build.connectionId)!;
    assert.equal(building.confidenceBand, 'medium', 'a system still being built');
    await decide(building.id, { decision: 'accept' });
    for (const p of entries.filter((x) => x.id !== building.id)) await decide(p.id, { decision: 'reject', reason: 'out_of_scope' });
    await step();
    await exit(1);

    for (let i = 0; i < 60 && (await pending('connector_mapping')).length === 0; i += 1) {
      await step();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const [manifest] = await pending('connector_manifest');
    const mappings = await pending('connector_mapping');
    assert.ok(manifest !== undefined && manifest.payload['connectionId'] === build.connectionId && manifest.requiredPermission === 'connection.create');
    assert.notEqual(manifest!.payload['manifestId'], build.manifest.id, 'the reconciled version, the probe being the source of truth');
    assert.ok(manifest!.payload['conformanceRunId'], 'with its conformance run');
    assert.deepEqual(mappings.map((p) => [p.payload['object'], p.payload['identifier']]), [['events', ['id']]], 'validated, probed, with its identifier');
    await assert.rejects(exit(2), { code: 'fde.criteria_unmet' }, 'not offered to stage 3 until verified');

    await decide(mappings[0]!.id, { decision: 'accept', edits: { objectType: 'Ops event' } });
    const connection = await gateway.call(getConnection, { params: { connectionId: build.connectionId } }, asRoot());
    assert.equal(connection.status, 'verified', 'confirmed in the builder as the person, who holds connector.verify');
    // A person's live view of the confirmed objects, as the state plane records it on subscribing (tests/services/live.test.ts opens one).
    await inTx(r.cell.app, { orgId: r.cell.org }, () => recordSubscription(r.cell.app, {
      organisationId: r.cell.org, membershipId: r.viewer.membershipId, correlationId: uuidv7(), event: 'subscription_opened', set: undefined,
      detail: { subscription_id: uuidv7(), connection_id: build.connectionId, source_object: 'events', objects: 2, properties: 2, mode: 'live' },
    }));
    await drainAudit();
    const clone = (await gateway.call(f.getMetrics, { params: { engagementId: third.id } }, asRoot())).metrics.find((m) => m.metric === 'time_to_first_live_clone');
    assert.ok(clone !== undefined && clone.unit === 'working_hours' && Number(clone.value) >= 0, 'from agent install to a confirmed mapping\'s objects live');
    const confirmed = await events('mapping_confirmed');
    assert.ok(confirmed.some((x) => x.detail['object_type'] === 'Ops event' && x.detail['corrected'] === true));
    await decide(manifest!.id, { decision: 'accept' });
    await step();
    await exit(2);
  });

  test('stage 2: a system listed with its documentation is drafted by the Integration principal, probed once its owner gives the credential, and goes to a person', async () => {
    const fourth = await gateway.call(f.startEngagement, { body: { name: 'Listed system', goals: 'Bring the shipping system in', tokenBudget: 100,
      providerCostBudget: '5.00' } }, r.keyed(r.root));
    engagement = fourth as typeof engagement;
    const openapi = {
      openapi: '3.0.3', info: { title: 'Shipping', version: '1.0.0' }, servers: [{ url: r.apiUrl }], security: [{ token: [] }],
      paths: { '/v1/events': { get: { summary: 'List events', responses: { 200: { description: 'Events', content: { 'application/json': {
        schema: { type: 'object', properties: { results: { type: 'array', items: { $ref: '#/components/schemas/Event' } } } } } } } } } } },
      components: { securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
        schemas: { Event: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, kind: { type: 'string' } } } } },
    };
    const body = { name: 'Shipping', provider: 'Example', slug: 'shipping', baseUrl: r.apiUrl, documentation: { kind: 'openapi' as const, text: JSON.stringify(openapi) },
      owningScopeId: r.cell.scopes['engineering']! };
    const listed = await gateway.call(f.addEngagementSystem, { params: { engagementId: fourth.id }, body }, asRoot());
    assert.deepEqual([listed.status, listed.connectionId, listed.awaitingCredential], ['listed', null, false]);
    await assert.rejects(gateway.call(f.addEngagementSystem, { params: { engagementId: fourth.id }, body }, asRoot()), { code: 'fde.system_slug_taken' });
    const systems = async () => (await gateway.call(f.listEngagementSystems, { params: { engagementId: fourth.id } }, asRoot())).systems;

    await step();
    await exit(0);
    await step();
    // Listing a system put it in scope; the survey's entries are another matter.
    for (const p of await pending('estate_entry')) await decide(p.id, { decision: 'reject', reason: 'out_of_scope' });
    await step();
    await exit(1);

    for (let i = 0; i < 10 && (await systems())[0]!.status === 'listed'; i += 1) await step();
    const [drafted] = await systems();
    assert.equal(drafted!.status, 'drafted');
    assert.ok(drafted!.awaitingCredential, 'its owner gives the credential: the AI FDE never holds a secret');
    const connectionId = drafted!.connectionId!;
    const sandbox = await gateway.call(getConnection, { params: { connectionId } }, asRoot());
    assert.deepEqual([sandbox.status, sandbox.owningMembershipId], ['draft', r.root.membershipId], 'owned by the engaging administrator');
    const built = (await events('connector_created')).at(-1)!;
    assert.deepEqual(built.actor, { kind: 'service_principal', servicePrincipalId: principalOf('integration') }, 'drafted by the Integration principal');
    await step();
    const stagesRun = async () => (await sql('select stage from connect.probe_runs where connection_id = $1', [connectionId])).rows.map((x) => x.stage as string);
    assert.deepEqual(await stagesRun(), ['parse'], 'no probe without the credential');

    await gateway.call(setConnectionSecrets, { params: { connectionId }, body: { values: { token: 'tok_valid' } } }, asRoot());
    for (let i = 0; i < 60 && (await pending('connector_mapping')).length === 0; i += 1) {
      await step();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok((await stagesRun()).includes('probe'), 'probed by the principal once the credential was given');
    const [manifest] = await pending('connector_manifest');
    const mappings = await pending('connector_mapping');
    assert.ok(manifest !== undefined && manifest.payload['connectionId'] === connectionId && manifest.payload['conformanceRunId'], 'with its conformance run');
    assert.deepEqual(mappings.map((p) => [p.payload['object'], p.payload['identifier']]), [['events', ['id']]]);
    await assert.rejects(exit(2), { code: 'fde.criteria_unmet' }, 'not offered to stage 3 until verified');
    await decide(mappings[0]!.id, { decision: 'accept' });
    assert.equal((await gateway.call(getConnection, { params: { connectionId } }, asRoot())).status, 'verified', 'confirmed by the person');
    await decide(manifest!.id, { decision: 'accept' });
    await step();
    await exit(2);
    assert.equal((await systems())[0]!.awaitingCredential, false);
  });
});
