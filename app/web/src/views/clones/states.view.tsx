'use client';

// State rules and staleness (spec 28.4, 28.5): how a clone's state is derived. A rule belongs to
// one type and maps its declared inputs to normal, warning or failed through ordered conditions
// (CEL over self.<property> and now); the first true one wins, none true is normal; a condition
// over a value that is empty or not visible is unknown, never false; a stale input makes the
// state stale. A rule is proposed, then confirmed by a person, which replaces the type's active
// rule. Staleness thresholds say, per connection and type, how old a value may be before it is
// stale; tightened freely, loosened past the connector's cadence only knowingly.

import { useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary, type ObjectType } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatDuration } from '../../utils/format.util.ts';
import styles from './clones.view.module.css';

type Rule = Output<'listStateRules'>['rules'][number];
type Line = Rule['rules'][number];

const STATE_TONE: Record<Line['state'], 'ok' | 'warn' | 'danger'> = { normal: 'ok', warning: 'warn', failed: 'danger' };

function ProposeDialog({ type, current, open, onClose }: { type: ObjectType; current: Rule | undefined; open: boolean; onClose: () => void }) {
  const say = useToast();
  const propose = useMutation('proposeStateRule', { invalidates: ['listStateRules'] });
  const [inputs, setInputs] = useState<Set<string>>(new Set(current?.inputs.map((i) => i.propertyIdentityId) ?? []));
  const [lines, setLines] = useState<Line[]>(current?.rules ?? [{ state: 'failed', when: '', reason: '' }, { state: 'warning', when: '', reason: '' }]);
  const [freshness, setFreshness] = useState(String(Math.round((current?.freshnessWindowSeconds ?? 900) / 60)));
  const names = type.properties.filter((p) => inputs.has(p.identityId)).map((p) => `self.${p.apiName}`);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await propose.run({ body: { objectTypeId: type.id, inputPropertyIds: [...inputs], rules: lines.filter((l) => l.when.trim() !== ''), freshnessWindowSeconds: Number(freshness) * 60 } });
    if (r.ok) {
      say('Proposed: someone who may manage state rules confirms it');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`A state rule for ${type.pluralName}`} size="lg" busy={propose.pending}
      description="Conditions are tried in order; the first true one sets the state; none true is normal. A condition over an empty or hidden value is unknown, never false.">
      <form className={styles.form} onSubmit={submit}>
        <fieldset className={styles.choices}>
          <legend>Properties it reads</legend>
          {type.properties.map((p) => (
            <Checkbox key={p.identityId} label={`${p.displayName} (self.${p.apiName})`} checked={inputs.has(p.identityId)} onChange={() => {
              const next = new Set(inputs);
              if (next.has(p.identityId)) next.delete(p.identityId);
              else next.add(p.identityId);
              setInputs(next);
            }} />
          ))}
        </fieldset>
        <Section title="Conditions" description={names.length > 0 ? `It may read ${names.join(', ')} and now.` : 'Choose the properties it reads first.'}>
          <div className={styles.stack}>
            {lines.map((l, i) => (
              <Panel key={i}>
                <div className={styles.split}>
                  <SelectField label={`${i + 1}. State`} value={l.state} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, state: e.target.value as Line['state'] } : x)))}
                    options={[{ value: 'failed', label: 'Failed' }, { value: 'warning', label: 'Warning' }, { value: 'normal', label: 'Normal' }]} />
                  <TextField label="When (CEL)" value={l.when} spellCheck={false} placeholder="self.temperature > 90.0" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, when: e.target.value } : x)))} />
                  <TextField label="Why, as people read it" value={l.reason} placeholder="Running hot" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} />
                </div>
                <div className={styles.row}>
                  <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => setLines(lines.map((x, j) => (j === i - 1 ? lines[i]! : j === i ? lines[i - 1]! : x)))}>Move up</Button>
                  <Button size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              </Panel>
            ))}
            <Button size="sm" icon="plus" onClick={() => setLines([...lines, { state: 'warning', when: '', reason: '' }])}>Add a condition</Button>
          </div>
        </Section>
        <TextField label="A value older than this is stale (minutes)" type="number" min={1} value={freshness} onChange={(e) => setFreshness(e.target.value)} />
        {propose.error !== undefined ? <ErrorMessage error={propose.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={propose.pending} blocked={propose.blocked}
          disabled={inputs.size === 0 || lines.every((l) => l.when.trim() === '') || lines.some((l) => l.when.trim() !== '' && l.reason.trim() === '')}>Propose</Button></FormActions>
      </form>
    </Dialog>
  );
}

function Rules({ type, propose: proposeAtOnce = false }: { type: ObjectType; propose?: boolean }) {
  const say = useToast();
  const people = useDirectory();
  const list = useQuery('listStateRules', { query: { objectTypeId: type.id } });
  const active = useQuery('getActiveStateRules', { body: { objectTypeIds: [type.id] } });
  const confirm = useMutation('confirmStateRule', { invalidates: ['listStateRules', 'getActiveStateRules'] });
  const retire = useMutation('retireStateRule', { invalidates: ['listStateRules', 'getActiveStateRules'] });
  const blocked = useBlocked('proposeStateRule');
  const [proposing, setProposing] = useState(proposeAtOnce);
  const [retiring, setRetiring] = useState<Rule | undefined>(undefined);
  const current = active.data?.rules[0];
  return (
    <div className={styles.stack}>
      <Section title="In force" actions={<Button icon="plus" blocked={blocked} onClick={() => setProposing(true)}>{current === undefined ? 'Propose a rule' : 'Propose a new version'}</Button>}>
        {current === undefined ? <EmptyState icon="success" title="No rule in force">Its clones show unknown until a rule is confirmed.</EmptyState> : (
          <Panel>
            <div className={styles.stack}>
              <Properties columns={3} items={[
                ['Version', String(current.version)], ['Stale after', formatDuration(current.freshnessWindowSeconds * 1000)],
                ['Confirmed', current.confirmedAt === null ? '—' : <span key="c">{people.nameOf(current.confirmedBy)}, <Time value={current.confirmedAt} /></span>],
              ]} />
              <ol className={styles.plainList}>{current.rules.map((l, i) => <li key={i}><Badge tone={STATE_TONE[l.state]}>{l.state}</Badge> when <span className={styles.mono}>{l.when}</span>: {l.reason}</li>)}</ol>
              <p className={styles.muted}>Reads {current.inputs.map((x) => x.apiName).join(', ')}. Otherwise normal.</p>
            </div>
          </Panel>
        )}
      </Section>
      <Section title="Every version">
        <QueryView query={list} what="State rules" isEmpty={(d) => d.rules.length === 0} empty={<p className={styles.muted}>None yet.</p>}>
          {(d) => (
            <DataTable label="State rules" rows={d.rules} rowKey={(r) => r.id} columns={[
              { id: 'v', header: 'Version', primary: true, sortValue: (r) => r.version, cell: (r) => String(r.version) },
              { id: 'status', header: 'State', width: 'sm', cell: (r) => <Badge tone={r.status === 'active' ? 'ok' : r.status === 'proposed' ? 'info' : 'neutral'}>{r.status}</Badge> },
              { id: 'what', header: 'Conditions', cell: (r) => <span className={styles.muted}>{r.rules.map((l) => `${l.state} when ${l.when}`).join('; ')}</span> },
              { id: 'by', header: 'Proposed by', width: 'md', cell: (r) => (r.proposedBy.kind === 'membership' ? people.nameOf(r.proposedBy.membershipId) : 'The AI FDE') },
              { id: 'act', header: <span className="visually-hidden">Act</span>, width: 'md', align: 'end', cell: (r) => (r.status === 'proposed' ? (
                <Button size="sm" variant="primary" pending={confirm.pending} blocked={confirm.blocked}
                  onClick={async () => {
                    const out = await confirm.run({ params: { ruleId: r.id }, body: { lockVersion: r.lockVersion } });
                    if (out.ok) say(`Version ${r.version} is in force`);
                  }}>Confirm</Button>
              ) : r.status === 'active' ? <Button size="sm" variant="ghost" blocked={retire.blocked} onClick={() => setRetiring(r)}>Retire</Button> : null) },
            ]} />
          )}
        </QueryView>
        {confirm.error ?? retire.error ? <ErrorMessage error={confirm.error ?? retire.error} /> : null}
      </Section>
      {proposing ? <ProposeDialog type={type} current={current} open onClose={() => setProposing(false)} /> : null}
      <ConfirmDialog open={retiring !== undefined} onClose={() => setRetiring(undefined)} title="Retire the rule in force?" confirmLabel="Retire" tone="danger"
        onConfirm={async () => {
          const r = await retire.run({ params: { ruleId: retiring!.id }, body: { lockVersion: retiring!.lockVersion } });
          if (r.ok) say('Retired: its clones show unknown until another is confirmed');
          return r;
        }}><p>Its clones show unknown until another rule is confirmed. Crons and apps that use their state are told.</p></ConfirmDialog>
    </div>
  );
}

function Staleness() {
  const say = useToast();
  const people = useDirectory();
  const { lookup } = useVocabulary();
  const connections = useQuery('listConnections', { query: { limit: 500 } });
  const [params, set] = useParams();
  const live = (connections.data?.connections ?? []).filter((c) => c.status !== 'revoked');
  const connectionId = params.get('connection') ?? live[0]?.id;
  const list = useQuery('listStalenessThresholds', connectionId === undefined ? null : { query: { connectionId } });
  const setThreshold = useMutation('setStalenessThreshold', { invalidates: ['listStalenessThresholds'] });
  const [minutes, setMinutes] = useState('');
  const [typeId, setTypeId] = useState('');
  return (
    <Section title="When a value is stale" description="Per connection, and per type it feeds: how old a value may be before its clone shows stale. Looser than the connector's cadence is allowed, and marked.">
      <Toolbar><SelectField label="Connection" value={connectionId ?? ''} onChange={(e) => set({ connection: e.target.value })} options={live.map((c) => ({ value: c.id, label: c.name }))} /></Toolbar>
      <QueryView query={list} what="Thresholds" isEmpty={(d) => d.thresholds.length === 0} empty={<p className={styles.muted}>The defaults apply.</p>}>
        {(d) => (
          <DataTable label="Staleness thresholds" rows={d.thresholds} rowKey={(t) => t.id} columns={[
            { id: 'type', header: 'For', primary: true, cell: (t) => (t.objectTypeId === null ? 'Everything it feeds' : lookup?.typeName(t.objectTypeId, true) ?? 'a type') },
            { id: 'after', header: 'Stale after', width: 'md', cell: (t) => <span className={styles.row}>{formatDuration(t.thresholdSeconds * 1000)}{t.loosened ? <Badge tone="warn">Looser than its cadence</Badge> : null}</span> },
            { id: 'cadence', header: 'Its cadence', width: 'md', cell: (t) => formatDuration(t.manifestCadenceSeconds * 1000) },
            { id: 'by', header: 'Set', width: 'md', cell: (t) => <span>{people.nameOf(t.setBy)}, <Time value={t.setAt} /></span> },
          ]} />
        )}
      </QueryView>
      {connectionId !== undefined ? (
        <Panel>
          <form className={styles.next} onSubmit={async (event) => {
            event.preventDefault();
            const r = await setThreshold.run({ params: { connectionId }, body: { thresholdSeconds: Number(minutes) * 60, ...(typeId !== '' ? { objectTypeId: typeId } : {}) } });
            if (r.ok) {
              setMinutes('');
              say(r.data.loosened ? 'Set: looser than the connector\'s cadence, and marked so' : 'Set');
            }
          }}>
            <SelectField label="For" value={typeId} onChange={(e) => setTypeId(e.target.value)} placeholder="Everything it feeds" options={(lookup === undefined ? [] : [...lookup.types.values()]).map((t) => ({ value: t.id, label: t.pluralName }))} />
            <TextField label="Stale after (minutes)" type="number" min={1} required value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            <Button type="submit" pending={setThreshold.pending} blocked={setThreshold.blocked} disabled={minutes === ''}>Set</Button>
          </form>
          {setThreshold.error !== undefined ? <ErrorMessage error={setThreshold.error} /> : null}
        </Panel>
      ) : null}
    </Section>
  );
}

export function StateRules() {
  const { data: vocabulary } = useVocabulary();
  const [params, set] = useParams();
  usePageContext({ scope: { kind: 'page', page: 'clones' }, scopeLabel: 'State rules' });
  const types = vocabulary?.objectTypes ?? [];
  const type = types.find((t) => t.id === params.get('type')) ?? types[0];
  const tabs: readonly TabDef<'rules' | 'staleness'>[] = [{ id: 'rules', label: 'Rules' }, { id: 'staleness', label: 'Staleness' }];
  const [tab, setTab] = useTab(tabs);
  return (
    <Page title="State rules" description="How each clone's state is decided from its live values: normal, warning or failed; unknown and stale where it cannot tell." crumbs={[{ label: 'Clones' }]}>
      <Tabs label="State rules" tabs={tabs} current={tab} onChange={setTab} />
      <TabPanel id={tab}>
        {tab === 'rules' ? (
          type === undefined ? <EmptyState icon="object" title="No object type yet" /> : (
            <>
              <Toolbar><SelectField label="Object type" value={type.id} onChange={(e) => set({ type: e.target.value })} options={types.map((t) => ({ value: t.id, label: t.pluralName }))} /></Toolbar>
              <Rules key={type.id} type={type} propose={params.get('new') !== null} />
            </>
          )
        ) : <Staleness />}
      </TabPanel>
    </Page>
  );
}
