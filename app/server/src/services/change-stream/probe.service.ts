// Stream probes (contracts/change-stream/probe.contract.ts; decision 2026-11-15): the
// conformance service watching one test record's changes while it runs the change-stream
// class. A probe reads and publishes through the same paths the stream uses (the poller's
// page and draft rules, publishChanges' de-duplication), so what it sees is what a
// subscriber would get. What it keeps is in probeStore.service.ts.

import type { ProbeObservation, ProbeStep } from '../../contracts/change-stream/probe.contract.ts';
import { probeDigest } from '../../contracts/change-stream/probe.contract.ts';
import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import type { PlanStepInput } from '../../contracts/connect/step.contract.ts';
import { verifyWebhookDelivery } from '../../contracts/credential/changeStream.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { changeDedupKeys, changeProbeIndexKeys, changeProbeKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { ChangeStreamDeps } from './deps.service.ts';
import { draftsFromPage, POLL_PAGE, pollSourceOf, type PollSource } from './poller.service.ts';
import { entityHashOf, PROBE_TTL_SECONDS, probeKey, type PublishNote } from './probeStore.service.ts';
import { publishChanges } from './publish.service.ts';
import type { ConnectionSources, SourceCatalogue, StreamedObject } from './sources.service.ts';

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

const observationOf = (note: PublishNote, fields: readonly string[]): ProbeObservation => ({
  operation: note.delta.operation, sourceSeq: note.delta.sourceSeq, digest: probeDigest(note.delta.changed, fields), duplicate: note.duplicate,
});

export function createStreamProbes(deps: ChangeStreamDeps, catalogue: SourceCatalogue) {
  const control = deps.databases.pool('control');

  const read = (ctx: Context, connectionId: string, step: PlanStepInput) => deps.services.call(readObject, {
    body: { connectionId, reason: 'change_stream', step },
  }, { request: ctx.request, correlationId: ctx.correlationId, timeoutMs: 60_000 });

  async function streamedOf(ctx: Context, connectionId: string, object: string): Promise<{ sources: ConnectionSources; streamed: StreamedObject }> {
    const sources = await catalogue.load(ctx.request, connectionId);
    if (sources.connection.status !== 'active') {
      throw new AppError('conflict', 'a stream is probed on an active connection', { code: 'connection.not_active' });
    }
    const streamed = sources.streamed.get(object);
    if (streamed === undefined) throw new AppError('validation', `the connector does not stream ${object}`, { code: 'stream.not_declared' });
    return { sources, streamed };
  }

  /** One page past a watermark, published as the poller publishes it: what was noted, and where the watermark now stands. */
  async function pollFrom(ctx: Context, sources: ConnectionSources, streamed: StreamedObject, poll: PollSource, from: string | null)
    : Promise<{ notes: PublishNote[]; watermark: string | null }> {
    const field = poll.watermarkField;
    const page = await read(ctx, sources.connection.id, {
      object: streamed.object.name, ...(from === null ? {} : { filters: [{ field, op: 'gt', value: from }] }),
      sort: [{ field, direction: 'asc' }], limit: POLL_PAGE,
    });
    const { drafts, watermark } = draftsFromPage(streamed, poll, page.rows, from);
    const notes: PublishNote[] = [];
    if (drafts.length > 0) await publishChanges(deps, sources, 'poll', drafts, new Date(), (note) => notes.push(note));
    return { notes, watermark };
  }

  return {
    async open(ctx: Context, connectionId: string, object: string) {
      const { sources, streamed } = await streamedOf(ctx, connectionId, object);
      const organisationId = sources.connection.organisationId;
      const endpoint = streamed.kinds.includes('webhook')
        ? await inTransaction(control, ctx.request, (db) => webhookEndpointRepo.liveInbound(db, connectionId), { readOnly: true }) : undefined;
      const poll = pollSourceOf(streamed);
      // The source the stream uses now, in the manifest's order of preference.
      const source = endpoint?.status === 'active' ? 'webhook' as const
        : poll !== undefined ? 'poll' as const : streamed.kinds.includes('cdc') ? 'cdc' as const : 'none' as const;
      let baseline: string | null = null;
      if (poll !== undefined) {
        const field = poll.watermarkField;
        const latest = await read(ctx, connectionId, { object, fields: [field], sort: [{ field, direction: 'desc' }], limit: 1 });
        const value = latest.rows[0]?.[field];
        baseline = value === undefined || value === null ? null : String(value);
      }
      const probeId = uuidv7();
      await deps.state.put(changeProbeKeys, probeKey(organisationId, probeId), {
        connectionId, object, source, baseline, watermark: baseline, entityHash: null, fields: [], observations: [],
      }, { ttlSeconds: PROBE_TTL_SECONDS });
      await deps.state.addScored(changeProbeIndexKeys, changeProbeIndexKeys.key(organisationId, { connectionId }),
        [{ member: probeId, score: Date.now() + PROBE_TTL_SECONDS * 1000 }], { ttlSeconds: PROBE_TTL_SECONDS });
      return { probeId, source, resumable: poll !== undefined, ordering: streamed.stream.ordering };
    },

    async read(ctx: Context, probeId: string, input: { entityRef: string; fields: string[]; step: ProbeStep })
      : Promise<{ observations: ProbeObservation[]; rejected?: boolean }> {
      const organisationId = ctx.request.organisationId!;
      const key = probeKey(organisationId, probeId);
      let probe = await deps.state.read(changeProbeKeys, key);
      if (probe === undefined) throw new AppError('not_found', 'no such stream probe; a probe lapses after 15 minutes', { code: 'stream.probe_not_found' });
      const entityHash = entityHashOf(input.entityRef);
      const fields = [...input.fields].sort();
      if (probe.entityHash === null) {
        probe = { ...probe, entityHash, fields };
        await deps.state.put(changeProbeKeys, key, probe, { ttlSeconds: PROBE_TTL_SECONDS });
      } else if (probe.entityHash !== entityHash || probe.fields.join(',') !== fields.join(',')) {
        throw new AppError('validation', 'a probe watches one record and the same fields', { code: 'stream.probe_record_changed' });
      }
      const watched = probe;
      const { sources, streamed } = await streamedOf(ctx, watched.connectionId, watched.object);
      const poll = pollSourceOf(streamed);
      const mine = (notes: readonly PublishNote[]) => notes
        .filter((n) => n.delta.object === watched.object && entityHashOf(n.delta.entityRef) === entityHash).map((n) => observationOf(n, fields));
      const kept = async () => (await deps.state.read(changeProbeKeys, key))?.observations ?? [];

      switch (input.step) {
        case 'observe': {
          if (watched.source === 'poll' && poll !== undefined) {
            const { watermark } = await pollFrom(ctx, sources, streamed, poll, watched.watermark);
            const current = await deps.state.read(changeProbeKeys, key);
            if (current !== undefined) await deps.state.put(changeProbeKeys, key, { ...current, watermark }, { ttlSeconds: PROBE_TTL_SECONDS });
          }
          return { observations: (await kept()).map(({ dedupHash: _hash, ...o }) => o) };
        }
        case 'resume': {
          if (poll === undefined) {
            throw new AppError('validation', 'no poll source is declared: the stream cannot resume from a watermark', { code: 'stream.probe_not_resumable' });
          }
          return { observations: mine((await pollFrom(ctx, sources, streamed, poll, watched.baseline)).notes) };
        }
        case 'replay': {
          // Polling: reading the same page again is the replay. A webhook: each change offered
          // again by its de-duplication key, as publishChanges would test a redelivery.
          if (watched.source === 'poll' && poll !== undefined) return { observations: mine((await pollFrom(ctx, sources, streamed, poll, watched.baseline)).notes) };
          const dedupKey = changeDedupKeys.key(organisationId, { connectionId: watched.connectionId });
          const out: ProbeObservation[] = [];
          for (const { dedupHash, ...o } of (await kept()).filter((x) => !x.duplicate)) {
            const repeat = dedupHash !== null && await deps.state.addScored(changeDedupKeys, dedupKey, [{ member: dedupHash, score: Date.now() }]) === 0;
            out.push({ ...o, duplicate: repeat });
          }
          return { observations: out };
        }
        case 'forged_delivery': {
          if (watched.source !== 'webhook') throw new AppError('validation', 'only a webhook delivery is signed', { code: 'stream.probe_not_signed' });
          const endpoint = await inTransaction(control, ctx.request, (db) => webhookEndpointRepo.liveInbound(db, watched.connectionId), { readOnly: true });
          if (endpoint === undefined) throw new AppError('conflict', 'the stream has no webhook endpoint', { code: 'stream.not_enabled' });
          const verdict = await deps.services.call(verifyWebhookDelivery, {
            body: {
              connectionId: watched.connectionId, credentialId: endpoint.secretCredentialId,
              body: JSON.stringify({ silo_conformance: uuidv7() }), headers: {},
            },
          }, { request: ctx.request, correlationId: ctx.correlationId });
          return { observations: [], rejected: !verdict.valid };
        }
      }
    },
  };
}

export type StreamProbes = ReturnType<typeof createStreamProbes>;
