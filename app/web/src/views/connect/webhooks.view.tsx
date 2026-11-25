'use client';

// Webhooks (spec 20.4, 42.6): what Silo sends to other systems. Events out: each governed change
// sent, as it completes, to the endpoints that subscribe to it, signed so the receiver can
// check it came from Silo; one that keeps failing is stopped and says so, and resuming it
// delivers new events while those that died stay dead. Action targets: the URLs an Action's
// webhook side effect posts to, registered on a connection, each with its own signing secret
// shown once; a target that drives equipment is declared physical. Where each change's
// webhooks were delivered is on its receipt, in Governance.

import { useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { CopyButton } from '../../components/copy.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, fieldError, FormActions, RadioGroup, SelectField, TextField } from '../../components/field.component.tsx';
import { Page, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, usePermit, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import styles from './connect.view.module.css';

type Subscription = Output<'listActionEventSubscriptions'>['subscriptions'][number];
type Filter = NonNullable<Input<'createActionEventSubscription'>['body']['filter']>;
type Endpoint = Output<'listOutboundWebhooks'>['endpoints'][number];

const RISK: Record<NonNullable<Filter['riskClasses']>[number], string> = { data: 'Data', bulk: 'Bulk', external: 'External', physical: 'Physical' };
const OUTCOME: Record<NonNullable<Filter['outcomes']>[number], string> = {
  completed: 'Completed', completed_with_divergence: 'Completed, but the system differed', partially_failed: 'Partly failed', failed: 'Failed', expired: 'Expired',
};
const ORIGIN: Record<NonNullable<Filter['origins']>[number], string> = { action: 'Actions', revert: 'Reverts' };

/** A choice of several from a short list. */
function Choices<V extends string>({ legend, options, chosen, onChange }: { legend: string; options: readonly { value: V; label: string }[]; chosen: ReadonlySet<V>; onChange: (next: Set<V>) => void }) {
  if (options.length === 0) return null;
  return (
    <fieldset className={styles.choices}>
      <legend>{legend}</legend>
      {options.map((o) => (
        <Checkbox key={o.value} label={o.label} checked={chosen.has(o.value)} onChange={() => {
          const next = new Set(chosen);
          if (next.has(o.value)) next.delete(o.value);
          else next.add(o.value);
          onChange(next);
        }} />
      ))}
    </fieldset>
  );
}

function SecretOnce({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.secret}>
      <span className={styles.secretLabel}>{label}</span>
      <code className={styles.mono}>{value}</code>
      <CopyButton value={value} label="Copy the secret" />
    </div>
  );
}

function filterText(f: Subscription['filter'], typeName: (id: string) => string, actionName: (id: string) => string): string {
  const parts = [
    f.actionTypeIds?.length ? f.actionTypeIds.map(actionName).join(', ') : '',
    f.objectTypeIds?.length ? `on ${f.objectTypeIds.map(typeName).join(', ')}` : '',
    f.riskClasses?.length ? `${f.riskClasses.map((r) => RISK[r].toLowerCase()).join(' or ')} risk` : '',
    f.outcomes?.length ? f.outcomes.map((o) => OUTCOME[o].toLowerCase()).join(' or ') : '',
    f.origins?.length === 1 ? `${ORIGIN[f.origins[0]!].toLowerCase()} only` : '',
  ].filter(Boolean);
  return parts.length === 0 ? 'Every governed change' : parts.join('; ');
}

function NewSubscriptionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: vocabulary } = useVocabulary();
  const actionsPermit = usePermit('listActionTypes');
  const actions = useQuery('listActionTypes', actionsPermit.allowed === true ? { query: { status: 'confirmed', limit: 500 } } : null, { staleMs: 5 * 60_000 });
  const create = useMutation('createActionEventSubscription', { invalidates: ['listActionEventSubscriptions'] });
  const [url, setUrl] = useState('');
  const [actionIds, setActionIds] = useState<Set<string>>(new Set());
  const [typeIds, setTypeIds] = useState<Set<string>>(new Set());
  const [risks, setRisks] = useState<Set<keyof typeof RISK>>(new Set());
  const [outcomes, setOutcomes] = useState<Set<keyof typeof OUTCOME>>(new Set());
  const [origins, setOrigins] = useState<Set<keyof typeof ORIGIN>>(new Set());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const filter: Filter = {
      ...(actionIds.size > 0 ? { actionTypeIds: [...actionIds] } : {}),
      ...(typeIds.size > 0 ? { objectTypeIds: [...typeIds] } : {}),
      ...(risks.size > 0 ? { riskClasses: [...risks] } : {}),
      ...(outcomes.size > 0 ? { outcomes: [...outcomes] } : {}),
      ...(origins.size > 0 ? { origins: [...origins] } : {}),
    };
    await create.run({ body: { endpointUrl: url.trim(), ...(Object.keys(filter).length > 0 ? { filter } : {}) } });
  };
  const done = create.data;
  const close = () => {
    create.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title="Send governed changes to an endpoint" size="lg" busy={create.pending}
      description="Each change is posted as it completes, signed with a secret only you and Silo hold. Choose nothing below to send every change.">
      {done !== undefined ? (
        <div className={styles.stack}>
          <Banner tone="ok" title="Subscribed">Give the receiver the signing secret. It is shown only now.</Banner>
          {done.secret !== null ? <SecretOnce label="Signing secret" value={done.secret} /> : <p className={styles.muted}>It signs with the endpoint's existing secret.</p>}
          <FormActions><Button variant="primary" onClick={close}>Done</Button></FormActions>
        </div>
      ) : (
        <form onSubmit={submit} className={styles.form}>
          <TextField label="Endpoint (https)" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" pattern="https://.+"
            data-autofocus error={fieldError(create.error, 'endpointUrl')} />
          <div className={styles.split}>
            <Choices legend="Risk" options={(Object.keys(RISK) as (keyof typeof RISK)[]).map((v) => ({ value: v, label: RISK[v] }))} chosen={risks} onChange={setRisks} />
            <Choices legend="Outcome" options={(Object.keys(OUTCOME) as (keyof typeof OUTCOME)[]).map((v) => ({ value: v, label: OUTCOME[v] }))} chosen={outcomes} onChange={setOutcomes} />
            <Choices legend="From" options={(Object.keys(ORIGIN) as (keyof typeof ORIGIN)[]).map((v) => ({ value: v, label: ORIGIN[v] }))} chosen={origins} onChange={setOrigins} />
          </div>
          <div className={styles.split}>
            <Choices legend="Action types" chosen={actionIds} onChange={setActionIds}
              options={(actions.data?.actionTypes ?? []).map((a) => ({ value: a.id, label: a.displayName }))} />
            <Choices legend="On object types" chosen={typeIds} onChange={setTypeIds}
              options={(vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.displayName }))} />
          </div>
          {create.error !== undefined && fieldError(create.error, 'endpointUrl') === undefined ? <ErrorMessage error={create.error} /> : null}
          <FormActions>
            <Button onClick={close} disabled={create.pending}>Cancel</Button>
            <Button type="submit" variant="primary" pending={create.pending} blocked={create.blocked} disabled={!/^https:\/\/.+/.test(url.trim())}>Subscribe</Button>
          </FormActions>
        </form>
      )}
    </Dialog>
  );
}

function EventsOut() {
  const say = useToast();
  const people = useDirectory();
  const [params, set] = useParams();
  const { lookup } = useVocabulary();
  const actionsPermit = usePermit('listActionTypes');
  const actions = useQuery('listActionTypes', actionsPermit.allowed === true ? { query: { limit: 500 } } : null, { staleMs: 5 * 60_000 });
  const list = useQuery('listActionEventSubscriptions', { query: { limit: 200 } });
  const status = useMutation('setActionEventSubscriptionStatus', { invalidates: ['listActionEventSubscriptions'] });
  const create = useBlocked('createActionEventSubscription');
  const typeName = (id: string) => lookup?.typeName(id) ?? 'a type';
  const actionName = (id: string) => actions.data?.actionTypes.find((a) => a.id === id)?.displayName ?? 'an Action type';
  const move = async (s: Subscription, to: 'active' | 'paused') => {
    const r = await status.run({ params: { subscriptionId: s.id }, body: { status: to, version: s.version } });
    if (r.ok) say(to === 'paused' ? 'Paused: changes are not sent to it' : 'Resumed: new changes are sent to it');
  };
  return (
    <Section title="Events out" description="Governed changes sent, as each completes, to the endpoints that subscribe to them."
      actions={<Button variant="primary" icon="plus" blocked={create} onClick={() => set({ new: '1' })}>Add an endpoint</Button>}>
      <QueryView query={list} what="Endpoints" isEmpty={(d) => d.subscriptions.length === 0}
        empty={<EmptyState icon="send" title="No endpoint yet">Add one to tell another system of each governed change as it completes.</EmptyState>}>
        {(d) => (
          <DataTable label="Endpoints" rows={d.subscriptions} rowKey={(s) => s.id} columns={[
            { id: 'url', header: 'Endpoint', primary: true, sortValue: (s) => s.endpointUrl, cell: (s) => <span className={styles.mono}>{s.endpointUrl}</span> },
            { id: 'filter', header: 'Sent', cell: (s) => <span className={styles.muted}>{filterText(s.filter, typeName, actionName)}</span> },
            { id: 'state', header: 'State', width: 'md', sortValue: (s) => s.status, cell: (s) => (s.status === 'active' ? <Badge tone="ok">Active</Badge>
              : s.status === 'paused' ? <Badge tone="warn">Paused</Badge> : <Badge tone="danger" title="Stopped after repeated failures">Stopped: kept failing</Badge>) },
            { id: 'since', header: 'Since', width: 'sm', sortValue: (s) => s.statusChangedAt, cell: (s) => <Time value={s.statusChangedAt} /> },
            { id: 'by', header: 'Added by', width: 'md', cell: (s) => people.nameOf(s.createdBy) },
            { id: 'act', header: <span className="visually-hidden">Change</span>, width: 'sm', align: 'end', cell: (s) => (s.status === 'active'
              ? <Button size="sm" variant="ghost" blocked={status.blocked} onClick={() => void move(s, 'paused')}>Pause</Button>
              : <Button size="sm" variant="ghost" blocked={status.blocked} onClick={() => void move(s, 'active')}>Resume</Button>) },
          ]} />
        )}
      </QueryView>
      {status.error !== undefined ? <ErrorMessage error={status.error} /> : null}
      {params.get('new') !== null ? <NewSubscriptionDialog open onClose={() => set({ new: undefined })} /> : null}
    </Section>
  );
}

function RegisterTargetDialog({ connectionId, connectionName, open, onClose }: { connectionId: string; connectionName: string; open: boolean; onClose: () => void }) {
  const register = useMutation('registerOutboundWebhook', { invalidates: ['listOutboundWebhooks'] });
  const [target, setTarget] = useState('');
  const [statusUrl, setStatusUrl] = useState('');
  const [risk, setRisk] = useState<'external' | 'physical'>('external');
  const [actionName, setActionName] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await register.run({
      params: { connectionId },
      body: { targetUrl: target.trim(), riskClass: risk, ...(statusUrl.trim() !== '' ? { statusUrl: statusUrl.trim() } : {}), ...(actionName.trim() !== '' ? { actionName: actionName.trim() } : {}) },
    });
  };
  const done = register.data;
  const close = () => {
    register.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title={`A webhook target on ${connectionName}`} size="md" busy={register.pending}
      description="An Action with a webhook side effect posts here, signed with this target's own secret.">
      {done !== undefined ? (
        <div className={styles.stack}>
          <Banner tone="ok" title="Registered">Give the receiver its signing secret. It is shown only now.</Banner>
          <SecretOnce label="Signing secret" value={done.secret} />
          <FormActions><Button variant="primary" onClick={close}>Done</Button></FormActions>
        </div>
      ) : (
        <form onSubmit={submit} className={styles.form}>
          <TextField label="Target address" type="url" required value={target} onChange={(e) => setTarget(e.target.value)} data-autofocus
            hint="Posted from the Silo Agent when the connection runs through one, so it may be a private address." error={fieldError(register.error, 'targetUrl')} />
          <TextField label="Status address (optional)" type="url" value={statusUrl} onChange={(e) => setStatusUrl(e.target.value)}
            hint="Where Silo reads whether a delivery took effect, not only that it arrived." error={fieldError(register.error, 'statusUrl')} />
          <RadioGroup name="risk" label="What it does" value={risk} onChange={setRisk} options={[
            { value: 'external', label: 'Changes another system', hint: 'Actions that post here are at least external risk.' },
            { value: 'physical', label: 'Drives equipment', hint: 'Actions that post here are physical: they need a writable point and an allow-list entry.' },
          ]} />
          <TextField label={risk === 'physical' ? 'Webhook action name' : 'Webhook action name (optional)'} required={risk === 'physical'} value={actionName}
            onChange={(e) => setActionName(e.target.value)} hint="What writable points and allow-list entries address it by." error={fieldError(register.error, 'actionName')} />
          {register.error !== undefined && ['targetUrl', 'statusUrl', 'actionName'].every((f) => fieldError(register.error, f) === undefined) ? <ErrorMessage error={register.error} /> : null}
          <FormActions>
            <Button onClick={close} disabled={register.pending}>Cancel</Button>
            <Button type="submit" variant="primary" pending={register.pending} blocked={register.blocked}
              disabled={target.trim() === '' || (risk === 'physical' && actionName.trim() === '')}>Register</Button>
          </FormActions>
        </form>
      )}
    </Dialog>
  );
}

function ActionTargets() {
  const say = useToast();
  const [params, set] = useParams();
  const connectionsPermit = usePermit('listConnections');
  const connections = useQuery('listConnections', connectionsPermit.allowed === false ? null : { query: { limit: 500 } });
  const live = (connections.data?.connections ?? []).filter((c) => c.status !== 'revoked');
  const connectionId = params.get('target-connection') ?? live[0]?.id;
  const chosen = live.find((c) => c.id === connectionId);
  const endpoints = useQuery('listOutboundWebhooks', chosen === undefined ? null : { params: { connectionId: chosen.id } });
  const revoke = useMutation('revokeOutboundWebhook', { invalidates: ['listOutboundWebhooks'] });
  const registerBlocked = useBlocked('registerOutboundWebhook');
  const [registering, setRegistering] = useState(false);
  const [revoking, setRevoking] = useState<Endpoint | undefined>(undefined);
  return (
    <Section title="Action targets" description="Addresses an Action's webhook side effect posts to, registered on the connection for the system that receives them.">
      {connectionsPermit.blocked !== undefined ? <p className={styles.muted}>{connectionsPermit.blocked.message}</p> : (
        <>
          <Toolbar end={chosen !== undefined ? <Button icon="plus" blocked={registerBlocked} onClick={() => setRegistering(true)}>Register a target</Button> : undefined}>
            <SelectField label="Connection" value={connectionId ?? ''} onChange={(e) => set({ 'target-connection': e.target.value })}
              {...(live.length === 0 ? { placeholder: 'No connection yet' } : {})} options={live.map((c) => ({ value: c.id, label: c.name }))} />
          </Toolbar>
          {chosen === undefined ? null : (
            <QueryView query={endpoints} what="Its targets" isEmpty={(d) => d.endpoints.length === 0}
              empty={<EmptyState icon="send" title="No targets on this connection">Register one for an Action to post to.</EmptyState>}>
              {(d) => (
                <DataTable label={`Webhook targets on ${chosen.name}`} rows={d.endpoints} rowKey={(e) => e.id} columns={[
                  { id: 'url', header: 'Target', primary: true, cell: (e) => <span className={styles.stackTight}><span className={styles.mono}>{e.targetUrl}</span>{e.actionName !== null ? <span className={styles.muted}>{e.actionName}</span> : null}</span> },
                  { id: 'risk', header: 'Risk', width: 'sm', cell: (e) => (e.riskClass === 'physical' ? <Badge tone="danger">Physical</Badge> : <Badge tone="warn">External</Badge>) },
                  { id: 'from', header: 'Sent from', width: 'sm', cell: (e) => (e.sentFrom === 'agent' ? 'Silo Agent' : 'Silo') },
                  { id: 'effect', header: 'Effect read', width: 'sm', cell: (e) => (e.statusUrl === null ? 'Delivery only' : 'From its status') },
                  { id: 'state', header: 'State', width: 'sm', cell: (e) => (e.status === 'active' ? <Badge tone="ok">Active</Badge> : e.status === 'paused' ? <Badge tone="warn">Paused</Badge> : <Badge>Revoked</Badge>) },
                  { id: 'last', header: 'Last delivery', width: 'sm', cell: (e) => (e.lastDeliveryAt === null ? '—' : <Time value={e.lastDeliveryAt} />) },
                  { id: 'revoke', header: <span className="visually-hidden">Revoke</span>, width: 'sm', align: 'end', cell: (e) => (e.status === 'revoked' ? null
                    : <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => setRevoking(e)}>Revoke</Button>) },
                ]} />
              )}
            </QueryView>
          )}
        </>
      )}
      {registering && chosen !== undefined ? <RegisterTargetDialog connectionId={chosen.id} connectionName={chosen.name} open onClose={() => setRegistering(false)} /> : null}
      <ConfirmDialog open={revoking !== undefined} onClose={() => setRevoking(undefined)} title="Revoke this target?" confirmLabel="Revoke" tone="danger"
        onConfirm={async () => {
          const r = await revoke.run({ params: { endpointId: revoking!.id } });
          if (r.ok) say('Target revoked: its secret is destroyed');
          return r;
        }}>
        <p>Its secret is destroyed and nothing posts to it again. Action types whose side effect posts here can no longer run until they name another target.</p>
      </ConfirmDialog>
    </Section>
  );
}

export function Webhooks() {
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: 'Webhooks' });
  const tabs: readonly TabDef<'events' | 'targets'>[] = [{ id: 'events', label: 'Events out' }, { id: 'targets', label: 'Action targets' }];
  const [tab, setTab] = useTab(tabs);
  return (
    <Page title="Webhooks" description="What Silo sends to other systems: governed changes as they complete, and the posts Actions make."
      crumbs={[{ label: 'Connect' }]}>
      <Tabs label="Webhooks" tabs={tabs} current={tab} onChange={setTab} />
      <TabPanel id={tab}>{tab === 'events' ? <EventsOut /> : <ActionTargets />}</TabPanel>
    </Page>
  );
}
