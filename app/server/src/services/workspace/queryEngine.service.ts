// The query path as the workspace and Ask see it: the compile stage (chapter 26) and the
// federated engine (chapter 27), behind one interface.
//
// Ask compiles a question into a plan and runs it; a saved view re-runs its plan. Both
// run under the caller's own request context, so the engine re-resolves every plan
// against the caller's permissions, markings, connection grants and field policies and
// drops what they may not see (spec 37.5). Compile charges once a plan exists (spec 36.10,
// chapter 73); running is never metered.
//
// contractEngine.service.ts is the engine over the compile and executor contracts.
// unavailableEngine refuses everything (compile unavailable, runs refused as unavailable),
// so a plan is never half-run where no query path is deployed. Tests give a fake.

import type { ClarificationOption, StoredScope } from '../../contracts/ask/thread.contract.ts';
import type { KeptStep } from '../../contracts/compile/analysis.contract.ts';
import type { CompiledFailure, CompiledIntent, CompiledSchedule } from '../../contracts/compile/compile.contract.ts';
import type { RunOutcomeView } from '../../contracts/workspace/view.contract.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import { AppError } from '../../utils/errors.util.ts';

/** Who the engine works for: the request context the caller was given, and its correlation id. */
export interface EngineCaller {
  request: RequestContext;
  correlationId: string;
}

export interface CompileRequest {
  /** As typed: a record value. Compile runs the literal pass before any prompt. */
  question: string;
  /** answer and propose_action may come back as a change (an intent, 42.9); find_objects never does. */
  tool: 'answer' | 'find_objects' | 'propose_action' | 'propose_cron';
  /** The thread's scope, as references. */
  scope: StoredScope | null;
  /** The thread's latest compiled manifests, newest first: the structure compile may read. */
  priorManifestIds: string[];
  /** A clarification answered: the candidate the person chose. */
  chosen?: ClarificationOption | undefined;
  advanced: boolean;
  /** The turn being compiled. */
  turnId: string;
  /** Stable across retries of the same question, so a retry never compiles or charges twice. */
  chargeKey: string;
  /** The thread's previous turn, for the rephrase window (spec 36.10, 73.2). */
  previousTurnId?: string | undefined;
  /** The plan of the turn this question rephrases (the person said so): within the window it is not charged again. */
  rephraseOf?: string | undefined;
  /** The candidates a clarification offered and the person did not choose: left out of this compile's vocabulary. */
  rejected?: ClarificationOption[] | undefined;
  /** The thread's AI agent (D236): its brief and the object types it works with, which compile narrows to. */
  aiAgent?: { id: string; name: string; brief: string; objectTypeIds: string[]; tools: ('answer' | 'find_objects' | 'propose_action' | 'propose_cron')[] } | undefined;
}

export type CompileOutcome =
  | {
    outcome: 'plan';
    manifestId: string;
    compileClass: 'standard' | 'advanced';
    /** As metering charged it: 0 for a rephrase inside the window. */
    tokensCharged: number;
    rephraseUncharged: boolean;
    /** When compile also ran the plan (an answer), its outcome: the plan is not run again. */
    ran?: RunOutcomeView | undefined;
    /** A harder question compiled as a chain (37.8): its steps, which the holder records; the manifest is the chain's. */
    chain?: Omit<KeptStep, 'plans'>[] | undefined;
  }
  | { outcome: 'clarification'; options: ClarificationOption[] }
  /** A change the question asks for (42.9): compiled and charged, never executed; Ask makes it a draft. */
  | { outcome: 'intent'; intent: CompiledIntent; compileClass: 'standard' | 'advanced'; tokensCharged: number; rephraseUncharged: boolean }
  /** A Cron asked for (36.4): the schedule compile wrote; Ask makes it a draft a person saves. */
  | { outcome: 'schedule'; schedule: CompiledSchedule; compileClass: 'standard' | 'advanced'; tokensCharged: number; rephraseUncharged: boolean }
  | { outcome: 'refusal'; reason: 'no_plan' | 'bound_exceeded' | 'capability_missing' | 'unsupported' | 'daily_limit'; narrowing: string | null };

/** A stored plan with the binding of its values (the holder's id: a turn, a view), or a saved object set. */
export type RunTarget = { manifestId: string; bindingId?: string | undefined } | { objectSetId: string };

/** Start a scenario (36.4): the failure the question states, or a refusal in Ask's closed set. */
export type FailureOutcome =
  | { outcome: 'failure'; failure: CompiledFailure; tokensCharged: number }
  | { outcome: 'refusal'; reason: 'no_plan' | 'bound_exceeded' | 'capability_missing' | 'unsupported' | 'daily_limit'; narrowing: string | null };

export interface QueryEngine {
  compile(request: CompileRequest, caller: EngineCaller): Promise<CompileOutcome>;
  /** The failure a question states for an object type (36.4), charged as a compile under the question's key. */
  failure(request: { question: string; objectTypeId: string; chargeKey: string }, caller: EngineCaller): Promise<FailureOutcome>;
  /** Re-resolves and runs a plan under the caller's access. Never metered. */
  run(target: RunTarget, caller: EngineCaller): Promise<RunOutcomeView>;
  /** Copies the values bound into a plan to a new holder (a view saved from a turn); returns the plan they belong to. */
  bind(fromBindingId: string, toBindingId: string, caller: EngineCaller): Promise<{ planId: string }>;
}

/** The engine until the compile and executor contracts are built: nothing compiles, nothing runs. */
export const unavailableEngine: QueryEngine = {
  async compile() {
    throw new AppError('unavailable', 'questions cannot be compiled in this build yet', { code: 'ask.compile_unavailable', retryable: true });
  },
  async run() {
    return { outcome: 'refused', reason: 'unavailable', invalidSinceVersionId: null };
  },
  async failure() {
    throw new AppError('unavailable', 'questions cannot be compiled in this build yet', { code: 'ask.compile_unavailable', retryable: true });
  },
  async bind() {
    throw new AppError('unavailable', 'plans cannot be bound in this build yet', { code: 'ask.compile_unavailable', retryable: true });
  },
};
