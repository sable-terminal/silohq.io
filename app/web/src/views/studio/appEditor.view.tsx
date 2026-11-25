'use client';

// An app's draft and its release (spec 35.2, 35.7, 35.8; D229–D231). The editor works on the
// definition itself; every save is validated against the ontology and kept with what is wrong
// with it, and an invalid draft cannot go to review. A reviewer who is not the author approves it
// (at once, or in stages to scopes one after another) or returns it; an earlier version can be put
// up again. Branches hold work beside main, each with its own draft, compared element by element
// and merged into main's next draft, conflicts decided here and never guessed. Published, it is
// shared, published to scopes (and withdrawn), exported as a package, copied or archived. A custom
// object view layout (34.6) is an app of its own kind: one page, no branches or publications.

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, type Tone } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, RadioGroup, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Panel, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ShareDialog } from '../../components/share.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useData, useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { appHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { blankDefinition, DefinitionEditor } from './appDesign.view.tsx';
import { NameDialog, sharesFor } from './kit.view.tsx';
import type { AppDefinition } from './runtime.view.ts';
import styles from './studio.view.module.css';

type App = Output<'getApp'>;
type Version = App['versions'][number];
type Branch = Output<'listAppBranches'>['branches'][number];
type Conflict = Extract<Output<'mergeAppBranch'>, { outcome: 'conflicts' }>['conflicts'][number];
type Scope = Output<'listMyPermittedScopes'>['scopes'][number];
type Tab = 'design' | 'versions' | 'branches' | 'release';

const STATE: Record<Version['state'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' }, review: { label: 'In review', tone: 'warn' }, returned: { label: 'Returned', tone: 'warn' },
  published: { label: 'Published', tone: 'ok' }, superseded: { label: 'Superseded', tone: 'neutral' },
};
const ACCESS = [
  { value: 'run' as const, label: 'Use it', hint: 'Open the published version' },
  { value: 'view' as const, label: 'View it', hint: 'See how it is built' },
  { value: 'copy' as const, label: 'Copy it', hint: 'Make a draft of their own from it' },
  { value: 'edit' as const, label: 'Edit its drafts', hint: 'A named colleague only' },
];
const BRANCH_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const show = (v: unknown) => (v === undefined ? 'not there' : JSON.stringify(v, null, 1).slice(0, 600));
const editorHref = (appId: string, layout: boolean, extra: Record<string, string | undefined> = {}) =>
  hrefWith(layout ? '/studio/layouts/' : '/studio/apps/', { edit: appId, ...extra });

export function AppEditor({ appId }: { appId: string }) {
  const router = useRouter();
  const say = useToast();
  const read = useQuery('getApp', { params: { appId } });
  const ontology = useQuery('readOntology', { query: {} }, { staleMs: 60_000 });
  const [params, setParams] = useParams();
  const branchId = params.get('branch') ?? undefined;
  const [dialog, setDialog] = useState<'share' | 'copy' | 'archive' | undefined>();
  const copy = useMutation('copyApp', { invalidates: ['listApps'] });
  const archive = useMutation('archiveApp', { invalidates: ['listApps', 'listObjectViewLayouts'] });
  const shares = useQuery('listAppShares', read.data?.app.access === 'owner' && read.data.app.kind === 'app' ? { params: { appId } } : null);
  const share = useMutation('shareApp', { invalidates: ['listAppShares', 'getApp'] });
  const revoke = useMutation('revokeAppShare', { invalidates: ['listAppShares', 'getApp'] });
  usePageContext({ scope: { kind: 'app', appId }, scopeLabel: read.data?.app.name ?? 'this app' });

  const app = read.data;
  const layout = app?.app.kind === 'object_view_layout';
  const tabs: TabDef<Tab>[] = layout
    ? [{ id: 'design', label: 'Design' }, { id: 'versions', label: 'Versions' }]
    : [{ id: 'design', label: 'Design' }, { id: 'versions', label: 'Versions' }, { id: 'branches', label: 'Branches' }, { id: 'release', label: 'Release' }];
  const [tab, setTab] = useTab(tabs);
  const crumbs = [{ label: 'Studio' }, layout ? { label: 'Object view layouts', href: '/studio/layouts/' } : { label: 'Apps', href: '/studio/apps/' }];

  if (app === undefined) {
    return <Page title="App" crumbs={crumbs}><QueryView query={read} what="The app">{() => null}</QueryView></Page>;
  }
  const owner = app.app.access === 'owner';
  const canEdit = owner || app.app.access === 'edit';
  const published = app.versions.find((v) => v.state === 'published');
  const open = branchId === undefined
    ? app.versions.find((v) => v.branchId === null && (v.state === 'draft' || v.state === 'review' || v.state === 'returned'))
    : app.versions.find((v) => v.branchId === branchId && v.state === 'draft');
  return (
    <Page title={app.app.name} documentTitle={app.app.name} width="full" crumbs={crumbs}
      description={app.app.description ?? undefined}
      meta={
        <span className={styles.row}>
          {app.app.archivedAt !== null ? <Badge tone="neutral">Archived</Badge> : published !== undefined ? <Badge tone="ok">Version {published.version} published</Badge> : <Badge tone="neutral">Not published</Badge>}
          {app.app.draft !== null ? <Badge tone={STATE[app.app.draft.state].tone}>{STATE[app.app.draft.state].label} {app.app.draft.version}{app.app.draft.findings > 0 ? `, ${plural(app.app.draft.findings, 'thing')} to fix` : ''}</Badge> : null}
          {app.app.generatedBy === 'ai_fde' ? <Badge tone="info">Proposed by the AI FDE</Badge> : null}
          {branchId !== undefined ? <Badge tone="accent">On a branch</Badge> : null}
        </span>
      }
      actions={
        <div className={styles.row}>
          {published !== undefined && !layout ? <LinkButton href={appHref(appId)} icon="play">Open</LinkButton> : null}
          {owner && !layout ? <Button icon="share" blocked={share.blocked} onClick={() => setDialog('share')}>Share</Button> : null}
          <Menu label="More" items={[
            { label: 'Make a copy', icon: 'copy', disabled: layout || !(canEdit || app.app.access === 'copy'), blocked: copy.blocked, onSelect: () => setDialog('copy') },
            { separator: true },
            { label: 'Archive', icon: 'trash', tone: 'danger', disabled: !owner || app.app.archivedAt !== null, blocked: archive.blocked, onSelect: () => setDialog('archive') },
          ]} renderTrigger={(p) => <IconButton {...p} label="More" icon="more" />} />
        </div>
      }>
      {!canEdit ? <Banner tone="info" title="Shared with you without editing">You can see its versions; only its owner and co-editors change it.</Banner> : null}
      <Tabs label="App" tabs={tabs} current={tab} onChange={setTab} />
      <TabPanel id={tab}>
        {tab === 'design' ? (
          <Design key={`${branchId ?? 'main'}:${open?.id ?? 'none'}`} app={app} open={open} branchId={branchId} head={ontology.data?.version.sequence}
            canEdit={canEdit && app.app.archivedAt === null} layout={layout} published={published} />
        ) : tab === 'versions' ? (
          <Versions app={app} />
        ) : tab === 'branches' ? (
          <Branches appId={appId} published={published?.version} working={branchId}
            onWork={(b, toDesign) => setParams(toDesign ? { branch: b, tab: undefined } : { branch: b })} />
        ) : (
          <Release app={app} />
        )}
      </TabPanel>
      <ShareDialog open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${app.app.name}`} what="this app" access={ACCESS}
        shares={sharesFor(shares.data?.shares)} shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
        onShare={(grantee, access) => share.run({ params: { appId }, body: { grantee, access } })}
        onRevoke={(shareId) => revoke.run({ params: { appId, shareId } })} />
      <NameDialog open={dialog === 'copy'} title="Copy the app" initial={`${app.app.name} (copy)`.slice(0, 200)} action="Make the copy" pending={copy.pending} error={copy.error}
        hint="The copy is a draft of your own, from the published version."
        onClose={() => setDialog(undefined)}
        onSave={(name) => void copy.run({ params: { appId }, body: { name } }).then((r) => {
          if (!r.ok) return;
          setDialog(undefined);
          say('Copied: it is a draft of your own');
          router.push(editorHref(r.data.app.id, false) as never);
        })} />
      <ConfirmDialog open={dialog === 'archive'} onClose={() => setDialog(undefined)} title={`Archive ${app.app.name}?`} confirmLabel="Archive" tone="danger"
        onConfirm={async () => {
          const r = await archive.run({ params: { appId } });
          if (r.ok) {
            say('Archived');
            router.push((layout ? '/studio/layouts/' : '/studio/apps/') as never);
          }
          return r;
        }}>
        <p>{layout ? 'If it is the type\'s layout, object views go back to the generated default.' : 'No one can open it any more; its shares and publications end.'} Its history stays in the audit log.</p>
      </ConfirmDialog>
    </Page>
  );
}

// ----------------------------------------------------------------------------------------- design

function Design({ app, open, branchId, head, canEdit, layout, published }: {
  app: App; open: Version | undefined; branchId: string | undefined; head: number | undefined; canEdit: boolean; layout: boolean; published: Version | undefined;
}) {
  const say = useToast();
  const { api } = useData();
  const appId = app.app.id;
  const draft = useQuery('getAppVersion', open === undefined ? null : { params: { appId, version: open.version } });
  const saveMain = useMutation('saveAppDraft', { invalidates: ['getApp', 'getAppVersion', 'listApps'] });
  const saveBranch = useMutation('saveAppBranchDraft', { invalidates: ['getApp', 'getAppVersion', 'listAppBranches'] });
  const submit = useMutation('submitAppForReview', { invalidates: ['getApp', 'getAppVersion', 'listApps'] });
  const [def, setDef] = useState<AppDefinition | undefined>();
  const [loaded, setLoaded] = useState<{ id: string; lockVersion: number } | undefined>();
  const [dirty, setDirty] = useState(false);
  const [opening, setOpening] = useState<{ pending: boolean; error: unknown }>({ pending: false, error: undefined });

  // The draft as read: taken while nothing is changed here; a newer save by someone else is said, never merged over edits.
  const d = draft.data;
  useEffect(() => {
    if (d === undefined || dirty) return;
    if (loaded?.id === d.id && loaded.lockVersion === d.lockVersion) return;
    const parsed = d.definition as unknown as Partial<AppDefinition>;
    setDef(parsed.schemaVersion === '1' && Array.isArray(parsed.pages) ? { ...blankDefinition(d.ontologyVersion), ...parsed } as AppDefinition : blankDefinition(head ?? d.ontologyVersion));
    setLoaded({ id: d.id, lockVersion: d.lockVersion });
  }, [d, dirty, loaded, head]);

  if (open === undefined) {
    if (!canEdit) return <EmptyState icon="studio" title="No draft open">Its owner or a co-editor opens a draft to change it.</EmptyState>;
    return (
      <EmptyState icon="edit" title={branchId === undefined ? 'No draft open' : 'This branch has no open draft'} action={
        <Button variant="primary" pending={opening.pending} blocked={saveMain.blocked} onClick={async () => {
          setOpening({ pending: true, error: undefined });
          try {
            const from = published === undefined ? blankDefinition(head ?? 1)
              : (await api.call('getAppVersion', { params: { appId, version: published.version } })).definition as unknown as AppDefinition;
            const r = await saveMain.run({ body: { definition: { ...from, ontologyVersion: head ?? from.ontologyVersion } as never }, params: { appId } });
            setOpening({ pending: false, error: r.ok ? undefined : r.error });
          } catch (error) {
            setOpening({ pending: false, error });
          }
        }}>Open a new draft</Button>
      }>
        {published === undefined ? 'Start from a blank page.' : `A new draft starts from version ${published.version}, as published.`}
        {opening.error !== undefined ? <ErrorMessage error={opening.error} /> : null}
      </EmptyState>
    );
  }
  if (d === undefined || def === undefined) return draft.status === 'error' ? <ErrorMessage error={draft.error} onRetry={draft.refetch} /> : <Loading label="Reading the draft" />;
  const inReview = d.state === 'review';
  const editable = canEdit && !inReview;
  const stale = loaded !== undefined && loaded.lockVersion !== d.lockVersion;
  const save = async () => {
    const r = branchId !== undefined
      ? await saveBranch.run({ params: { appId, branchId }, body: { definition: def as never, lockVersion: loaded?.lockVersion ?? d.lockVersion } })
      : await saveMain.run({ params: { appId }, body: { definition: { ...def, ontologyVersion: head ?? def.ontologyVersion } as never, lockVersion: loaded?.lockVersion ?? d.lockVersion } });
    if (!r.ok) return;
    setDirty(false);
    setLoaded(undefined);
    say(r.data.findings.length === 0 ? 'Saved. It validates.' : `Saved with ${plural(r.data.findings.length, 'thing')} to fix`);
  };
  const saving = saveMain.pending || saveBranch.pending;
  const saveError = saveMain.error ?? saveBranch.error;
  return (
    <div className={styles.stack}>
      {inReview ? <Banner tone="info" title="In review">A reviewer who is not its author approves it or returns it. It cannot be changed while it waits.</Banner> : null}
      {d.state === 'returned' ? <Banner tone="warn" title="Returned">The reviewer sent it back. Change it and submit it again.</Banner> : null}
      {stale && dirty ? <Banner tone="warn" title="Saved by someone else since you opened it">Saving now would be refused. Copy what you changed, then read it again.</Banner> : null}
      {d.findings.length > 0 ? (
        <Banner tone="warn" title={`${plural(d.findings.length, 'thing')} to fix before it can go to review`}>
          <ul className={styles.plainList}>{d.findings.map((f, i) => <li key={i}><span className={styles.mono}>{f.path}</span>: {f.message}</li>)}</ul>
        </Banner>
      ) : null}
      <div className={styles.row}>
        {editable ? <Button variant="primary" icon="check" pending={saving} disabled={!dirty} blocked={branchId !== undefined ? saveBranch.blocked : saveMain.blocked} onClick={() => void save()}>Save the draft</Button> : null}
        <LinkButton href={appHref(appId, d.version)} icon="play">Preview draft {d.version}</LinkButton>
        {canEdit && branchId === undefined && (d.state === 'draft' || d.state === 'returned') ? (
          <Button pending={submit.pending} blocked={dirty ? 'Save the draft first' : d.findings.length > 0 ? 'Fix what is listed first' : submit.blocked}
            onClick={() => void submit.run({ params: { appId, version: d.version }, body: { lockVersion: d.lockVersion } }).then((r) => r.ok && say('Submitted for review'))}>
            Submit for review
          </Button>
        ) : null}
        {dirty ? <span className={styles.muted}>Unsaved changes</span> : null}
      </div>
      {saveError !== undefined ? <ErrorMessage error={saveError} /> : null}
      {submit.error !== undefined ? <ErrorMessage error={submit.error} /> : null}
      <DefinitionEditor def={def} readOnly={!editable} layout={layout} onChange={(next) => {
        setDef(next);
        setDirty(true);
      }} />
    </div>
  );
}

// --------------------------------------------------------------------------------------- versions

function StagePicker({ open, scopes, pending, error, onApprove, onClose }: {
  open: boolean; scopes: readonly Scope[]; pending: boolean; error: unknown; onApprove: (stages: { scopeIds: string[] }[]) => void; onClose: () => void;
}) {
  const [stages, setStages] = useState<string[][]>([[]]);
  const toggle = (i: number, id: string, on: boolean) => setStages(stages.map((s, j) => (j === i ? (on ? [...s, id] : s.filter((x) => x !== id)) : s)));
  return (
    <Dialog open={open} onClose={onClose} title="Approve in stages" size="md" busy={pending}
      description="The first stage opens the new version as soon as it is approved; everyone else keeps the version they have until you release their stage.">
      <div className={styles.form}>
        {stages.map((stage, i) => (
          <fieldset key={i} className={styles.fieldset}>
            <legend>Stage {i + 1}</legend>
            <div className={styles.checks}>{scopes.map((s) => (
              <Checkbox key={s.id} label={s.name} checked={stage.includes(s.id)} onChange={(e) => toggle(i, s.id, e.target.checked)} />
            ))}</div>
          </fieldset>
        ))}
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions>
          {stages.length < 5 ? <Button icon="plus" onClick={() => setStages([...stages, []])}>Add a stage</Button> : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" pending={pending} disabled={stages.some((s) => s.length === 0)} onClick={() => onApprove(stages.map((scopeIds) => ({ scopeIds })))}>Approve and release stage 1</Button>
        </FormActions>
      </div>
    </Dialog>
  );
}

function Versions({ app }: { app: App }) {
  const say = useToast();
  const people = useDirectory();
  const appId = app.app.id;
  const scopes = useQuery('listMyPermittedScopes', { query: { permission: 'app.publish' } });
  const approve = useMutation('approveAppVersion', { invalidates: ['getApp', 'listApps', 'listAppReleases', 'listObjectViewLayouts'] });
  const ret = useMutation('returnAppVersion', { invalidates: ['getApp', 'listApps'] });
  const rollback = useMutation('rollbackApp', { invalidates: ['getApp', 'listApps'] });
  const [staging, setStaging] = useState<Version | undefined>();
  const [comparing, setComparing] = useState<{ from: number; to: number } | undefined>();
  const compare = useQuery('compareAppVersions', comparing === undefined ? null : { params: { appId }, query: { from: comparing.from, to: comparing.to } });
  const main = app.versions.filter((v) => v.branchId === null);
  const published = main.find((v) => v.state === 'published');
  const releasedBefore = main.some((v) => v.state === 'published' || v.state === 'superseded');
  const layout = app.app.kind === 'object_view_layout';
  const error = approve.error ?? ret.error ?? rollback.error;
  return (
    <div className={styles.stack}>
      {error !== undefined ? <ErrorMessage error={error} /> : null}
      <DataTable label="Versions" rows={[...main].reverse()} rowKey={(v) => v.id} columns={[
        { id: 'version', header: 'Version', primary: true, width: 'sm', cell: (v) => <>{v.version}{v.rolledBackFromVersion !== null ? <span className={styles.muted}> (from {v.rolledBackFromVersion})</span> : null}</> },
        { id: 'state', header: 'State', width: 'md', cell: (v) => <span className={styles.row}><Badge tone={STATE[v.state].tone}>{STATE[v.state].label}</Badge>{v.findings.length > 0 ? <Badge tone="warn">{plural(v.findings.length, 'thing')} to fix</Badge> : null}</span> },
        { id: 'by', header: 'Written by', cell: (v) => people.nameOf(v.authoredBy) },
        { id: 'reviewed', header: 'Reviewed by', cell: (v) => (v.reviewedBy === null ? '—' : people.nameOf(v.reviewedBy)) },
        { id: 'when', header: 'Published', width: 'sm', cell: (v) => (v.publishedAt === null ? '—' : <Time value={v.publishedAt} />) },
        { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (v) => (
          <Menu label={`Version ${v.version}`} items={[
            ...(v.state === 'review' ? [
              { label: 'Approve and publish', icon: 'check' as const, blocked: approve.blocked, onSelect: () => void approve.run({ params: { appId, version: v.version }, body: { lockVersion: v.lockVersion } }).then((r) => r.ok && say(`Version ${v.version} published`)) },
              ...(!layout && releasedBefore ? [{ label: 'Approve in stages', icon: 'branch' as const, blocked: approve.blocked, disabled: (scopes.data?.scopes.length ?? 0) === 0, onSelect: () => setStaging(v) }] : []),
              { label: 'Return to its author', icon: 'arrowLeft' as const, blocked: ret.blocked, onSelect: () => void ret.run({ params: { appId, version: v.version }, body: { lockVersion: v.lockVersion } }).then((r) => r.ok && say('Returned')) },
            ] : []),
            ...(v.state === 'superseded' ? [{ label: 'Put this version up again', icon: 'undo' as const, blocked: rollback.blocked, onSelect: () => void rollback.run({ params: { appId }, body: { toVersion: v.version } }).then((r) => r.ok && say(`Version ${v.version} is up again, as a new version`)) }] : []),
            ...(published !== undefined && v.version !== published.version ? [{ label: `Compare with version ${published.version}`, icon: 'arrowUpDown' as const, onSelect: () => setComparing({ from: published.version, to: v.version }) }] : []),
            ...(v.state === 'draft' || v.state === 'review' || v.state === 'returned' ? [{ label: 'Preview it', icon: 'play' as const, href: appHref(appId, v.version) }] : []),
          ]} renderTrigger={(p) => <IconButton {...p} size="sm" label={`Version ${v.version} actions`} icon="more" />} />
        ) },
      ]} />
      <StagePicker key={staging?.id ?? 'none'} open={staging !== undefined} scopes={scopes.data?.scopes ?? []} pending={approve.pending} error={approve.error}
        onClose={() => setStaging(undefined)}
        onApprove={(stages) => {
          const v = staging!;
          void approve.run({ params: { appId, version: v.version }, body: { lockVersion: v.lockVersion, stages } }).then((r) => {
            if (!r.ok) return;
            setStaging(undefined);
            say(`Version ${v.version} approved; stage 1 has it now`);
          });
        }} />
      <Dialog open={comparing !== undefined} onClose={() => setComparing(undefined)} drawer title={comparing === undefined ? 'Compare' : `Version ${comparing.to} against ${comparing.from}`}>
        <QueryView query={compare} what="The comparison">
          {(c) => c.changes.length === 0 ? <p className={styles.muted}>No differences.</p> : (
            <ul className={styles.plainList}>{c.changes.map((x) => <li key={x.path}><span className={styles.mono}>{x.path}</span> <Badge tone={x.change === 'removed' ? 'danger' : x.change === 'added' ? 'ok' : 'info'}>{x.change}</Badge></li>)}</ul>
          )}
        </QueryView>
      </Dialog>
    </div>
  );
}

// --------------------------------------------------------------------------------------- branches

function Branches({ appId, published, working, onWork }: {
  appId: string; published: number | undefined; working: string | undefined;
  /** Work on a branch's draft (its id) or main's (undefined), going to the design when asked. */
  onWork: (branchId: string | undefined, toDesign: boolean) => void;
}) {
  const say = useToast();
  const people = useDirectory();
  const list = useQuery('listAppBranches', { params: { appId } });
  const ontologyBranches = useQuery('listOntologyBranches', { query: { status: 'open' } });
  const openBranch = useMutation('openAppBranch', { invalidates: ['listAppBranches', 'getApp'] });
  const merge = useMutation('mergeAppBranch', { invalidates: ['listAppBranches', 'getApp', 'listApps'] });
  const abandon = useMutation('abandonAppBranch', { invalidates: ['listAppBranches', 'getApp'] });
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [bindTo, setBindTo] = useState('');
  const [comparing, setComparing] = useState<Branch | undefined>();
  const [abandoning, setAbandoning] = useState<Branch | undefined>();
  const [conflicts, setConflicts] = useState<{ branch: Branch; list: Conflict[]; take: Record<string, 'main' | 'branch'> } | undefined>();
  const compare = useQuery('compareAppVersions', comparing?.draftVersion == null || published === undefined ? null : { params: { appId }, query: { from: published, to: comparing.draftVersion } });
  const working_ = ontologyBranches.data?.branches.filter((b) => b.kind === 'working') ?? [];

  const doMerge = async (b: Branch, take: Record<string, 'main' | 'branch'> = {}) => {
    const r = await merge.run({ params: { appId, branchId: b.id }, body: { lockVersion: b.lockVersion, decisions: Object.entries(take).map(([path, side]) => ({ path, take: side })) } });
    if (!r.ok) return;
    if (r.data.outcome === 'conflicts') {
      setConflicts({ branch: b, list: r.data.conflicts, take });
      return;
    }
    setConflicts(undefined);
    if (working === b.id) onWork(undefined, false);
    say(`Merged: main's draft ${r.data.draft.version} holds it`);
  };

  return (
    <Section title="Branches" description="Lines of work beside main, each with a draft of its own, optionally built on an ontology branch still in review."
      actions={<Button icon="plus" blocked={published === undefined ? 'A branch is opened from a published version' : openBranch.blocked} onClick={() => setMaking(true)}>New branch</Button>}>
      <div className={styles.stack}>
        <p className={styles.row}>Working on <strong>{working === undefined ? 'main' : list.data?.branches.find((b) => b.id === working)?.name ?? 'a branch'}</strong>
          {working !== undefined ? <Button size="sm" variant="ghost" onClick={() => onWork(undefined, true)}>Work on main</Button> : null}</p>
        {merge.error !== undefined ? <ErrorMessage error={merge.error} /> : null}
        <QueryView query={list} what="Branches" isEmpty={(d) => d.branches.length === 0} empty={<p className={styles.muted}>No branches yet.</p>}>
          {(d) => (
            <DataTable label="Branches" rows={d.branches} rowKey={(b) => b.id} columns={[
              { id: 'name', header: 'Branch', primary: true, cell: (b) => <span className={styles.mono}>{b.name}</span> },
              { id: 'on', header: 'Built on', cell: (b) => (b.ontologyBranchId === null ? "Main's ontology" : `Ontology branch ${working_.find((o) => o.id === b.ontologyBranchId)?.name ?? '(closed)'}`) },
              { id: 'from', header: 'From', width: 'sm', cell: (b) => (b.baseVersion === null ? '—' : `version ${b.baseVersion}`) },
              { id: 'state', header: 'State', width: 'md', cell: (b) => (b.status === 'open' ? <Badge tone="info">Open</Badge> : b.status === 'merged' ? <Badge tone="ok">Merged as version {b.mergedVersion ?? '?'}</Badge> : <Badge>Abandoned</Badge>) },
              { id: 'by', header: 'By', cell: (b) => people.nameOf(b.createdBy) },
              { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (b) => b.status !== 'open' ? null : (
                <Menu label={b.name} items={[
                  { label: 'Work on it', icon: 'edit', disabled: working === b.id, onSelect: () => onWork(b.id, true) },
                  { label: 'Compare with main', icon: 'arrowUpDown', disabled: b.draftVersion === null || published === undefined, onSelect: () => setComparing(b) },
                  { label: 'Merge into main', icon: 'branch', blocked: merge.blocked, onSelect: () => void doMerge(b) },
                  { separator: true },
                  { label: 'Abandon', icon: 'trash', tone: 'danger', blocked: abandon.blocked, onSelect: () => setAbandoning(b) },
                ]} renderTrigger={(p) => <IconButton {...p} size="sm" label={`${b.name} actions`} icon="more" />} />
              ) },
            ]} />
          )}
        </QueryView>
      </div>
      <Dialog open={making} onClose={() => setMaking(false)} title="New branch" size="sm" busy={openBranch.pending}>
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await openBranch.run({ params: { appId }, body: { name, ...(bindTo === '' ? {} : { ontologyBranchId: bindTo }) } });
          if (!r.ok) return;
          setMaking(false);
          setName('');
          setBindTo('');
          onWork(r.data.branch.id, true);
        }}>
          <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="pump-alerts" hint="Lower-case letters, digits and hyphens."
            error={name !== '' && !BRANCH_NAME.test(name) ? 'Lower-case letters, digits and hyphens, starting with a letter or digit' : undefined} />
          <SelectField label="Built on" value={bindTo} onChange={(e) => setBindTo(e.target.value)}
            options={[{ value: '', label: "Main's ontology" }, ...working_.map((o) => ({ value: o.id, label: `Ontology branch ${o.name}` }))]} />
          {openBranch.error !== undefined ? <ErrorMessage error={openBranch.error} /> : null}
          <FormActions>
            <Button onClick={() => setMaking(false)}>Cancel</Button>
            <Button type="submit" variant="primary" pending={openBranch.pending} disabled={!BRANCH_NAME.test(name)}>Open the branch</Button>
          </FormActions>
        </form>
      </Dialog>
      <Dialog open={comparing !== undefined} onClose={() => setComparing(undefined)} drawer title={`${comparing?.name ?? ''} against main`}>
        <QueryView query={compare} what="The comparison">
          {(c) => c.changes.length === 0 ? <p className={styles.muted}>The branch changes nothing against main.</p> : (
            <ul className={styles.plainList}>{c.changes.map((x) => <li key={x.path}><span className={styles.mono}>{x.path}</span> <Badge tone={x.change === 'removed' ? 'danger' : x.change === 'added' ? 'ok' : 'info'}>{x.change}</Badge></li>)}</ul>
          )}
        </QueryView>
      </Dialog>
      <Dialog open={conflicts !== undefined} onClose={() => setConflicts(undefined)} title="Decide each conflict" size="lg" busy={merge.pending}
        description={conflicts === undefined ? undefined : `Main and ${conflicts.branch.name} changed ${plural(conflicts.list.length, 'element')} differently. Choose which to keep for each.`}>
        {conflicts !== undefined ? (
          <div className={styles.form}>
            {conflicts.list.map((c) => (
              <div key={c.path} className={styles.card}>
                <span className={styles.mono}>{c.path}</span>
                <div className={styles.compare}>
                  <pre className={styles.code} aria-label="Main">{show(c.main)}</pre>
                  <pre className={styles.code} aria-label="The branch">{show(c.branch)}</pre>
                </div>
                <RadioGroup label="Keep" name={c.path} value={conflicts.take[c.path] ?? ''} onChange={(v) => setConflicts({ ...conflicts, take: { ...conflicts.take, [c.path]: v as 'main' | 'branch' } })}
                  options={[{ value: 'main', label: "Main's" }, { value: 'branch', label: "The branch's" }]} />
              </div>
            ))}
            {merge.error !== undefined ? <ErrorMessage error={merge.error} /> : null}
            <FormActions>
              <Button onClick={() => setConflicts(undefined)}>Not now</Button>
              <Button variant="primary" pending={merge.pending} disabled={conflicts.list.some((c) => conflicts.take[c.path] === undefined)} onClick={() => void doMerge(conflicts.branch, conflicts.take)}>Merge with these choices</Button>
            </FormActions>
          </div>
        ) : null}
      </Dialog>
      <ConfirmDialog open={abandoning !== undefined} onClose={() => setAbandoning(undefined)} title={`Abandon ${abandoning?.name ?? 'the branch'}?`} confirmLabel="Abandon" tone="danger"
        onConfirm={async () => {
          const b = abandoning!;
          const r = await abandon.run({ params: { appId, branchId: b.id }, body: { lockVersion: b.lockVersion } });
          if (r.ok && working === b.id) onWork(undefined, false);
          return r;
        }}><p>Its draft is kept in the history but can no longer be merged.</p></ConfirmDialog>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------- release

function Release({ app }: { app: App }) {
  const say = useToast();
  const people = useDirectory();
  const appId = app.app.id;
  const published = app.versions.find((v) => v.state === 'published');
  const canEdit = app.app.access === 'owner' || app.app.access === 'edit';
  const scopes = useQuery('listMyPermittedScopes', { query: { permission: 'app.publish' } });
  const releases = useQuery('listAppReleases', { params: { appId } });
  const publications = useQuery('listAppPublications', { params: { appId } });
  const promote = useMutation('promoteAppRelease', { invalidates: ['listAppReleases', 'getApp'] });
  const rollBack = useMutation('rollBackAppRelease', { invalidates: ['listAppReleases', 'getApp'] });
  const publish = useMutation('publishAppToScope', { invalidates: ['listAppPublications', 'getApp', 'listApps'] });
  const withdraw = useMutation('withdrawAppPublication', { invalidates: ['listAppPublications', 'getApp', 'listApps'] });
  const exportIt = useMutation('exportAppPackage');
  const [scopeId, setScopeId] = useState('');
  const [mobile, setMobile] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | undefined>();
  const nameOf = (id: string) => scopes.data?.scopes.find((s) => s.id === id)?.name ?? people.scopeName(id);
  const rolling = releases.data?.releases.find((r) => r.status === 'rolling_out');
  const last = releases.data?.releases[0];
  return (
    <div className={styles.stack}>
      <Section title="Rollout" description="A version approved in stages reaches each stage's scopes when its stage is released; everyone else keeps the version before.">
        <QueryView query={releases} what="Releases" isEmpty={(d) => d.releases.length === 0} empty={<p className={styles.muted}>No staged release yet: an approval in stages starts one.</p>}>
          {() => rolling !== undefined ? (
            <Panel>
              <div className={styles.stack}>
                <p>Version {rolling.toVersion} is rolling out; everyone not yet reached opens version {rolling.fromVersion}.</p>
                <ol className={styles.plainList}>{rolling.stages.map((s) => (
                  <li key={s.ordinal}>{s.scopeIds.map(nameOf).join(', ')}: {s.releasedAt === null ? <Badge tone="warn">Waiting</Badge> : <>released <Time value={s.releasedAt} /></>}</li>
                ))}</ol>
                <div className={styles.row}>
                  <Button variant="primary" pending={promote.pending} blocked={promote.blocked}
                    onClick={() => void promote.run({ params: { appId, releaseId: rolling.id }, body: { lockVersion: rolling.lockVersion } }).then((r) => r.ok && say('Released'))}>
                    {rolling.stages.some((s) => s.releasedAt === null) ? 'Release the next stage' : 'Complete the release'}
                  </Button>
                  <Button variant="danger" pending={rollBack.pending} blocked={rollBack.blocked}
                    onClick={() => void rollBack.run({ params: { appId, releaseId: rolling.id }, body: { lockVersion: rolling.lockVersion } }).then((r) => r.ok && say(`Rolled back: everyone opens version ${rolling.fromVersion}`))}>Roll back</Button>
                </div>
                {promote.error !== undefined ? <ErrorMessage error={promote.error} /> : null}
                {rollBack.error !== undefined ? <ErrorMessage error={rollBack.error} /> : null}
              </div>
            </Panel>
          ) : last !== undefined ? (
            <p className={styles.muted}>Version {last.toVersion} {last.status === 'complete' ? 'reached everyone' : `was rolled back: everyone opens version ${last.fromVersion}`}.</p>
          ) : null}
        </QueryView>
      </Section>
      <Section title="Published to scopes" description="Everyone in a scope, and the scopes within it, can open the published version from their directory.">
        <div className={styles.stack}>
          <QueryView query={publications} what="Publications" isEmpty={(d) => d.publications.length === 0} empty={<p className={styles.muted}>Not published to any scope.</p>}>
            {(d) => (
              <DataTable label="Publications" rows={d.publications} rowKey={(p) => p.id} columns={[
                { id: 'scope', header: 'Scope', primary: true, cell: (p) => nameOf(p.scopeId) },
                { id: 'mobile', header: 'On mobile', width: 'sm', cell: (p) => (p.mobileEnabled ? 'Yes' : 'No') },
                { id: 'by', header: 'Published by', cell: (p) => people.nameOf(p.publishedBy) },
                { id: 'when', header: 'Since', width: 'sm', cell: (p) => <Time value={p.publishedAt} /> },
                { id: 'act', header: <span className="visually-hidden">Withdraw</span>, align: 'end', cell: (p) => <Button size="sm" variant="ghost" blocked={withdraw.blocked} onClick={() => setWithdrawing(p.id)}>Withdraw</Button> },
              ]} />
            )}
          </QueryView>
          {published !== undefined ? (
            <form className={styles.rowEnd} aria-label="Publish to a scope" onSubmit={async (e) => {
              e.preventDefault();
              const r = await publish.run({ params: { appId }, body: { scopeId, mobileEnabled: mobile } });
              if (r.ok) {
                setScopeId('');
                say(`Published to ${nameOf(r.data.scopeId)}`);
              }
            }}>
              <SelectField label="Publish to" value={scopeId} placeholder={scopes.data === undefined ? 'Listing…' : (scopes.data.scopes.length === 0 ? 'No scope where you may publish' : 'Choose a scope')}
                onChange={(e) => setScopeId(e.target.value)} options={(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: `${'— '.repeat(s.depth)}${s.name}` }))} />
              <Checkbox label="Also on mobile" checked={mobile} onChange={(e) => setMobile(e.target.checked)} />
              <Button type="submit" pending={publish.pending} blocked={publish.blocked} disabled={scopeId === ''}>Publish</Button>
            </form>
          ) : <p className={styles.muted}>A reviewed, published version is published to scopes.</p>}
          {publish.error !== undefined ? <ErrorMessage error={publish.error} /> : null}
        </div>
      </Section>
      <Section title="Package" description="The published version as a file another organisation or cell imports; each element it uses is found there by its API name.">
        <div className={styles.row}>
          <Button icon="download" pending={exportIt.pending} blocked={published === undefined ? 'Publish a version first' : !canEdit ? 'Its owner or a co-editor exports it' : exportIt.blocked}
            onClick={() => void exportIt.run({ params: { appId }, body: {} }).then((r) => r.ok && say(`Saved to Files as ${r.data.file.name}${r.data.unresolved > 0 ? `; ${plural(r.data.unresolved, 'id')} in it name nothing in the ontology` : ''}`))}>
            Export as a package
          </Button>
          {exportIt.data !== undefined ? <LinkButton href={hrefWith('/files/all/', { file: exportIt.data.file.id })} variant="link">Open it in Files</LinkButton> : null}
        </div>
        {exportIt.error !== undefined ? <ErrorMessage error={exportIt.error} /> : null}
      </Section>
      <ConfirmDialog open={withdrawing !== undefined} onClose={() => setWithdrawing(undefined)} title="Withdraw the publication?" confirmLabel="Withdraw" tone="danger"
        onConfirm={() => withdraw.run({ params: { appId, publicationId: withdrawing! } }).then((r) => {
          if (r.ok) say('Withdrawn');
          return r;
        })}><p>Members who reach the app only through this scope can no longer open it.</p></ConfirmDialog>
    </div>
  );
}

