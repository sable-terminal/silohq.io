// model-gateway end to end (spec 7.8, 62): the service as a real process on a fresh cell
// database and redis-data, in front of fake model endpoints. A Vertex AI style endpoint
// (with a fake metadata server issuing workload identity tokens) and a self-hosted
// OpenAI-compatible endpoint (with a bearer token file) stand in for the providers.
//
// What is proved: calls are built from typed vocabulary and reach the route's endpoint;
// every call, allowed or refused, is in platform.model_calls with tokens and outcome and
// never the prompt; usage and audit events go out through the outbox with the ledger row;
// refusals (value patterns, record value fields, length, concurrency, the carve-out) are
// recorded and never sent; output that does not match its schema is refused, not
// repaired; timeouts and endpoint failures name themselves; prompts, documents and outputs
// never reach the logs.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { z } from 'zod';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import type { ServiceName } from '../../src/config/service.config.ts';
import { callModel, outputSpec, parseOutput } from '../../src/contracts/model-gateway/call.contract.ts';
import { extractDocument } from '../../src/contracts/model-gateway/extraction.contract.ts';
import { modelCellSlotKeys } from '../../src/infra/keyspaces.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { connectRedis } from '../../src/infra/redis.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import type { ModelCall } from '../../src/models/platform/modelCall.model.ts';
import { modelCallRepo } from '../../src/repos/platform/index.repo.ts';
import { service as modelGateway } from '../../src/routes/model-gateway/index.route.ts';
import { containsRecordValue } from '../../src/utils/recordValue.util.ts';
import { isAppError, type AppError } from '../../src/utils/errors.util.ts';
import { CELL_ID, createLocalCell, createMembership, createOrganisation, createUser } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

// ----------------------------------------------------------------------------- fake endpoints

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  delayMs?: number;
}

interface Fake {
  url: string;
  received: Received[];
  reply: (request: Received) => Reply | Promise<Reply>;
  close(): Promise<void>;
}

async function fakeEndpoint(reply: Fake['reply']): Promise<Fake> {
  const fake = { received: [] as Received[], reply } as Fake;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const request = { path: req.url ?? '', headers: req.headers, body: text ? JSON.parse(text) : undefined };
      fake.received.push(request);
      void Promise.resolve(fake.reply(request)).then(async (r) => {
        if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
        if (res.destroyed) return;
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
        res.end(r.text ?? JSON.stringify(r.json ?? {}));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return fake;
}

const vertexReply = (output: unknown, usage = { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 12 }): Reply => ({
  json: {
    candidates: [{ content: { role: 'model', parts: [{ text: typeof output === 'string' ? output : JSON.stringify(output) }] }, finishReason: 'STOP' }],
    usageMetadata: usage,
    modelVersion: 'gemini-test-001',
  },
});

const chatReply = (output: unknown): Reply => ({
  json: {
    model: 'open-weights-test-q8',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 25, completion_tokens_details: { reasoning_tokens: 5 } },
  },
});

// ----------------------------------------------------------------------------- the cell

// As a deployment gives model-gateway: the model call ledger, the outbox, the Siloes rows.
const LOGIN = 'test_model_gateway';
const VERTEX_PATH = '/v1/projects/silo-test-1/locations/europe-west2/publishers/google/models/gemini-test:generateContent';

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let auth: pg.Client;
let vertex: Fake;
let selfHosted: Fake;
let metadata: Fake;
let gateway: RunningProcess;
let config: Config;
const clients = new Map<ServiceName, ServiceClient>();
const logLines: string[] = [];

let org: string;
let otherOrg: string;
let member: string;
let otherMember: string;

const planSchema = z.strictObject({ objectType: z.string(), measure: z.string(), period: z.enum(['last_quarter', 'this_year']) });
const plan = { objectType: 'Customer', measure: 'Invoice.total', period: 'last_quarter' } as const;
const QUESTION = 'Which customers spent most last quarter?';
const INSTRUCTIONS = 'Translate the question into a plan over the vocabulary. Name only what the vocabulary offers.';

const vocabulary = {
  objectTypes: [{
    name: 'Customer', description: 'A company we invoice',
    properties: [{ name: 'name', type: 'string' }, { name: 'email', type: 'string', description: 'Billing contact address' }],
    timeFields: ['createdAt'],
  }, {
    name: 'Invoice', properties: [{ name: 'total', type: 'decimal' }, { name: 'issuedOn', type: 'date' }],
  }],
  linkTypes: [{ name: 'billed', from: 'Invoice', to: 'Customer' }],
  capabilities: [{ connection: 'Finance', operations: ['filter', 'aggregate'] }],
  profiles: [{ object: 'Invoice', rowCount: 120_000, field: 'total', nullRate: 0.01 }],
};

const client = (caller: ServiceName): ServiceClient => {
  let c = clients.get(caller);
  if (!c) {
    c = createServiceClient({
      caller, timeoutMs: 20_000, http: { ...config.http, serviceUrls: { 'model-gateway': `http://127.0.0.1:${gateway.port}` } },
    });
    clients.set(caller, c);
  }
  return c;
};

const asMember = (organisationId = org, membershipId = member) => ({ request: { organisationId, membershipId } });

const compileBody = (overrides: Record<string, unknown> = {}) => ({
  role: 'compile' as const, instructions: INSTRUCTIONS, vocabulary, question: QUESTION, context: { today: '2026-11-01', fiscalYearStartMonth: 4 },
  output: outputSpec('Plan', planSchema), ...overrides,
});

async function ledger(correlationId: string, organisationId = org): Promise<ModelCall[]> {
  return withTransaction(app, { organisationId }, (db) => modelCallRepo.listByCorrelation(db, organisationId, correlationId));
}

async function outbox(correlationId: string, organisationId = org): Promise<{ topic: string; event: string; payload: any }[]> {
  const { rows } = await inTx(app, { orgId: organisationId }, () => app.query(
    'select topic, event, payload from platform.outbox where correlation_id = $1 order by seq', [correlationId]));
  return rows as { topic: string; event: string; payload: any }[];
}

async function refusal(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  assert.fail('expected a refusal');
}

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function routesFile(dir: string, routes: unknown[]): string {
  const file = path.join(dir, `routes-${uuidv7()}.json`);
  writeFileSync(file, JSON.stringify(routes));
  return file;
}

function gatewayConfig(routes: string, extra: Record<string, string> = {}): Config {
  return loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'model-gateway', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
    PG_CONTROL_URL: h.url(LOGIN), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`,
    MODEL_ROUTES_FILE: routes, GCE_METADATA_HOST: metadata.url.replace('http://', ''),
    MODEL_PER_ORGANISATION_CONCURRENCY: '2', MODEL_CELL_CONCURRENCY: '3', MODEL_MAX_REQUEST_BYTES: '65536',
    MODEL_MAX_DOCUMENT_BYTES: '4096', ...extra,
  });
}

let dir: string;
let vertexRoute: Record<string, unknown>;

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  auth = await h.connect('test_auth');
  await createLocalCell(migrate);
  org = await createOrganisation(app, 'acme');
  otherOrg = await createOrganisation(app, 'globex');
  member = await createMembership(app, org, await createUser(auth, 'ada@acme.example'));
  otherMember = await createMembership(app, otherOrg, await createUser(auth, 'grace@globex.example'));

  metadata = await fakeEndpoint(() => ({ json: { access_token: 'ya29.workload-token', expires_in: 3600, token_type: 'Bearer' } }));
  vertex = await fakeEndpoint(() => vertexReply(plan));
  selfHosted = await fakeEndpoint(() => chatReply({ matches: [] }));

  dir = mkdtempSync(path.join(tmpdir(), 'silo-model-'));
  const tokenFile = path.join(dir, 'token');
  writeFileSync(tokenFile, 'self-hosted-token\n');
  vertexRoute = {
    provider: 'vertex_ai', endpoint: vertex.url, project: 'silo-test-1', model: 'gemini-test', region: 'europe-west2', zeroRetention: true,
    auth: { kind: 'workload_identity' },
  };
  const routes = routesFile(dir, [
    // Priced in pounds per million tokens (D106); recognition is not priced.
    { ...vertexRoute, role: 'compile', maxOutputTokens: 2048, pricing: { inputPerMillion: '0.25', outputPerMillion: '2' } },
    { ...vertexRoute, role: 'recognition', name: 'recognition-uk' },
    { ...vertexRoute, role: 'document_extraction', documentMediaTypes: ['text/plain', 'application/pdf'] },
    { role: 'resolution', provider: 'self_hosted', endpoint: selfHosted.url, model: 'open-weights-test', region: 'uk-lon-1', zeroRetention: true,
      auth: { kind: 'bearer_file', file: tokenFile }, maxOutputTokens: 1024 },
    { role: 'fde', provider: 'self_hosted', endpoint: selfHosted.url, model: 'open-weights-test', region: 'uk-lon-1', zeroRetention: true,
      timeoutMs: 300 },
  ]);
  config = gatewayConfig(routes);

  // A run that stopped mid-call may have left leases in the shared cell key.
  const redis = await connectRedis('data', config.redis);
  await redis.remove(modelCellSlotKeys, modelCellSlotKeys.key({ cellId: CELL_ID }));
  await redis.close();

  const logger = createLogger({ service: 'model-gateway', cell: CELL_ID, release: 'test', level: 'debug', write: (line) => logLines.push(line) });
  gateway = await runProcess([modelGateway], config, { logger });
});

after(async () => {
  for (const c of clients.values()) c.close();
  await gateway?.stop('test');
  await Promise.all([vertex?.close(), selfHosted?.close(), metadata?.close()]);
  await h?.close();
});

// ----------------------------------------------------------------------------- tests

describe('the contracts (spec 62.3, 62.5)', () => {
  test('a vocabulary request has nowhere to put a record value; the extraction request is the one that does', () => {
    assert.equal(containsRecordValue(callModel.body), false);
    assert.equal(containsRecordValue(extractDocument.body), true);
  });

  test('a caller states its output as a JSON Schema from its Zod schema and parses the answer with the same schema', () => {
    const spec = outputSpec('Plan', planSchema);
    assert.equal(spec.schema['additionalProperties'], false);
    assert.deepEqual(parseOutput(planSchema, plan), plan);
    assert.throws(() => parseOutput(planSchema, { ...plan, extra: 1 }), /does not match/);
  });
});

describe('a vocabulary call (spec 7.8, 62.1)', () => {
  test('reaches the route\'s endpoint, built from the typed request, and returns checked output', async () => {
    const correlationId = uuidv7();
    const before = vertex.received.length;
    const result = await client('compile').call(callModel, { body: compileBody() }, { ...asMember(), correlationId });

    assert.deepEqual(result.output, plan);
    assert.equal(result.model, 'gemini-test-001');
    assert.equal(result.route, 'compile');
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 30, thinkingTokens: 12 });

    assert.equal(vertex.received.length, before + 1);
    const sent = vertex.received.at(-1)!;
    assert.equal(sent.path, VERTEX_PATH);
    assert.equal(sent.headers.authorization, 'Bearer ya29.workload-token', 'workload identity from the metadata server');
    assert.equal(sent.body.generationConfig.temperature, 0);
    assert.equal(sent.body.generationConfig.maxOutputTokens, 2048, 'the route\'s maximum when the caller names none');
    assert.equal(sent.body.generationConfig.responseMimeType, 'application/json');
    assert.equal(sent.body.generationConfig.responseJsonSchema.$schema, undefined);
    assert.deepEqual(sent.body.generationConfig.responseJsonSchema.required.sort(), ['measure', 'objectType', 'period']);
    assert.match(sent.body.systemInstruction.parts[0].text, /^Translate the question/);
    const user = sent.body.contents[0].parts[0].text as string;
    for (const expected of ['"Customer"', '"Invoice"', '"rowCount":120000', QUESTION, '2026-11-01']) assert.ok(user.includes(expected), expected);
  });

  test('is recorded with tokens, route and outcome, and metered and audited through the outbox in the same transaction', async () => {
    const correlationId = uuidv7();
    const result = await client('compile').call(callModel, { body: compileBody({ engagementId: uuidv7() }) }, { ...asMember(), correlationId });

    const [row, ...rest] = await ledger(correlationId);
    assert.equal(rest.length, 0);
    assert.equal(row!.callId, result.callId);
    assert.equal(row!.callerService, 'compile');
    assert.equal(row!.requestType, 'vocabulary');
    assert.equal(row!.model, 'gemini-test-001');
    assert.equal(row!.modelRoute, 'compile');
    assert.equal(row!.outcome, 'ok');
    assert.equal(row!.refusalCategory, null);
    assert.deepEqual([row!.inputTokens, row!.outputTokens, row!.thinkingTokens], [120, 30, 12]);
    assert.equal(row!.promptHash.length, 32);
    assert.ok(row!.latencyMs !== null && row!.latencyMs >= 0);
    // At the route's prices: 120 input at £0.25 a million, 30 output and 12 thinking at £2 a million.
    assert.equal(row!.providerCost, '0.00011400');
    assert.ok(!JSON.stringify(row).includes('Which customers'), 'never the prompt');

    const messages = await outbox(correlationId);
    assert.deepEqual(messages.map((m) => `${m.topic} ${m.event}`), ['metering.usage model_usage', 'audit.events audit_event']);
    assert.equal(messages[0]!.payload.callId, result.callId);
    assert.deepEqual([messages[0]!.payload.inputTokens, messages[0]!.payload.outputTokens, messages[0]!.payload.thinkingTokens], [120, 30, 12]);
    assert.equal(messages[0]!.payload.membershipId, member);
    assert.ok(messages[0]!.payload.engagementId);
    const audit = messages[1]!.payload;
    assert.equal(audit.event, 'model_call_made');
    assert.deepEqual(audit.actor, { kind: 'membership', membershipId: member });
    assert.deepEqual(audit.resource, { type: 'model_call', id: result.callId });
    assert.deepEqual([audit.detail.input_tokens, audit.detail.route, audit.detail.caller_service], [120, 'compile', 'compile']);
    for (const m of messages) assert.ok(!JSON.stringify(m.payload).includes('Customer'), 'references and counts only');
  });

  test('the same request gives the same prompt hash; a different question a different one', async () => {
    const [a, b, c] = [uuidv7(), uuidv7(), uuidv7()];
    await client('compile').call(callModel, { body: compileBody() }, { ...asMember(), correlationId: a });
    await client('compile').call(callModel, { body: compileBody() }, { ...asMember(), correlationId: b });
    await client('compile').call(callModel, { body: compileBody({ question: 'Which customers spent least?' }) }, { ...asMember(), correlationId: c });
    const [ra] = await ledger(a);
    const [rb] = await ledger(b);
    const [rc] = await ledger(c);
    assert.deepEqual(ra!.promptHash, rb!.promptHash);
    assert.notDeepEqual(ra!.promptHash, rc!.promptHash);
  });

  test('the workload identity token is fetched once and reused', () => {
    assert.equal(metadata.received.length, 1);
    assert.equal(metadata.received[0]!.headers['metadata-flavor'], 'Google');
  });

  test('a self-hosted route speaks the OpenAI-compatible API with its bearer token; reasoning tokens are kept apart', async () => {
    const correlationId = uuidv7();
    const matchSchema = z.strictObject({ matches: z.array(z.strictObject({ left: z.string(), right: z.string() })) });
    const result = await client('resolution').call(callModel, {
      body: { role: 'resolution', instructions: 'Propose which properties identify the same entity.', vocabulary, output: outputSpec('Matches', matchSchema) },
    }, { ...asMember(), correlationId });
    assert.deepEqual(result.output, { matches: [] });
    assert.equal(result.model, 'open-weights-test-q8');
    assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 20, thinkingTokens: 5 });

    const sent = selfHosted.received.at(-1)!;
    assert.equal(sent.path, '/v1/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer self-hosted-token');
    assert.equal(sent.body.model, 'open-weights-test');
    assert.equal(sent.body.max_tokens, 1024);
    assert.equal(sent.body.temperature, 0);
    assert.deepEqual(sent.body.response_format.type, 'json_schema');
    assert.equal(sent.body.response_format.json_schema.name, 'Matches');
    assert.equal(sent.body.response_format.json_schema.strict, true);
    assert.equal(sent.body.messages[0].role, 'system');
    const [row] = await ledger(correlationId);
    assert.deepEqual([row!.modelRoute, row!.callerService, row!.outputTokens, row!.thinkingTokens], ['resolution', 'resolution', 20, 5]);
  });
});

describe('refusals before sending (spec 7.8, 62.2, 62.3)', () => {
  const refusedCall = async (caller: ServiceName, body: Record<string, unknown>) => {
    const correlationId = uuidv7();
    const sentBefore = vertex.received.length + selfHosted.received.length;
    const error = await refusal(client(caller).call(callModel, { body: body as never }, { ...asMember(), correlationId }));
    assert.equal(vertex.received.length + selfHosted.received.length, sentBefore, 'nothing was sent');
    const rows = await ledger(correlationId);
    const messages = await outbox(correlationId);
    return { error, rows, messages };
  };

  test('a value pattern anywhere is refused, not stripped, and the refusal names where without the text', async () => {
    const withEmail = structuredClone(vocabulary);
    withEmail.objectTypes[0]!.properties[1] = { name: 'email', type: 'string', description: 'Billing contact, for example jo.bloggs@acme.example' };
    const { error, rows, messages } = await refusedCall('compile', compileBody({ vocabulary: withEmail }));
    assert.equal(error.code, 'model.value_pattern');
    assert.equal(error.details['where'], 'vocabulary.objectTypes.0.properties.1.description');
    assert.equal(error.details['kinds'], 'email');
    assert.ok(!error.message.includes('jo.bloggs'));
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.outcome, rows[0]!.refusalCategory, rows[0]!.inputTokens, rows[0]!.latencyMs], ['refused', 'redaction_match', 0, null]);
    assert.deepEqual(messages.map((m) => `${m.topic} ${m.payload.event}`), ['audit.events model_call_refused'], 'refused: audited, not metered');
    assert.equal(messages[0]!.payload.detail.refusal_category, 'redaction_match');
    assert.equal(messages[0]!.payload.detail.reason, 'model.value_pattern');

    for (const [body, where, kind] of [
      [compileBody({ question: 'Who paid with card 4111 1111 1111 1111?' }), 'question', 'card_number'],
      [compileBody({ instructions: 'Ring 07700900123 for help.' }), 'instructions', 'long_digit_string'],
      [compileBody({ question: 'Which customer has NI number AB123456C?' }), 'question', 'national_insurance_number'],
    ] as const) {
      const refused = await refusedCall('compile', body);
      assert.equal(refused.error.details['where'], where);
      assert.ok(String(refused.error.details['kinds']).includes(kind), kind);
      assert.equal(refused.rows[0]!.refusalCategory, 'redaction_match');
    }
  });

  test('a key the caller chose is masked in the path, so a value in a key never reaches the error', async () => {
    const summary = { copiedFields: [{ objectType: 'jo@acme.example', property: 'total' }], findings: [] };
    const { error } = await refusedCall('recognition', {
      role: 'recognition', instructions: 'Rank the findings.', vocabulary: {}, findingsSummary: summary, output: outputSpec('Ranking', planSchema),
    });
    assert.equal(error.details['where'], 'findingsSummary.copiedFields.0.objectType');
    const schemaKey = outputSpec('Plan', z.strictObject({ 'jo@acme.example': z.string() }));
    const keyed = await refusedCall('compile', compileBody({ output: schemaKey }));
    assert.equal(keyed.error.details['where'], 'output.schema.properties.[key]');
  });

  test('a ranking figure from a field the summary does not name is a record value field', async () => {
    const { error, rows } = await refusedCall('recognition', {
      role: 'recognition', instructions: 'Rank the findings by impact.', vocabulary: {},
      findingsSummary: {
        copiedFields: [{ objectType: 'Invoice', property: 'total' }],
        findings: [{ detector: 'Late payers', severity: 'high', count: 12, metrics: { 'Invoice.total': 1200.5, 'Customer.creditLimit': 5000 } }],
      },
      output: outputSpec('Ranking', z.strictObject({ order: z.array(z.string()) })),
    });
    assert.equal(error.code, 'model.record_value_field');
    assert.equal(error.details['where'], 'findingsSummary.findings.0.metrics');
    assert.deepEqual([rows[0]!.callerService, rows[0]!.modelRoute, rows[0]!.refusalCategory], ['recognition', 'recognition-uk', 'record_value_field']);
  });

  test('an output schema carrying examples or defaults is a record value field', async () => {
    const schema = { ...outputSpec('Plan', planSchema).schema };
    schema['properties'] = { ...(schema['properties'] as object), measure: { type: 'string', examples: ['Invoice.total'] } };
    const { error, rows } = await refusedCall('compile', compileBody({ output: { name: 'Plan', schema } }));
    assert.equal(error.details['where'], 'output.schema.properties.measure.examples');
    assert.equal(rows[0]!.refusalCategory, 'record_value_field');
    // A field named "default" is a name, not the keyword.
    const named = outputSpec('Plan', z.strictObject({ default: z.string() }));
    vertex.reply = () => vertexReply({ default: 'x' });
    try {
      const ok = await client('compile').call(callModel, { body: compileBody({ output: named }) }, asMember());
      assert.deepEqual(ok.output, { default: 'x' });
    } finally {
      vertex.reply = () => vertexReply(plan);
    }
  });

  test('length bounds: the prompt\'s size and the output tokens asked for', async () => {
    const documentation = Array.from({ length: 4 }, (_, i) => ({ title: `Guide ${i}`, text: 'Schema notes. '.repeat(1400) }));
    const big = await refusedCall('compile', compileBody({ vocabulary: { ...vocabulary, documentation } }));
    assert.equal(big.error.code, 'bound.model_request_bytes');
    assert.equal(big.error.details['limit'], 65536);
    assert.equal(big.rows[0]!.refusalCategory, 'length_bound');

    const tokens = await refusedCall('compile', compileBody({ maxOutputTokens: 4096 }));
    assert.equal(tokens.error.code, 'bound.model_output_tokens');
    assert.equal(tokens.error.details['limit'], 2048);
    assert.equal(tokens.rows[0]!.refusalCategory, 'length_bound');
  });
});

describe('what is not a model call', () => {
  const raw = async (caller: string, body: unknown, pathname = '/v1/calls') => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-silo-caller': caller, 'x-silo-organisation-id': org, 'x-silo-membership-id': member,
        'x-correlation-id': uuidv7(),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as { error: { code: string; issues?: { path: string }[] } } };
  };

  test('a field the request type does not have is refused at the edge: there is nowhere to put a sample value', async () => {
    const withSamples = compileBody() as Record<string, unknown>;
    withSamples['vocabulary'] = { ...vocabulary, sampleValues: [{ object: 'Customer', values: ['Acme Ltd'] }] };
    const sentBefore = vertex.received.length;
    const reply = await raw('compile', withSamples);
    assert.equal(reply.status, 400);
    assert.equal(reply.body.error.code, 'contract.request_invalid');
    assert.equal(vertex.received.length, sentBefore);
  });

  test('a service may use only its own roles, and a role needs a route', async () => {
    const wrongRole = await refusal(client('recognition').call(callModel, { body: compileBody() }, asMember()));
    assert.equal(wrongRole.code, 'model.role_not_permitted');
    const noRoute = await refusal(client('fde-orchestrator').call(callModel, {
      body: compileBody({ role: 'connector_generation' }),
    }, asMember()));
    assert.equal(noRoute.code, 'model.role_unavailable');
    const notCaller = await raw('gateway', compileBody());
    assert.equal(notCaller.status, 403);
    assert.equal(notCaller.body.error.code, 'caller.not_listed');
  });
});

describe('output and endpoint failures (spec 62.3)', () => {
  test('output that does not match the schema is refused, never repaired, and its tokens are still recorded and metered', async () => {
    for (const bad of [{ objectType: 'Customer', measure: 'Invoice.total' }, { ...plan, extra: 'field' }, 'not json at all']) {
      const correlationId = uuidv7();
      vertex.reply = () => vertexReply(bad);
      try {
        const error = await refusal(client('compile').call(callModel, { body: compileBody() }, { ...asMember(), correlationId }));
        assert.equal(error.code, 'model.output_invalid');
        assert.equal(error.category, 'upstream');
      } finally {
        vertex.reply = () => vertexReply(plan);
      }
      const [row] = await ledger(correlationId);
      assert.deepEqual([row!.outcome, row!.refusalCategory, row!.inputTokens], ['error', null, 120]);
      const messages = await outbox(correlationId);
      assert.deepEqual(messages.map((m) => m.event), ['model_usage', 'audit_event']);
      assert.equal(messages[0]!.payload.outcome, 'error');
      assert.equal(messages[1]!.payload.detail.reason, 'model.output_invalid');
      assert.equal(messages[1]!.payload.detail.outcome, 'error');
    }
  });

  test('an endpoint that does not answer in time is a timeout naming the bound, recorded as an error', async () => {
    selfHosted.reply = () => ({ ...chatReply({}), delayMs: 2_000 });
    const correlationId = uuidv7();
    try {
      const error = await refusal(client('fde-orchestrator').call(callModel, {
        body: { role: 'fde', instructions: 'Draft the mapping.', vocabulary, output: outputSpec('Draft', z.strictObject({})) },
      }, { ...asMember(), correlationId }));
      assert.equal(error.code, 'model.timeout');
      assert.equal(error.details['limit'], 300);
    } finally {
      selfHosted.reply = () => chatReply({ matches: [] });
    }
    const [row] = await ledger(correlationId);
    assert.equal(row!.outcome, 'error');
    assert.ok(row!.latencyMs! >= 290 && row!.latencyMs! < 2_000, `latency ${row!.latencyMs}`);
    const messages = await outbox(correlationId);
    assert.deepEqual(messages.map((m) => m.payload.event), ['model_call_made'], 'no tokens reported, none metered');
    assert.equal(messages[0]!.payload.detail.reason, 'model.timeout');
  });

  test('an endpoint at capacity is a capacity refusal with retry-after; a failing one is upstream', async () => {
    vertex.reply = () => ({ status: 429, headers: { 'retry-after': '7' }, json: { error: { message: 'echo of the prompt: Which customers' } } });
    try {
      const busy = await refusal(client('compile').call(callModel, { body: compileBody() }, asMember()));
      assert.equal(busy.code, 'model.provider_capacity');
      assert.equal(busy.retryAfterSeconds, 7);
      assert.ok(!busy.message.includes('Which customers'), 'the endpoint\'s body is never read into an error');
      vertex.reply = () => ({ status: 500, json: {} });
      const failed = await refusal(client('compile').call(callModel, { body: compileBody() }, asMember()));
      assert.equal(failed.code, 'model.provider_error');
      assert.equal(failed.category, 'upstream');
    } finally {
      vertex.reply = () => vertexReply(plan);
    }
  });
});

describe('concurrency bounds (spec 7.8)', () => {
  test('per organisation and per cell, across replicas, each refusal naming its bound; slots free when calls end', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    vertex.reply = async () => {
      await gate;
      return vertexReply(plan);
    };
    const start = vertex.received.length;
    try {
      const held = [
        client('compile').call(callModel, { body: compileBody() }, asMember()),
        client('compile').call(callModel, { body: compileBody() }, asMember()),
      ];
      await until(() => vertex.received.length === start + 2);

      const correlationId = uuidv7();
      const orgBound = await refusal(client('compile').call(callModel, { body: compileBody() }, { ...asMember(), correlationId }));
      assert.equal(orgBound.code, 'bound.model_organisation_concurrency');
      assert.equal(orgBound.category, 'capacity');
      assert.equal(orgBound.retryAfterSeconds, 1);
      assert.equal(orgBound.details['limit'], 2);
      assert.equal((await ledger(correlationId))[0]!.refusalCategory, 'concurrency_bound');

      held.push(client('compile').call(callModel, { body: compileBody() }, asMember(otherOrg, otherMember)));
      await until(() => vertex.received.length === start + 3);
      const cellCorrelation = uuidv7();
      const cellBound = await refusal(client('compile').call(callModel, { body: compileBody() },
        { ...asMember(otherOrg, otherMember), correlationId: cellCorrelation }));
      assert.equal(cellBound.code, 'bound.model_cell_concurrency');
      assert.equal(cellBound.details['limit'], 3);
      assert.equal((await ledger(cellCorrelation, otherOrg))[0]!.refusalCategory, 'concurrency_bound');

      open();
      for (const result of await Promise.all(held)) assert.deepEqual(result.output, plan);
    } finally {
      open();
      vertex.reply = () => vertexReply(plan);
    }
    const again = await client('compile').call(callModel, { body: compileBody() }, asMember());
    assert.deepEqual(again.output, plan);
  });
});

describe('document extraction, the carve-out (spec 62.5)', () => {
  let silo: string;
  let prose: string;
  let tabular: string;
  const document = 'Invoice INV-1 from Acme Ltd, contact jo@acme.example, total 1,200.50 GBP';
  const invoiceSchema = z.strictObject({ supplier: z.string(), total: z.number() });

  const extract = (fileId: string, content = document, mediaType: 'text/plain' | 'image/png' = 'text/plain', correlationId = uuidv7()) =>
    client('siloes-import').call(extractDocument, {
      body: {
        siloId: silo, fileId, instructions: 'Extract the supplier and the total.',
        document: { mediaType, contentBase64: Buffer.from(content).toString('base64') }, output: outputSpec('Invoice', invoiceSchema),
      },
    }, { ...asMember(), correlationId });

  before(async () => {
    silo = uuidv7();
    prose = uuidv7();
    tabular = uuidv7();
    const [connector, manifest, scopeType, scope, connection, source] = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    await inTx(app, { orgId: org }, async () => {
      await app.query(`insert into connect.connectors (id, organisation_id, kind, slug, name, provider, trust_tier, source_route,
        author_organisation_id, created_by_membership_id) values ($1, $2, 'private', 'imports', 'Imports', 'files', 'private', 'ai', $2, $3)`,
      [connector, org, member]);
      await app.query(`insert into connect.connector_manifests (id, organisation_id, connector_id, version, document, document_hash,
        schema_version, source_route, created_by_membership_id) values ($1, $2, $3, '1.0.0', '{}', $4, '1', 'ai', $5)`,
      [manifest, org, connector, Buffer.alloc(32), member]);
      await app.query('insert into iam.scope_types (id, organisation_id, name) values ($1, $2, $3)', [scopeType, org, 'Department']);
      await app.query(`insert into iam.scopes (id, organisation_id, scope_type_id, name, path, depth, created_by)
        values ($1, $2, $3, 'Finance', 'x', 1, $4)`, [scope, org, scopeType, member]);
      await app.query(`insert into connect.connections (id, organisation_id, connector_id, manifest_id, name, provider, trust_tier,
        owning_scope_id, owning_membership_id, created_by) values ($1, $2, $3, $4, 'Invoices', 'files', 'private', $5, $6, $6)`,
      [connection, org, connector, manifest, scope, member]);
      await app.query(`insert into siloes.siloes (id, organisation_id, kind, name, purpose, retention_days, location, source_connection_id, created_by)
        values ($1, $2, 'import', 'Invoices', 'Supplier invoices', 365, 'europe-west2', $3, $4)`, [silo, org, connection, member]);
      await app.query(`insert into siloes.silo_sources (id, organisation_id, silo_id, kind, location, created_by)
        values ($1, $2, $3, 'upload', 'uploads', $4)`, [source, org, silo, member]);
      for (const [id, contentClass] of [[prose, 'prose'], [tabular, 'tabular']]) {
        await app.query(`insert into siloes.silo_files (id, organisation_id, silo_id, source_id, object_store_key, filename, size_bytes,
          content_type, content_class) values ($1, $2, $3, $4, $5, 'invoice', 80, 'text/plain', $6)`, [id, org, silo, source, `k/${id}`, contentClass]);
      }
    });
  });

  test('is refused until a holder of silo.enable acknowledges the carve-out, and nothing is sent', async () => {
    const correlationId = uuidv7();
    const sentBefore = vertex.received.length;
    const error = await refusal(extract(prose, document, 'text/plain', correlationId));
    assert.equal(error.code, 'model.extraction_not_enabled');
    assert.equal(error.details['reason'], 'carveout_not_acknowledged');
    assert.equal(vertex.received.length, sentBefore);
    const [row] = await ledger(correlationId);
    assert.deepEqual([row!.requestType, row!.callerService, row!.refusalCategory], ['document_extraction', 'siloes-import', 'extraction_not_enabled']);
  });

  test('once acknowledged, sends the document unscanned, and records extraction_carveout_used with the file and byte count', async () => {
    await inTx(app, { orgId: org }, () => app.query(
      'update siloes.siloes set carveout_acknowledged_by = $2, carveout_acknowledged_at = now() where id = $1', [silo, member]));
    vertex.reply = () => vertexReply({ supplier: 'Acme Ltd', total: 1200.5 });
    const correlationId = uuidv7();
    try {
      const result = await extract(prose, document, 'text/plain', correlationId);
      assert.deepEqual(result.output, { supplier: 'Acme Ltd', total: 1200.5 });
    } finally {
      vertex.reply = () => vertexReply(plan);
    }
    const sent = vertex.received.at(-1)!;
    const part = sent.body.contents[0].parts[1].inlineData;
    assert.equal(part.mimeType, 'text/plain');
    assert.equal(Buffer.from(part.data, 'base64').toString(), document, 'the document is the carve-out: sent as it is');

    const [row] = await ledger(correlationId);
    assert.deepEqual([row!.requestType, row!.outcome, row!.modelRoute], ['document_extraction', 'ok', 'document_extraction']);
    assert.ok(!JSON.stringify(row).includes('Acme'));
    const messages = await outbox(correlationId);
    assert.deepEqual(messages.map((m) => m.payload.event ?? m.event), ['model_usage', 'model_call_made', 'extraction_carveout_used']);
    assert.equal(messages[0]!.payload.siloFileId, prose);
    assert.deepEqual(messages[2]!.payload.resource, { type: 'silo_file', id: prose });
    assert.deepEqual(messages[2]!.payload.detail, {
      call_id: row!.callId, silo_id: silo, media_type: 'text/plain', byte_count: Buffer.byteLength(document),
    });
    for (const m of messages) assert.ok(!JSON.stringify(m.payload).includes('jo@acme'), 'never the document');
  });

  test('the prompt hash covers the document\'s size, never its contents', async () => {
    vertex.reply = () => vertexReply({ supplier: 'x', total: 1 });
    const [a, b] = [uuidv7(), uuidv7()];
    try {
      await extract(prose, 'Invoice from Alpha Ltd, 10 GBP', 'text/plain', a);
      await extract(prose, 'Invoice from Omega Ltd, 99 GBP', 'text/plain', b);
    } finally {
      vertex.reply = () => vertexReply(plan);
    }
    const [ra] = await ledger(a);
    const [rb] = await ledger(b);
    assert.deepEqual(ra!.promptHash, rb!.promptHash);
  });

  test('never for a tabular file, a type the route cannot read, a document over the bound, or another service', async () => {
    const tab = await refusal(extract(tabular));
    assert.equal(tab.details['reason'], 'tabular_file');
    const png = await refusal(extract(prose, document, 'image/png'));
    assert.equal(png.code, 'model.media_type_unsupported');
    const correlationId = uuidv7();
    const large = await refusal(extract(prose, 'x'.repeat(5000), 'text/plain', correlationId));
    assert.equal(large.code, 'bound.model_document_bytes');
    assert.equal((await ledger(correlationId))[0]!.refusalCategory, 'length_bound');
    const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/extractions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-silo-caller': 'compile', 'x-silo-organisation-id': org, 'x-silo-membership-id': member },
      body: '{}',
    });
    assert.equal(res.status, 403);
  });
});

describe('start-up (spec 7.8)', () => {
  test('refuses a route that could outlive its request, and a Vertex AI route without its project', async () => {
    const slow = gatewayConfig(routesFile(dir, [{ ...vertexRoute, role: 'compile', timeoutMs: 30_000 }]));
    await assert.rejects(runProcess([modelGateway], slow, { logger: createLogger({ service: 't', cell: CELL_ID, release: 't', level: 'error', write: () => undefined }) }),
      /HTTP_REQUEST_TIMEOUT_MS/);
    const { project: _project, ...noProject } = vertexRoute;
    const unnamed = gatewayConfig(routesFile(dir, [{ ...noProject, role: 'compile' }]));
    await assert.rejects(runProcess([modelGateway], unnamed, { logger: createLogger({ service: 't', cell: CELL_ID, release: 't', level: 'error', write: () => undefined }) }),
      /names its project/);
  });
});

describe('logging (spec 62.7)', () => {
  test('prompts, documents and outputs never reach the logs; the call, route, outcome and counts do', () => {
    const text = logLines.join('\n');
    for (const secret of ['Which customers', 'Translate the question', 'jo@acme', 'Acme Ltd', 'Invoice.total', 'ya29', 'self-hosted-token']) {
      assert.ok(!text.includes(secret), secret);
    }
    const calls = logLines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['event'] === 'model.call');
    assert.ok(calls.some((l) => l['outcome'] === 'ok' && l['dependency'] === 'compile' && typeof l['count'] === 'number'));
    assert.ok(logLines.some((l) => l.includes('"event":"model.call_refused"') && l.includes('"reason":"redaction_match"')));
  });
});
