'use client';

// The object view (spec 34): one object as the reader may see it, read live from each system that
// holds it (34.2). Every system's own value is shown where they disagree, with the field authority
// that decided it and who declared it; nothing is resolved by the client. A property withheld from
// the reader is named, never shown; a marked one is not mentioned. Links say how many objects they
// reach, or why they were not followed. Its sections read separately (34.2), so one that cannot be
// read says why and the rest stand: Actions with their submission criteria and the changes a
// proposal would make, the timeline of observed changes (Capture), findings naming it under the
// Lens that applies, scenarios that stage an Action on it or reach it, and its media (D238). The
// Ask panel is scoped to the object (33.6), by reference.

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge, Marking } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Checkbox, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { RefusalNotice } from '../../components/refusal.component.tsx';
import { EmptyState, ErrorMessage, ErrorState, Loading } from '../../components/states.component.tsx';
import { Time } from '../../components/time.component.tsx';

import { useMutation, useQuery, type Blocked } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { MediaSection } from '../files/objectMedia.view.tsx';
import { findingHref, objectHref, scenarioHref, typeHref } from '../../navigation/links.navigation.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { formatNumber, humanise, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { formatValue, type DataType } from '../../utils/value.util.ts';
import { statementOf } from './findings.view.tsx';
import styles from './object.view.module.css';

type Read = Output<'readObjectView'>;
type View = Extract<Read, { outcome: 'object' }>['view'];
type Property = View['properties'][number];
type Action = NonNullable<View['actions']>[number];
export type ObjectViewAction = Action;
type Parameter = Action['parameters'][number];
type Proposal = Output<'proposeMutation'>;

export type ObjectAddress = { objectTypeId: string } & ({ objectId: string } | { connectionId: string; reference: string });

const describe = (value: unknown, dataType: string): string =>
  typeof value === 'object' && value !== null ? JSON.stringify(value) : formatValue(dataType as DataType, value);

/** The address from the page's query: a Silo id, or a system and its reference. */
export function addressOf(params: URLSearchParams): ObjectAddress | undefined {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const objectTypeId = params.get('type') ?? '';
  if (!UUID.test(objectTypeId)) return undefined;
  const id = params.get('id');
  if (id !== null && UUID.test(id)) return { objectTypeId, objectId: id };
  const connectionId = params.get('connection');
  const reference = params.get('ref');
  if (connectionId !== null && UUID.test(connectionId) && reference !== null && reference !== '') return { objectTypeId, connectionId, reference };
  return undefined;
}

// ----------------------------------------------------------------------------- properties and links

function PropertyRow({ property: p }: { property: Property }) {
  const disputed = p.state === 'disputed';
  return (
    <tr className={disputed ? styles.disputed : undefined}>
      <th scope="row">{p.displayName}{p.computed ? <Badge>computed</Badge> : null}</th>
      <td>
        {disputed ? <strong className={styles.dispute}>Systems disagree</strong>
          : p.state === 'unchecked' ? <span className={styles.muted}>Not checked: a system holding it did not answer</span>
          : p.state === 'empty' ? <span className={styles.muted}>Empty</span>
          : describe(p.value, p.dataType)}
        {p.effect !== 'allow' ? <> <Badge tone="warn">{p.effect === 'mask' ? 'masked' : 'redacted'}</Badge></> : null}
        {disputed ? (
          <ul className={styles.readings}>
            {p.readings.map((r) => (
              <li key={`${r.connectionId}:${r.fieldPath}`}>{describe(r.value, p.dataType)} <span className={styles.muted}>in {r.sourceObject}, read <Time value={r.readAt} /></span></li>
            ))}
          </ul>
        ) : null}
        {p.readings.filter((r) => r.extraction !== null).map((r) => (
          <p key={r.extraction!.extractionId} className={styles.muted}>
            Read from the document {r.extraction!.document} ({r.extraction!.location}){r.extraction!.confirmed ? ', confirmed by a person' : `, ${r.extraction!.method}`}
            {r.extraction!.modelScore !== null && !r.extraction!.confirmed ? `, model score ${formatNumber(r.extraction!.modelScore, 2)}` : ''}.
          </p>
        ))}
        {p.partial ? <p className={styles.warn}>A system holding this did not answer.</p> : null}
      </td>
      <td className={styles.source}>
        {p.authority !== null ? <>Decided by a field authority: {p.authority.reason}</>
          : p.state === 'agreed' ? 'Every system agrees'
          : p.readings[0] !== undefined ? <>{p.readings[0].sourceObject}<span className={styles.muted}> · connector {p.readings[0].connectorVersion}</span></> : '—'}
      </td>
    </tr>
  );
}

// ----------------------------------------------------------------------------- Actions

function inputType(p: Parameter): string {
  switch (p.type) {
    case 'integer': case 'decimal': return 'number';
    case 'date': return 'date';
    case 'timestamp': return 'datetime-local';
    default: return 'text';
  }
}

function valueOf(p: Parameter, text: string, checked: boolean): unknown {
  if (p.type === 'boolean') return checked;
  if (text === '') return undefined;
  if (p.type === 'integer') return Number.parseInt(text, 10);
  if (p.type === 'decimal') return Number(text);
  if (p.type === 'timestamp') return new Date(text).toISOString();
  return text;
}

/** What a proposal would change, as the mutation path previewed it: each field's value before and after. */
function ProposalOutcome({ proposal }: { proposal: Proposal }) {
  const rows = proposal.preview?.rows ?? [];
  return (
    <div className={styles.outcome}>
      {proposal.status === 'refused' ? <Banner tone="danger" title={`Refused at ${humanise(proposal.refusedStage ?? 'a check')}`}>{proposal.refusalReason ?? 'No reason was given.'}</Banner>
        : proposal.status === 'awaiting_approval' ? <Banner tone="ok" title="Proposed">It waits for approval. <Link href={hrefWith('/governance/changes/', { mutation: proposal.id }) as never}>Follow it in Changes</Link></Banner>
        : <Banner tone="info" title={humanise(proposal.status)}><Link href={hrefWith('/governance/changes/', { mutation: proposal.id }) as never}>Follow it in Changes</Link></Banner>}
      {rows.length > 0 ? (
        <table className={styles.diff} aria-label="What it would change">
          <thead><tr><th scope="col">Field</th><th scope="col">Now</th><th scope="col">After</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{r.field ?? humanise(r.operation)}</th>
                <td>{r.priorAbsent ? <span className={styles.muted}>absent</span> : describe(r.prior, 'string')}</td>
                <td>{r.proposedAbsent ? <span className={styles.muted}>absent</span> : r.proposedUnknown ? <span className={styles.muted}>set by the system</span> : describe(r.proposed, 'string')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/** An Action's form over one object's record; proposed through the mutation path, with what it would change shown. Studio's Action widgets use it too. */
export function ActionForm({ action, target, onProposed, stage }: {
  action: ObjectViewAction; target: { connectionId: string; reference: string }; onProposed?: (() => void) | undefined;
  /** Stage it in a scenario branch instead of proposing it (39.8): the same fields, nothing written. */
  stage?: { label: string; pending: boolean; error: unknown; blocked?: Blocked | undefined; run: (parameters: Record<string, unknown>) => void } | undefined;
}) {
  const propose = useMutation('proposeMutation', { invalidates: ['listMutations', 'listApprovalInbox'], onSuccess: () => onProposed?.() });
  const [text, setText] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parameters: Record<string, unknown> = {};
    for (const p of action.parameters) {
      const v = valueOf(p, text[p.name] ?? '', checks[p.name] === true);
      if (v !== undefined) parameters[p.name] = v;
    }
    if (stage !== undefined) {
      stage.run(parameters);
      return;
    }
    const body: NonNullable<Input<'proposeMutation'>['body']> = { actionTypeId: action.actionTypeId, parameters: parameters as never, objects: [target] };
    void propose.run({ body });
  };
  return (
    <form className={styles.actionForm} onSubmit={submit} aria-label={action.displayName}>
      {action.parameters.map((p) => {
        const label = `${humanise(p.name)}${p.required ? '' : ' (optional)'}`;
        return p.type === 'boolean' ? (
          <Checkbox key={p.name} label={label} checked={checks[p.name] === true} onChange={(e) => setChecks({ ...checks, [p.name]: e.target.checked })} />
        ) : p.type === 'enumeration' ? (
          <SelectField key={p.name} label={label} required={p.required} value={text[p.name] ?? ''} placeholder="Choose…"
            onChange={(e) => setText({ ...text, [p.name]: e.target.value })} options={(p.enumValues ?? []).map((v) => ({ value: v, label: v }))} />
        ) : (
          <TextField key={p.name} label={label} type={inputType(p)} step={p.type === 'decimal' ? 'any' : undefined} required={p.required}
            value={text[p.name] ?? ''} onChange={(e) => setText({ ...text, [p.name]: e.target.value })} />
        );
      })}
      {stage !== undefined ? (stage.error !== undefined ? <ErrorMessage error={stage.error} /> : null) : propose.error !== undefined ? <ErrorMessage error={propose.error} /> : null}
      <FormActions>
        {stage !== undefined
          ? <Button type="submit" variant="primary" pending={stage.pending} blocked={stage.blocked}>{stage.label}</Button>
          : <Button type="submit" variant="primary" pending={propose.pending} blocked={propose.blocked}>Propose</Button>}
      </FormActions>
      {stage === undefined && propose.data !== undefined ? <ProposalOutcome proposal={propose.data} /> : null}
    </form>
  );
}

function ActionsSection({ view }: { view: View }) {
  const [open, setOpen] = useState<string | undefined>(undefined);
  if (view.actions === null) return <ErrorMessage error={new Error('the Actions could not be listed just now')} />;
  if (view.actions.length === 0) return <p className={styles.muted}>No Actions you may take on this object.</p>;
  return (
    <ul className={styles.actions}>
      {view.actions.map((a) => {
        const unavailable = a.state === 'criteria_failed' ? `Not available: ${a.criterion}` : a.state === 'no_record' ? 'Not available: this object has no record in a system it writes through' : undefined;
        return (
          <li key={a.actionTypeId} className={styles.actionItem}>
            <div className={styles.actionHead}>
              <Button icon="play" blocked={unavailable} aria-expanded={open === a.actionTypeId} onClick={() => setOpen(open === a.actionTypeId ? undefined : a.actionTypeId)}>
                {a.displayName}
              </Button>
              {a.physical ? <Badge tone="warn">Physical: a revert cannot undo its effect</Badge> : null}
              {unavailable !== undefined ? <span className={styles.muted}>{unavailable}</span> : null}
            </div>
            {open === a.actionTypeId && a.target !== null ? <ActionForm action={a} target={a.target} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

// ----------------------------------------------------------------------------- the other sections

function Timeline({ view }: { view: View }) {
  const changes = useQuery('readObjectChanges', { body: { objectTypeId: view.objectTypeId, objectId: view.id, limit: 50 } });
  const name = (apiName: string) => view.properties.find((p) => p.apiName === apiName)?.displayName ?? humanise(apiName);
  if (changes.status === 'error') return <ErrorMessage error={changes.error} onRetry={changes.refetch} />;
  if (changes.data === undefined) return <Loading label="Reading its history" block={false} />;
  const c = changes.data;
  if (c.state !== 'silo') return <p className={styles.muted}>History is not kept for this type. <Link href="/siloes/capture/">Capture it in a Silo</Link> to see how it changes.</p>;
  if (c.changes.length === 0) return <p className={styles.muted}>No changes observed{c.capturedFrom !== null ? <> since <Time value={c.capturedFrom} exact /></> : null}.</p>;
  return (
    <ol className={styles.timeline}>
      {c.changes.map((x, i) => (
        <li key={`${x.observedAt}:${x.property}:${i}`}>
          <Time value={x.observedAt} exact /> <strong>{name(x.property)}</strong>:{' '}
          {x.withheld !== null ? <span className={styles.muted}>{x.withheld === 'mask' ? 'masked' : 'redacted'}</span> : <>{describe(x.previousValue, 'string')} → {describe(x.newValue, 'string')}</>}
        </li>
      ))}
    </ol>
  );
}

function Findings({ view }: { view: View }) {
  const workspace = useWorkspace();
  const lensId = workspace.lens?.id;
  const findings = useQuery('listObjectFindings', { params: { objectTypeId: view.objectTypeId, objectId: view.id }, query: lensId === undefined ? {} : { lensId } });
  if (findings.status === 'error') return <ErrorMessage error={findings.error} onRetry={findings.refetch} />;
  if (findings.data === undefined) return <Loading label="Reading its findings" block={false} />;
  return (
    <>
      {findings.data.findings.length === 0 ? <p className={styles.muted}>No findings name this object.</p> : (
        <ul className={styles.list}>
          {findings.data.findings.map((f) => (
            <li key={f.id}>
              <Link href={findingHref(f.id) as never}>{humanise(f.detector)}</Link> <span className={styles.muted}>{statementOf(f)}</span>
              {f.lensDisposition !== null ? <> <Badge>{humanise(f.lensDisposition)} in your Lens</Badge></> : null}
            </li>
          ))}
        </ul>
      )}
      {findings.data.withheld > 0 ? <p className={styles.muted}>{plural(findings.data.withheld, 'more finding')} not visible to you.</p> : null}
    </>
  );
}

function Scenarios({ view }: { view: View }) {
  const scenarios = useQuery('listObjectSimulationScenarios', { body: { objectTypeId: view.objectTypeId, objectId: view.id } });
  if (scenarios.status === 'error') return <ErrorMessage error={scenarios.error} onRetry={scenarios.refetch} />;
  if (scenarios.data === undefined) return <Loading label="Reading its scenarios" block={false} />;
  if (scenarios.data.scenarios.length === 0) return <p className={styles.muted}>No scenario you hold stages an Action on this object or reaches it.</p>;
  return (
    <ul className={styles.list}>
      {scenarios.data.scenarios.map((s) => (
        <li key={s.scenario.id}>
          <Link href={scenarioHref(s.scenario.id) as never}>{s.scenario.name}</Link>{' '}
          <span className={styles.muted}>
            {s.staged.length > 0 ? `${plural(s.staged.length, 'staged Action')} on it` : ''}
            {s.staged.length > 0 && s.reached.length > 0 ? '; ' : ''}
            {s.reached.length > 0 ? `reached in ${plural(s.reached.length, 'run')} (${[...new Set(s.reached.map((r) => r.effect))].join(', ')})` : ''}
          </span> <Badge tone="warn">Scenario: not current</Badge>
        </li>
      ))}
    </ul>
  );
}

function Favourite({ view }: { view: View }) {
  const favourites = useQuery('listFavourites', {});
  const add = useMutation('addFavourite', { invalidates: ['listFavourites', 'readBriefing'] });
  const remove = useMutation('removeFavourite', { invalidates: ['listFavourites', 'readBriefing'] });
  const mine = favourites.data?.favourites.find((f) => f.target.kind === 'object' && f.target.objectTypeId === view.objectTypeId && f.target.objectRef === view.id);
  if (favourites.data === undefined) return null;
  return mine === undefined
    ? <Button icon="star" pending={add.pending} blocked={add.blocked} onClick={() => void add.run({ body: { target: { kind: 'object', objectTypeId: view.objectTypeId, objectRef: view.id } } })}>Favourite</Button>
    : <Button icon="star" variant="secondary" pending={remove.pending} onClick={() => void remove.run({ params: { favouriteId: mine.id } })}>Favourited</Button>;
}

// ----------------------------------------------------------------------------- the page

const SECTIONS = [['properties', 'Properties'], ['links', 'Links'], ['actions', 'Actions'], ['timeline', 'Timeline'], ['findings', 'Findings'], ['scenarios', 'Scenarios'], ['media', 'Media']] as const;

function ObjectBody({ view }: { view: View }) {
  const { lookup } = useVocabulary();
  const workspace = useWorkspace();
  // This object named by its identifying property, to begin an analysis from a link group (37.8): only where that value is decided and visible.
  const primaryKey = lookup?.types.get(view.objectTypeId)?.primaryKey ?? null;
  const keyValue = primaryKey === null ? undefined : view.properties.find((p) => p.identityId === primaryKey && p.effect === 'allow' && p.value !== null);
  const analyseFrom = keyValue === undefined || !['string', 'number', 'boolean'].includes(typeof keyValue.value) ? undefined
    : JSON.stringify([{ property: primaryKey, op: 'eq', value: keyValue.value }]);
  const title = view.title === null || view.title === undefined ? lookup?.typeName(view.objectTypeId) ?? 'Object' : String(view.title);
  usePageContext({
    scope: { kind: 'object', objectTypeId: view.objectTypeId, objectRef: view.id },
    scopeLabel: title,
    status: `Read live from ${plural(view.references.length, 'system')}${view.incomplete.length > 0 ? `, ${view.incomplete.length} did not answer` : ''}`,
  });
  return (
    <Page title={title} crumbs={[{ label: 'Explorer', href: '/explorer/types/' }, { label: lookup?.typeName(view.objectTypeId, true) ?? 'Objects', href: typeHref(view.objectTypeId) }]}
      meta={(
        <>
          {view.markings.map((m) => <Marking key={m.id}>{m.name}</Marking>)}
          <span>Read <Time value={view.readAt} /> from {plural(view.references.length, 'system')}{view.binding.kind === 'match_key' ? `, matched on ${view.binding.keys.map((k) => k.apiName).join(', ')}` : ''}</span>
        </>
      )}
      actions={<><Favourite view={view} /><Button icon="ask" onClick={() => workspace.setPreferences({ askPanelOpen: true })}>Ask about it</Button>
        <Link href={hrefWith('/clones/canvas/', { type: view.objectTypeId, object: view.id }) as never}>Show on the canvas</Link></>}>
      {view.unmatched ? <Banner tone="info">This record stood alone: its match key was not complete, so it was not joined to records in other systems.</Banner> : null}
      {view.incomplete.length > 0 ? (
        <Banner tone="warn" title="Not everything answered">
          {view.incomplete.map((i) => `${i.sourceObject} (${humanise(i.reason)})`).join('; ')}: what is shown may not be all of it.
        </Banner>
      ) : null}
      <nav className={styles.sectionNav} aria-label="On this page">
        {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
      </nav>
      <section id="properties" className={styles.block} aria-labelledby="properties-title">
        <h2 id="properties-title" className={styles.blockTitle}>Properties</h2>
        <div className={styles.tableWrap}>
          <table className={styles.properties}>
            <thead><tr><th scope="col">Property</th><th scope="col">Value</th><th scope="col">Where it comes from</th></tr></thead>
            <tbody>{view.properties.map((p) => <PropertyRow key={p.identityId} property={p} />)}</tbody>
          </table>
        </div>
        {view.withheld.length > 0 ? <p className={styles.muted}>Not visible to you: {view.withheld.map((w) => w.displayName).join(', ')}.</p> : null}
      </section>
      <section id="links" className={styles.block} aria-labelledby="links-title">
        <h2 id="links-title" className={styles.blockTitle}>Links</h2>
        {view.links.length === 0 ? <p className={styles.muted}>No links you may see.</p> : (
          <ul className={styles.links}>
            {view.links.map((l) => (
              <li key={`${l.linkTypeId}:${l.direction}`}>
                <strong>{l.name}</strong>{' '}
                {l.refusal !== null ? <span className={styles.muted}>not followed: {l.refusal.reason}</span>
                  : <span className={styles.muted}>{plural(l.count ?? 0, lookup?.typeName(l.otherTypeId).toLowerCase() ?? 'object')}</span>}
                {analyseFrom !== undefined && l.refusal === null && (l.count ?? 0) > 0 ? (
                  <> <Link href={hrefWith('/explorer/analyses/', { type: view.objectTypeId, f: analyseFrom, follow: l.linkTypeId }) as never}>Analyse these</Link></>
                ) : null}
                {l.objects.length > 0 ? (
                  <ul className={styles.linked}>
                    {l.objects.map((o) => <li key={o.id}><Link href={objectHref({ objectTypeId: o.objectTypeId, objectId: o.id }) as never}>{o.title === null ? lookup?.typeName(o.objectTypeId) : String(o.title)}</Link></li>)}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section id="actions" className={styles.block} aria-labelledby="actions-title">
        <h2 id="actions-title" className={styles.blockTitle}>Actions</h2>
        <ActionsSection view={view} />
      </section>
      <section id="timeline" className={styles.block} aria-labelledby="timeline-title">
        <h2 id="timeline-title" className={styles.blockTitle}>Timeline</h2>
        <Timeline view={view} />
      </section>
      <section id="findings" className={styles.block} aria-labelledby="findings-title">
        <h2 id="findings-title" className={styles.blockTitle}>Findings</h2>
        <Findings view={view} />
      </section>
      <section id="scenarios" className={styles.block} aria-labelledby="scenarios-title">
        <h2 id="scenarios-title" className={styles.blockTitle}>Scenarios</h2>
        <Scenarios view={view} />
      </section>
      <div id="media">
        <MediaSection objectTypeId={view.objectTypeId} objectId={view.id} className={styles.block} titleClassName={styles.blockTitle} />
      </div>
    </Page>
  );
}

/**
 * An object beside something else (the canvas's selection panel): its properties, each system's
 * value where they disagree, its links and the Actions you may take, read live as you, with the
 * full page a link away.
 */
export function ObjectPanel({ address }: { address: { objectTypeId: string; objectId: string } }) {
  const { lookup } = useVocabulary();
  const read = useQuery('readObjectView', { body: { objectTypeId: address.objectTypeId, object: { objectId: address.objectId } } }, { staleMs: 30_000 });
  if (read.data === undefined) return read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading it from its systems" block={false} />;
  if (read.data.outcome === 'not_found') return <p className={styles.muted}>No such object, or none you may see.</p>;
  if (read.data.outcome === 'refusal') return <RefusalNotice refusal={read.data.refusal} />;
  const view = read.data.view;
  return (
    <div className={styles.panelStack}>
      <p className={styles.muted}>
        {view.markings.map((m) => <Marking key={m.id}>{m.name}</Marking>)} Read <Time value={view.readAt} /> from {plural(view.references.length, 'system')}.{' '}
        <Link href={objectHref({ objectTypeId: view.objectTypeId, objectId: view.id }) as never}>Open {lookup?.typeName(view.objectTypeId).toLowerCase() ?? 'it'}</Link>
      </p>
      {view.incomplete.length > 0 ? <Banner tone="warn">Not everything answered: {view.incomplete.map((i) => i.sourceObject).join(', ')}.</Banner> : null}
      <div className={styles.tableWrap}>
        <table className={styles.properties} aria-label="Properties">
          <thead><tr><th scope="col">Property</th><th scope="col">Value</th><th scope="col">Where it comes from</th></tr></thead>
          <tbody>{view.properties.map((p) => <PropertyRow key={p.identityId} property={p} />)}</tbody>
        </table>
      </div>
      <h3 className={styles.blockTitle}>Actions</h3>
      <ActionsSection view={view} />
    </div>
  );
}

export function ObjectPage() {
  const [params] = useParams();
  const { lookup } = useVocabulary();
  const address = addressOf(params);
  const object = address === undefined ? undefined : 'objectId' in address ? { objectId: address.objectId } : { connectionId: address.connectionId, reference: address.reference };
  const read = useQuery('readObjectView', address === undefined ? null : { body: { objectTypeId: address.objectTypeId, object: object! } }, { staleMs: 30_000 });
  usePageContext({});
  if (address === undefined) return <Page title="Object"><EmptyState icon="object" title="This address does not name an object" action={<Link href="/explorer/types/">Browse object types</Link>} /></Page>;
  const typeName = lookup?.typeName(address.objectTypeId) ?? 'Object';
  if (read.status === 'error' && read.data === undefined) return <Page title={typeName}><ErrorState error={read.error} what="The object" onRetry={read.refetch} /></Page>;
  if (read.data === undefined) return <Page title={typeName}><Loading label="Reading the object from its systems" /></Page>;
  if (read.data.outcome === 'not_found') return <Page title={typeName}><EmptyState icon="object" title="No such object, or none you may see" /></Page>;
  if (read.data.outcome === 'refusal') return <Page title={typeName}><RefusalNotice refusal={read.data.refusal} /></Page>;
  return <ObjectBody view={read.data.view} />;
}
