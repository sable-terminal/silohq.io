// AI ranking (spec 38.7): a model reads a summary of the reader's current findings and
// proposes an order of significance.
//
// - Vocabulary first: the model is told only the object types and properties the reader
//   can see, so a denied property never reaches it.
// - No business data: the summary is detector names, counts and scores, and copies no
//   field (copiedFields is empty), so no customer figure reaches the prompt by omission.
// - It cannot introduce a finding: a placement naming no summarised finding is discarded
//   and counted. It must cite: an uncited placement is discarded. Duplicates are discarded.
// - Omitted findings stay visible, listed below the ranking as unranked.
// The detector decides whether a finding exists; the model only orders (38.4).

import { z } from 'zod';
import { callModel, outputSpec, parseOutput } from '../../contracts/model-gateway/call.contract.ts';
import type { FindingView } from '../../contracts/recognition/finding.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { demand, member, readManifest, recordEvent, type Context, type RecognitionDeps } from './deps.service.ts';
import { listFindings } from './findings.service.ts';

const INSTRUCTIONS = [
  'You order findings by how much each is worth a person looking at.',
  'Each finding in the summary is identified by its position in the list, starting at 0.',
  'Return a ranking: each entry names one finding by its position and gives a short citation of what in the summary justifies its place.',
  'Never name a position that is not in the summary. Never invent a finding. You may leave findings out.',
  'State only what the summary shows: say "occurs together with" or "precedes", never that one thing causes another.',
].join(' ');

const rankingOutput = z.object({
  ranking: z.array(z.object({ item: z.int(), citation: z.string().max(500) })).max(500),
});

/** A coarse band from how far past its threshold a finding sits. */
function severity(f: FindingView): 'low' | 'medium' | 'high' | 'critical' {
  const { value, threshold } = f.computation;
  const ratio = threshold === 0 ? value : value / threshold;
  return ratio >= 3 ? 'critical' : ratio >= 2 ? 'high' : ratio >= 1.25 ? 'medium' : 'low';
}

export async function rankFindings(deps: RecognitionDeps, ctx: Context, input: { objectTypeId?: string | undefined; limit: number }) {
  const who = member(ctx);
  await demand(deps, ctx, 'recognition.run');
  const { findings } = await listFindings(deps, ctx, {
    ...(input.objectTypeId === undefined ? {} : { objectTypeId: input.objectTypeId }), includeSuperseded: false, limit: 500,
  });
  const summarised = [...findings].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, input.limit);
  if (summarised.length === 0) return { ranked: [], unranked: [], discarded: { unknown: 0, uncited: 0, duplicate: 0 } };

  // The vocabulary: the types and the properties these visible findings name, nothing more.
  const manifest = await readManifest(deps, ctx);
  const types = [...new Set(summarised.map((f) => f.objectTypeId))].flatMap((id) => {
    const type = manifest.objectTypes.find((t) => t.id === id);
    if (type === undefined) return [];
    const named = new Set(summarised.filter((f) => f.objectTypeId === id).flatMap((f) => f.properties));
    return [{
      name: type.displayName,
      properties: type.properties.filter((p) => named.has(p.apiName)).map((p) => ({ name: p.displayName, type: p.dataType })),
    }];
  });
  const reply = await deps.services.call(callModel, {
    body: {
      role: 'recognition', instructions: INSTRUCTIONS, vocabulary: { objectTypes: types },
      findingsSummary: {
        copiedFields: [],
        findings: summarised.map((f) => ({ detector: f.detector, severity: severity(f), count: f.objectIds.length, score: f.score })),
      },
      output: outputSpec('ranking', rankingOutput),
    },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  const output = parseOutput(rankingOutput, reply.output);

  const discarded = { unknown: 0, uncited: 0, duplicate: 0 };
  const placed = new Set<number>();
  const ranked: { findingId: string; position: number; citation: string }[] = [];
  for (const entry of output.ranking) {
    if (entry.item < 0 || entry.item >= summarised.length) { discarded.unknown += 1; continue; }
    if (entry.citation.trim() === '') { discarded.uncited += 1; continue; }
    if (placed.has(entry.item)) { discarded.duplicate += 1; continue; }
    placed.add(entry.item);
    ranked.push({ findingId: summarised[entry.item]!.id, position: ranked.length + 1, citation: entry.citation.trim() });
  }
  const unranked = summarised.filter((_, i) => !placed.has(i)).map((f) => f.id);
  await inTransaction(deps.databases.pool('control'), who.request, (db) => recordEvent(db, who, ctx.correlationId, {
    event: 'ranking_produced', resource: null,
    detail: {
      summarised: summarised.length, ranked: ranked.length, unranked: unranked.length, discarded_unknown: discarded.unknown,
      discarded_uncited: discarded.uncited, discarded_duplicate: discarded.duplicate, model_call_id: reply.callId,
    },
  }));
  return { ranked, unranked, discarded };
}
