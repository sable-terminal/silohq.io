'use client';

// The organisation's data in Silo (spec 6.4, 6.7, 33.4, 74, 79): whether it keeps any at all
// (Siloes, after reading what that means), which statistical inference it opts into, whether its
// agents may look for systems on its networks, everything it has here as files it can take away
// (each part checked against the checksum the receipt states), and moving it to another cell.

import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { isApiError } from '../../api/client.api.ts';
import { Badge, type Tone } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, RadioGroup, Switch, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useData, useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { formatBytes, humanise } from '../../utils/format.util.ts';
import styles from './settings.view.module.css';

const crumbs = [{ label: 'Settings', href: '/settings/' }];

/** /settings/siloes/: whether the organisation keeps any data in Silo, after the disclosure. */
export function SiloesSetting() {
  const say = useToast();
  const read = useQuery('getSiloesSetting', {});
  const set = useMutation('setSiloesEnabled', { invalidates: ['getSiloesSetting', 'listSiloes', 'getSiloesWeb'] });
  const [confirmOff, setConfirmOff] = useState(false);
  return (
    <Page title="Siloes" description="Whether your organisation keeps any data in Silo. Off, Silo reads your systems and keeps nothing of them." crumbs={crumbs} width="narrow">
      <QueryView query={read} what="The Siloes setting">
        {(s) => (
          <div className={styles.stack}>
            <Panel>
              <div className={styles.stack}>
                <p>{s.disclosure}</p>
                <Switch label="Siloes are on" checked={s.enabled} disabled={set.pending} blocked={set.blocked}
                  hint={s.enabled ? 'Turning them off keeps every Silo as it is until it is wiped; nothing new is kept.' : 'Turning them on keeps nothing until someone makes a Silo.'}
                  onChange={(on) => (on ? void set.run({ body: { enabled: true } }).then((r) => r.ok && say('Siloes are on')) : setConfirmOff(true))} />
              </div>
            </Panel>
            {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
          </div>
        )}
      </QueryView>
      <ConfirmDialog open={confirmOff} onClose={() => setConfirmOff(false)} title="Turn Siloes off?" confirmLabel="Turn them off" tone="danger"
        onConfirm={async () => {
          const r = await set.run({ body: { enabled: false } });
          if (r.ok) say('Siloes are off');
          return r;
        }}>
        No new Silo can be made and none takes anything more in. What each one holds stays until it is wiped from its own page.
      </ConfirmDialog>
    </Page>
  );
}

type Inference = Output<'getInferenceSettings'>;
const INFERENCE: { key: keyof Inference; label: string; hint: string }[] = [
  { key: 'simulation', label: 'Simulation priors', hint: 'Simulations draw their inputs from what your history makes likely, rather than fixed ranges.' },
  { key: 'resolution', label: 'Probabilistic resolution', hint: 'Records that probably describe the same thing are matched with a stated probability.' },
  { key: 'links', label: 'Link inference', hint: 'Links your systems do not state are proposed, each with how likely it is.' },
  { key: 'findings', label: 'Finding probabilities', hint: 'Each finding says how likely it is to be real.' },
];

/** /settings/inference/: Bayesian inference, opted into for each use (decision 2026-11-11). */
export function InferenceSettings() {
  const say = useToast();
  const read = useQuery('getInferenceSettings', {});
  const set = useMutation('setInferenceSettings', { invalidates: ['getInferenceSettings'] });
  return (
    <Page title="Inference" description="Statistical inference Silo uses only where you opt in. Bands, canaries, tuning and intervals are always on; these four are your choice." crumbs={crumbs} width="narrow">
      <QueryView query={read} what="Inference settings">
        {(s) => (
          <Panel>
            <div className={styles.stack}>
              {INFERENCE.map((i) => (
                <Switch key={i.key} label={i.label} hint={i.hint} checked={s[i.key]} disabled={set.pending} blocked={set.blocked}
                  onChange={(on) => void set.run({ body: { [i.key]: on } }).then((r) => r.ok && say(`${i.label} ${on ? 'on' : 'off'}`))} />
              ))}
              {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
            </div>
          </Panel>
        )}
      </QueryView>
    </Page>
  );
}

/** /settings/discovery/: whether the organisation's agents may look for systems on its networks. */
export function DiscoverySettings() {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('getDiscoverySettings', {});
  const set = useMutation('setDiscoveryEnabled', { invalidates: ['getDiscoverySettings'] });
  return (
    <Page title="Discovery" description="Whether Silo Agents may look for systems on the networks they sit in, and propose them as connections. Nothing found is connected until someone says so." crumbs={crumbs} width="narrow">
      <QueryView query={read} what="Discovery settings">
        {(s) => (
          <Panel>
            <div className={styles.stack}>
              <Switch label="Agents may discover systems" checked={s.enabled} disabled={set.pending} blocked={set.blocked}
                hint={s.enabled && s.enabledBy !== null && s.enabledAt !== null ? <>Turned on by {people.nameOf(s.enabledBy)}, <Time value={s.enabledAt} />.</> : s.disabledAt !== null ? <>Turned off <Time value={s.disabledAt} />.</> : 'Off until someone turns it on.'}
                onChange={(on) => void set.run({ body: { enabled: on } }).then((r) => r.ok && say(on ? 'Discovery on' : 'Discovery off'))} />
              {set.error !== undefined ? <ErrorMessage error={set.error} /> : null}
            </div>
          </Panel>
        )}
      </QueryView>
    </Page>
  );
}

type OrgExport = Output<'listOrgExports'>['exports'][number];
type Part = 'bundle' | 'manifest' | 'receipt';
const EXPORT_STATUS: Record<OrgExport['status'], { label: string; tone: Tone }> = {
  requested: { label: 'Waiting', tone: 'neutral' }, running: { label: 'Running', tone: 'info' }, completed: { label: 'Ready', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
const hexOf = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** /settings/export/: everything the organisation has in Silo, as files it can take away. */
export function OrgExport() {
  const say = useToast();
  const people = useDirectory();
  const { api } = useData();
  const list = useQuery('listOrgExports', {});
  const request = useMutation('requestOrgExport', { invalidates: ['listOrgExports'] });
  const [open, setOpen] = useState<string | undefined>();
  const [saving, setSaving] = useState<{ id: string; part: Part; done: number; total: number } | undefined>();
  const [failed, setFailed] = useState<unknown>();
  const running = (list.data?.exports ?? []).some((e) => e.status === 'requested' || e.status === 'running');

  /** Reads a part in pieces, checks the whole against its SHA-256, then hands it to the browser. */
  async function save(id: string, part: Part) {
    setFailed(undefined);
    setSaving({ id, part, done: 0, total: 0 });
    try {
      const pieces: Uint8Array<ArrayBuffer>[] = [];
      let offset = 0;
      let meta: { name: string; contentType: string; totalBytes: number; sha256: string } | undefined;
      do {
        const r = await api.call('downloadOrgExport', { params: { exportId: id }, query: { part, offset } });
        meta = r;
        const bytes = Uint8Array.from(atob(r.content), (c) => c.charCodeAt(0));
        if (bytes.length === 0 && offset < r.totalBytes) throw new Error('the export stopped short');
        pieces.push(bytes);
        offset += bytes.length;
        setSaving({ id, part, done: offset, total: r.totalBytes });
      } while (offset < meta.totalBytes);
      const blob = new Blob(pieces, { type: meta.contentType });
      if (hexOf(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())) !== meta.sha256) throw new Error('the file did not match its checksum; try again');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = meta.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      say(`Saved ${meta.name}, checked against its checksum`);
    } catch (error) {
      setFailed(error);
    } finally {
      setSaving(undefined);
    }
  }

  return (
    <Page title="Organisation export" description="Everything your organisation has in Silo, as open files: the ontology, views, apps, scenarios, Crons, connection manifests, audit, Siloes and receipts. Data under a marking is left out and listed as left out." crumbs={crumbs} width="full"
      actions={<Button variant="primary" icon="download" pending={request.pending} blocked={request.blocked ?? (running ? 'An export is already being made' : undefined)}
        onClick={() => void request.run({}).then((r) => r.ok && say('Export requested: it is made in the background'))}>Request an export</Button>}>
      <div className={styles.stack}>
        {request.error !== undefined ? <ErrorMessage error={request.error} /> : null}
        {failed !== undefined ? <ErrorMessage error={isApiError(failed) ? failed : new Error(failed instanceof Error ? failed.message : 'The file could not be saved')} /> : null}
        {saving !== undefined ? <Banner tone="info" title={`Saving the ${saving.part}`}>{saving.total > 0 ? `${formatBytes(saving.done)} of ${formatBytes(saving.total)}` : 'Starting'}</Banner> : null}
        <QueryView query={list} what="Exports" isEmpty={(d) => d.exports.length === 0} empty={<EmptyState icon="download" title="No exports yet">An export is made in the background; it appears here when it is ready.</EmptyState>}>
          {(d) => (
            <DataTable label="Exports" rows={d.exports} rowKey={(e) => e.id} columns={[
              { id: 'when', header: 'Requested', primary: true, cell: (e) => <button type="button" className={styles.linkButton} onClick={() => setOpen(e.id)}><Time value={e.requestedAt} exact /></button>, sortValue: (e) => e.requestedAt },
              { id: 'by', header: 'By', cell: (e) => people.nameOf(e.requestedByMembershipId) },
              { id: 'status', header: 'State', width: 'sm', cell: (e) => <Badge tone={EXPORT_STATUS[e.status].tone}>{EXPORT_STATUS[e.status].label}</Badge> },
              { id: 'size', header: 'Size', align: 'end', cell: (e) => (e.bundleBytes !== null ? formatBytes(Number(e.bundleBytes)) : '—') },
              { id: 'items', header: 'Items', align: 'end', cell: (e) => (e.itemCount !== null ? `${e.itemCount}${(e.omittedItemCount ?? 0) > 0 ? ` (${e.omittedItemCount} left out)` : ''}` : '—') },
              { id: 'save', header: <span className="visually-hidden">Save</span>, align: 'end', cell: (e) => (e.status !== 'completed' ? null : (
                <Button size="sm" icon="download" pending={saving?.id === e.id && saving.part === 'bundle'} disabled={saving !== undefined} onClick={() => void save(e.id, 'bundle')}>Save</Button>
              )) },
            ]} />
          )}
        </QueryView>
      </div>
      {open !== undefined ? <ExportDrawer exportId={open} saving={saving !== undefined} onSave={(part) => void save(open, part)} onClose={() => setOpen(undefined)} /> : null}
    </Page>
  );
}

function ExportDrawer({ exportId, saving, onSave, onClose }: { exportId: string; saving: boolean; onSave: (part: Part) => void; onClose: () => void }) {
  const read = useQuery('getOrgExport', { params: { exportId } });
  return (
    <Dialog open drawer onClose={onClose} title="Export" size="lg">
      <QueryView query={read} what="The export">
        {(e) => (
          <div className={styles.stack}>
            <Properties columns={2} items={[
              ['State', <Badge key="s" tone={EXPORT_STATUS[e.status].tone}>{EXPORT_STATUS[e.status].label}</Badge>],
              ['Format', e.formatVersion],
              ['Requested', <Time key="r" value={e.requestedAt} exact />],
              ['Finished', e.completedAt !== null ? <Time key="c" value={e.completedAt} exact /> : e.failedAt !== null ? <Time key="f" value={e.failedAt} exact /> : '—'],
              ['Bundle SHA-256', e.bundleSha256 !== null ? <span key="b" className={styles.mono}>{e.bundleSha256}</span> : '—'],
              ['Receipt issued', e.receiptIssuedAt !== null ? <Time key="i" value={e.receiptIssuedAt} exact /> : '—'],
            ]} />
            {e.failureCategory !== null ? <Banner tone="danger" title="It failed">{humanise(e.failureCategory)}</Banner> : null}
            {e.status === 'completed' ? (
              <div className={styles.row}>
                <Button icon="download" disabled={saving} onClick={() => onSave('bundle')}>The bundle</Button>
                <Button disabled={saving} onClick={() => onSave('manifest')}>The manifest</Button>
                <Button disabled={saving} onClick={() => onSave('receipt')}>The receipt</Button>
              </div>
            ) : null}
            <DataTable label="What it holds" rows={e.items} rowKey={(i) => `${i.family}/${i.artefact}`} columns={[
              { id: 'what', header: 'What', primary: true, cell: (i) => `${humanise(i.family)}: ${i.artefact}` },
              { id: 'format', header: 'Format', width: 'sm', cell: (i) => i.format.toUpperCase() },
              { id: 'rows', header: 'Rows', align: 'end', cell: (i) => i.rows ?? '—' },
              { id: 'size', header: 'Size', align: 'end', cell: (i) => (i.bytes !== null ? formatBytes(Number(i.bytes)) : '—') },
              { id: 'state', header: 'State', cell: (i) => (i.status === 'included' ? <Badge tone="ok">Included</Badge> : <Badge tone="warn">Left out: marked</Badge>) },
            ]} />
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

type Migration = Output<'listTenantMigrations'>['migrations'][number];
const MIGRATION_REASON: Record<Migration['reason'], string> = {
  residency_change: 'A change of residency', promotion_dedicated: 'To a dedicated cell', promotion_sovereign: 'To a sovereign cell', rebalancing: 'Rebalancing by Silo',
};
const LIVE: Migration['status'][] = ['requested', 'approved', 'scheduled', 'read_only', 'exporting', 'importing', 'verifying', 'reauthorising', 'directory_updated', 'source_read_only'];

/** /settings/migration/: moving the organisation to another cell (spec 6.4). */
export function CellMigration() {
  const say = useToast();
  const people = useDirectory();
  const list = useQuery('listTenantMigrations', {});
  const request = useMutation('requestTenantMigration', { invalidates: ['listTenantMigrations'] });
  const withdraw = useMutation('withdrawTenantMigration', { invalidates: ['listTenantMigrations'] });
  const respond = useMutation('respondToRebalancing', { invalidates: ['listTenantMigrations'] });
  const [asking, setAsking] = useState(false);
  const [form, setForm] = useState<{ destinationCellId: string; reason: 'residency_change' | 'promotion_dedicated' | 'promotion_sovereign' }>({ destinationCellId: '', reason: 'residency_change' });
  const [open, setOpen] = useState<string | undefined>();
  const [answer, setAnswer] = useState<{ migration: Migration; decision: 'approve' | 'object'; note: string } | undefined>();
  const [withdrawing, setWithdrawing] = useState<Migration | undefined>();
  const live = (list.data?.migrations ?? []).find((m) => m.side === 'source' && LIVE.includes(m.status));
  return (
    <Page title="Cell migration" description="Moving your organisation to another cell: for a change of residency, or to a dedicated or sovereign cell under contract. Silo arranges each one with you; it is read-only while it moves, and is checked row for row." crumbs={crumbs} width="full"
      actions={<Button variant="primary" blocked={request.blocked ?? (live !== undefined ? 'A migration is already under way' : undefined)} onClick={() => setAsking(true)}>Request a migration</Button>}>
      <div className={styles.stack}>
        {[respond.error, withdraw.error].map((e, i) => (e !== undefined ? <ErrorMessage key={i} error={e} /> : null))}
        {(list.data?.migrations ?? []).filter((m) => m.reason === 'rebalancing' && m.status === 'requested' && m.customerObjectedAt === null && m.approvedByMembershipId === null).map((m) => (
          <Banner key={m.id} tone="warn" title="Silo proposes to move your organisation" action={
            <span className={styles.row}>
              <Button blocked={respond.blocked} onClick={() => setAnswer({ migration: m, decision: 'approve', note: '' })}>Approve</Button>
              <Button variant="ghost" blocked={respond.blocked} onClick={() => setAnswer({ migration: m, decision: 'object', note: '' })}>Object</Button>
            </span>
          }>
            To {m.destinationCellId}, in the same residency{m.windowStartsAt !== null ? <>, from <Time value={m.windowStartsAt} exact /></> : null}. An objection stops it.
          </Banner>
        ))}
        <QueryView query={list} what="Migrations" isEmpty={(d) => d.migrations.length === 0} empty={<EmptyState icon="arrowRight" title="No migrations">Your organisation has stayed on the cell it started on.</EmptyState>}>
          {(d) => (
            <DataTable label="Migrations" rows={d.migrations} rowKey={(m) => m.id} columns={[
              { id: 'when', header: 'Asked', primary: true, cell: (m) => <button type="button" className={styles.linkButton} onClick={() => setOpen(m.id)}><Time value={m.createdAt} exact /></button>, sortValue: (m) => m.createdAt },
              { id: 'why', header: 'Why', cell: (m) => MIGRATION_REASON[m.reason] },
              { id: 'route', header: 'From, to', cell: (m) => <span className={styles.mono}>{m.sourceCellId} → {m.destinationCellId}</span> },
              { id: 'by', header: 'By', cell: (m) => (m.requestedByMembershipId !== null ? people.nameOf(m.requestedByMembershipId) : 'Silo') },
              { id: 'state', header: 'State', cell: (m) => <Badge tone={m.status === 'completed' || m.status === 'source_purged' ? 'ok' : m.status === 'aborted' ? 'neutral' : 'info'}>{humanise(m.status)}</Badge> },
              { id: 'act', header: <span className="visually-hidden">Withdraw</span>, align: 'end', cell: (m) => (m.side === 'source' && m.reason !== 'rebalancing' && (m.status === 'requested' || m.status === 'approved' || m.status === 'scheduled')
                ? <Button size="sm" variant="ghost" blocked={withdraw.blocked} onClick={() => setWithdrawing(m)}>Withdraw</Button> : null) },
            ]} />
          )}
        </QueryView>
      </div>
      <Dialog open={asking} onClose={() => setAsking(false)} title="Request a migration" size="sm" busy={request.pending}
        description="Silo's security officer approves a change of residency; a promotion needs the contract too. You can withdraw it until it starts.">
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await request.run({ body: { destinationCellId: form.destinationCellId.trim().toLowerCase(), reason: form.reason } });
          if (r.ok) {
            setAsking(false);
            say('Requested: Silo will be in touch to agree a window');
          }
        }}>
          <RadioGroup label="Why" name="reason" value={form.reason} onChange={(reason) => setForm({ ...form, reason })}
            options={(['residency_change', 'promotion_dedicated', 'promotion_sovereign'] as const).map((r) => ({ value: r, label: MIGRATION_REASON[r] }))} />
          <TextField label="To the cell" required className={styles.mono} value={form.destinationCellId} onChange={(e) => setForm({ ...form, destinationCellId: e.target.value })}
            pattern="[a-z0-9]+(-[a-z0-9]+)*" hint="The cell Silo has agreed with you, such as uk-lon-1." />
          {request.error !== undefined ? <ErrorMessage error={request.error} /> : null}
          <FormActions><Button onClick={() => setAsking(false)}>Cancel</Button><Button type="submit" variant="primary" pending={request.pending} disabled={form.destinationCellId.trim() === ''}>Request it</Button></FormActions>
        </form>
      </Dialog>
      <Dialog open={answer !== undefined} onClose={() => setAnswer(undefined)} title={answer?.decision === 'object' ? 'Object to the move' : 'Approve the move'} size="sm" busy={respond.pending}
        description={answer?.decision === 'object' ? 'Your objection stops it.' : 'Silo moves your organisation in the window it gave notice of.'}>
        {answer !== undefined ? (
          <form className={styles.form} onSubmit={async (e) => {
            e.preventDefault();
            const r = await respond.run({ params: { migrationId: answer.migration.id }, body: { decision: answer.decision, ...(answer.note.trim() !== '' ? { note: answer.note.trim() } : {}) } });
            if (r.ok) {
              setAnswer(undefined);
              say(answer.decision === 'object' ? 'Objected: it will not go ahead' : 'Approved');
            }
          }}>
            <TextArea label="A note for Silo (optional)" rows={3} maxLength={2000} value={answer.note} onChange={(e) => setAnswer({ ...answer, note: e.target.value })} />
            {respond.error !== undefined ? <ErrorMessage error={respond.error} /> : null}
            <FormActions><Button onClick={() => setAnswer(undefined)}>Cancel</Button><Button type="submit" variant={answer.decision === 'object' ? 'danger' : 'primary'} pending={respond.pending}>{answer.decision === 'object' ? 'Object' : 'Approve'}</Button></FormActions>
          </form>
        ) : null}
      </Dialog>
      <ConfirmDialog open={withdrawing !== undefined} onClose={() => setWithdrawing(undefined)} title="Withdraw the migration?" confirmLabel="Withdraw it"
        onConfirm={async () => {
          const r = await withdraw.run({ params: { migrationId: withdrawing!.id } });
          if (r.ok) say('Withdrawn');
          return r;
        }}>
        Your organisation stays where it is. You can ask again later.
      </ConfirmDialog>
      {open !== undefined ? <MigrationDrawer migrationId={open} onClose={() => setOpen(undefined)} /> : null}
    </Page>
  );
}

function MigrationDrawer({ migrationId, onClose }: { migrationId: string; onClose: () => void }) {
  const people = useDirectory();
  const read = useQuery('getTenantMigration', { params: { migrationId } });
  const at = (v: string | null) => (v !== null ? <Time value={v} exact /> : '—');
  return (
    <Dialog open drawer onClose={onClose} title="Migration" size="lg">
      <QueryView query={read} what="The migration">
        {(m) => (
          <div className={styles.stack}>
            <Properties columns={2} items={[
              ['Why', MIGRATION_REASON[m.reason]],
              ['State', humanise(m.status)],
              ['From', <span key="f" className={styles.mono}>{m.sourceCellId}</span>],
              ['To', <span key="t" className={styles.mono}>{m.destinationCellId}</span>],
              ['Asked by', m.requestedByMembershipId !== null ? people.nameOf(m.requestedByMembershipId) : 'Silo'],
              ['Approved by', m.approvedByMembershipId !== null ? people.nameOf(m.approvedByMembershipId) : '—'],
              ['Window', m.windowStartsAt !== null ? <span key="w"><Time value={m.windowStartsAt} exact /> to {m.windowEndsAt !== null ? <Time value={m.windowEndsAt} exact /> : '—'}</span> : 'Not set'],
              ['Siloes move too', m.moveSiloes ? 'Yes' : 'No'],
              ['Read-only from', at(m.readOnlyAt)],
              ['Exported', at(m.exportCompletedAt)],
              ['Imported', at(m.importCompletedAt)],
              ['Verified', at(m.verifiedAt)],
              ['Routing changed', at(m.directoryUpdatedAt)],
              ['Old copy read-only until', at(m.sourceReadOnlyUntil)],
              ['Old copy purged', at(m.sourcePurgedAt)],
              ['Connections to re-authorise', m.connectionsPendingReauthorisation ?? '—'],
            ]} />
            {m.abortReason !== null ? <Banner tone="warn" title="Stopped">{m.abortReason}</Banner> : null}
            {m.tables.length > 0 ? (
              <DataTable label="Tables checked" rows={m.tables} rowKey={(t) => `${t.schema}.${t.table}`} columns={[
                { id: 'table', header: 'Table', primary: true, cell: (t) => <span className={styles.mono}>{t.schema}.{t.table}</span> },
                { id: 'source', header: 'Rows here', align: 'end', cell: (t) => t.sourceRowCount ?? '—' },
                { id: 'dest', header: 'Rows there', align: 'end', cell: (t) => t.destinationRowCount ?? '—' },
                { id: 'match', header: 'Matched', width: 'sm', cell: (t) => (t.matched === null ? '—' : t.matched ? <Badge tone="ok">Yes</Badge> : <Badge tone="danger">No</Badge>) },
              ]} />
            ) : null}
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}
