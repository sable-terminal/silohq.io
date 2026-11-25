'use client';

// Saved views (spec 37): answers and object sets kept to run again. A view is run again on open,
// as the person opening it, unmetered; it keeps its definition, never its rows. The owner renames,
// shares (with a person, a team or the organisation, to view, run or copy), and archives it;
// anyone it is shared with to copy makes their own. A favourite puts it on the dashboard. Views
// inherited from a colleague who left, or a scope that was archived, wait here for a decision.

import Link from 'next/link';
import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, TextField } from '../../components/field.component.tsx';
import { Menu, type MenuEntry } from '../../components/menu.component.tsx';
import { Page, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { SearchInput } from '../../components/search.component.tsx';
import { ShareDialog } from '../../components/share.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { type TabDef, TabPanel, Tabs, useTab } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { threadHref, viewHref } from '../../navigation/links.navigation.ts';
import { ResultByRef } from '../../results/result.result.tsx';
import { usePageContext } from '../../shell/context.shell.tsx';
import { humanise, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './ask.view.module.css';

type View = Output<'listWorkspaceViews'>['views'][number];
type Access = 'view' | 'run' | 'copy';

const ACCESS: { value: Access; label: string; hint: string }[] = [
  { value: 'run', label: 'Run it', hint: 'See its answer, read again as them' },
  { value: 'view', label: 'View it', hint: 'See how it was asked' },
  { value: 'copy', label: 'Copy it', hint: 'Make their own to change' },
];
const KIND: Record<View['kind'], string> = { result: 'Answer', analysis: 'Analysis', object_set: 'Object set' };
const REFUSED: Record<string, string> = {
  bound_exceeded: 'it reads more than a view may', capability_missing: 'a system it needs cannot answer it', invalid_manifest: 'the ontology changed under it',
  unavailable: 'a system it reads is unavailable', unsupported: 'it is not supported',
};

function ViewDetail({ viewId, onClose }: { viewId: string; onClose: () => void }) {
  const say = useToast();
  const [, set] = useParams();
  const opened = useQuery('openWorkspaceView', { params: { viewId } });
  const ran = useQuery('runWorkspaceView', { params: { viewId } }, { staleMs: 60_000 });
  const run = ran.data?.run;
  const owner = opened.data?.view.access === 'owner';
  const shares = useQuery('listWorkspaceViewShares', owner ? { params: { viewId } } : null);
  const rename = useMutation('renameWorkspaceView', { invalidates: ['listWorkspaceViews', 'openWorkspaceView'] });
  const copy = useMutation('copyWorkspaceView', { invalidates: ['listWorkspaceViews'] });
  const archive = useMutation('archiveWorkspaceView', { invalidates: ['listWorkspaceViews', 'readDashboard'] });
  const share = useMutation('shareWorkspaceView', { invalidates: ['listWorkspaceViewShares'] });
  const revoke = useMutation('revokeWorkspaceViewShare', { invalidates: ['listWorkspaceViewShares'] });
  const favourite = useMutation('favouriteWorkspaceView', { invalidates: ['listWorkspaceViews', 'readDashboard', 'openWorkspaceView'] });
  const unfavourite = useMutation('unfavouriteWorkspaceView', { invalidates: ['listWorkspaceViews', 'readDashboard', 'openWorkspaceView'] });
  const [dialog, setDialog] = useState<'rename' | 'copy' | 'share' | 'archive' | undefined>(undefined);
  const [name, setName] = useState('');
  const v = opened.data?.view;
  usePageContext(v?.objectSetId != null ? { scope: { kind: 'object_set', objectSetId: v.objectSetId }, scopeLabel: v.name } : { scope: { kind: 'page', page: 'ask' }, scopeLabel: v?.name ?? 'Saved views' });
  return (
    <Dialog open onClose={onClose} drawer title={v?.name ?? 'Saved view'} description={v === undefined ? undefined : `${KIND[v.kind]} · read again now, as you`}>
      <QueryView query={opened} what="The view">
        {({ view }) => (
          <div className={styles.thread}>
            <div className={styles.listTabs}>
              {view.favourited
                ? <Button icon="star" pending={unfavourite.pending} onClick={() => void unfavourite.run({ params: { viewId } })}>On your dashboard</Button>
                : <Button icon="star" pending={favourite.pending} blocked={favourite.blocked} onClick={() => void favourite.run({ params: { viewId }, body: {} }).then((r) => r.ok && say('Added to your dashboard'))}>Add to your dashboard</Button>}
              {owner ? <Button icon="share" onClick={() => setDialog('share')} blocked={share.blocked}>Share</Button> : null}
              {owner ? <Button icon="edit" onClick={() => {
                setName(view.name);
                setDialog('rename');
              }} blocked={rename.blocked}>Rename</Button> : null}
              {owner || view.access === 'copy' ? <Button icon="copy" onClick={() => {
                setName(`${view.name} (copy)`);
                setDialog('copy');
              }} blocked={copy.blocked}>Make a copy</Button> : null}
              <Link href={threadHref(view.threadId) as never} className={styles.listLink}>How it was asked</Link>
              {view.kind === 'object_set' ? <Link href={viewHref(view.id, 'object_set') as never} className={styles.listLink}>Open in Explorer</Link> : null}
              {view.kind === 'analysis' && view.manifestId !== null ? (
                <Link href={hrefWith('/explorer/analyses/', { manifest: view.manifestId, analysis: owner ? view.id : undefined }) as never} className={styles.listLink}>Open in Analysis</Link>
              ) : null}
            </div>
            {favourite.error !== undefined ? <ErrorMessage error={favourite.error} /> : null}
            {ran.status === 'error' ? <ErrorMessage error={ran.error} onRetry={ran.refetch} />
              : run === undefined ? <Loading label="Running it" />
              : run.outcome === 'refused' ? (
                <Banner tone="info" title={run.step !== undefined ? `Not shown: refused at step ${run.step.position}` : 'Not shown'}>
                  {humanise(REFUSED[run.reason] ?? run.reason)}
                  {run.bound !== undefined ? `: ${run.bound.observed !== undefined ? `${run.bound.observed.toLocaleString()} where its bound is ${run.bound.limit.toLocaleString()}` : `its bound is ${run.bound.limit.toLocaleString()}`}` : ''}.
                  {run.step !== undefined ? ' The steps before it stand; open it in Analysis to see them.' : ''}
                </Banner>
              )
              : (
                <>
                  <p className={styles.muted}>Ran <Time value={run.ranAt} />{run.reduced ? ' · some values are not visible to you' : ''}{run.incompleteSources.length > 0 ? ` · ${plural(run.incompleteSources.length, 'source')} did not answer` : ''}</p>
                  <ResultByRef queryId={run.resultRef} label={run.comparedRef !== undefined ? `${view.name}, the first set` : view.name} savedViewId={view.id} />
                  {run.comparedRef !== undefined ? <ResultByRef queryId={run.comparedRef} label={`${view.name}, the second set`} /> : null}
                </>
              )}
            {owner ? <Button variant="ghost" icon="trash" onClick={() => setDialog('archive')} blocked={archive.blocked}>Archive this view</Button> : null}
            <Dialog open={dialog === 'rename' || dialog === 'copy'} onClose={() => setDialog(undefined)} title={dialog === 'copy' ? 'Copy the view' : 'Rename the view'} size="sm"
              busy={rename.pending || copy.pending}>
              <form className={styles.composer} onSubmit={(e) => {
                e.preventDefault();
                if (name.trim() === '') return;
                if (dialog === 'rename') void rename.run({ params: { viewId }, body: { name: name.trim(), lockVersion: view.lockVersion } }).then((r) => r.ok && setDialog(undefined));
                else void copy.run({ params: { viewId }, body: { name: name.trim() } }).then((r) => {
                  if (!r.ok) return;
                  setDialog(undefined);
                  set({ view: r.data.id });
                });
              }}>
                <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                {rename.error !== undefined ? <ErrorMessage error={rename.error} /> : null}
                {copy.error !== undefined ? <ErrorMessage error={copy.error} /> : null}
                <FormActions>
                  <Button onClick={() => setDialog(undefined)}>Cancel</Button>
                  <Button type="submit" variant="primary" pending={rename.pending || copy.pending} disabled={name.trim() === ''}>{dialog === 'copy' ? 'Make the copy' : 'Rename'}</Button>
                </FormActions>
              </form>
            </Dialog>
            <ShareDialog<Access> open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${view.name}`} what="this view" access={ACCESS}
              shares={shares.data?.shares.filter((s) => s.state === 'live' || s.state === 'suspended').map((s) => ({
                id: s.id, grantee: s.grantee, access: s.access, createdAt: s.sharedAt, revokedAt: s.revokedAt,
                note: s.state === 'suspended' ? 'suspended' : s.expiresAt !== null ? `until ${new Date(s.expiresAt).toLocaleDateString('en-GB')}` : undefined,
              }))}
              shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
              onShare={(grantee, access) => share.run({ params: { viewId }, body: { grantee, access } })}
              onRevoke={(shareId) => revoke.run({ params: { viewId, shareId } })} />
            <ConfirmDialog open={dialog === 'archive'} onClose={() => setDialog(undefined)} title={`Archive ${view.name}?`} confirmLabel="Archive" tone="danger"
              onConfirm={async () => {
                const r = await archive.run({ params: { viewId } });
                if (r.ok) {
                  say('View archived');
                  onClose();
                }
                return r;
              }}>
              <p>It leaves your views and your dashboard, and its shares end. You can still find it under Archived.</p>
            </ConfirmDialog>
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

function Inherited() {
  const people = useDirectory();
  const inherited = useQuery('listInheritedViews', {});
  const review = useMutation('reviewInheritedView', { invalidates: ['listInheritedViews', 'listWorkspaceViews'] });
  const say = useToast();
  if (inherited.data === undefined || inherited.data.inherited.length === 0) return null;
  return (
    <Section title="Inherited views to decide on" description="These came to you from a colleague who left or was suspended, or a team that was archived. Keep, share or archive each.">
      <DataTable label="Inherited views" rows={inherited.data.inherited} rowKey={(i) => i.flagId} columns={[
        { id: 'name', header: 'View', primary: true, cell: (i) => i.view.name },
        { id: 'from', header: 'From', cell: (i) => `${people.nameOf(i.transferredFrom)} (${humanise(i.reason).toLowerCase()})` },
        { id: 'when', header: 'Since', width: 'sm', cell: (i) => <Time value={i.createdAt} /> },
        { id: 'decide', header: <span className="visually-hidden">Decide</span>, align: 'end', cell: (i) => (
          <Menu label={`Decide on ${i.view.name}`} items={([['retained', 'Keep it'], ['shared', 'Keep its shares'], ['archived', 'Archive it']] as const).map(([decision, label]): MenuEntry => ({
            label, blocked: review.blocked,
            onSelect: () => void review.run({ params: { flagId: i.flagId }, body: { decision } }).then((r) => r.ok && say(`${i.view.name}: ${label.toLowerCase()}`)),
          }))} renderTrigger={(p) => <Button {...p} size="sm" iconEnd="chevronDown">Decide</Button>} />
        ) },
      ]} />
      {review.error !== undefined ? <ErrorMessage error={review.error} /> : null}
    </Section>
  );
}

const TABS: TabDef<'mine' | 'shared' | 'favourited' | 'archived'>[] = [
  { id: 'mine', label: 'Yours' }, { id: 'shared', label: 'Shared with you' }, { id: 'favourited', label: 'On your dashboard' }, { id: 'archived', label: 'Archived' },
];

export function SavedViews() {
  const [params, set] = useParams();
  const [tab, setTab] = useTab(TABS, 'set');
  const [search, setSearch] = useState('');
  const views = useQuery('listWorkspaceViews', { query: { set: tab, ...(search === '' ? {} : { search }), limit: 200 } }, { keepPrevious: true });
  const people = useDirectory();
  const viewId = params.get('view') ?? undefined;
  usePageContext({ scope: { kind: 'page', page: 'ask' }, scopeLabel: 'Saved views' });
  return (
    <Page title="Saved views" description="Answers and object sets kept to run again: each runs again when opened, as whoever opens it, and is never charged."
      crumbs={[{ label: 'Ask', href: '/ask/threads/' }]}
      actions={<Link href="/ask/threads/?new=1">Ask a question to save</Link>}>
      <Inherited />
      <Tabs label="Saved views" tabs={TABS} current={tab} onChange={setTab} />
      <TabPanel id={tab}>
        <Toolbar><SearchInput label="Search saved views" value={search} onChange={setSearch} /></Toolbar>
        <QueryView query={views} what="Saved views" isEmpty={(d) => d.views.length === 0}
          empty={<EmptyState icon="star" title={tab === 'mine' ? 'No saved views yet' : tab === 'shared' ? 'Nothing shared with you yet' : tab === 'favourited' ? 'Your dashboard is empty' : 'Nothing archived'}>
            {tab === 'mine' ? 'Save an answer from Ask, or a narrowed type from Explorer, to run it again here.' : undefined}
          </EmptyState>}>
          {(d) => (
            <DataTable label="Saved views" rows={d.views} rowKey={(v) => v.id} rowHref={(v) => hrefWith('/ask/views/', { view: v.id, ...(tab === 'mine' ? {} : { set: tab }) })} columns={[
              { id: 'name', header: 'View', primary: true, sortValue: (v) => v.name, cell: (v) => <>{v.name} {v.favourited ? <Badge tone="accent" icon="star">dashboard</Badge> : null}</> },
              { id: 'kind', header: 'Kind', width: 'sm', cell: (v) => KIND[v.kind] },
              { id: 'owner', header: 'Owner', width: 'md', cell: (v) => (v.access === 'owner' ? 'You' : people.nameOf(v.ownerMembershipId)) },
              { id: 'access', header: 'You may', width: 'sm', cell: (v) => (v.access === 'owner' ? 'Everything' : humanise(v.access)) },
              { id: 'ran', header: 'Last run', width: 'sm', sortValue: (v) => v.lastRunAt ?? '', cell: (v) => (v.lastRunAt === null ? 'Not yet' : <Time value={v.lastRunAt} />) },
            ]} />
          )}
        </QueryView>
      </TabPanel>
      {viewId !== undefined ? <ViewDetail key={viewId} viewId={viewId} onClose={() => set({ view: undefined })} /> : null}
    </Page>
  );
}
