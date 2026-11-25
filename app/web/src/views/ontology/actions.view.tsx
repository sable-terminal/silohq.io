'use client';

// Action types (spec 42): the changes people may propose on objects, each a governed write with
// its parameters, rules, risk class, how it is reverted, the connections it writes through and
// its side effects. A type is proposed, then a version is published (confirmed by someone who
// may), rejected or retired; nothing runs that is not confirmed. The organisation's write
// settings sit beside them: the canary sample, generic edits and dry runs for physical Actions.

import { useMemo, useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, fieldError, FormActions, SelectField, Switch, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, usePermits, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { apiNameOf } from './words.view.ts';
import styles from './ontology.view.module.css';

type ActionType = Output<'getActionType'>;
type Status = ActionType['status'];
type Publish = Input<'publishActionTypeVersion'>['body'];
type Parameter = NonNullable<Publish['parameters']>[number];

const STATUS: Record<Status, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  proposed: { label: 'Proposed', tone: 'info' }, confirmed: { label: 'Confirmed', tone: 'ok' }, blocked: { label: 'Blocked', tone: 'warn' },
  rejected: { label: 'Rejected', tone: 'danger' }, retired: { label: 'Retired', tone: 'neutral' },
};
const RISK: Record<'data' | 'external' | 'physical', string> = { data: 'Data: changes records', external: 'External: tells another system', physical: 'Physical: drives equipment' };
const REVERT: Record<'three_way' | 'compensating' | 'state_only' | 'not_revertible', string> = {
  three_way: 'Undone by putting back what it changed, if nothing changed since', compensating: 'Undone by another Action', state_only: 'Only Silo\'s record is undone', not_revertible: 'Cannot be undone',
};
const PARAM_TYPES: readonly Parameter['type'][] = ['string', 'integer', 'decimal', 'boolean', 'date', 'timestamp', 'enumeration', 'object_reference', 'object_set_reference', 'attachment_reference'];

function ruleText(r: NonNullable<ActionType['current']>['rules'][number]): string {
  const value = (v: { parameter: string } | { cel: string }) => ('parameter' in v ? `the ${v.parameter} given` : v.cel);
  switch (r.kind) {
    case 'set_property': return `Set ${r.property} to ${value(r.value)}`;
    case 'clear_property': return `Clear ${r.property}`;
    case 'create_object': return `Create an object with ${Object.keys(r.values).join(', ')}`;
    case 'delete_object': return 'Delete the object';
    case 'add_link': return `Link it by ${r.linkType} to the ${r.object.parameter} given`;
    case 'remove_link': return `Remove its ${r.linkType} link`;
    case 'invoke_custom': return `Call ${r.customAction}`;
  }
}

function ProposeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const say = useToast();
  const [, set] = useParams();
  const scopes = useQuery('listMyPermittedScopes', { query: { permission: 'action_type.propose' } });
  const propose = useMutation('proposeActionType', { invalidates: ['listActionTypes'] });
  const [name, setName] = useState('');
  const [scopeId, setScopeId] = useState('');
  const scope = scopeId || (scopes.data?.scopes.length === 1 ? scopes.data.scopes[0]!.id : '');
  return (
    <Dialog open={open} onClose={onClose} title="Propose an Action type" size="sm" busy={propose.pending}
      description="Name it first; its first version says what it does, and someone who may confirms it.">
      <form className={styles.form} onSubmit={async (event) => {
        event.preventDefault();
        const r = await propose.run({ body: { apiName: apiNameOf(name), displayName: name.trim(), owningScopeId: scope } });
        if (r.ok) {
          say('Proposed: write its first version');
          set({ new: undefined, action: r.data.id, publish: '1' });
        }
      }}>
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Escalate a ticket" data-autofocus error={fieldError(propose.error, 'displayName')} />
        <SelectField label="Owned by" required value={scope} onChange={(e) => setScopeId(e.target.value)} placeholder="Choose a scope" options={(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        {propose.error !== undefined && fieldError(propose.error, 'displayName') === undefined ? <ErrorMessage error={propose.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={propose.pending} blocked={propose.blocked} disabled={name.trim() === '' || scope === ''}>Propose</Button></FormActions>
      </form>
    </Dialog>
  );
}

function PublishDialog({ action, open, onClose }: { action: ActionType; open: boolean; onClose: () => void }) {
  const say = useToast();
  const { data: vocabulary } = useVocabulary();
  const connections = useQuery('listConnections', { query: { limit: 500 } });
  const publish = useMutation('publishActionTypeVersion', { invalidates: ['listActionTypes', 'getActionType'] });
  const c = action.current;
  const [typeId, setTypeId] = useState(c?.objectTypeId ?? '');
  const [params, setParams] = useState<Parameter[]>(() => (c?.parameters ?? []) as Parameter[]);
  const [rules, setRules] = useState(() => JSON.stringify(c?.rules ?? [{ kind: 'set_property', property: 'status', value: { parameter: 'status' } }], null, 2));
  const [risk, setRisk] = useState<'data' | 'external' | 'physical'>(c?.riskClass ?? 'data');
  const [revert, setRevert] = useState<'three_way' | 'compensating' | 'state_only' | 'not_revertible'>(c?.revertBehaviour ?? 'three_way');
  const [criteria, setCriteria] = useState(c?.submissionCriteria ?? '');
  const [permitted, setPermitted] = useState<Set<string>>(new Set(c?.permittedConnections ?? []));
  const [description, setDescription] = useState(c?.description ?? '');
  let parsedRules: unknown;
  let rulesProblem: string | undefined;
  try {
    parsedRules = JSON.parse(rules);
    if (!Array.isArray(parsedRules)) rulesProblem = 'Write a list of rules: [ { "kind": … } ]';
  } catch (e) {
    rulesProblem = (e as Error).message;
  }
  const type = vocabulary?.objectTypes.find((t) => t.id === typeId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (rulesProblem !== undefined || vocabulary === undefined) return;
    const r = await publish.run({ params: { actionTypeId: action.id }, body: {
      ontologyVersionId: vocabulary.ontologyVersionId, objectTypeId: typeId, parameters: params, rules: parsedRules as never, permittedConnections: [...permitted],
      riskClass: risk, revertBehaviour: revert, ...(criteria.trim() !== '' ? { submissionCriteria: criteria.trim() } : {}), ...(description.trim() !== '' ? { description: description.trim() } : {}),
    } });
    if (r.ok) {
      say(`Version ${r.data.current?.version ?? ''} confirmed`);
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`A new version of ${action.displayName}`} size="xl" busy={publish.pending}
      description="What it changes, what a person gives it, where it writes and how it is undone. Publishing confirms it: you need to be allowed to confirm Action types.">
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.split}>
          <SelectField label="On objects of" required value={typeId} onChange={(e) => setTypeId(e.target.value)} placeholder="Choose a type"
            options={(vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.displayName }))} />
          <SelectField label="Risk" value={risk} onChange={(e) => setRisk(e.target.value as typeof risk)} options={(Object.keys(RISK) as (keyof typeof RISK)[]).map((k) => ({ value: k, label: RISK[k] }))} />
          <SelectField label="Undone" value={revert} onChange={(e) => setRevert(e.target.value as typeof revert)} options={(Object.keys(REVERT) as (keyof typeof REVERT)[]).map((k) => ({ value: k, label: REVERT[k] }))} />
        </div>
        <TextArea label="What it is for" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <Section title="What a person gives it">
          <div className={styles.stack}>
            {params.map((p, i) => (
              <div key={i} className={styles.split}>
                <TextField label="Parameter" value={p.name} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <SelectField label="Type" value={p.type} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, type: e.target.value as Parameter['type'] } : x)))} options={PARAM_TYPES.map((t) => ({ value: t, label: t.replaceAll('_', ' ') }))} />
                {p.type === 'enumeration' ? <TextField label="Values" value={(p.enumValues ?? []).join(', ')} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, enumValues: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) } : x)))} /> : null}
                {p.type === 'object_reference' || p.type === 'object_set_reference' ? (
                  <SelectField label="Of type" value={p.objectTypeId ?? ''} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, objectTypeId: e.target.value } : x)))} placeholder="Choose a type"
                    options={(vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.displayName }))} />
                ) : null}
                <Checkbox label="Required" checked={p.required ?? false} onChange={() => setParams(params.map((x, j) => (j === i ? { ...x, required: !(x.required ?? false) } : x)))} />
                <Button size="sm" variant="ghost" onClick={() => setParams(params.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            <Button size="sm" icon="plus" onClick={() => setParams([...params, { name: '', type: 'string', required: true }])}>Add a parameter</Button>
          </div>
        </Section>
        <TextArea label="Rules (JSON)" required rows={8} spellCheck={false} className={styles.code} value={rules} onChange={(e) => setRules(e.target.value)} error={rulesProblem}
          hint={`Each a change to the object: set_property, clear_property, create_object, delete_object, add_link, remove_link or invoke_custom.${type !== undefined ? ` ${type.displayName} has ${type.properties.map((p) => p.apiName).slice(0, 12).join(', ')}.` : ''}`} />
        <TextField label="Submission criteria (CEL, optional)" value={criteria} onChange={(e) => setCriteria(e.target.value)} spellCheck={false} hint="When it may be proposed at all, over the object and its parameters." />
        <fieldset className={styles.choices}>
          <legend>Connections it writes through</legend>
          {(connections.data?.connections ?? []).filter((x) => x.status !== 'revoked').map((x) => (
            <Checkbox key={x.id} label={x.name} hint={x.writesEnabled ? 'Writes enabled' : 'Read only: enable writes on the connection first'} checked={permitted.has(x.id)} onChange={() => {
              const next = new Set(permitted);
              if (next.has(x.id)) next.delete(x.id);
              else next.add(x.id);
              setPermitted(next);
            }} />
          ))}
        </fieldset>
        {publish.error !== undefined ? <ErrorMessage error={publish.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={publish.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={publish.pending} blocked={publish.blocked} disabled={typeId === '' || rulesProblem !== undefined || params.some((p) => p.name.trim() === '')}>Publish this version</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function ActionDetail({ actionId, onClose }: { actionId: string; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const { lookup } = useVocabulary();
  const [params, set] = useParams();
  const read = useQuery('getActionType', { params: { actionTypeId: actionId } });
  const reject = useMutation('rejectActionType', { invalidates: ['listActionTypes'] });
  const retire = useMutation('retireActionType', { invalidates: ['listActionTypes'] });
  const [rejecting, setRejecting] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const a = read.data;
  if (a === undefined) return <Dialog open onClose={onClose} drawer title="Action type">{read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the Action type" />}</Dialog>;
  const c = a.current;
  return (
    <Dialog open onClose={onClose} drawer title={a.displayName} description={<span className={styles.row}><Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge><span className={styles.mono}>{a.apiName}</span></span>}>
      <div className={styles.stack}>
        {a.isSystem ? <Banner tone="info">A system Action type: Silo maintains it.</Banner> : null}
        <div className={styles.row}>
          {a.status !== 'retired' && !a.isSystem ? <Button variant="primary" onClick={() => set({ publish: '1' })}>{c === null ? 'Write its first version' : 'Publish a new version'}</Button> : null}
          {a.status === 'proposed' ? <Button variant="ghost" blocked={reject.blocked} onClick={() => setRejecting(true)}>Reject</Button> : null}
          {a.status === 'confirmed' && !a.isSystem ? <Button variant="ghost" blocked={retire.blocked} onClick={() => setRetiring(true)}>Retire</Button> : null}
        </div>
        {c === null ? <p className={styles.muted}>No version yet: it does nothing until one is published.</p> : (
          <>
            <Properties columns={1} items={[
              ['On', lookup?.typeName(c.objectTypeId, true) ?? 'objects'],
              ['Version', `${c.version}, confirmed by ${people.nameOf(c.confirmedBy)}, ${new Date(c.confirmedAt).toLocaleDateString('en-GB')}`],
              ['Risk', RISK[c.riskClass]],
              ['Undone', REVERT[c.revertBehaviour]],
              ['Writes through', plural(c.permittedConnections.length, 'connection')],
              c.submissionCriteria !== null ? ['Only when', <span key="s" className={styles.mono}>{c.submissionCriteria}</span>] : null,
              ['Side effects', c.sideEffects.length === 0 ? 'None' : c.sideEffects.map((s) => (s.kind === 'notification' ? `tells ${(s.recipients ?? []).join(', ')}` : 'calls a webhook')).join('; ')],
            ]} />
            {c.description !== null ? <p>{c.description}</p> : null}
            <Section title="What a person gives it">
              {c.parameters.length === 0 ? <p className={styles.muted}>Nothing.</p> : (
                <DataTable label="Parameters" rows={c.parameters} rowKey={(p) => p.name} dense columns={[
                  { id: 'name', header: 'Parameter', primary: true, cell: (p) => p.name },
                  { id: 'type', header: 'Type', width: 'md', cell: (p) => `${p.type.replaceAll('_', ' ')}${p.enumValues !== undefined ? `: ${p.enumValues.join(', ')}` : ''}` },
                  { id: 'req', header: 'Required', width: 'sm', cell: (p) => (p.required ? 'Yes' : 'No') },
                ]} />
              )}
            </Section>
            <Section title="What it does"><ol className={styles.plainList}>{c.rules.map((r, i) => <li key={i}>{ruleText(r)}</li>)}</ol></Section>
          </>
        )}
        <p className={styles.muted}>Created <Time value={a.createdAt} />.</p>
      </div>
      {params.get('publish') !== null ? <PublishDialog action={a} open onClose={() => set({ publish: undefined })} /> : null}
      <ConfirmDialog open={rejecting} onClose={() => setRejecting(false)} title={`Reject ${a.displayName}?`} confirmLabel="Reject" tone="danger"
        onConfirm={async () => {
          const r = await reject.run({ params: { actionTypeId: a.id }, body: { version: a.version, reason: 'not_needed' } });
          if (r.ok) say('Rejected');
          return r;
        }}><p>It is closed and never runs.</p></ConfirmDialog>
      <ConfirmDialog open={retiring} onClose={() => setRetiring(false)} title={`Retire ${a.displayName}?`} confirmLabel="Retire" tone="danger"
        onConfirm={async () => {
          const r = await retire.run({ params: { actionTypeId: a.id }, body: { version: a.version } });
          if (r.ok) say('Retired: it can no longer be proposed');
          return r;
        }}><p>It can no longer be proposed. Changes already made keep their receipts and can still be reverted as they could before.</p></ConfirmDialog>
    </Dialog>
  );
}

function Settings() {
  const say = useToast();
  const read = useQuery('getActionSettings', {});
  const canary = useMutation('setCanarySample', { invalidates: ['getActionSettings'] });
  const generic = useMutation('setGenericEdit', { invalidates: ['getActionSettings'] });
  const dryRun = useMutation('setPhysicalDryRun', { invalidates: ['getActionSettings'] });
  const [rows, setRows] = useState<string | undefined>(undefined);
  return (
    <Section title="How writes behave here" description="For every Action type in the organisation.">
      <QueryView query={read} what="Write settings">
        {(s) => (
          <Panel>
            <div className={styles.stack}>
              <form className={styles.next} onSubmit={async (event) => {
                event.preventDefault();
                const value = (rows ?? String(s.canarySampleRows)).trim();
                const r = await canary.run({ body: { sampleRows: value === '' ? null : Number(value) } });
                if (r.ok) say('Canary sample saved');
              }}>
                <TextField label="Canary sample (rows)" type="number" min={1} max={9999} value={rows ?? String(s.canarySampleRows)} onChange={(e) => setRows(e.target.value)}
                  hint={`A change over ${s.canaryThresholdRows} rows is first applied to this many, checked, then confirmed by a person before the rest. Empty for the default.`} />
                <Button type="submit" pending={canary.pending} blocked={canary.blocked}>Save</Button>
              </form>
              <Switch label="Generic edits" checked={s.genericEdit.enabled} blocked={generic.blocked?.message}
                hint="Lets people with write access change a property directly, as a governed Action with its own receipt."
                onChange={async (enabled) => {
                  const r = await generic.run({ body: { enabled } });
                  if (r.ok) say(enabled ? 'Generic edits on' : 'Generic edits off');
                }} />
              <Switch label="Dry runs for physical Actions" checked={s.physicalDryRunRequired} blocked={dryRun.blocked?.message}
                hint="Every physical Action is first run against its simulator node before it may touch equipment."
                onChange={async (required) => {
                  const r = await dryRun.run({ body: { required } });
                  if (r.ok) say(required ? 'Dry runs required' : 'Dry runs no longer required');
                }} />
              {canary.error ?? generic.error ?? dryRun.error ? <ErrorMessage error={canary.error ?? generic.error ?? dryRun.error} /> : null}
            </div>
          </Panel>
        )}
      </QueryView>
    </Section>
  );
}

export function ActionTypes() {
  const permits = usePermits();
  const { lookup } = useVocabulary();
  const [params, set] = useParams();
  const status = params.get('status') ?? '';
  const list = useQuery('listActionTypes', { query: { limit: 500, ...(status !== '' ? { status: status as Status } : {}) } });
  const blocked = useBlocked('proposeActionType');
  usePageContext({ scope: { kind: 'page', page: 'ontology' }, scopeLabel: 'Action types' });
  const actionId = params.get('action');
  const rows = useMemo(() => list.data?.actionTypes ?? [], [list.data]);
  return (
    <Page title="Action types" description="The changes people may propose on objects: each governed, with its parameters, rules, risk and how it is undone."
      crumbs={[{ label: 'Ontology' }]} actions={<Button variant="primary" icon="plus" blocked={blocked} onClick={() => set({ new: '1' })}>Propose an Action type</Button>}>
      <Toolbar>
        <SelectField label="State" hideLabel value={status} onChange={(e) => set({ status: e.target.value })} placeholder="Every state"
          options={(Object.keys(STATUS) as Status[]).map((s) => ({ value: s, label: STATUS[s].label }))} />
      </Toolbar>
      <QueryView query={list} what="Action types" isEmpty={() => rows.length === 0}
        empty={<EmptyState icon="play" title="No Action type yet" action={<Button variant="primary" blocked={blocked} onClick={() => set({ new: '1' })}>Propose one</Button>}>The AI FDE proposes them too.</EmptyState>}>
        {() => (
          <DataTable label="Action types" rows={rows} rowKey={(a) => a.id} rowHref={(a) => hrefWith('/ontology/actions/', { action: a.id, status: status || undefined })} columns={[
            { id: 'name', header: 'Action type', primary: true, sortValue: (a) => a.displayName, cell: (a) => a.displayName },
            { id: 'on', header: 'On', width: 'md', cell: (a) => (a.current === null ? '—' : lookup?.typeName(a.current.objectTypeId, true) ?? '') },
            { id: 'risk', header: 'Risk', width: 'sm', cell: (a) => (a.current === null ? '—' : a.current.riskClass) },
            { id: 'state', header: 'State', width: 'md', cell: (a) => <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge> },
            { id: 'version', header: 'Version', width: 'xs', align: 'end', cell: (a) => (a.current === null ? '—' : String(a.current.version)) },
          ]} />
        )}
      </QueryView>
      {permits('getActionSettings') === undefined ? <Settings /> : null}
      {params.get('new') !== null ? <ProposeDialog open onClose={() => set({ new: undefined })} /> : null}
      {actionId !== null ? <ActionDetail key={actionId} actionId={actionId} onClose={() => set({ action: undefined, publish: undefined })} /> : null}
    </Page>
  );
}
