'use client';

// An Ask thread (spec 36): its turns, each with what it came to (an answer as a table read from
// its result, re-run unmetered once the result has expired; a refusal with the narrower question
// that would work; a clarification whose candidates the person chooses; a proposed change or
// Cron, a draft never executed here; a scenario started; an explanation; outside context in its
// own block, each source cited), and the question box. A question is a record value: it is never
// shown back unless the thread kept it. Compact, it is the Ask side panel's conversation.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Checkbox, TextArea } from '../../components/field.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ErrorMessage, Loading } from '../../components/states.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { findingHref, objectHref, scenarioHref } from '../../navigation/links.navigation.ts';
import { ResultByRef } from '../../results/result.result.tsx';
import { hrefWith } from '../../utils/href.util.ts';
import { plural } from '../../utils/format.util.ts';
import { PlanWords } from './plan.view.tsx';
import styles from './ask.view.module.css';

type Thread = Output<'readAskThread'>;
type Turn = Thread['turns'][number];
type AskBody = Input<'askQuestion'>['body'];

const REFUSALS: Record<string, string> = {
  no_plan: 'Silo could not turn that into a question over your data.',
  bound_exceeded: 'Answering it would read more than a question may.',
  capability_missing: 'A system it needs cannot answer that kind of question.',
  unsupported: 'That kind of question is not supported yet.',
  daily_limit: 'Your organisation has reached its daily limit for questions.',
};

export const TOOL_LABEL: Record<string, string> = {
  answer: 'Answer questions', find_objects: 'Find objects', propose_action: 'Propose changes (a person submits them)',
  propose_cron: 'Propose Crons (a person saves them)', explain_finding: 'Explain findings', explain_lineage: 'Explain lineage',
  open_clone: 'Open the canvas', start_scenario: 'Start scenarios', clarify: 'Ask what you meant',
};

/** An answer's result, a page at a time; an expired result is run again, unmetered. */
function Answer({ threadId, turn }: { threadId: string; turn: Turn }) {
  const [resultRef, setResultRef] = useState(turn.resultRef);
  const rerun = useMutation('rerunAskTurn', { refresh: false });
  const again = (
    <div className={styles.expired}>
      <span>This answer&rsquo;s result has expired.</span>
      <Button size="sm" pending={rerun.pending} onClick={() => void rerun.run({ params: { threadId, sequence: turn.sequence } }).then((ran) => {
        if (ran.ok && ran.data.resultRef !== null) setResultRef(ran.data.resultRef);
      })}>Run it again</Button>
      <span className={styles.muted}>(not charged)</span>
      {rerun.data !== undefined && rerun.data.refusalReason !== null ? <p className={styles.muted}>It could not run again: {rerun.data.refusalReason.replaceAll('_', ' ')}.</p> : null}
      {rerun.error !== undefined ? <ErrorMessage error={rerun.error} /> : null}
    </div>
  );
  if (resultRef === null) return again;
  return (
    <div className={styles.answer}>
      <ResultByRef key={resultRef} queryId={resultRef} label={`Answer to turn ${turn.sequence}`} expired={() => again} />
      {turn.manifestId !== null ? <HowAnswered planId={turn.manifestId} /> : null}
      {turn.manifestId !== null ? <AnalyseFurther threadId={threadId} turn={turn} /> : null}
    </div>
  );
}

/** The answer continued as an analysis (37.8): its plan made steps with its values, opened in Analysis. */
function AnalyseFurther({ threadId, turn }: { threadId: string; turn: Turn }) {
  const router = useRouter();
  const make = useMutation('createWorkspaceAnalysisFromTurn', { refresh: false });
  const [notSteps, setNotSteps] = useState<string | undefined>();
  return (
    <div className={styles.expired}>
      <Button size="sm" icon="chart" pending={make.pending} blocked={make.blocked} onClick={() => void make.run({ body: { threadId, sequence: turn.sequence } }).then((r) => {
        if (!r.ok) return;
        if (r.data.outcome === 'analysis') router.push(hrefWith('/explorer/analyses/', { manifest: r.data.manifestId, analysis: r.data.analysisId }) as never);
        else setNotSteps(r.data.outcome === 'not_steps' ? r.data.refusal.reason : `step ${r.data.refused.position}: ${r.data.refused.refusal.reason}`);
      })}>Analyse further</Button>
      {notSteps !== undefined ? <span className={styles.muted}>Not as steps: {notSteps}.</span> : null}
      {make.error !== undefined ? <ErrorMessage error={make.error} /> : null}
    </div>
  );
}

/** How Silo answered, read when opened. */
function HowAnswered({ planId }: { planId: string }) {
  const [open, setOpen] = useState(false);
  const plan = useQuery('readCompiledPlan', open ? { params: { planId } } : null, { staleMs: 30 * 60_000 });
  return (
    <details className={styles.how} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>How Silo answered</summary>
      {plan.data !== undefined ? <PlanWords plan={plan.data.plan} /> : plan.status === 'error' ? <ErrorMessage error={plan.error} /> : open ? <Loading label="Reading the plan" block={false} /> : null}
    </details>
  );
}

function TurnView({ threadId, turn, onChoose, busy }: { threadId: string; turn: Turn; onChoose: (optionId: string) => void; busy: boolean }) {
  const { lookup } = useVocabulary();
  return (
    <article className={styles.turn} aria-label={`Turn ${turn.sequence}`}>
      <p className={styles.meta}>
        <span>{turn.questionRetained ? 'Question kept on the thread' : 'Question not kept'}</span>
        <Time value={turn.createdAt} />
        {turn.tokensCharged > 0 ? <span>{plural(turn.tokensCharged, 'token')}</span> : null}
        {turn.tool !== 'answer' ? <Badge>{TOOL_LABEL[turn.tool] ?? turn.tool}</Badge> : null}
      </p>
      {turn.outcome === 'answer' && turn.manifestId !== null ? <Answer threadId={threadId} turn={turn} /> : null}
      {turn.outcome === 'refusal' ? (
        <Banner tone="info" title={REFUSALS[turn.refusalReason ?? ''] ?? 'That could not be answered.'}>
          {turn.narrowing !== null ? <>A narrower question would work: {turn.narrowing}</> : undefined}
        </Banner>
      ) : null}
      {turn.outcome === 'clarification' && turn.clarificationOptions !== null ? (
        <div className={styles.clarify}>
          <p>Which did you mean?</p>
          <div className={styles.options}>
            {turn.clarificationOptions.map((o) => (
              <Button key={o.id} size="sm" disabled={busy} onClick={() => onChoose(o.id)}>{o.label}{o.source !== null ? ` (${o.source})` : ''}</Button>
            ))}
          </div>
        </div>
      ) : null}
      {turn.proposal !== null ? (
        <div className={styles.draft}>
          <p><strong>A change to {lookup?.typeName(turn.proposal.objectTypeId, true) ?? 'objects'}</strong>: {turn.proposal.operation}
            {turn.proposal.properties.length > 0 ? ` ${turn.proposal.properties.map((p) => lookup?.propertyName(p) ?? p).join(', ')}` : ''}.</p>
          <p className={styles.muted}>
            {turn.proposal.genericEdit ? 'No confirmed Action fits: it would be a governed edit.' : `It fits ${turn.proposal.candidates.map((c) => c.displayName).join(' or ')}.`}{' '}
            Nothing changes until it is proposed and approved.
          </p>
        </div>
      ) : null}
      {turn.cron !== null ? (
        <div className={styles.draft}>
          <p><strong>A Cron, as asked</strong>: {turn.cron.asWritten} (schedule {turn.cron.trigger.schedule}).</p>
          <p className={styles.muted}>Name it and save it in Crons; nothing runs until you do. <Link href="/governance/crons/?new=1">Open Crons</Link></p>
        </div>
      ) : null}
      {turn.scenarioId !== null ? <p><Link href={scenarioHref(turn.scenarioId) as never}>A failure scenario was started: open it</Link></p> : null}
      {turn.explanation?.kind === 'navigation' ? (
        <p>
          {turn.explanation.target.kind === 'object_view'
            ? <Link href={objectHref({ objectTypeId: turn.explanation.target.objectTypeId, objectId: turn.explanation.target.objectId }) as never}>Open the object</Link>
            : <Link href={hrefWith('/clones/canvas/', { type: turn.explanation.target.objectTypeId }) as never}>Open the canvas on {lookup?.typeName(turn.explanation.target.objectTypeId, true) ?? 'these objects'}</Link>}
        </p>
      ) : null}
      {turn.explanation?.kind === 'finding' ? (
        <p>The finding explained: <Link href={findingHref(turn.explanation.finding.id) as never}>{turn.explanation.finding.detector} on {plural(turn.explanation.finding.objectIds.length, 'object')}</Link></p>
      ) : null}
      {turn.explanation?.kind === 'lineage' ? (
        <p>
          Lineage traced {turn.explanation.graph.direction}: {plural(turn.explanation.graph.nodes.length, 'node')}, {plural(turn.explanation.graph.edges.length, 'link')}
          {turn.explanation.graph.withheld > 0 ? `, ${turn.explanation.graph.withheld} you may not see` : ''}.{' '}
          <Link href={hrefWith('/governance/lineage/', { node: turn.explanation.graph.root }) as never}>Open in Lineage</Link>
        </p>
      ) : null}
      {turn.incompleteSources.length > 0 ? (
        <Banner tone="warn">{plural(turn.incompleteSources.length, 'source')} did not answer in time: the answer may be incomplete.</Banner>
      ) : null}
      {turn.outsideContext !== null ? (
        <aside className={styles.outside} aria-label="Outside context">
          <p className={styles.meta}>From the web, searched for &ldquo;{turn.outsideContext.query}&rdquo; <Time value={turn.outsideContext.retrievedAt} />. Not your data.</p>
          {turn.outsideContext.status === 'unavailable' ? <p className={styles.muted}>Web search was unavailable.</p> : (
            <ul>{turn.outsideContext.results.map((r) => <li key={r.url}><a href={r.url} rel="noreferrer noopener" target="_blank">{r.title}</a> <span className={styles.muted}>{r.snippet}</span></li>)}</ul>
          )}
        </aside>
      ) : null}
    </article>
  );
}

/** The question box: plain words in; a harder question may ask for the advanced compile. */
/** How a question would be read, without running it: a compile (charged), never a read of the systems. */
function Preview({ question, onClose }: { question: string; onClose: () => void }) {
  const compile = useMutation('compileQuestion', { refresh: false });
  const [asked, setAsked] = useState(false);
  if (!asked) {
    return (
      <div className={styles.preview}>
        <p className={styles.muted}>Checking compiles the question as Ask would (it is charged), and shows how it would be answered, without reading your systems.</p>
        <div className={styles.composerFoot}>
          <Button size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" blocked={compile.blocked} onClick={() => {
            setAsked(true);
            void compile.run({ body: { question, execute: false } });
          }}>Check it</Button>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.preview}>
      {compile.pending ? <Loading label="Compiling" block={false} /> : null}
      {compile.error !== undefined ? <ErrorMessage error={compile.error} /> : null}
      {compile.data !== undefined ? (
        compile.data.outcome === 'plan' || compile.data.outcome === 'answer' ? <PlanWords plan={compile.data.plan} />
          : compile.data.outcome === 'clarification' ? <p className={styles.muted}>Silo would ask what you meant: ask it, and choose.</p>
          : <p className={styles.muted}>It could not be turned into a question over your data as written.</p>
      ) : null}
      <Button size="sm" onClick={onClose}>Close</Button>
    </div>
  );
}

export function Composer({ onAsk, pending, blocked, error, placeholder, tool, initial, preview = false }: {
  onAsk: (body: AskBody) => Promise<boolean>;
  /** Offer to check how the question would be read before asking it. */
  preview?: boolean;
  /** Text to start with: a question carried over from search. */
  initial?: string | undefined;
  pending: boolean;
  blocked: Parameters<typeof Button>[0]['blocked'];
  error: unknown;
  placeholder?: string;
  tool?: AskBody['tool'];
}) {
  const [question, setQuestion] = useState(initial ?? '');
  const [advanced, setAdvanced] = useState(false);
  const [checking, setChecking] = useState(false);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = question.trim();
    if (text === '' || pending) return;
    if (await onAsk({ question: text, advanced, ...(tool === undefined ? {} : { tool }) })) setQuestion('');
  };
  return (
    <form className={styles.composer} onSubmit={(e) => void submit(e)}>
      <TextArea label="Your question" hideLabel rows={3} maxLength={2000} value={question} placeholder={placeholder ?? 'Ask about your data in plain language'}
        onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }} />
      {error !== undefined ? <ErrorMessage error={error} /> : null}
      <div className={styles.composerFoot}>
        <Checkbox label="A harder question" hint="Charged as an advanced compile" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
        <span className={styles.composerButtons}>
          {preview ? <Button variant="ghost" disabled={question.trim() === ''} onClick={() => setChecking(true)}>Check how it would be read</Button> : null}
          <Button type="submit" variant="primary" icon="send" pending={pending} blocked={blocked} disabled={question.trim() === ''}>Ask</Button>
        </span>
      </div>
      {checking ? <Preview key={question} question={question.trim()} onClose={() => setChecking(false)} /> : null}
    </form>
  );
}

export function ThreadView({ threadId, compact = false }: { threadId: string; compact?: boolean }) {
  const thread = useQuery('readAskThread', { params: { threadId } });
  const ask = useMutation('askQuestion', { invalidates: ['listAskThreads'] });
  const agentId = thread.data?.thread.aiAgentId ?? null;
  const agent = useQuery('getAiAgent', agentId === null ? null : { params: { aiAgentId: agentId } });
  // An agent that does not answer questions is asked with the first thing it may do.
  const tool = agent.data !== undefined && !agent.data.tools.includes('answer') ? agent.data.tools[0] as AskBody['tool'] : undefined;
  const send = async (body: AskBody) => (await ask.run({ params: { threadId }, body })).ok;

  return (
    <QueryView query={thread} what="The thread">
      {(t) => (
        <div className={compact ? styles.compactThread : styles.thread}>
          {agentId !== null && agent.status === 'error' ? (
            <Banner tone="warn">This thread&rsquo;s AI agent is no longer available to you: its turns are kept, and it takes no new question.</Banner>
          ) : null}
          {agent.data !== undefined ? (
            <aside className={styles.agent} aria-label="AI agent">
              <p><strong>Asking {agent.data.name}</strong>{agent.data.description !== '' ? <> · {agent.data.description}</> : null}</p>
              <p className={styles.muted}>It may: {agent.data.tools.map((x) => (TOOL_LABEL[x] ?? x).toLowerCase()).join('; ')}. It sees only what you may see.</p>
              {agent.data.brief !== '' ? <details><summary>Its brief</summary><p className={styles.brief}>{agent.data.brief}</p></details> : null}
            </aside>
          ) : null}
          {t.turns.length === 0 ? <p className={styles.muted}>Ask your first question below.</p> : null}
          <ol className={styles.turns}>
            {t.turns.map((turn) => (
              <li key={turn.id}>
                <TurnView threadId={threadId} turn={turn} busy={ask.pending}
                  onChoose={(optionId) => void send({ question: 'Use this', clarification: { sequence: turn.sequence, optionId } })} />
              </li>
            ))}
          </ol>
          {t.thread.archivedAt === null && !(agentId !== null && agent.status === 'error') ? (
            <Composer onAsk={send} pending={ask.pending} blocked={ask.blocked} error={ask.error} tool={tool} preview={!compact} />
          ) : t.thread.archivedAt !== null ? <p className={styles.muted}>This thread is archived: it takes no new question.</p> : null}
        </div>
      )}
    </QueryView>
  );
}

export type { Thread, Turn };
