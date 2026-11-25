'use client';

// Security (spec 57, 58, 61, 62): markings (classifications ranked, compartments, purposes) and
// the clearances that let people and principals see what they mark, with markings applied to
// types, properties, links, connections and Siloes; declassifiers (who may remove a marking,
// approved by another); field policies that deny, mask or redact a field for a role, a marking or a
// scope; purposes people declare before using purpose-marked data, approved, suspended or retired,
// and who is eligible to declare each; and when Silo staff may ask for access.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, type Tone } from '../../components/badge.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { plural } from '../../utils/format.util.ts';
import { StaffAccessPolicy } from '../governance/staff.view.tsx';
import { idFrom } from '../studio/kit.view.tsx';
import styles from './settings.view.module.css';

type Marking = Output<'listMarkings'>['markings'][number];
type ResourceType = 'object_type' | 'property' | 'link_type' | 'action_type' | 'connection' | 'silo';
const crumbs = [{ label: 'Settings', href: '/settings/' }];
const KIND: Record<Marking['kind'], string> = { classification: 'Classification', compartment: 'Compartment', purpose: 'Purpose' };
const MTABS: TabDef<'markings' | 'clearances' | 'applied'>[] = [{ id: 'markings', label: 'Markings' }, { id: 'clearances', label: 'Clearances' }, { id: 'applied', label: 'Where they apply' }];

/** /settings/markings/: markings, clearances, and where markings apply. */
export function Markings() {
  const [tab, setTab] = useTab(MTABS);
  return (
    <Page title="Markings and clearances" description="Marked data is seen only by those cleared for every marking on it." crumbs={crumbs} width="full">
      <div className={styles.stack}>
        <Tabs label="Markings" tabs={MTABS} current={tab} onChange={setTab} />
        <TabPanel id={tab}>{tab === 'markings' ? <MarkingList /> : tab === 'clearances' ? <Clearances /> : <Applied />}</TabPanel>
      </div>
    </Page>
  );
}

function MarkingList() {
  const say = useToast();
  const markings = useQuery('listMarkings', {});
  const create = useMutation('createMarking', { invalidates: ['listMarkings'] });
  const retire = useMutation('retireMarking', { invalidates: ['listMarkings'] });
  const [making, setMaking] = useState(false);
  const [retiring, setRetiring] = useState<Marking | undefined>();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Marking['kind']>('classification');
  const [rank, setRank] = useState('1');
  const [description, setDescription] = useState('');
  return (
    <Section title="Markings" actions={<Button icon="plus" blocked={create.blocked} onClick={() => setMaking(true)}>New marking</Button>}>
      <QueryView query={markings} what="Markings" isEmpty={(d) => d.markings.length === 0} empty={<EmptyState icon="shield" title="No markings">Mark what only some may see.</EmptyState>}>
        {(d) => (
          <DataTable label="Markings" rows={d.markings} rowKey={(m) => m.id} columns={[
            { id: 'name', header: 'Marking', primary: true, cell: (m) => <span className={styles.row}>{m.name}{m.retiredAt !== null ? <Badge>Retired</Badge> : null}</span> },
            { id: 'kind', header: 'Kind', width: 'sm', cell: (m) => `${KIND[m.kind]}${m.rank !== null ? `, rank ${m.rank}` : ''}` },
            { id: 'what', header: 'Meaning', cell: (m) => m.description || '—' },
            { id: 'act', header: <span className="visually-hidden">Retire</span>, align: 'end', cell: (m) => (m.retiredAt === null ? <Button size="sm" variant="ghost" blocked={retire.blocked} onClick={() => setRetiring(m)}>Retire</Button> : null) },
          ]} />
        )}
      </QueryView>
      <Dialog open={making} onClose={() => setMaking(false)} title="New marking" size="sm" busy={create.pending}>
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.run({ body: { name: name.trim(), kind, description: description.trim(), ...(kind === 'classification' ? { rank: Number(rank) || 1 } : {}) } });
          if (r.ok) {
            setMaking(false);
            setName('');
            say('Marking made');
          }
        }}>
          <TextField label="Name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as Marking['kind'])}
            options={[{ value: 'classification', label: 'Classification: ranked, a higher rank clears a lower' }, { value: 'compartment', label: 'Compartment: held one by one' }, { value: 'purpose', label: 'Purpose: used once a purpose is declared' }]} />
          {kind === 'classification' ? <TextField label="Rank" type="number" min={1} value={rank} onChange={(e) => setRank(e.target.value)} /> : null}
          <TextArea label="What it means" rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
          {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
          <FormActions><Button onClick={() => setMaking(false)}>Cancel</Button><Button type="submit" variant="primary" pending={create.pending} disabled={name.trim() === ''}>Make it</Button></FormActions>
        </form>
      </Dialog>
      <ConfirmDialog open={retiring !== undefined} onClose={() => setRetiring(undefined)} title={`Retire ${retiring?.name ?? 'the marking'}?`} confirmLabel="Retire" tone="danger"
        onConfirm={() => retire.run({ params: { markingId: retiring!.id } }).then((r) => {
          if (r.ok) say('Retired');
          return r;
        })}><p>It can no longer be applied. Where it is applied already, it still applies until declassified.</p></ConfirmDialog>
    </Section>
  );
}

function Clearances() {
  const say = useToast();
  const people = useDirectory();
  const clearances = useQuery('listClearances', {});
  const markings = useQuery('listMarkings', {});
  const principals = useQuery('listServicePrincipals', {});
  const grant = useMutation('grantClearance', { invalidates: ['listClearances'] });
  const revoke = useMutation('revokeClearance', { invalidates: ['listClearances'] });
  const [markingId, setMarkingId] = useState('');
  const [holder, setHolder] = useState('');
  const [expires, setExpires] = useState('');
  const markingName = (id: string) => markings.data?.markings.find((m) => m.id === id)?.name ?? 'a marking';
  const principalName = (id: string) => principals.data?.servicePrincipals.find((p) => p.id === id)?.name ?? 'a principal';
  return (
    <Section title="Clearances">
      <form className={styles.rowEnd} aria-label="Grant a clearance" onSubmit={async (e) => {
        e.preventDefault();
        const [kind, id] = holder.split(':') as ['membership' | 'service_principal', string];
        const r = await grant.run({ body: { markingId, holder: { kind, id }, ...(expires === '' ? {} : { expiresAt: new Date(expires).toISOString() }) } });
        if (r.ok) {
          setHolder('');
          say('Cleared');
        }
      }}>
        <SelectField label="Clear" required value={holder} placeholder="Choose who" onChange={(e) => setHolder(e.target.value)} options={[
          ...people.members.filter((m) => m.status === 'active').map((m) => ({ value: `membership:${m.membershipId}`, label: m.displayName })),
          ...(principals.data?.servicePrincipals ?? []).filter((p) => p.revokedAt === null).map((p) => ({ value: `service_principal:${p.id}`, label: `${p.name} (a principal)` })),
        ]} />
        <SelectField label="For" required value={markingId} placeholder="Choose a marking" onChange={(e) => setMarkingId(e.target.value)} options={(markings.data?.markings ?? []).filter((m) => m.retiredAt === null).map((m) => ({ value: m.id, label: m.name }))} />
        <TextField label="Until (optional)" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        <Button type="submit" pending={grant.pending} blocked={grant.blocked} disabled={holder === '' || markingId === ''}>Grant</Button>
      </form>
      {grant.error !== undefined ? <ErrorMessage error={grant.error} /> : null}
      <QueryView query={clearances} what="Clearances" isEmpty={(d) => d.clearances.filter((c) => c.revokedAt === null).length === 0} empty={<p className={styles.muted}>No one is cleared yet.</p>}>
        {(d) => (
          <DataTable label="Clearances" rows={d.clearances.filter((c) => c.revokedAt === null)} rowKey={(c) => c.id} columns={[
            { id: 'who', header: 'Cleared', primary: true, cell: (c) => (c.membershipId !== null ? people.nameOf(c.membershipId) : principalName(c.servicePrincipalId ?? '')) },
            { id: 'marking', header: 'For', cell: (c) => markingName(c.markingId) },
            { id: 'by', header: 'By', cell: (c) => people.nameOf(c.grantedBy) },
            { id: 'until', header: 'Until', width: 'sm', cell: (c) => (c.expiresAt === null ? '—' : <Time value={c.expiresAt} />) },
            { id: 'act', header: <span className="visually-hidden">Revoke</span>, align: 'end', cell: (c) => <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => void revoke.run({ params: { clearanceId: c.id } }).then((r) => r.ok && say('Revoked'))}>Revoke</Button> },
          ]} />
        )}
      </QueryView>
    </Section>
  );
}

/** Where markings apply: a resource's markings read and one applied. */
function Applied() {
  const say = useToast();
  const { data: vocabulary } = useVocabulary();
  const markings = useQuery('listMarkings', {});
  const connections = useQuery('listConnections', { query: {} });
  const siloes = useQuery('listSiloes', { query: {} });
  const actions = useQuery('listActionTypes', { query: {} });
  const apply = useMutation('applyMarking', { invalidates: ['listResourceMarkings'] });
  const [type, setType] = useState<ResourceType>('object_type');
  const [id, setId] = useState('');
  const [markingId, setMarkingId] = useState('');
  const current = useQuery('listResourceMarkings', id === '' ? null : { query: { type, id } });
  const options = type === 'object_type' ? (vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.displayName }))
    : type === 'property' ? (vocabulary?.objectTypes ?? []).flatMap((t) => t.properties.map((p) => ({ value: p.identityId, label: `${t.displayName}: ${p.displayName}` })))
      : type === 'link_type' ? (vocabulary?.linkTypes ?? []).map((l) => ({ value: l.id, label: l.forwardName }))
        : type === 'action_type' ? (actions.data?.actionTypes ?? []).map((a) => ({ value: a.id, label: a.displayName }))
          : type === 'connection' ? (connections.data?.connections ?? []).map((c) => ({ value: c.id, label: c.name }))
            : (siloes.data?.siloes ?? []).map((s) => ({ value: s.id, label: s.name }));
  const markingName = (mid: string) => markings.data?.markings.find((m) => m.id === mid)?.name ?? 'a marking';
  return (
    <Section title="Where they apply" description="A marking on a type marks every object of it; on a property, that field; on a connection or a Silo, everything it holds. A marking is removed only by a declassifier.">
      <div className={styles.stack}>
        <div className={styles.fields}>
          <SelectField label="On" value={type} onChange={(e) => {
            setType(e.target.value as ResourceType);
            setId('');
          }} options={[{ value: 'object_type', label: 'A type' }, { value: 'property', label: 'A property' }, { value: 'link_type', label: 'A link' }, { value: 'action_type', label: 'An Action' }, { value: 'connection', label: 'A connection' }, { value: 'silo', label: 'A Silo' }]} />
          <SelectField label="Which" value={id} placeholder="Choose one" onChange={(e) => setId(e.target.value)} options={options} />
        </div>
        {id !== '' ? (
          <QueryView query={current} what="Its markings">
            {(c) => (
              <div className={styles.stackTight}>
                <p className={styles.row}>{c.markingIds.length === 0 ? <span className={styles.muted}>Not marked.</span> : c.markingIds.map((m) => <Badge key={m} tone="warn">{markingName(m)}</Badge>)}</p>
                <form className={styles.rowEnd} aria-label="Apply a marking" onSubmit={async (e) => {
                  e.preventDefault();
                  const r = await apply.run({ body: { markingId, resource: { type, id } } });
                  if (r.ok) say(r.data.applied ? 'Marked' : 'It was marked already');
                }}>
                  <SelectField label="Apply" value={markingId} placeholder="Choose a marking" onChange={(e) => setMarkingId(e.target.value)}
                    options={(markings.data?.markings ?? []).filter((m) => m.retiredAt === null && !c.markingIds.includes(m.id)).map((m) => ({ value: m.id, label: m.name }))} />
                  <Button type="submit" pending={apply.pending} blocked={apply.blocked} disabled={markingId === ''}>Apply</Button>
                </form>
                {apply.error !== undefined ? <ErrorMessage error={apply.error} /> : null}
              </div>
            )}
          </QueryView>
        ) : null}
      </div>
    </Section>
  );
}

const DECL_STATUS: Record<'active' | 'awaiting_approval' | 'expired' | 'revoked', { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'ok' }, awaiting_approval: { label: 'Waiting for approval', tone: 'warn' }, expired: { label: 'Expired', tone: 'neutral' }, revoked: { label: 'Revoked', tone: 'neutral' },
};

/** /settings/declassifiers/: who may remove a marking, each approved by someone else. */
export function Declassifiers() {
  const say = useToast();
  const people = useDirectory();
  const list = useQuery('listDeclassifiers', {});
  const markings = useQuery('listMarkings', {});
  const grant = useMutation('grantDeclassifier', { invalidates: ['listDeclassifiers'] });
  const approve = useMutation('approveDeclassifier', { invalidates: ['listDeclassifiers'] });
  const revoke = useMutation('revokeDeclassifier', { invalidates: ['listDeclassifiers'] });
  const [making, setMaking] = useState(false);
  const [markingId, setMarkingId] = useState('');
  const [grantee, setGrantee] = useState('');
  const [why, setWhy] = useState('');
  const markingName = (id: string) => markings.data?.markings.find((m) => m.id === id)?.name ?? 'a marking';
  const error = approve.error ?? revoke.error;
  return (
    <Page title="Declassifiers" description="Who may remove a marking from data. A grant waits for someone other than its grantor to approve it." crumbs={crumbs} width="full"
      actions={<Button variant="primary" icon="plus" blocked={grant.blocked} onClick={() => setMaking(true)}>New declassifier</Button>}>
      <div className={styles.stack}>
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <QueryView query={list} what="Declassifiers" isEmpty={(d) => d.declassifiers.length === 0} empty={<EmptyState icon="key" title="No declassifiers">No one may remove a marking yet.</EmptyState>}>
          {(d) => (
            <DataTable label="Declassifiers" rows={d.declassifiers} rowKey={(x) => x.id} columns={[
              { id: 'who', header: 'Who', primary: true, cell: (x) => (x.grantee.kind === 'membership' ? people.nameOf(x.grantee.id) : `Everyone in ${people.scopeName(x.grantee.id)}`) },
              { id: 'marking', header: 'May remove', cell: (x) => markingName(x.markingId) },
              { id: 'why', header: 'Why', cell: (x) => x.justification },
              { id: 'state', header: 'State', width: 'md', cell: (x) => <Badge tone={DECL_STATUS[x.status].tone}>{DECL_STATUS[x.status].label}</Badge> },
              { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (x) => (
                <span className={styles.row}>
                  {x.status === 'awaiting_approval' ? <Button size="sm" blocked={approve.blocked} onClick={() => void approve.run({ params: { declassifierId: x.id } }).then((r) => r.ok && say('Approved'))}>Approve</Button> : null}
                  {x.status === 'active' || x.status === 'awaiting_approval' ? <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => void revoke.run({ params: { declassifierId: x.id } }).then((r) => r.ok && say('Revoked'))}>Revoke</Button> : null}
                </span>
              ) },
            ]} />
          )}
        </QueryView>
      </div>
      <Dialog open={making} onClose={() => setMaking(false)} title="New declassifier" size="sm" busy={grant.pending}>
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const [kind, id] = grantee.split(':') as ['membership' | 'scope', string];
          const r = await grant.run({ body: { markingId, grantee: { kind, id }, justification: why.trim() } });
          if (r.ok) {
            setMaking(false);
            say('Granted: it waits for someone else to approve it');
          }
        }}>
          <SelectField label="Who" required value={grantee} placeholder="Choose a person or team" onChange={(e) => setGrantee(e.target.value)} options={[
            ...people.members.filter((m) => m.status === 'active').map((m) => ({ value: `membership:${m.membershipId}`, label: m.displayName })),
            ...people.scopes.map((s) => ({ value: `scope:${s.id}`, label: `Everyone in ${s.name}` })),
          ]} />
          <SelectField label="May remove" required value={markingId} placeholder="Choose a marking" onChange={(e) => setMarkingId(e.target.value)} options={(markings.data?.markings ?? []).filter((m) => m.retiredAt === null).map((m) => ({ value: m.id, label: m.name }))} />
          <TextArea label="Why" required rows={2} maxLength={1000} value={why} onChange={(e) => setWhy(e.target.value)} />
          {grant.error !== undefined ? <ErrorMessage error={grant.error} /> : null}
          <FormActions><Button onClick={() => setMaking(false)}>Cancel</Button><Button type="submit" variant="primary" pending={grant.pending} disabled={grantee === '' || markingId === '' || why.trim() === ''}>Grant</Button></FormActions>
        </form>
      </Dialog>
    </Page>
  );
}

/** /settings/field-policies/: rules that deny, mask or redact a field for a role, a marking or a scope. */
export function FieldPolicies() {
  const say = useToast();
  const { lookup, data: vocabulary } = useVocabulary();
  const list = useQuery('listFieldPolicies', {});
  const roles = useQuery('listRoles', {});
  const markings = useQuery('listMarkings', {});
  const scopes = useQuery('listScopes', { query: {} });
  const connections = useQuery('listConnections', { query: {} });
  const create = useMutation('createFieldPolicy', { invalidates: ['listFieldPolicies'] });
  const retire = useMutation('retireFieldPolicy', { invalidates: ['listFieldPolicies'] });
  const [making, setMaking] = useState(false);
  const [target, setTarget] = useState<'property' | 'field'>('property');
  const [propertyId, setPropertyId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [fieldPath, setFieldPath] = useState('');
  const [effect, setEffect] = useState<'deny' | 'mask' | 'redact'>('mask');
  const [roleId, setRoleId] = useState('');
  const [markingId, setMarkingId] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [descendants, setDescendants] = useState(true);
  const who = (p: Output<'listFieldPolicies'>['fieldPolicies'][number]) => [
    p.appliesToRoleId !== null ? `holders of ${roles.data?.roles.find((r) => r.id === p.appliesToRoleId)?.name ?? 'a role'}` : undefined,
    p.appliesToMarkingId !== null ? `those not cleared for ${markings.data?.markings.find((m) => m.id === p.appliesToMarkingId)?.name ?? 'a marking'}` : undefined,
    p.appliesToScopeId !== null ? `people in ${scopes.data?.scopes.find((s) => s.id === p.appliesToScopeId)?.name ?? 'a scope'}${p.includeDescendants ? ' and beneath' : ''}` : undefined,
  ].filter(Boolean).join(', ') || 'everyone';
  return (
    <Page title="Field policies" description="Hide (deny), mask or redact a field for some people, whatever else they may see." crumbs={crumbs} width="full"
      actions={<Button variant="primary" icon="plus" blocked={create.blocked} onClick={() => setMaking(true)}>New policy</Button>}>
      <QueryView query={list} what="Field policies" isEmpty={(d) => d.fieldPolicies.filter((p) => p.retiredAt === null).length === 0} empty={<EmptyState icon="eye" title="No field policies">Every field is shown to whoever may see its object.</EmptyState>}>
        {(d) => (
          <DataTable label="Field policies" rows={d.fieldPolicies.filter((p) => p.retiredAt === null)} rowKey={(p) => p.id} columns={[
            { id: 'field', header: 'Field', primary: true, cell: (p) => (p.propertyId !== null ? lookup?.propertyName(p.propertyId) ?? '…' : <span className={styles.mono}>{p.fieldPath}</span>) },
            { id: 'effect', header: 'Is', width: 'sm', cell: (p) => <Badge tone={p.effect === 'deny' ? 'danger' : 'warn'}>{p.effect === 'deny' ? 'Hidden' : p.effect === 'mask' ? 'Masked' : 'Redacted'}</Badge> },
            { id: 'who', header: 'For', cell: (p) => who(p) },
            { id: 'act', header: <span className="visually-hidden">Retire</span>, align: 'end', cell: (p) => <Button size="sm" variant="ghost" blocked={retire.blocked} onClick={() => void retire.run({ params: { fieldPolicyId: p.id } }).then((r) => r.ok && say('Retired'))}>Retire</Button> },
          ]} />
        )}
      </QueryView>
      {retire.error !== undefined ? <ErrorMessage error={retire.error} /> : null}
      <Dialog open={making} onClose={() => setMaking(false)} title="New field policy" size="md" busy={create.pending}>
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.run({ body: {
            target: target === 'property' ? { propertyId } : { connectionId, fieldPath: fieldPath.trim() }, effect,
            appliesTo: { ...(roleId === '' ? {} : { roleId }), ...(markingId === '' ? {} : { markingId }), ...(scopeId === '' ? {} : { scopeId }), includeDescendants: descendants },
          } });
          if (r.ok) {
            setMaking(false);
            say('Policy made: it applies at once');
          }
        }}>
          <SelectField label="On" value={target} onChange={(e) => setTarget(e.target.value as typeof target)} options={[{ value: 'property', label: 'A property' }, { value: 'field', label: 'A field of a connection' }]} />
          {target === 'property' ? (
            <SelectField label="Property" required value={propertyId} placeholder="Choose a property" onChange={(e) => setPropertyId(e.target.value)}
              options={(vocabulary?.objectTypes ?? []).flatMap((t) => t.properties.map((p) => ({ value: p.identityId, label: `${t.displayName}: ${p.displayName}` })))} />
          ) : (
            <div className={styles.fields}>
              <SelectField label="Connection" required value={connectionId} placeholder="Choose a connection" onChange={(e) => setConnectionId(e.target.value)} options={(connections.data?.connections ?? []).map((c) => ({ value: c.id, label: c.name }))} />
              <TextField label="Field" required className={styles.mono} value={fieldPath} onChange={(e) => setFieldPath(e.target.value)} hint="As the connection names it, such as customer.email." />
            </div>
          )}
          <SelectField label="It is" value={effect} onChange={(e) => setEffect(e.target.value as typeof effect)}
            options={[{ value: 'mask', label: 'Masked: its shape shown, not its value' }, { value: 'redact', label: 'Redacted: shown as withheld' }, { value: 'deny', label: 'Hidden: not mentioned at all' }]} />
          <div className={styles.fields}>
            <SelectField label="For holders of" value={roleId} placeholder="Any role" onChange={(e) => setRoleId(e.target.value)} options={(roles.data?.roles ?? []).filter((r) => r.retiredAt === null).map((r) => ({ value: r.id, label: r.name }))} />
            <SelectField label="Unless cleared for" value={markingId} placeholder="No marking" onChange={(e) => setMarkingId(e.target.value)} options={(markings.data?.markings ?? []).filter((m) => m.retiredAt === null).map((m) => ({ value: m.id, label: m.name }))} />
            <SelectField label="For people in" value={scopeId} placeholder="Any scope" onChange={(e) => setScopeId(e.target.value)} options={(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))} />
          </div>
          {scopeId !== '' ? <Checkbox label="And the scopes beneath it" checked={descendants} onChange={(e) => setDescendants(e.target.checked)} /> : null}
          {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
          <FormActions><Button onClick={() => setMaking(false)}>Cancel</Button><Button type="submit" variant="primary" pending={create.pending} disabled={target === 'property' ? propertyId === '' : connectionId === '' || fieldPath.trim() === ''}>Make it</Button></FormActions>
        </form>
      </Dialog>
    </Page>
  );
}

type Purpose = Output<'listPurposeDefinitions'>['purposeDefinitions'][number];
const PURPOSE_STATUS: Record<Purpose['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' }, approved: { label: 'Approved', tone: 'ok' }, suspended: { label: 'Suspended', tone: 'warn' }, retired: { label: 'Retired', tone: 'neutral' },
};
const USE: Record<Purpose['use'], string> = { analysis: 'Analysis', export: 'Export', external_sharing: 'Sharing outside', write_back: 'Changing records', ai_or_simulation: 'AI or simulation' };

/** /settings/purposes/: purposes people declare before using purpose-marked data, and who may declare each. */
export function PurposeDefinitions() {
  const say = useToast();
  const [params, set] = useParams();
  const list = useQuery('listPurposeDefinitions', {});
  const markings = useQuery('listMarkings', {});
  const create = useMutation('createPurposeDefinition', { invalidates: ['listPurposeDefinitions'] });
  const [making, setMaking] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', markingId: '', lawfulBasis: '', minutes: '60', justification: true, approval: false, use: 'analysis' as Purpose['use'] });
  const open = idFrom(params.get('purpose'));
  return (
    <Page title="Purposes" description="Data marked for a purpose is used only once a person declares it, for as long as the purpose allows." crumbs={crumbs} width="full"
      actions={<Button variant="primary" icon="plus" blocked={create.blocked} onClick={() => setMaking(true)}>New purpose</Button>}>
      <QueryView query={list} what="Purposes" isEmpty={(d) => d.purposeDefinitions.length === 0} empty={<EmptyState icon="document" title="No purposes">Define the purposes people may declare.</EmptyState>}>
        {(d) => (
          <DataTable label="Purposes" rows={d.purposeDefinitions} rowKey={(p) => p.id} rowHref={(p) => `/settings/purposes/?purpose=${p.id}`} columns={[
            { id: 'name', header: 'Purpose', primary: true, cell: (p) => p.name },
            { id: 'use', header: 'For', width: 'md', cell: (p) => USE[p.use] },
            { id: 'marking', header: 'Opens', cell: (p) => markings.data?.markings.find((m) => m.id === p.markingId)?.name ?? 'a marking' },
            { id: 'state', header: 'State', width: 'sm', cell: (p) => <Badge tone={PURPOSE_STATUS[p.status].tone}>{PURPOSE_STATUS[p.status].label}</Badge> },
            { id: 'review', header: 'Review by', width: 'sm', cell: (p) => (p.reviewDueAt === null ? '—' : <Time value={p.reviewDueAt} />) },
          ]} />
        )}
      </QueryView>
      {open !== undefined ? <PurposeDrawer purpose={list.data?.purposeDefinitions.find((p) => p.id === open)} onClose={() => set({ purpose: undefined })} /> : null}
      <Dialog open={making} onClose={() => setMaking(false)} title="New purpose" size="md" busy={create.pending}>
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.run({ body: {
            name: form.name.trim(), description: form.description.trim(), markingId: form.markingId, maxSessionMinutes: Math.max(1, Number(form.minutes) || 60),
            requiresJustification: form.justification, requiresApproval: form.approval, use: form.use, ...(form.lawfulBasis.trim() === '' ? {} : { lawfulBasis: form.lawfulBasis.trim() }),
          } });
          if (r.ok) {
            setMaking(false);
            say('A draft: someone else approves it');
          }
        }}>
          <TextField label="Name" required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <TextArea label="What it is for" required rows={2} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div className={styles.fields}>
            <SelectField label="It opens" required value={form.markingId} placeholder="Choose a purpose marking" onChange={(e) => setForm({ ...form, markingId: e.target.value })}
              options={(markings.data?.markings ?? []).filter((m) => m.kind === 'purpose' && m.retiredAt === null).map((m) => ({ value: m.id, label: m.name }))} />
            <SelectField label="For" value={form.use} onChange={(e) => setForm({ ...form, use: e.target.value as Purpose['use'] })} options={(Object.keys(USE) as Purpose['use'][]).map((u) => ({ value: u, label: USE[u] }))} />
            <TextField label="For at most (minutes)" type="number" min={1} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} />
          </div>
          <TextField label="Lawful basis (optional)" maxLength={500} value={form.lawfulBasis} onChange={(e) => setForm({ ...form, lawfulBasis: e.target.value })} />
          <Checkbox label="A person says why when they declare it" checked={form.justification} onChange={(e) => setForm({ ...form, justification: e.target.checked })} />
          <Checkbox label="Each declaration is approved first" checked={form.approval} onChange={(e) => setForm({ ...form, approval: e.target.checked })} />
          {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
          <FormActions><Button onClick={() => setMaking(false)}>Cancel</Button><Button type="submit" variant="primary" pending={create.pending} disabled={form.name.trim() === '' || form.description.trim() === '' || form.markingId === ''}>Make the draft</Button></FormActions>
        </form>
      </Dialog>
    </Page>
  );
}

function PurposeDrawer({ purpose, onClose }: { purpose: Purpose | undefined; onClose: () => void }) {
  const say = useToast();
  const people = useDirectory();
  const roles = useQuery('listRoles', {});
  const approve = useMutation('approvePurposeDefinition', { invalidates: ['listPurposeDefinitions'] });
  const status = useMutation('setPurposeDefinitionStatus', { invalidates: ['listPurposeDefinitions'] });
  const eligibility = useQuery('listPurposeEligibility', purpose === undefined ? null : { params: { purposeDefinitionId: purpose.id } });
  const grant = useMutation('grantPurposeEligibility', { invalidates: ['listPurposeEligibility'] });
  const revoke = useMutation('revokePurposeEligibility', { invalidates: ['listPurposeEligibility'] });
  const [grantee, setGrantee] = useState('');
  const [review, setReview] = useState('');
  if (purpose === undefined) return null;
  const roleName = (id: string) => roles.data?.roles.find((r) => r.id === id)?.name ?? 'a role';
  const error = approve.error ?? status.error ?? revoke.error;
  return (
    <Dialog open onClose={onClose} drawer title={purpose.name} description={<Badge tone={PURPOSE_STATUS[purpose.status].tone}>{PURPOSE_STATUS[purpose.status].label}</Badge>}>
      <div className={styles.stack}>
        <p>{purpose.description}</p>
        <p className={styles.muted}>{USE[purpose.use]}; for at most {plural(purpose.maxSessionMinutes, 'minute')}{purpose.requiresJustification ? '; a reason is given' : ''}{purpose.requiresApproval ? '; each declaration approved' : ''}{purpose.lawfulBasis !== null ? `; lawful basis: ${purpose.lawfulBasis}` : ''}.</p>
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        {purpose.status === 'draft' || purpose.status === 'suspended' ? (
          <form className={styles.rowEnd} onSubmit={async (e) => {
            e.preventDefault();
            const r = await approve.run({ params: { purposeDefinitionId: purpose.id }, body: { version: purpose.version, ...(review === '' ? {} : { reviewDueAt: new Date(review).toISOString() }) } });
            if (r.ok) say('Approved: it may be declared');
          }}>
            <TextField label="Review by (optional)" type="date" value={review} onChange={(e) => setReview(e.target.value)} />
            <Button type="submit" variant="primary" pending={approve.pending} blocked={approve.blocked}>Approve</Button>
          </form>
        ) : null}
        {purpose.status === 'approved' ? (
          <div className={styles.row}>
            <Button blocked={status.blocked} onClick={() => void status.run({ params: { purposeDefinitionId: purpose.id }, body: { version: purpose.version, status: 'suspended' } }).then((r) => r.ok && say('Suspended: its open sessions ended'))}>Suspend</Button>
            <Button variant="ghost" blocked={status.blocked} onClick={() => void status.run({ params: { purposeDefinitionId: purpose.id }, body: { version: purpose.version, status: 'retired' } }).then((r) => r.ok && say('Retired: its open sessions ended'))}>Retire</Button>
          </div>
        ) : null}
        <Section title="Who may declare it">
          <QueryView query={eligibility} what="Who may declare it" isEmpty={(d) => d.eligibility.filter((x) => x.revokedAt === null).length === 0} empty={<p className={styles.muted}>No one yet.</p>}>
            {(d) => (
              <DataTable label="Eligible" rows={d.eligibility.filter((x) => x.revokedAt === null)} rowKey={(x) => x.id} columns={[
                { id: 'who', header: 'Who', primary: true, cell: (x) => (x.granteeMembershipId !== null ? people.nameOf(x.granteeMembershipId) : x.granteeRoleId !== null ? `Holders of ${roleName(x.granteeRoleId)}`
                  : x.granteeScopeId !== null ? `Everyone in ${people.scopeName(x.granteeScopeId)}` : 'A service principal') },
                { id: 'until', header: 'Until', width: 'sm', cell: (x) => (x.expiresAt === null ? '—' : <Time value={x.expiresAt} />) },
                { id: 'act', header: <span className="visually-hidden">Revoke</span>, align: 'end', cell: (x) => <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => void revoke.run({ params: { eligibilityId: x.id } }).then((r) => r.ok && say('Revoked: their open sessions of it ended'))}>Revoke</Button> },
              ]} />
            )}
          </QueryView>
          <form className={styles.rowEnd} aria-label="Make someone eligible" onSubmit={async (e) => {
            e.preventDefault();
            const [kind, id] = grantee.split(':') as ['membership' | 'role' | 'scope', string];
            const r = await grant.run({ body: { purposeDefinitionId: purpose.id, grantee: { kind, id } } });
            if (r.ok) {
              setGrantee('');
              say('Eligible');
            }
          }}>
            <SelectField label="Make eligible" value={grantee} placeholder="Choose who" onChange={(e) => setGrantee(e.target.value)} options={[
              ...people.members.filter((m) => m.status === 'active').map((m) => ({ value: `membership:${m.membershipId}`, label: m.displayName })),
              ...(roles.data?.roles ?? []).filter((r) => r.retiredAt === null).map((r) => ({ value: `role:${r.id}`, label: `Holders of ${r.name}` })),
              ...people.scopes.map((s) => ({ value: `scope:${s.id}`, label: `Everyone in ${s.name}` })),
            ]} />
            <Button type="submit" pending={grant.pending} blocked={grant.blocked} disabled={grantee === ''}>Make eligible</Button>
          </form>
          {grant.error !== undefined ? <ErrorMessage error={grant.error} /> : null}
        </Section>
      </div>
    </Dialog>
  );
}

/** /settings/staff-access/: when Silo staff may ask for access, and who approves. */
export function StaffAccessSettings() {
  return (
    <Page title="Silo staff access" description="When someone at Silo asks to see or act in your organisation, for support or an incident. Every request and what was done under it is in Governance." crumbs={crumbs} width="narrow">
      <StaffAccessPolicy />
    </Page>
  );
}

