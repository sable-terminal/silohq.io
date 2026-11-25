// Analysis over object sets in the workspace (spec 37.8; contracts/workspace/analysis.contract.ts).
// compile plans, keeps and runs the chain; the workspace records its steps (written by the view
// service, per the catalogue) and runs a view of kind analysis through it, its refusal naming the
// step it stopped at and the bound and count that stopped it (37.10).

import type { z } from 'zod';
import { analysisFromPlan, compileAnalysis, getAnalysis, runAnalysis as runChain, type KeptStep, type StepOutcome } from '../../contracts/compile/analysis.contract.ts';
import type { createAnalysis, createAnalysisFromTurn, readAnalysis, runAnalysis } from '../../contracts/workspace/analysis.contract.ts';
import type { RunOutcomeView } from '../../contracts/workspace/view.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { analysisStepRepo, askThreadRepo, askTurnRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { runRefusalOf } from './contractEngine.service.ts';
import { member, type Context, type WorkspaceDeps } from './deps.service.ts';

const opts = (ctx: Context) => ({ request: ctx.request, correlationId: ctx.correlationId });

/** The chain's steps, written once per manifest (steps are immutable: a changed chain is a new manifest). */
async function recordSteps(deps: WorkspaceDeps, ctx: Context, manifestId: string, steps: readonly KeptStep[]): Promise<void> {
  const me = member(ctx);
  await inTransaction(deps.databases.pool('control'), me.request, (db) => analysisStepRepo.insertMissing(db, steps.map((s) => ({
    id: uuidv7(), organisationId: me.organisationId, manifestId, position: s.position, operation: s.operation,
    inputSteps: s.inputSteps, definition: s.step as never, outputKind: s.outputKind, bound: s.bound,
  }))));
}

export async function create(deps: WorkspaceDeps, ctx: Context, input: z.output<typeof createAnalysis.body>): Promise<z.output<typeof createAnalysis.response>> {
  const analysisId = uuidv7();
  const out = await deps.services.call(compileAnalysis, { body: { steps: input.steps, parameters: input.parameters, bindingId: analysisId } }, opts(ctx));
  if (out.outcome === 'refusal') return { outcome: 'refusal', refused: out.refused };
  await recordSteps(deps, ctx, out.manifestId, out.steps);
  return { outcome: 'analysis', analysisId, manifestId: out.manifestId, steps: out.steps.map(({ plans: _plans, ...s }) => s) };
}

/** An Ask answer continued as an analysis: only the asker's own turn, whose values are bound under its id. */
export async function fromTurn(deps: WorkspaceDeps, ctx: Context, input: z.output<typeof createAnalysisFromTurn.body>): Promise<z.output<typeof createAnalysisFromTurn.response>> {
  const me = member(ctx);
  const turn = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const thread = await askThreadRepo.findById(db, input.threadId);
    if (thread === undefined || thread.ownerMembershipId !== me.membershipId) return undefined;
    return askTurnRepo.findBySequence(db, input.threadId, input.sequence);
  }, { readOnly: true });
  if (turn === undefined || turn.manifestId === null) throw new AppError('not_found', 'no answer of yours there to continue', { code: 'workspace.turn_not_found' });
  const analysisId = uuidv7();
  const out = await deps.services.call(analysisFromPlan, { body: { planId: turn.manifestId, fromBindingId: turn.id, bindingId: analysisId } }, opts(ctx));
  if (out.outcome !== 'analysis') return out;
  await recordSteps(deps, ctx, out.manifestId, out.steps);
  return { outcome: 'analysis', analysisId, manifestId: out.manifestId, steps: out.steps.map(({ plans: _plans, ...s }) => s), notes: out.notes };
}

export async function read(deps: WorkspaceDeps, ctx: Context, manifestId: string, analysisId: string | undefined): Promise<z.output<typeof readAnalysis.response>> {
  const out = await deps.services.call(getAnalysis, { params: { manifestId }, query: analysisId === undefined ? {} : { bindingId: analysisId } }, opts(ctx));
  return { manifestId: out.manifestId, createdAt: out.createdAt, steps: out.steps.map(({ plans: _plans, ...s }) => s), parameters: out.parameters };
}

export async function run(deps: WorkspaceDeps, ctx: Context, manifestId: string, input: z.output<typeof runAnalysis.body>): Promise<z.output<typeof runAnalysis.response>> {
  return deps.services.call(runChain, {
    params: { manifestId }, body: { ...(input.analysisId !== undefined ? { bindingId: input.analysisId } : {}), ...(input.upTo !== undefined ? { upTo: input.upTo } : {}), trigger: 'structured' },
  }, opts(ctx));
}

/** A view of kind analysis, run with its own values (its id): the last step's result, or the step it stopped at. */
export async function runView(deps: WorkspaceDeps, ctx: Context, manifestId: string, viewId: string): Promise<RunOutcomeView> {
  const out = await deps.services.call(runChain, { params: { manifestId }, body: { bindingId: viewId, trigger: 'saved_view_run' } }, opts(ctx));
  const refused = out.steps.find((s): s is Extract<StepOutcome, { outcome: 'refused' }> => s.outcome === 'refused');
  if (refused !== undefined) {
    return {
      outcome: 'refused', reason: runRefusalOf(refused.refusal), invalidSinceVersionId: null,
      step: { position: refused.position, operation: refused.operation },
      ...(refused.refusal.bound !== undefined ? { bound: { name: refused.refusal.bound.name, limit: refused.refusal.bound.limit, ...(refused.refusal.bound.observed !== undefined ? { observed: refused.refusal.bound.observed } : {}) } } : {}),
    };
  }
  const last = out.steps.at(-1);
  if (last === undefined || last.outcome !== 'result') return { outcome: 'refused', reason: 'unsupported', invalidSinceVersionId: null };
  const [first, second] = last.results;
  return {
    outcome: 'result', resultRef: first!.queryId, ranAt: first!.computedAt, reduced: last.results.some((r) => r.reduced), incompleteSources: [],
    ...(second !== undefined ? { comparedRef: second.queryId } : {}),
  };
}
