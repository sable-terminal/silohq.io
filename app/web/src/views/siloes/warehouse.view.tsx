'use client';

// The Warehouse (spec 69.10 to 69.16): a BigQuery copy of the types an organisation nominates,
// kept in step with their systems, for analysis in the tools people already use. Made with only a
// purpose, a retention and what to copy; set up step by step (a failed step resumed); synced;
// opened to named Google identities for SQL (each grant revocable, ended for anyone whose marked
// data it would show); exported with its schema and lineage; reconciled against its systems;
// handed over to the organisation's own project, which ends Silo's part; and holding the Action
// ledger on request.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { isApiError } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, RadioGroup, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useRefreshWhile } from '../../hooks/refresh.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, humanise, plural } from '../../utils/format.util.ts';
import styles from './siloes.view.module.css';

type Warehouse = Output<'getWarehouse'>;
type Mode = 'off' | 'references' | 'values';
const STATUS: Record<Warehouse['status'], { label: string; tone: 'ok' | 'info' | 'danger' | 'neutral' | 'warn' }> = {
  provisioning: { label: 'Being set up', tone: 'info' }, backfilling: { label: 'Copying', tone: 'info' }, active: { label: 'In step', tone: 'ok' },
  failed: { label: 'Stopped', tone: 'danger' }, handed_over: { label: 'Handed over', tone: 'neutral' }, purged: { label: 'Wiped', tone: 'neutral' },
};

export function WarehousePage() {
  const read = useQuery('getWarehouse', {});
  useRefreshWhile(read.data?.status === 'provisioning' || read.data?.status === 'backfilling', read.refetch, 5000);
  usePageContext({ scope: { kind: 'page', page: 'siloes' }, scopeLabel: 'Warehouse' });
  const absent = read.error !== undefined && isApiError(read.error) && read.error.code === 'warehouse.not_found';
  return (
    <Page title="Warehouse" description="A BigQuery copy of the types you nominate, kept in step with their systems, for analysis in the tools you already use."
      crumbs={[{ label: 'Siloes', href: '/siloes/overview/' }]}>
      {absent ? <CreateWarehouse /> : read.data === undefined ? (read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the Warehouse" />)
        : <WarehouseBody w={read.data} />}
    </Page>
  );
}

function CreateWarehouse() {
  const say = useToast();
  const { data: vocabulary } = useVocabulary();
  const create = useMutation('createWarehouse', { invalidates: ['getWarehouse', 'listSiloes'] });
  const [purpose, setPurpose] = useState('');
  const [retention, setRetention] = useState('365');
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const nominations = Object.entries(chosen).filter(([, p]) => p.length > 0).map(([objectTypeId, properties]) => ({ objectTypeId, properties }));
  return (
    <div className={styles.stack}>
      <EmptyState icon="table" title="No Warehouse yet">Nominate the types and properties to copy; nothing else is ever copied.</EmptyState>
      <form className={styles.form} aria-label="Create the Warehouse" onSubmit={async (e) => {
        e.preventDefault();
        const r = await create.run({ body: { purpose: purpose.trim(), retentionDays: Math.max(1, Math.min(3650, Number(retention) || 365)), objectTypes: nominations } });
        if (r.ok) say('Being set up: each step shows here as it completes');
      }}>
        <TextArea label="What it is for" required rows={2} maxLength={500} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        <TextField label="Keep for (days)" type="number" min={1} max={3650} value={retention} onChange={(e) => setRetention(e.target.value)} />
        <fieldset className={styles.fieldset}>
          <legend>What it copies</legend>
          <div className={styles.stack}>{(vocabulary?.objectTypes ?? []).map((t) => (
            <div key={t.id} className={styles.stackTight}>
              <strong>{t.pluralName}</strong>
              <div className={styles.checks}>{t.properties.map((p) => (
                <Checkbox key={p.identityId} label={p.displayName} checked={(chosen[t.id] ?? []).includes(p.apiName)}
                  onChange={(e) => setChosen({ ...chosen, [t.id]: e.target.checked ? [...(chosen[t.id] ?? []), p.apiName] : (chosen[t.id] ?? []).filter((x) => x !== p.apiName) })} />
              ))}</div>
            </div>
          ))}</div>
        </fieldset>
        {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
        <FormActions>
          <Button type="submit" variant="primary" pending={create.pending} blocked={create.blocked} disabled={purpose.trim() === '' || nominations.length === 0}>Create the Warehouse</Button>
        </FormActions>
      </form>
    </div>
  );
}

function WarehouseBody({ w }: { w: Warehouse }) {
  const say = useToast();
  const { lookup } = useVocabulary();
  const retry = useMutation('retryWarehouseProvisioning', { invalidates: ['getWarehouse'] });
  const sync = useMutation('syncWarehouse', { invalidates: ['getWarehouse'] });
  const exportIt = useMutation('exportWarehouse');
  const reconcile = useMutation('reconcileWarehouse', { invalidates: ['getWarehouse'] });
  const [dialog, setDialog] = useState<'handover' | 'ledger' | undefined>();
  const live = w.status !== 'handed_over' && w.status !== 'purged';
  const error = retry.error ?? sync.error ?? exportIt.error ?? reconcile.error;
  return (
    <div className={styles.stack}>
      <Panel>
        <Properties items={[
          ['State', <Badge key="s" tone={STATUS[w.status].tone}>{STATUS[w.status].label}</Badge>],
          ['For', w.purpose],
          ['Where', `${w.location}; project ${w.projectId}, dataset ${w.dataset}`],
          ['Kept for', plural(w.retentionDays, 'day')],
          ['Copies', w.nominations.map((n) => `${lookup?.typeName(n.objectTypeId, true) ?? 'a type'} (${n.properties.join(', ')})`).join('; ')],
          ['Made', <Time key="m" value={w.createdAt} exact />],
        ]} />
      </Panel>
      {w.status === 'provisioning' || w.status === 'backfilling' ? <Banner tone="info" title="Being set up">Done so far: {humanise(w.provisioningStep).toLowerCase()}.</Banner> : null}
      {w.status === 'failed' ? (
        <Banner tone="danger" title={`Stopped at ${humanise(w.failedStep ?? 'a step').toLowerCase()}`}
          action={<Button pending={retry.pending} blocked={retry.blocked} onClick={() => void retry.run({ params: { warehouseId: w.id } }).then((r) => r.ok && say('Resuming from the step that stopped'))}>Resume</Button>}>
          Resuming starts again from that step; nothing done is redone.
        </Banner>
      ) : null}
      {error !== undefined ? <ErrorMessage error={error} /> : null}
      {live ? (
        <div className={styles.row}>
          <Button icon="refresh" pending={sync.pending} blocked={sync.blocked} onClick={() => void sync.run({ params: { warehouseId: w.id }, body: { mode: 'scheduled' } }).then((r) => r.ok && say('Syncing'))}>Sync now</Button>
          <Button pending={reconcile.pending} blocked={reconcile.blocked} onClick={() => void reconcile.run({ params: { warehouseId: w.id } })}>Check it against its systems</Button>
          <Button icon="download" pending={exportIt.pending} blocked={exportIt.blocked} onClick={() => void exportIt.run({ params: { warehouseId: w.id } }).then((r) => r.ok && say('Exported, with its schema and lineage'))}>Export</Button>
          <Button onClick={() => setDialog('ledger')}>Action ledger</Button>
          <Button variant="danger" onClick={() => setDialog('handover')}>Hand over…</Button>
        </div>
      ) : null}
      {reconcile.data !== undefined ? (
        <DataTable label="Checked against its systems" rows={reconcile.data.tables} rowKey={(t) => t.tableId} columns={[
          { id: 'type', header: 'Type', primary: true, cell: (t) => lookup?.typeName(t.objectTypeId, true) ?? '…' },
          { id: 'source', header: 'In its systems', align: 'end', cell: (t) => formatNumber(t.sourceCount) },
          { id: 'table', header: 'In the Warehouse', align: 'end', cell: (t) => formatNumber(t.tableCount) },
          { id: 'missing', header: 'Missing of those sampled', align: 'end', cell: (t) => `${formatNumber(t.missing)} of ${formatNumber(t.sampled)}` },
          { id: 'outcome', header: 'Outcome', cell: (t) => (t.outcome === 'in_step' ? <Badge tone="ok">In step</Badge> : t.outcome === 'resynced' ? <Badge tone="warn">Resynced</Badge> : <Badge tone="danger">Its system did not answer</Badge>) },
        ]} />
      ) : null}
      {exportIt.data !== undefined ? (
        <Panel>
          <div className={styles.stackTight}>
            <strong>Exported</strong>
            <ul className={styles.plainList}>{exportIt.data.tables.map((t) => <li key={t.table}><span className={styles.mono}>{t.uri}</span> ({t.kind})</li>)}</ul>
          </div>
        </Panel>
      ) : null}
      <Section title="Tables">
        {w.tables.length === 0 ? <p className={styles.muted}>No tables yet.</p> : (
          <DataTable label="Warehouse tables" rows={w.tables} rowKey={(t) => t.id} columns={[
            { id: 'table', header: 'Table', primary: true, cell: (t) => <span className={styles.mono}>{t.tableName}</span> },
            { id: 'kind', header: 'Holds', width: 'sm', cell: (t) => humanise(t.kind) },
            { id: 'rows', header: 'Rows', width: 'sm', align: 'end', cell: (t) => formatNumber(t.rowCount) },
            { id: 'fresh', header: 'Freshness', width: 'sm', cell: (t) => (t.freshness === 'current' ? <Badge tone="ok">Current</Badge> : t.freshness === 'stale' ? <Badge tone="warn">Stale</Badge> : <Badge>Never synced</Badge>) },
            { id: 'synced', header: 'Last synced', width: 'sm', cell: (t) => (t.lastSyncedAt === null ? '—' : <Time value={t.lastSyncedAt} />) },
          ]} />
        )}
      </Section>
      {live ? <SqlAccess warehouseId={w.id} /> : null}
      {dialog === 'ledger' ? <LedgerDialog w={w} onClose={() => setDialog(undefined)} /> : null}
      {dialog === 'handover' ? <HandOver w={w} onClose={() => setDialog(undefined)} /> : null}
    </div>
  );
}

function SqlAccess({ warehouseId }: { warehouseId: string }) {
  const say = useToast();
  const people = useDirectory();
  const grants = useQuery('listWarehouseSqlGrants', { params: { warehouseId } });
  const grant = useMutation('grantWarehouseSqlAccess', { invalidates: ['listWarehouseSqlGrants'] });
  const revoke = useMutation('revokeWarehouseSqlAccess', { invalidates: ['listWarehouseSqlGrants'] });
  const [identity, setIdentity] = useState('');
  const [revoking, setRevoking] = useState<string | undefined>();
  return (
    <Section title="SQL access" description="Named Google identities that query the dataset directly. A grant ends by itself for anyone whose marked data it would show.">
      <div className={styles.stack}>
        <QueryView query={grants} what="SQL access" isEmpty={(d) => d.grants.length === 0} empty={<p className={styles.muted}>No one queries it directly yet.</p>}>
          {(d) => (
            <DataTable label="SQL access" rows={d.grants} rowKey={(g) => g.id} columns={[
              { id: 'who', header: 'Google identity', primary: true, cell: (g) => <span className={styles.mono}>{g.googleIdentity}</span> },
              { id: 'by', header: 'Granted by', cell: (g) => people.nameOf(g.grantedBy) },
              { id: 'when', header: 'Since', width: 'sm', cell: (g) => <Time value={g.grantedAt} /> },
              { id: 'state', header: 'State', cell: (g) => (g.revokedAt === null ? <Badge tone="ok">Open</Badge> : <Badge>{g.revokedReason === null ? 'Ended' : `Ended: ${humanise(g.revokedReason).toLowerCase()}`}</Badge>) },
              { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (g) => (g.revokedAt === null ? <Button size="sm" variant="ghost" blocked={revoke.blocked} onClick={() => setRevoking(g.id)}>End it</Button> : null) },
            ]} />
          )}
        </QueryView>
        <form className={styles.rowEnd} aria-label="Grant SQL access" onSubmit={async (e) => {
          e.preventDefault();
          const r = await grant.run({ params: { warehouseId }, body: { googleIdentity: identity.trim() } });
          if (r.ok) {
            setIdentity('');
            say('Granted');
          }
        }}>
          <TextField label="Google identity" type="email" value={identity} onChange={(e) => setIdentity(e.target.value)} hint="A person's or group's Google account." />
          <Button type="submit" pending={grant.pending} blocked={grant.blocked} disabled={identity.trim() === ''}>Grant</Button>
        </form>
        {grant.error !== undefined ? <ErrorMessage error={grant.error} /> : null}
      </div>
      <ConfirmDialog open={revoking !== undefined} onClose={() => setRevoking(undefined)} title="End this SQL access?" confirmLabel="End it" tone="danger"
        onConfirm={() => revoke.run({ params: { warehouseId, grantId: revoking! } }).then((r) => {
          if (r.ok) say('Ended');
          return r;
        })}><p>They can no longer query the dataset.</p></ConfirmDialog>
    </Section>
  );
}

function LedgerDialog({ w, onClose }: { w: Warehouse; onClose: () => void }) {
  const say = useToast();
  const set = useMutation('setActionLedger', { invalidates: ['getWarehouse'] });
  const [mode, setMode] = useState<Mode>(w.actionLedger);
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <Dialog open onClose={onClose} title="The Action ledger in the Warehouse" size="md" busy={set.pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = await set.run({ params: { warehouseId: w.id }, body: { mode, ...(mode === 'values' ? { disclosureAcknowledged: acknowledged } : {}) } });
        if (r.ok) {
          say(mode === 'off' ? 'The ledger is not copied now' : 'The ledger is copied from now on');
          onClose();
        }
      }}>
        <RadioGroup label="Copy it" name="wledger" value={mode} onChange={(v) => setMode(v as Mode)} options={[
          { value: 'off', label: 'Off' }, { value: 'references', label: 'References only', hint: 'What changed, by whom and when' }, { value: 'values', label: 'With values', hint: 'Each change with its values before and after' },
        ]} />
        {mode === 'values' ? <Checkbox label="I understand values are copied into the Warehouse, where SQL access reads them" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} /> : null}
        {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={set.pending} blocked={set.blocked} disabled={mode === 'values' && !acknowledged}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function HandOver({ w, onClose }: { w: Warehouse; onClose: () => void }) {
  const say = useToast();
  const hand = useMutation('handOverWarehouse', { invalidates: ['getWarehouse', 'listSiloes'] });
  const [destination, setDestination] = useState('');
  return (
    <ConfirmDialog open onClose={onClose} title="Hand the Warehouse over?" confirmLabel="Hand it over" tone="danger" typeToConfirm="hand over"
      onConfirm={async () => {
        if (destination.trim() === '') return { ok: false, error: new Error('name the project it goes to') };
        const r = await hand.run({ params: { warehouseId: w.id }, body: { destination: destination.trim() } });
        if (r.ok) say(`Handed over; ${plural(r.data.grantsRevoked, 'SQL grant')} ended`);
        return r;
      }}>
      <div className={styles.stack}>
        <p>Its dataset <span className={styles.mono}>{w.dataset}</span> moves to your own project and Silo stops keeping it in step. Every SQL grant Silo made ends. This cannot be undone here.</p>
        <TextField label="Your Google Cloud project" required value={destination} onChange={(e) => setDestination(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}
