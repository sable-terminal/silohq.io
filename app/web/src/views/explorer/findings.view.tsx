'use client';

// Findings (spec 38): what Recognition noticed in the person's data, by the score its detectors
// computed, under the Lens that applies. A finding is a computed fact (a statistic against a
// threshold over a population, with the coverage it was computed on), never a judgement. The
// person dismisses, defers or confirms it in their Lens (silencing it for them only); a holder of
// finding.disposition does so for the organisation, which tunes the detector's threshold. Beside
// the list: the outcomes the organisation designated, the associations between findings and
// outcomes, an AI ranking that cites why, and an investigation of a type's anomalies, clusters,
// contradictions or gaps (stated in fixed language, never an accusation).

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, type Tone } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, usePermits, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary, type Lookup } from '../../hooks/vocabulary.hook.ts';
import { findingHref, objectHref } from '../../navigation/links.navigation.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { formatNumber, humanise, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './explorer.view.module.css';

type Finding = Output<'readRecognitionFinding'>;
type Disposition = 'confirmed' | 'deferred' | 'dismissed';

const DISPOSITION: Record<Disposition, { label: string; tone: Tone }> = {
  confirmed: { label: 'Confirmed', tone: 'ok' }, deferred: { label: 'Deferred', tone: 'warn' }, dismissed: { label: 'Dismissed', tone: 'neutral' },
};

/** What a finding computed, in words: the statistic, its value, against its threshold, over the population. */
export function statementOf(f: Pick<Finding, 'computation'>): string {
  const c = f.computation;
  return `${humanise(c.statistic)} ${formatNumber(c.value, 3)} ${c.comparison === 'ge' ? '≥' : '≤'} ${formatNumber(c.threshold, 3)}, over ${plural(c.population, 'object')}${c.sampleSize !== c.population ? ` (sample of ${formatNumber(c.sampleSize)})` : ''}`;
}

const titleOf = (f: Pick<Finding, 'detector' | 'objectIds' | 'objectTypeId'>, lookup: Lookup | undefined) =>
  `${humanise(f.detector)} on ${f.objectIds.length} ${lookup?.typeName(f.objectTypeId, f.objectIds.length !== 1) ?? 'objects'}`;

const coverageOf = (f: Pick<Finding, 'coverage'>) => {
  const c = f.coverage;
  const parts = [`${formatNumber(c.decided)} decided`, c.disputed > 0 ? `${formatNumber(c.disputed)} disputed` : '', c.empty > 0 ? `${formatNumber(c.empty)} empty` : '',
    c.unchecked > 0 ? `${formatNumber(c.unchecked)} not checked` : ''].filter(Boolean);
  return parts.join(', ');
};

function FindingDetail({ findingId, onClose }: { findingId: string; onClose: () => void }) {
  const workspace = useWorkspace();
  const say = useToast();
  const { lookup } = useVocabulary();
  const lensId = workspace.lens?.id;
  const finding = useQuery('readRecognitionFinding', { params: { findingId }, query: lensId === undefined ? {} : { lensId } });
  const run = useQuery('readRecognitionRun', finding.data === undefined ? null : { params: { runId: finding.data.runId } });
  const mine = useMutation('recordRecognitionLensDisposition', { invalidates: ['listRecognitionFindings', 'readRecognitionFinding', 'listRecognitionLenses'] });
  const org = useMutation('dispositionRecognitionFinding', { invalidates: ['listRecognitionFindings', 'readRecognitionFinding'] });
  return (
    <Dialog open onClose={onClose} drawer title={finding.data === undefined ? 'Finding' : titleOf(finding.data, lookup)} description="A computed fact about your data: never a judgement.">
      <QueryView query={finding} what="The finding">
        {(f) => {
          const type = lookup?.types.get(f.objectTypeId);
          return (
            <div className={styles.stack}>
              <p className={styles.statement}>{statementOf(f)}</p>
              {!f.current ? <Banner tone="info">A later run no longer raised it{f.supersededAt !== null ? <>, <Time value={f.supersededAt} /></> : null}.</Banner> : null}
              <Panel>
                <Properties items={[
                  ['Detector', `${humanise(f.detector)} (version ${f.detectorVersion})`],
                  ['Score', formatNumber(f.score, 3)],
                  ['Computed on', coverageOf(f)],
                  ['Properties examined', f.properties.map((p) => type?.properties.find((x) => x.apiName === p)?.displayName ?? humanise(p)).join(', ') || '—'],
                  ['Systems', plural(f.connectionIds.length, 'connection')],
                  ['Raised', <Time key="r" value={f.raisedAt} />],
                  ['Run', run.data === undefined ? '…' : `${humanise(run.data.state)}${run.data.populationCount !== null ? `, ${plural(run.data.populationCount, 'object')}` : ''}`],
                  f.markingIds.length > 0 ? ['Markings', plural(f.markingIds.length, 'marking')] : null,
                ]} />
              </Panel>
              {f.usefulness !== null ? <p className={styles.muted}>{f.usefulness.statement}</p> : null}
              <Section title="In your Lens" description={lensId === undefined ? 'Choose a Lens from the Lens chip at the top to keep your own dispositions.' : `Only you see it so in ${workspace.lens!.name}: it still counts for Crons and for everyone else.`}>
                <div className={styles.row}>
                  {f.lensDisposition !== null ? <Badge tone={DISPOSITION[f.lensDisposition].tone}>{DISPOSITION[f.lensDisposition].label}</Badge> : null}
                  {(['confirmed', 'deferred', 'dismissed'] as const).map((d) => (
                    <Button key={d} size="sm" disabled={f.lensDisposition === d} blocked={lensId === undefined ? 'Choose a Lens first' : mine.blocked} pending={mine.pending}
                      onClick={() => void mine.run({ params: { lensId: lensId!, findingId: f.id }, body: { disposition: d } }).then((r) => r.ok && say(`${DISPOSITION[d].label} in your Lens`))}>
                      {d === 'confirmed' ? 'Confirm' : d === 'deferred' ? 'Defer' : 'Dismiss'}
                    </Button>
                  ))}
                </div>
                {mine.error !== undefined ? <ErrorMessage error={mine.error} /> : null}
              </Section>
              <Section title="For the organisation" description="Counts toward the detector's threshold for everyone.">
                <div className={styles.row}>
                  {f.orgDisposition !== null ? <Badge tone={DISPOSITION[f.orgDisposition].tone}>{DISPOSITION[f.orgDisposition].label}</Badge> : <span className={styles.muted}>Not decided</span>}
                  {(['confirmed', 'deferred', 'dismissed'] as const).map((d) => (
                    <Button key={d} size="sm" disabled={f.orgDisposition === d} blocked={org.blocked} pending={org.pending}
                      onClick={() => void org.run({ params: { findingId: f.id }, body: { disposition: d, version: f.version } }).then((r) => {
                        if (r.ok) say(r.data.tuned === null ? `${DISPOSITION[d].label} for the organisation` : `${DISPOSITION[d].label}: the threshold moved from ${formatNumber(r.data.tuned.from, 3)} to ${formatNumber(r.data.tuned.to, 3)}`);
                      })}>
                      {d === 'confirmed' ? 'Confirm' : d === 'deferred' ? 'Defer' : 'Dismiss'}
                    </Button>
                  ))}
                </div>
                {org.error !== undefined ? <ErrorMessage error={org.error} onRetry={finding.refetch} /> : null}
              </Section>
              <Section title={`The ${plural(f.objectIds.length, 'object')}`}>
                <ul className={styles.plainList}>
                  {f.objectIds.slice(0, 25).map((id, i) => (
                    <li key={id}><Link href={objectHref({ objectTypeId: f.objectTypeId, objectId: id }) as never}>{type?.displayName ?? 'Object'} {i + 1}</Link></li>
                  ))}
                </ul>
                {f.objectIds.length > 25 ? <p className={styles.muted}>And {formatNumber(f.objectIds.length - 25)} more.</p> : null}
              </Section>
              {f.links.length > 0 ? (
                <Section title="Findings that occur with it">
                  <ul className={styles.plainList}>
                    {f.links.map((l) => <li key={l.findingId}><Link href={findingHref(l.findingId) as never}>A finding sharing {plural(l.sharedObjects, 'object')}</Link></li>)}
                  </ul>
                </Section>
              ) : null}
              <Section title="From here">
                <div className={styles.row}>
                  <Button icon="ask" onClick={() => workspace.askAboutPage('Explain this finding')}>Ask about it</Button>
                  <Link href={hrefWith('/scenarios/list/', { new: 1, finding: f.id }) as never}>Open a scenario on its objects</Link>
                  <Link href={objectHref({ objectTypeId: f.objectTypeId, objectId: f.objectIds[0] ?? '' }) as never}>Propose an Action from its first object</Link>
                </div>
              </Section>
            </div>
          );
        }}
      </QueryView>
    </Dialog>
  );
}

function FindingsList() {
  const workspace = useWorkspace();
  const { lookup } = useVocabulary();
  const [params, set] = useParams();
  const type = params.get('type') ?? '';
  const detector = params.get('detector') ?? '';
  const [superseded, setSuperseded] = useState(false);
  const lensId = workspace.lens?.id;
  const findings = useQuery('listRecognitionFindings', {
    query: { ...(type === '' ? {} : { objectTypeId: type }), ...(detector === '' ? {} : { detector }), includeSuperseded: superseded ? 'true' : 'false',
      ...(lensId === undefined ? {} : { lensId }), limit: 200 },
  }, { keepPrevious: true });
  const rank = useMutation('rankRecognitionFindings', { refresh: false });
  const [ranked, setRanked] = useState<Map<string, { position: number; citation: string }> | undefined>(undefined);
  const detectors = useMemo(() => [...new Set(findings.data?.findings.map((f) => f.detector) ?? [])].sort(), [findings.data]);

  const rows = useMemo(() => {
    const list = findings.data?.findings ?? [];
    if (ranked === undefined) return list;
    return [...list].sort((a, b) => (ranked.get(a.id)?.position ?? 1e9) - (ranked.get(b.id)?.position ?? 1e9));
  }, [findings.data, ranked]);

  return (
    <div className={styles.stack}>
      <Toolbar end={(
        <Button icon="sparkle" blocked={rank.blocked} pending={rank.pending} onClick={() => void rank.run({ body: { ...(type === '' ? {} : { objectTypeId: type }), limit: 50 } }).then((r) => {
          if (r.ok) setRanked(new Map(r.data.ranked.map((x) => [x.findingId, { position: x.position, citation: x.citation }])));
        })}>Rank with AI</Button>
      )}>
        <div className={styles.filters}>
          <SelectField label="Object type" value={type} onChange={(e) => set({ type: e.target.value })} placeholder="Every type"
            options={(lookup === undefined ? [] : [...lookup.types.values()]).map((t) => ({ value: t.id, label: t.pluralName }))} />
          <SelectField label="Detector" value={detector} onChange={(e) => set({ detector: e.target.value })} placeholder="Every detector"
            options={detectors.map((d) => ({ value: d, label: humanise(d) }))} />
          <Checkbox label="Include superseded" checked={superseded} onChange={(e) => setSuperseded(e.target.checked)} />
        </div>
      </Toolbar>
      {rank.error !== undefined ? <ErrorMessage error={rank.error} /> : null}
      {ranked !== undefined ? <Banner tone="info" action={<Button size="sm" variant="ghost" onClick={() => setRanked(undefined)}>Back to score order</Button>}>Ordered by the AI ranking; each ranked finding says why.</Banner> : null}
      <QueryView query={findings} what="Findings" isEmpty={(d) => d.findings.length === 0}
        empty={<EmptyState icon="sparkle" title="No findings">Recognition raises findings as its detectors run over the types configured for them (Ontology › Detectors).</EmptyState>}>
        {(d) => (
          <>
            <DataTable label="Findings" rows={rows} rowKey={(f) => f.id} rowHref={(f) => findingHref(f.id)} columns={[
              ...(ranked !== undefined ? [{ id: 'rank', header: 'Rank', width: 'xs' as const, cell: (f: typeof rows[number]) => String(ranked.get(f.id)?.position ?? '—') }] : []),
              { id: 'finding', header: 'Finding', primary: true, cell: (f) => titleOf(f, lookup) },
              { id: 'statement', header: ranked !== undefined ? 'Why' : 'What it computed', cell: (f) => <span className={styles.muted}>{ranked?.get(f.id)?.citation ?? statementOf(f)}</span> },
              { id: 'score', header: 'Score', width: 'xs', align: 'end', sortValue: (f) => f.score, cell: (f) => <span className={styles.score}>{formatNumber(f.score, 2)}</span> },
              { id: 'yours', header: 'Your Lens', width: 'sm', cell: (f) => (f.lensDisposition === null ? '—' : <Badge tone={DISPOSITION[f.lensDisposition].tone}>{DISPOSITION[f.lensDisposition].label}</Badge>) },
              { id: 'org', header: 'Organisation', width: 'sm', cell: (f) => (f.orgDisposition === null ? '—' : <Badge tone={DISPOSITION[f.orgDisposition].tone}>{DISPOSITION[f.orgDisposition].label}</Badge>) },
              { id: 'raised', header: 'Raised', width: 'sm', sortValue: (f) => f.raisedAt, cell: (f) => <Time value={f.raisedAt} /> },
            ]} />
            {d.withheld > 0 || d.silenced > 0 ? (
              <p className={styles.muted}>
                {d.withheld > 0 ? `${plural(d.withheld, 'finding')} you may not see. ` : ''}
                {d.silenced > 0 ? `${plural(d.silenced, 'finding')} dismissed in your Lens, not shown.` : ''}
              </p>
            ) : null}
          </>
        )}
      </QueryView>
    </div>
  );
}

function Outcomes() {
  const { lookup } = useVocabulary();
  const people = useDirectory();
  const [type, setType] = useState('');
  const [property, setProperty] = useState('');
  const outcomes = useQuery('listRecognitionOutcomes', { query: type === '' ? {} : { objectTypeId: type } });
  const designate = useMutation('designateRecognitionOutcome', { invalidates: ['listRecognitionOutcomes'] });
  const revoke = useMutation('revokeRecognitionOutcome', { invalidates: ['listRecognitionOutcomes'] });
  const chosen = type === '' ? undefined : lookup?.types.get(type);
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>An outcome is what the organisation cares about (a property, or a detector's findings) on a type. Associations say which findings occur with it.</p>
      <Panel>
        <form className={styles.filters} onSubmit={(e) => {
          e.preventDefault();
          if (type === '' || property === '') return;
          void designate.run({ body: { objectTypeId: type, property } }).then((r) => r.ok && setProperty(''));
        }}>
          <SelectField label="Object type" value={type} onChange={(e) => {
            setType(e.target.value);
            setProperty('');
          }} placeholder="Choose a type…" options={(lookup === undefined ? [] : [...lookup.types.values()]).map((t) => ({ value: t.id, label: t.displayName }))} />
          <SelectField label="Property" value={property} onChange={(e) => setProperty(e.target.value)} placeholder="Choose a property…" disabled={chosen === undefined}
            options={(chosen?.properties ?? []).map((p) => ({ value: p.apiName, label: p.displayName }))} />
          <Button type="submit" variant="primary" pending={designate.pending} blocked={designate.blocked} disabled={type === '' || property === ''}>Designate as an outcome</Button>
        </form>
        {designate.error !== undefined ? <ErrorMessage error={designate.error} /> : null}
      </Panel>
      <QueryView query={outcomes} what="Outcomes" isEmpty={(d) => d.outcomes.length === 0} empty={<p className={styles.muted}>No outcomes designated{type === '' ? '' : ' on this type'}.</p>}>
        {(d) => (
          <DataTable label="Outcomes" rows={d.outcomes} rowKey={(o) => o.id} columns={[
            { id: 'type', header: 'Type', cell: (o) => lookup?.typeName(o.objectTypeId) ?? '' },
            { id: 'what', header: 'Outcome', primary: true, cell: (o) => (o.property !== null ? (lookup?.types.get(o.objectTypeId)?.properties.find((p) => p.apiName === o.property)?.displayName ?? humanise(o.property)) : humanise(o.detector ?? '')) },
            { id: 'by', header: 'Designated by', cell: (o) => <>{people.nameOf(o.designatedBy)}, <Time value={o.designatedAt} /></> },
            { id: 'revoke', header: <span className="visually-hidden">Revoke</span>, align: 'end', cell: (o) => (
              <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => void revoke.run({ params: { outcomeId: o.id } })}>Revoke</Button>
            ) },
          ]} />
        )}
      </QueryView>
      {revoke.error !== undefined ? <ErrorMessage error={revoke.error} /> : null}
    </div>
  );
}

function Associations() {
  const { lookup } = useVocabulary();
  const [type, setType] = useState('');
  const associations = useQuery('listRecognitionAssociations', { query: type === '' ? {} : { objectTypeId: type } });
  const compute = useMutation('computeRecognitionAssociations', { invalidates: ['listRecognitionAssociations'] });
  const say = useToast();
  return (
    <div className={styles.stack}>
      <Toolbar end={(
        <Button icon="refresh" pending={compute.pending} blocked={compute.blocked} onClick={() => void compute.run({}).then((r) => r.ok && say(`${plural(r.data.associations, 'association')} computed${r.data.skipped.length > 0 ? `, ${r.data.skipped.length} skipped` : ''}`))}>Compute again</Button>
      )}>
        <div className={styles.filters}>
          <SelectField label="Object type" value={type} onChange={(e) => setType(e.target.value)} placeholder="Every type"
            options={(lookup === undefined ? [] : [...lookup.types.values()]).map((t) => ({ value: t.id, label: t.pluralName }))} />
        </div>
      </Toolbar>
      {compute.error !== undefined ? <ErrorMessage error={compute.error} /> : null}
      <QueryView query={associations} what="Associations" isEmpty={(d) => d.associations.length === 0}
        empty={<EmptyState icon="link" title="No associations yet">Designate outcomes, then compute: Silo states which findings occur with them, how often, and in which order.</EmptyState>}>
        {(d) => (
          <>
            {d.computation !== null ? <p className={styles.muted}>Computed <Time value={d.computation.computedAt} />.</p> : null}
            <DataTable label="Associations" rows={d.associations} rowKey={(a) => a.id} columns={[
              { id: 'statement', header: 'What occurs together', primary: true, cell: (a) => a.statement },
              { id: 'together', header: 'Together', width: 'sm', align: 'end', sortValue: (a) => a.coOccurrence, cell: (a) => `${formatNumber(a.coOccurrence)} of ${formatNumber(a.sampleSize)}` },
              { id: 'relation', header: 'How', width: 'md', cell: (a) => (a.relation === 'linked_through' ? 'Through a link' : 'On the same objects') },
            ]} />
            {d.withheld > 0 ? <p className={styles.muted}>{plural(d.withheld, 'association')} you may not see.</p> : null}
          </>
        )}
      </QueryView>
    </div>
  );
}

function Investigate({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lookup } = useVocabulary();
  const [type, setType] = useState('');
  const [question, setQuestion] = useState<'anomalies' | 'clusters' | 'contradictions' | 'gaps'>('anomalies');
  const investigate = useMutation('investigateRecognition', { refresh: false });
  const result = investigate.data;
  return (
    <Dialog open={open} onClose={onClose} title="Investigate a type" description="What stands out about a type, stated in fixed language: it never asserts wrongdoing; a person decides." size="lg" busy={investigate.pending}>
      <div className={styles.stack}>
        <form className={styles.filters} onSubmit={(e) => {
          e.preventDefault();
          if (type !== '') void investigate.run({ body: { question, objectTypeId: type } });
        }}>
          <SelectField label="Object type" value={type} onChange={(e) => setType(e.target.value)} placeholder="Choose a type…"
            options={(lookup === undefined ? [] : [...lookup.types.values()]).map((t) => ({ value: t.id, label: t.pluralName }))} />
          <SelectField label="Look for" value={question} onChange={(e) => setQuestion(e.target.value as typeof question)} options={[
            { value: 'anomalies', label: 'Anomalies' }, { value: 'clusters', label: 'Clusters' }, { value: 'contradictions', label: 'Contradictions' }, { value: 'gaps', label: 'Gaps' },
          ]} />
          <Button type="submit" variant="primary" pending={investigate.pending} blocked={investigate.blocked} disabled={type === ''}>Investigate</Button>
        </form>
        {investigate.error !== undefined ? <ErrorMessage error={investigate.error} /> : null}
        {result !== undefined ? (
          <>
            {result.incomplete !== null ? <Banner tone="warn">Incomplete: {humanise(result.incomplete.reason)}.</Banner> : null}
            <p className={styles.muted}>
              {result.population === null ? '' : `Over ${plural(result.population, 'object')}. `}
              History {result.history === 'held' ? `is held for ${result.capturedProperties.length} properties` : result.history === 'not_held' ? 'is not held: capture its properties to see change over time' : 'could not be read'}.
            </p>
            <Section title="Now">
              {result.current.length === 0 ? <p className={styles.muted}>Nothing stands out.</p> : <ul className={styles.plainList}>{result.current.map((c, i) => <li key={i}>{c.statement}</li>)}</ul>}
            </Section>
            {result.historical.length > 0 ? <Section title="Over time"><ul className={styles.plainList}>{result.historical.map((c, i) => <li key={i}>{c.statement}</li>)}</ul></Section> : null}
            {result.requiresCapture.length > 0 ? <p className={styles.muted}>More can be said once {result.requiresCapture.join(', ')} {result.requiresCapture.length === 1 ? 'is' : 'are'} captured (Siloes › Capture).</p> : null}
          </>
        ) : null}
        <FormActions><Button onClick={onClose}>Done</Button></FormActions>
      </div>
    </Dialog>
  );
}

const TABS: TabDef<'findings' | 'outcomes' | 'associations'>[] = [
  { id: 'findings', label: 'Findings' }, { id: 'outcomes', label: 'Outcomes' }, { id: 'associations', label: 'Occurring together' },
];

export function Findings() {
  const workspace = useWorkspace();
  const [params, set] = useParams();
  const [tab, setTab] = useTab(TABS);
  const [investigating, setInvestigating] = useState(false);
  const findingId = params.get('finding') ?? undefined;
  const blockedOf = usePermits();
  usePageContext({ scope: { kind: 'page', page: 'explorer' }, scopeLabel: 'Findings', status: workspace.lens === undefined ? 'No Lens applies' : `Lens: ${workspace.lens.name}` });
  return (
    <Page title="Findings" description="What Recognition noticed in your data, ranked by what matters. Each is a computed fact; you decide what it means."
      crumbs={[{ label: 'Explorer', href: '/explorer/types/' }]}
      meta={workspace.lens === undefined ? <span>No Lens applies: dispositions are the organisation's</span> : <span>Under your Lens {workspace.lens.name}</span>}
      actions={<Button icon="search" blocked={blockedOf('investigateRecognition')} onClick={() => setInvestigating(true)}>Investigate a type</Button>}>
      <Tabs label="Findings" tabs={TABS} current={tab} onChange={setTab} />
      <TabPanel id={tab}>
        {tab === 'findings' ? <FindingsList /> : tab === 'outcomes' ? <Outcomes /> : <Associations />}
      </TabPanel>
      {findingId !== undefined ? <FindingDetail key={findingId} findingId={findingId} onClose={() => set({ finding: undefined })} /> : null}
      <Investigate open={investigating} onClose={() => setInvestigating(false)} />
    </Page>
  );
}
