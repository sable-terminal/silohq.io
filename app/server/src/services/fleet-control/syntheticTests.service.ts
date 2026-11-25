// The synthetic question, subscription, Action and revert tests of a release's health gates
// (spec 11.2; decision 2026-11-18), run by the cell's Fleet agent in the cell's synthetic
// organisation, through the public API as its two members, the way a customer's people would.
//
// Setup, once, resumed from what was recorded if it was cut short (the ConfigMap the agent keeps
// it in): a scope; the synthetic source's connector and manifest (the agent's fixture, behind the
// cell's ingress); a connection, through conformance, activated; its write class, writes enabled;
// its change stream enabled and its class passed, so it is subscribable; the approver's access;
// the probe object type, proposed by one member, approved by the other, merged; a saved set of
// probes; an Action type setting a probe's score. Each round the fixture's token is set again
// (a new one each time the agent starts).
//
// Each round, for the release the cell runs: a structured question counting the probes
// (synthetic_question); a live subscription to the saved set, which must open with its snapshot
// and then carry the Action's change as a delta (synthetic_subscription); an Action setting a
// probe's score, proposed by one member and approved by the other, completed and verified
// (synthetic_action); and its revert, approved likewise, completed with the score back as it was
// (synthetic_revert). The latest round's results are kept per release for the gates.

import WebSocket from 'ws';
import { issueSyntheticSession, provisionSyntheticTenant } from '../../contracts/auth/synthetic.contract.ts';
import { decideApproval, getMutation, proposeActionType, proposeMutation, publishActionTypeVersion, requestRevert, runWriteClass, setConnectionWrites } from '../../contracts/gateway/actionRoutes.contract.ts';
import { createScope, createScopeType } from '../../contracts/gateway/adminRoutes.contract.ts';
import { createConnection, createConnector, createManifestVersion } from '../../contracts/gateway/connectRoutes.contract.ts';
import {
  changeConnectionStatusRoute, getConformanceRunRoute, setConnectionSecretsRoute, startChangeStreamClassRoute, startConformanceRunRoute,
} from '../../contracts/gateway/connectionRoutes.contract.ts';
import { grantConnectionRoute } from '../../contracts/gateway/governanceReadRoutes.contract.ts';
import { LIVE_PATH } from '../../contracts/gateway/live.contract.ts';
import {
  approveOntologyProposal, mergeOntologyProposal, openOntologyBranch, putOntologyObjectType, readOntology, saveOntologyObjectSet, submitOntologyProposal,
} from '../../contracts/gateway/ontologyRoutes.contract.ts';
import { runStructuredPlan } from '../../contracts/gateway/queryRoutes.contract.ts';
import { enableStream } from '../../contracts/gateway/streamRoutes.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { AppError } from '../../utils/errors.util.ts';
import { sleep } from '../../utils/time.util.ts';
import type { SyntheticGate } from './cellRelease.service.ts';
import type { PublicApi } from './publicApi.service.ts';
import type { SyntheticFixture } from './syntheticFixture.service.ts';

/** What setup made, recorded as it goes so a restart resumes it. */
export interface SyntheticTenant {
  organisationId: string;
  scopeId?: string;
  connectorId?: string;
  manifestCreated?: boolean;
  connectionId?: string;
  active?: boolean;
  writesEnabled?: boolean;
  webhookPath?: string;
  webhookSecret?: string;
  subscribable?: boolean;
  approverGranted?: boolean;
  ontologyVersionId?: string;
  objectTypeId?: string;
  /** The probe type's property identity ids by api name. */
  properties?: Record<string, string>;
  objectSetId?: string;
  actionTypeId?: string;
}

export interface SyntheticDeps {
  services: ServiceClient;
  api: PublicApi;
  /** The gateway's public listener, for the live WebSocket and the stream's webhook. */
  gatewayUrl: string;
  fixture: SyntheticFixture;
  /** The fixture's public base URL, behind the cell's ingress. */
  fixtureUrl: string;
  store: { read(): Promise<SyntheticTenant | undefined>; write(tenant: SyntheticTenant): Promise<void> };
  logger: Logger;
  /** How long a step that waits (a conformance run, a mutation, a delta) may take; 2 minutes by default. */
  waitMs?: number;
}

export type SyntheticResults = Record<SyntheticGate, boolean>;

const failed = (message: string): AppError => new AppError('conflict', message, { code: 'synthetic.failed' });

export function syntheticManifest(baseUrl: string) {
  return {
    schemaVersion: '1',
    identity: { name: 'Silo synthetic probes', provider: 'Silo', version: '1.0.0' },
    transport: { viaAgent: false, baseUrl },
    protocol: { kind: 'rest' },
    auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'Fixture token', role: 'token' }] },
    objects: [{
      name: 'probes', identifier: ['id'],
      fields: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'name', type: 'string', path: 'properties.name' },
        { name: 'score', type: 'integer', path: 'properties.score' },
        { name: 'updated_at', type: 'date-time' },
      ],
      source: { kind: 'rest', request: { method: 'GET', path: '/v1/probes', query: {} }, records: { jsonata: 'results' } },
      pushdown: { filters: [
        { field: 'id', ops: ['eq'], patch: { cel: '{"query": {"id": string(value)}}' } },
        { field: 'updated_at', ops: ['gt'], patch: { cel: '{"query": {"since": string(value)}}' } },
      ] },
      writes: {
        create: { request: { method: 'POST', path: '/v1/probes' }, body: { jsonata: '{"properties": $}' }, result: { jsonata: 'id' } },
        update: { request: { method: 'PATCH', path: '/v1/probes/{identifier}' }, body: { jsonata: '{"properties": $}' } },
        delete: { request: { method: 'DELETE', path: '/v1/probes/{identifier}' } },
        bounds: { maxRows: 10 },
      },
    }],
    changeStream: {
      webhook: {
        verify: { cel: '{"expected": hex(hmac_sha256(secret.webhook, headers["x-timestamp"] + "." + body)), "provided": headers["x-signature"], "signedAt": int(headers["x-timestamp"])}' },
        decode: { jsonata: '[events.{"object": "probes", "entityRef": id, "operation": type, "changed": data, "sourceSeq": seq}]' },
      },
      // The webhook carries each change; the poll resumes from a watermark after a gap.
      objects: [{ object: 'probes', sources: [{ kind: 'webhook' }, { kind: 'poll', intervalSeconds: 60, watermarkField: 'updated_at' }], ordering: 'source_sequence' }],
    },
  };
}

export function createSyntheticTests(deps: SyntheticDeps) {
  const { api } = deps;
  const waitMs = deps.waitMs ?? 120_000;
  const latest = new Map<string, { at: string; results: SyntheticResults }>();

  async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw failed(`${what} did not finish in time`);
      await sleep(250);
    }
  }

  async function sessions(correlationId: string) {
    // The organisation first: made once, then found.
    await deps.services.call(provisionSyntheticTenant, {}, { correlationId });
    const [proposer, approver] = await Promise.all((['proposer', 'approver'] as const).map((member) =>
      deps.services.call(issueSyntheticSession, { body: { member } }, { correlationId })));
    return { proposer: proposer!.sessionToken, approver: approver!.sessionToken, approverMembershipId: approver!.membershipId };
  }

  async function conformance(as: string, runId: string) {
    const run = await until('a conformance run', () => api.call(getConformanceRunRoute, as, { params: { runId } }), (r) => r.status !== 'running');
    if (run.status !== 'completed' || run.failedCount > 0) {
      const failing = (run.tests as { id: string; outcome: string; reason?: string | null }[]).filter((x) => x.outcome !== 'passed' && x.outcome !== 'not_applicable')
        .map((x) => `${x.id}${x.reason ? ` (${x.reason})` : ''}`).slice(0, 5).join(', ');
      throw failed(`a conformance run of the synthetic source ended ${run.status}, failing ${failing || run.failedCount}`);
    }
    return run;
  }

  /** Setup, resumed where it stopped; each step recorded once done. */
  async function ensureTenant(correlationId: string, s: Awaited<ReturnType<typeof sessions>>): Promise<Required<SyntheticTenant>> {
    const provisioned = await deps.services.call(provisionSyntheticTenant, {}, { correlationId });
    let t: SyntheticTenant = (await deps.store.read()) ?? { organisationId: provisioned.organisationId };
    if (t.organisationId !== provisioned.organisationId) t = { organisationId: provisioned.organisationId };
    const save = async (changes: Partial<SyntheticTenant>): Promise<void> => { t = { ...t, ...changes }; await deps.store.write(t); };
    const p = s.proposer;

    if (t.scopeId === undefined) {
      const type = await api.call(createScopeType, p, { body: { name: 'Synthetic' } });
      const scope = await api.call(createScope, p, { body: { name: 'Synthetic checks', scopeTypeId: (type as { id: string }).id } });
      await save({ scopeId: (scope as { id: string }).id });
    }
    if (t.connectorId === undefined) {
      const connector = await api.call(createConnector, p, { body: { slug: 'synthetic-probes', name: 'Synthetic probes', provider: 'Silo', sourceRoute: 'visual' } });
      await save({ connectorId: connector.id });
    }
    if (t.manifestCreated !== true) {
      await api.call(createManifestVersion, p, { params: { connectorId: t.connectorId! }, body: { document: syntheticManifest(deps.fixtureUrl) } });
      await save({ manifestCreated: true });
    }
    if (t.connectionId === undefined) {
      const connection = await api.call(createConnection, p, { body: { connectorId: t.connectorId!, name: 'Synthetic probes', owningScopeId: t.scopeId! } });
      await save({ connectionId: connection.id });
    }
    const connectionId = t.connectionId!;
    // The fixture's token is new each time the agent starts.
    await api.call(setConnectionSecretsRoute, p, { params: { connectionId }, body: { values: { token: deps.fixture.token } } });
    if (t.active !== true) {
      let connection = await api.call(changeConnectionStatusRoute, p, { params: { connectionId }, body: { move: 'probe', version: 1 } as never }).catch(() => undefined);
      const run = await api.call(startConformanceRunRoute, p, { body: { connectionId } });
      await conformance(p, run.id);
      for (const move of ['confirm', 'activate'] as const) {
        connection = await api.call(changeConnectionStatusRoute, p, { params: { connectionId }, body: { move, version: (connection as { version?: number } | undefined)?.version ?? 1 } as never });
      }
      await save({ active: true });
    }
    if (t.writesEnabled !== true) {
      const write = await api.call(runWriteClass, p, { params: { connectionId }, body: { object: 'probes', create: { name: 'Write class probe', score: 1 } } });
      if (!write.passed) throw failed('the synthetic source did not pass its write class');
      await api.call(setConnectionWrites, p, { params: { connectionId }, body: { enabled: true } });
      await save({ writesEnabled: true });
    }
    if (t.webhookPath === undefined) {
      const enabled = await api.call(enableStream, p, { params: { connectionId }, body: {} });
      const webhook = (enabled as { webhook?: { path: string; secret?: string } }).webhook;
      if (webhook?.secret === undefined) throw failed('the synthetic stream gave no webhook');
      // The stream keeps the secret it generated; the fixture signs with it.
      await save({ webhookPath: webhook.path, webhookSecret: webhook.secret });
    }
    deps.fixture.setStream(new URL(t.webhookPath!, deps.gatewayUrl).toString(), t.webhookSecret!);
    if (t.subscribable !== true) {
      const run = await api.call(startChangeStreamClassRoute, p, {
        params: { connectionId }, body: { object: 'probes', create: { name: 'Stream probe', score: 1 }, updates: [{ score: 2 }, { score: 3 }] },
      });
      await conformance(p, run.id);
      await save({ subscribable: true });
    }
    if (t.approverGranted !== true) {
      await api.call(grantConnectionRoute, p, { body: { connectionId, grantee: { kind: 'membership', id: s.approverMembershipId }, access: 'read' } });
      await save({ approverGranted: true });
    }
    if (t.ontologyVersionId === undefined) {
      const branch = await api.call(openOntologyBranch, p, { body: { name: 'synthetic probes' } });
      const mapped = (apiName: string, field: string, dataType: 'string' | 'integer', nullable = true) =>
        ({ apiName, displayName: apiName, dataType, nullable, mappings: [{ connectionId, sourceObject: 'probes', fieldPath: field }] });
      await api.call(putOntologyObjectType, p, {
        params: { branchId: branch.id, apiName: 'probe' },
        body: {
          displayName: 'Probe', pluralName: 'Probes', contributingObjects: [{ connectionId, sourceObject: 'probes', identifierFieldPath: 'id' }],
          properties: [mapped('probe_id', 'id', 'string', false), mapped('name', 'name', 'string'), mapped('score', 'score', 'integer')],
          primaryKey: 'probe_id', title: 'name',
        },
      });
      const proposal = await api.call(submitOntologyProposal, p, { params: { branchId: branch.id }, body: { title: 'Synthetic probes' } });
      await api.call(approveOntologyProposal, s.approver, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } });
      const merged = await api.call(mergeOntologyProposal, p, { params: { proposalId: proposal.id } });
      const ontology = await api.call(readOntology, p) as { objectTypes?: { id: string; apiName: string; properties: { identityId: string; apiName: string }[] }[] };
      const probe = ontology.objectTypes?.find((o) => o.apiName === 'probe');
      if (probe === undefined) throw failed('the probe object type is not on main after its merge');
      await save({
        ontologyVersionId: (merged as { version: { id: string } }).version.id, objectTypeId: probe.id,
        // Plans and sets name a property by its stable identity.
        properties: Object.fromEntries(probe.properties.map((x) => [x.apiName, x.identityId])),
      });
    }
    if (t.objectSetId === undefined) {
      const set = await api.call(saveOntologyObjectSet, p, {
        body: { name: 'Synthetic probes', definition: { kind: 'filter', base: { objectTypeId: t.objectTypeId! }, predicate: { cel: 'object.score > -1000000', properties: [t.properties!['score']!] } } },
      });
      await save({ objectSetId: set.id });
    }
    if (t.actionTypeId === undefined) {
      const type = await api.call(proposeActionType, p, { body: { apiName: 'set_probe_score', displayName: 'Set a probe\'s score', owningScopeId: t.scopeId! } });
      await api.call(publishActionTypeVersion, p, {
        params: { actionTypeId: type.id },
        body: {
          ontologyVersionId: t.ontologyVersionId!, objectTypeId: t.objectTypeId!, properties: ['score'],
          parameters: [{ name: 'score', type: 'integer', required: true }], rules: [{ kind: 'set_property', property: 'score', value: { parameter: 'score' } }],
          permittedConnections: [connectionId], riskClass: 'data',
        } as never,
      });
      await save({ actionTypeId: type.id });
    }
    return t as Required<SyntheticTenant>;
  }

  /** A live subscription to the saved set: its frames, as they come. */
  function subscribe(token: string, setId: string, scoreProperty: string) {
    const url = new URL(LIVE_PATH, deps.gatewayUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, { headers: { cookie: `__Host-silo_session=${token}`, origin: api.origin } });
    const frames: { type: string; [key: string]: unknown }[] = [];
    ws.on('message', (data) => { try { frames.push(JSON.parse(String(data)) as never); } catch { /* not ours */ } });
    const opened = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    return {
      async start() {
        await opened;
        ws.send(JSON.stringify({ type: 'subscribe', ref: 'synthetic', set: { kind: 'object_set', id: setId }, properties: ['name', 'score'] }));
        return until('the subscription', async () => frames, (f) => f.some((x) => x.type === 'refused' || x.type === 'snapshot'))
          .then((f) => { if (f.some((x) => x.type === 'refused')) throw failed('the subscription was refused'); });
      },
      async delta(seen: (frame: Record<string, unknown>) => boolean) {
        await until('the Action\'s delta', async () => frames, (f) => f.some((x) => x.type === 'delta' && seen(x)));
      },
      scoreProperty,
      close: () => ws.close(),
    };
  }

  async function approveAndWait(s: { approver: string; proposer: string }, mutation: { id: string; chain?: { id: string } | null; diffHash?: string | null }) {
    if (mutation.chain) {
      await api.call(decideApproval, s.approver, { params: { chainId: mutation.chain.id }, body: { decision: 'approved', diffHash: mutation.diffHash! } });
    }
    return until('a mutation', () => api.call(getMutation, s.proposer, { params: { mutationId: mutation.id } }), (m) => m.completedAt !== null);
  }

  return {
    /** The latest round's results for a release, if one ran under it. */
    resultsFor(releaseId: string): SyntheticResults | undefined {
      return latest.get(releaseId)?.results;
    },

    /** One round under the release the cell runs. */
    async run(releaseId: string, correlationId: string): Promise<SyntheticResults> {
      const results: SyntheticResults = { synthetic_question: false, synthetic_subscription: false, synthetic_action: false, synthetic_revert: false };
      const s = await sessions(correlationId);
      const t = await ensureTenant(correlationId, s);
      const note = (gate: SyntheticGate, error: unknown): void => {
        deps.logger.failure(`the ${gate} test failed`, error, { event: 'fleet.synthetic_failed', reason: gate, resourceType: 'release', resourceId: releaseId });
      };
      try {
        const out = await api.call(runStructuredPlan, s.proposer, { body: {
          plan: { schemaVersion: '1', ontologyVersionId: t.ontologyVersionId, nodes: [{ objectTypeId: t.objectTypeId }], select: [{ node: 0, property: t.properties['score'] }] },
        } as never }) as { outcome: string; result?: { population: number } };
        results.synthetic_question = out.outcome === 'answer' && (out.result?.population ?? 0) >= 3;
        if (!results.synthetic_question) throw failed(`the question answered ${out.outcome}`);
      } catch (error) { note('synthetic_question', error); }

      const live = subscribe(s.proposer, t.objectSetId, t.properties['score']!);
      let subscribed = false;
      try {
        await live.start();
        subscribed = true;
      } catch (error) { note('synthetic_subscription', error); }

      const score = 100 + (Date.now() % 100_000);
      let receiptId: string | undefined;
      try {
        const proposed = await api.call(proposeMutation, s.proposer, { body: { actionTypeId: t.actionTypeId, parameters: { score }, objects: [{ connectionId: t.connectionId, reference: 'p1' }] } });
        const done = await approveAndWait(s, proposed as never);
        results.synthetic_action = done.status === 'completed';
        receiptId = done.receiptId ?? undefined;
        if (!results.synthetic_action) throw failed(`the Action ended ${done.status}`);
      } catch (error) { note('synthetic_action', error); }

      if (subscribed && results.synthetic_action) {
        try {
          await live.delta((f) => JSON.stringify(f).includes(String(score)));
          results.synthetic_subscription = true;
        } catch (error) { note('synthetic_subscription', error); }
      }
      live.close();

      if (receiptId !== undefined) {
        try {
          const revert = await api.call(requestRevert, s.proposer, { body: { receiptId, scope: 'full' } }) as { newMutationId: string };
          const proposed = await api.call(getMutation, s.proposer, { params: { mutationId: revert.newMutationId } });
          const done = await approveAndWait(s, proposed as never);
          results.synthetic_revert = done.status === 'completed' && deps.fixture.probes.get('p1')?.properties.score !== score;
          if (!results.synthetic_revert) throw failed(`the revert ended ${done.status}`);
        } catch (error) { note('synthetic_revert', error); }
      }
      latest.set(releaseId, { at: new Date().toISOString(), results });
      return results;
    },
  };
}

export type SyntheticTests = ReturnType<typeof createSyntheticTests>;
