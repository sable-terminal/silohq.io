'use client';

// The dependency graph (spec 39.2, 39.3, 39.10): edges between object types over a link type, each
// hard, soft or resource, with its lead time and where that came from. A link says one record
// points at another; it does not say one waits on the other, so every edge is a person's statement
// of that. Proposed edges (from the model's links, stated by a person, or observed from history)
// are never walked until a person confirms them with a kind, a lead time and a reason; a confirmed
// edge is revised when its lead time stops being true, or retired; every one of these moves the
// graph's version. A resource edge states the capacity its dependants share.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Page } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { type TabDef, TabPanel, Tabs, useTab } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary, type Vocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { EDGE_KIND, EDGE_SOURCE, UNITS_OF_TIME } from './words.view.ts';
import styles from './scenarios.view.module.css';

export type Edge = Output<'listSimulationEdges'>['edges'][number];
type Kind = Edge['kind'];
type Unit = typeof UNITS_OF_TIME[number];
type Capacity = NonNullable<Edge['capacity']>;
type Status = 'proposed' | 'confirmed' | 'retired';
const TABS: TabDef<Status>[] = [{ id: 'proposed', label: 'Proposed' }, { id: 'confirmed', label: 'Confirmed' }, { id: 'retired', label: 'Retired' }];
const NUMERIC = ['integer', 'decimal', 'money', 'duration'];
const span = (d: { value: number; unit: string } | null) => (d === null ? undefined : `${d.value} ${d.unit}`);

/** "Orders depend on Suppliers (hard, 5 days, buffer 1 day; stated)". */
export function edgeWords(e: Edge, typeName: (id: string) => string): string {
  const facts = [e.kind, span(e.leadTime), e.buffer !== null ? `buffer ${span(e.buffer)}` : undefined].filter(Boolean).join(', ');
  return `${typeName(e.toObjectTypeId)} depends on ${typeName(e.fromObjectTypeId)} (${facts}; ${EDGE_SOURCE[e.source]})`;
}

export function Graph() {
  const say = useToast();
  const { lookup } = useVocabulary();
  const [, set] = useParams();
  const [status, setStatus] = useTab(TABS, 'status');
  const edges = useQuery('listSimulationEdges', { query: { status } }, { keepPrevious: true });
  const derive = useMutation('deriveSimulationEdges', { invalidates: ['listSimulationEdges'] });
  const [proposing, setProposing] = useState(false);
  usePageContext({ scope: { kind: 'page', page: 'scenarios' }, scopeLabel: 'The dependency graph' });
  const typeName = (id: string) => lookup?.typeName(id) ?? 'a type';
  return (
    <Page title="Dependency graph" description="A link says one record points at another; it does not say one waits on the other. Each edge here is a person's statement of that, and only confirmed edges are walked."
      crumbs={[{ label: 'Scenarios', href: '/scenarios/list/' }]}
      meta={edges.data !== undefined ? <span className={styles.muted}>Graph version {edges.data.graphVersion}.</span> : undefined}
      actions={
        <div className={styles.row}>
          <Button icon="sparkle" pending={derive.pending} blocked={derive.blocked} onClick={() => void derive.run({ body: {} }).then((r) => {
            if (!r.ok) return;
            say(`${plural(r.data.proposed.length, 'edge')} proposed from the model's links${r.data.alreadyPresent > 0 ? `; ${r.data.alreadyPresent} were already there` : ''}`);
            set({ status: undefined });
          })}>Propose edges from the model&apos;s links</Button>
          <Button variant="primary" icon="plus" onClick={() => setProposing(true)}>State an edge</Button>
        </div>
      }>
      <div className={styles.stack}>
        {derive.error !== undefined ? <ErrorMessage error={derive.error} /> : null}
        <Tabs label="Which edges" tabs={TABS} current={status} onChange={setStatus} />
        <TabPanel id={status}>
          <QueryView query={edges} what="The graph" isEmpty={(d) => d.edges.length === 0}
            empty={<EmptyState icon="ontology" title={`No ${status} edges`}>{status === 'proposed' ? 'Propose edges from the model\'s links, or state one.' : status === 'confirmed' ? 'Confirm a proposed edge for a scenario to walk it.' : 'Retired edges stay here, with why.'}</EmptyState>}>
            {(d) => (
              <ul className={styles.stack} aria-label="Edges">
                {d.edges.map((e) => (
                  <li key={e.id} className={styles.card}>
                    <EdgeCard edge={e} typeName={typeName} />
                  </li>
                ))}
              </ul>
            )}
          </QueryView>
        </TabPanel>
      </div>
      {proposing ? <ProposeDialog onClose={() => setProposing(false)} /> : null}
    </Page>
  );
}

function EdgeCard({ edge: e, typeName }: { edge: Edge; typeName: (id: string) => string }) {
  const say = useToast();
  const people = useDirectory();
  const { lookup } = useVocabulary();
  const confirm = useMutation('confirmSimulationEdge', { invalidates: ['listSimulationEdges'] });
  const revise = useMutation('reviseSimulationEdge', { invalidates: ['listSimulationEdges'] });
  const retire = useMutation('retireSimulationEdge', { invalidates: ['listSimulationEdges'] });
  const [dialog, setDialog] = useState<'revise' | 'retire' | undefined>();
  const link = lookup?.links.get(e.viaLinkTypeId);
  return (
    <div className={styles.stackTight}>
      <div className={styles.cardHead}>
        <span><strong>{typeName(e.toObjectTypeId)}</strong> depends on <strong>{typeName(e.fromObjectTypeId)}</strong></span>
        <Badge tone={e.kind === 'hard' ? 'danger' : e.kind === 'soft' ? 'warn' : 'info'}>{e.kind}</Badge>
        <Badge>{EDGE_SOURCE[e.source]}</Badge>
        {e.status === 'confirmed' ? (
          <>
            <Button size="sm" blocked={revise.blocked} onClick={() => setDialog('revise')}>Revise</Button>
            <Button size="sm" variant="ghost" blocked={retire.blocked} onClick={() => setDialog('retire')}>Retire</Button>
          </>
        ) : null}
      </div>
      <span className={styles.muted}>
        Over the link {link === undefined ? 'you cannot see' : link.forwardName}
        {e.leadTime !== null ? `; lead time ${span(e.leadTime)}` : '; no lead time yet'}{e.buffer !== null ? `, buffer ${span(e.buffer)}` : ''}
        {e.capacity !== null ? `; ${e.capacity.consumption} of ${lookup?.propertyName(e.capacity.capacityPropertyId) ?? 'its capacity'} per unit of ${lookup?.propertyName(e.capacity.demandPropertyId) ?? 'demand'}, a ${e.capacity.period}` : ''}
        {e.confirmedBy !== null && e.confirmedAt !== null ? <>; confirmed by {people.nameOf(e.confirmedBy)} <Time value={e.confirmedAt} /></> : null}
      </span>
      {e.status === 'proposed' ? (
        <EdgeForm edge={e} label="Confirm the edge" action="Confirm" pending={confirm.pending} error={confirm.error} blocked={confirm.blocked}
          onSubmit={(v) => void confirm.run({ params: { edgeId: e.id }, body: { kind: v.kind, leadTime: v.leadTime, buffer: v.buffer, reason: v.reason, version: e.version, ...(v.capacity === undefined ? {} : { capacity: v.capacity }) } })
            .then((r) => r.ok && say('Confirmed: it is now walked.'))} />
      ) : null}
      <Dialog open={dialog === 'revise'} onClose={() => setDialog(undefined)} title="Revise the edge" size="md" busy={revise.pending}
        description="A lead time true in March may not be true in September. The revision moves the graph's version; earlier runs keep what they walked.">
        <EdgeForm edge={e} label="Revise the edge" action="Revise" pending={revise.pending} error={revise.error} blocked={revise.blocked}
          onSubmit={(v) => void revise.run({ params: { edgeId: e.id }, body: { kind: v.kind, leadTime: v.leadTime, buffer: v.buffer, reason: v.reason, version: e.version, ...(v.capacity === undefined ? {} : { capacity: v.capacity }) } })
            .then((r) => {
              if (!r.ok) return;
              setDialog(undefined);
              say(`Revised: the graph is at version ${r.data.graphVersion}`);
            })} />
      </Dialog>
      <Dialog open={dialog === 'retire'} onClose={() => setDialog(undefined)} title="Retire the edge" size="sm" busy={retire.pending}>
        <ReasonForm action="Retire" pending={retire.pending} error={retire.error} onClose={() => setDialog(undefined)}
          onSubmit={(reason) => void retire.run({ params: { edgeId: e.id }, body: { reason, version: e.version } }).then((r) => {
            if (!r.ok) return;
            setDialog(undefined);
            say(`Retired: the graph is at version ${r.data.graphVersion}`);
          })} />
      </Dialog>
    </div>
  );
}

interface EdgeValues { kind: Kind; leadTime: { value: number; unit: Unit }; buffer: { value: number; unit: Unit } | null; reason: string; capacity: Capacity | undefined }

/** Kind, lead time, buffer, a resource's capacity, and why: confirming or revising an edge. */
function EdgeForm({ edge, label, action, pending, error, blocked, onSubmit }: {
  edge: Edge; label: string; action: string; pending: boolean; error: unknown; blocked: ReturnType<typeof useMutation>['blocked']; onSubmit: (v: EdgeValues) => void;
}) {
  const { data: vocabulary } = useVocabulary();
  const [kind, setKind] = useState<Kind>(edge.kind);
  const [value, setValue] = useState(String(edge.leadTime?.value ?? 1));
  const [unit, setUnit] = useState<Unit>(edge.leadTime?.unit ?? 'days');
  const [buffer, setBuffer] = useState(edge.buffer === null ? '' : String(edge.buffer.value));
  const [bufferUnit, setBufferUnit] = useState<Unit>(edge.buffer?.unit ?? 'days');
  const [reason, setReason] = useState('');
  const [capacity, setCapacity] = useState<Partial<Capacity>>(edge.capacity ?? { period: 'week', consumption: 1 });
  const numeric = (typeId: string) => (vocabulary?.objectTypes.find((t) => t.id === typeId)?.properties ?? []).filter((p) => NUMERIC.includes(p.dataType)).map((p) => ({ value: p.identityId, label: p.displayName }));
  const capacityReady = kind !== 'resource' || (capacity.capacityPropertyId !== undefined && capacity.demandPropertyId !== undefined && (capacity.consumption ?? 0) > 0 && capacity.period !== undefined);
  return (
    <form className={styles.form} aria-label={label} onSubmit={(e) => {
      e.preventDefault();
      if (reason.trim() === '' || !capacityReady) return;
      onSubmit({
        kind, leadTime: { value: Math.max(0, Number(value) || 0), unit }, buffer: buffer.trim() === '' ? null : { value: Math.max(0, Number(buffer) || 0), unit: bufferUnit },
        reason: reason.trim(), capacity: kind === 'resource' ? capacity as Capacity : undefined,
      });
    }}>
      <div className={styles.fields}>
        <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} options={(Object.keys(EDGE_KIND) as Kind[]).map((k) => ({ value: k, label: EDGE_KIND[k] }))} />
        <TextField label="Lead time" type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} />
        <SelectField label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} options={UNITS_OF_TIME.map((u) => ({ value: u, label: u }))} />
        <TextField label="Buffer (optional)" type="number" min={0} value={buffer} onChange={(e) => setBuffer(e.target.value)} hint="Slack that absorbs a delay." />
        {buffer.trim() !== '' ? <SelectField label="Buffer unit" value={bufferUnit} onChange={(e) => setBufferUnit(e.target.value as Unit)} options={UNITS_OF_TIME.map((u) => ({ value: u, label: u }))} /> : null}
      </div>
      {kind === 'resource' ? (
        <fieldset className={styles.fieldset}>
          <legend>The capacity they share</legend>
          <div className={styles.fields}>
            <SelectField label="Capacity, on the resource" value={capacity.capacityPropertyId ?? ''} placeholder="Choose a number" onChange={(e) => setCapacity({ ...capacity, capacityPropertyId: e.target.value })} options={numeric(edge.fromObjectTypeId)} />
            <SelectField label="Demand, on each dependant" value={capacity.demandPropertyId ?? ''} placeholder="Choose a number" onChange={(e) => setCapacity({ ...capacity, demandPropertyId: e.target.value })} options={numeric(edge.toObjectTypeId)} />
            <TextField label="Consumed per unit of demand" type="number" min={0} step="any" value={capacity.consumption ?? ''} onChange={(e) => setCapacity({ ...capacity, consumption: Number(e.target.value) })} />
            <SelectField label="Per" value={capacity.period ?? 'week'} onChange={(e) => setCapacity({ ...capacity, period: e.target.value as Capacity['period'] })}
              options={[{ value: 'day', label: 'day' }, { value: 'week', label: 'week' }, { value: 'month', label: 'month' }]} />
          </div>
        </fieldset>
      ) : null}
      <TextField label="Why" required value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} hint="Kept with the graph's history." />
      {error !== undefined ? <ErrorMessage error={error} /> : null}
      <FormActions>
        <Button type="submit" variant="primary" pending={pending} blocked={blocked} disabled={reason.trim() === '' || !capacityReady}>{action}</Button>
      </FormActions>
    </form>
  );
}

function ReasonForm({ action, pending, error, onClose, onSubmit }: { action: string; pending: boolean; error: unknown; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <form className={styles.form} onSubmit={(e) => {
      e.preventDefault();
      if (reason.trim() !== '') onSubmit(reason.trim());
    }}>
      <TextField label="Why" required value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-autofocus />
      {error !== undefined ? <ErrorMessage error={error} /> : null}
      <FormActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="danger" pending={pending} disabled={reason.trim() === ''}>{action}</Button>
      </FormActions>
    </form>
  );
}

/** A person states an edge over a link type; it is a proposal until confirmed. */
function ProposeDialog({ onClose }: { onClose: () => void }) {
  const say = useToast();
  const { data: vocabulary } = useVocabulary();
  const propose = useMutation('proposeSimulationEdge', { invalidates: ['listSimulationEdges'] });
  const [linkId, setLinkId] = useState('');
  const [reversed, setReversed] = useState(false);
  const [kind, setKind] = useState<Kind>('hard');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState<Unit>('days');
  const links = (vocabulary?.linkTypes ?? []) as Vocabulary['linkTypes'];
  const link = links.find((l) => l.id === linkId);
  const typeName = (id: string) => vocabulary?.objectTypes.find((t) => t.id === id)?.displayName ?? 'a type';
  const from = link === undefined ? undefined : reversed ? link.toTypeId : link.fromTypeId;
  const to = link === undefined ? undefined : reversed ? link.fromTypeId : link.toTypeId;
  return (
    <Dialog open onClose={onClose} title="State an edge" size="md" busy={propose.pending} description="It is proposed, not walked, until someone confirms it with a kind, a lead time and a reason.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        if (from === undefined || to === undefined) return;
        const r = await propose.run({ body: { fromObjectTypeId: from, toObjectTypeId: to, viaLinkTypeId: linkId, kind, ...(value.trim() === '' ? {} : { leadTime: { value: Math.max(0, Number(value) || 0), unit } }) } });
        if (r.ok) {
          say('Proposed: confirm it to walk it');
          onClose();
        }
      }}>
        <SelectField label="Over the link" required value={linkId} placeholder="Choose a link type" onChange={(e) => setLinkId(e.target.value)}
          options={links.map((l) => ({ value: l.id, label: `${typeName(l.fromTypeId)} ${l.forwardName} ${typeName(l.toTypeId)}` }))} />
        {link !== undefined ? (
          <SelectField label="Which depends on which" value={reversed ? 'reverse' : 'forward'} onChange={(e) => setReversed(e.target.value === 'reverse')}
            options={[{ value: 'forward', label: `${typeName(link.toTypeId)} depends on ${typeName(link.fromTypeId)}` }, { value: 'reverse', label: `${typeName(link.fromTypeId)} depends on ${typeName(link.toTypeId)}` }]} />
        ) : null}
        <div className={styles.fields}>
          <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} options={(Object.keys(EDGE_KIND) as Kind[]).map((k) => ({ value: k, label: EDGE_KIND[k] }))} />
          <TextField label="Lead time (optional)" type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} />
          <SelectField label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} options={UNITS_OF_TIME.map((u) => ({ value: u, label: u }))} />
        </div>
        {propose.error !== undefined ? <ErrorMessage error={propose.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={propose.pending} blocked={propose.blocked} disabled={link === undefined}>Propose it</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
