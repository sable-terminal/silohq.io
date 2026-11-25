'use client';

// Studio apps (spec 35): operational applications, each a definition one generic runtime renders
// under the permissions of whoever opens it. The directory (a person's own, those shared with
// them, those published to their scopes, and archived ones), apps that came to them when their
// owner left (35.8), a new app from a blank page or a structural template bound to the
// organisation's own types (checked and previewed as the person would see it before anything is
// saved), and an app imported from another organisation's package (D231). The same page opens an
// app (?app=) and its editor (?edit=).

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton, LinkButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Panel } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { type TabDef, TabPanel, Tabs, useTab } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { appEditorHref, appHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { AppEditor } from './appEditor.view.tsx';
import { AppRuntime } from './appRuntime.view.tsx';
import { HELD, idFrom, NameDialog } from './kit.view.tsx';
import styles from './studio.view.module.css';

type App = Output<'listApps'>['apps'][number];
type Filter = 'mine' | 'shared' | 'published' | 'archived';
type Template = Output<'listAppTemplates'>['templates'][number];
type CreateBody = NonNullable<Input<'createApp'>['body']>;

const FILTERS: TabDef<Filter>[] = [
  { id: 'mine', label: 'Yours' }, { id: 'shared', label: 'Shared with you' }, { id: 'published', label: 'Published to your teams' }, { id: 'archived', label: 'Archived' },
];
const REASON: Record<Output<'listInheritedApps'>['inherited'][number]['reason'], string> = {
  member_removed: 'its owner left the organisation', member_suspended: 'its owner was suspended', scope_archived: 'the team it belonged to was archived',
};
const ELEMENT: Record<string, string> = {
  object_type: 'object type', property: 'property', link_type: 'link type', function: 'Function', action_type: 'Action type', shared_property: 'shared property',
};

/** /studio/apps/: the directory, an app opened, or an app's editor. */
export function Apps() {
  const [params] = useParams();
  const app = params.get('app');
  const edit = params.get('edit');
  if (app !== null) {
    const id = idFrom(app);
    const version = params.get('version');
    return id === undefined ? <NotAnApp /> : <AppRuntime key={`${id}:${version ?? ''}`} appId={id} version={version === null || !/^\d+$/.test(version) ? undefined : Number(version)} />;
  }
  if (edit !== null) {
    const id = idFrom(edit);
    return id === undefined ? <NotAnApp /> : <AppEditor key={id} appId={id} />;
  }
  return <Directory />;
}

function NotAnApp() {
  return (
    <Page title="Apps" crumbs={[{ label: 'Studio' }]}>
      <EmptyState icon="studio" title="This address does not name an app" action={<LinkButton href="/studio/apps/">All apps</LinkButton>}>Check the link you followed.</EmptyState>
    </Page>
  );
}

function state(a: App): string {
  if (a.archivedAt !== null) return 'Archived';
  const live = a.currentVersionId === null ? 'Not published' : a.visibility === 'published' ? 'Published' : a.visibility === 'shared' ? 'Shared' : 'Published, private';
  if (a.draft === null) return live;
  const draft = `draft ${a.draft.version} ${a.draft.state === 'review' ? 'in review' : a.draft.state === 'returned' ? 'returned' : 'open'}`;
  return `${live}; ${draft}${a.draft.findings > 0 ? `, ${plural(a.draft.findings, 'thing')} to fix` : ''}`;
}

function Directory() {
  const router = useRouter();
  const say = useToast();
  const [params, set] = useParams();
  const [filter, setFilter] = useTab(FILTERS, 'filter');
  const list = useQuery('listApps', { query: { filter } }, { keepPrevious: true });
  const copy = useMutation('copyApp', { invalidates: ['listApps'] });
  const create = useMutation('createApp', { invalidates: ['listApps'] });
  const [copying, setCopying] = useState<App | undefined>();
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: 'Apps' });
  const apps = (list.data?.apps ?? []).filter((a) => a.kind === 'app');
  const editable = (a: App) => (a.access === 'owner' || a.access === 'edit') && a.archivedAt === null;
  const opens = (a: App) => a.currentVersionId !== null && a.archivedAt === null;

  return (
    <Page title="Apps" description="Operational apps over your objects. Each runs under the permissions of whoever opens it."
      crumbs={[{ label: 'Studio' }]}
      actions={
        <div className={styles.row}>
          <Button icon="upload" onClick={() => set({ import: '1' })}>Import a package</Button>
          <Button variant="primary" icon="plus" blocked={create.blocked} onClick={() => set({ new: '1' })}>New app</Button>
        </div>
      }>
      <Inherited />
      <Tabs label="Which apps" tabs={FILTERS} current={filter} onChange={setFilter} />
      <TabPanel id={filter}>
        <QueryView query={list} what="Apps" isEmpty={() => apps.length === 0}
          empty={filter === 'mine'
            ? <EmptyState icon="studio" title="No apps yet" action={<Button variant="primary" icon="plus" blocked={create.blocked} onClick={() => set({ new: '1' })}>New app</Button>}>Start from a template bound to your own types, or from a blank page.</EmptyState>
            : <EmptyState icon="studio" title="None here">{filter === 'shared' ? 'No one has shared an app with you.' : filter === 'published' ? 'No app is published to a team you are in.' : 'No archived apps.'}</EmptyState>}>
          {() => (
            <DataTable label="Apps" rows={apps} rowKey={(a) => a.id}
              rowHref={(a) => (opens(a) ? appHref(a.id) : editable(a) ? appEditorHref(a.id) : undefined)}
              columns={[
                { id: 'name', header: 'App', primary: true, cell: (a) => (
                  <span className={styles.stackTight}>
                    <span className={styles.row}>{a.name}{a.generatedBy === 'ai_fde' ? <Badge tone="info">Proposed by the AI FDE</Badge> : null}</span>
                    {a.description !== null ? <span className={styles.muted}>{a.description}</span> : null}
                  </span>
                ) },
                { id: 'state', header: 'State', cell: (a) => state(a) },
                { id: 'held', header: 'Yours or shared', cell: (a) => HELD[a.access] ?? a.access },
                { id: 'updated', header: 'Changed', width: 'sm', sortValue: (a) => a.updatedAt, cell: (a) => <Time value={a.updatedAt} /> },
                { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (a) => (
                  <Menu label={a.name} items={[
                    { label: 'Open', icon: 'play', disabled: !opens(a), href: appHref(a.id) },
                    { label: 'Edit', icon: 'edit', disabled: !editable(a), href: appEditorHref(a.id) },
                    { label: 'Make a copy', icon: 'copy', disabled: !(editable(a) || a.access === 'copy') || a.currentVersionId === null, blocked: copy.blocked, onSelect: () => setCopying(a) },
                  ]} renderTrigger={(p) => <IconButton {...p} size="sm" label={`${a.name} actions`} icon="more" />} />
                ) },
              ]} />
          )}
        </QueryView>
      </TabPanel>
      {params.get('new') !== null ? <NewApp onClose={() => set({ new: undefined })} onCreate={async (body) => {
        const r = await create.run({ body });
        if (r.ok) router.push(appEditorHref(r.data.app.id) as never);
        return r;
      }} pending={create.pending} error={create.error} /> : null}
      {params.get('import') !== null ? <ImportPackage onClose={() => set({ import: undefined })} /> : null}
      <NameDialog key={copying?.id ?? 'none'} open={copying !== undefined} title="Copy the app" initial={`${copying?.name ?? ''} (copy)`.slice(0, 200)} action="Make the copy"
        pending={copy.pending} error={copy.error} hint="The copy is a draft of your own, from the published version."
        onClose={() => setCopying(undefined)}
        onSave={(name) => void copy.run({ params: { appId: copying!.id }, body: { name } }).then((r) => {
          if (!r.ok) return;
          setCopying(undefined);
          say('Copied: it is a draft of your own');
          router.push(appEditorHref(r.data.app.id) as never);
        })} />
    </Page>
  );
}

/** Apps that came to the person when their owner left: shares suspended until they decide (35.8). */
function Inherited() {
  const say = useToast();
  const people = useDirectory();
  const inherited = useQuery('listInheritedApps', {});
  const review = useMutation('reviewInheritedApp', { invalidates: ['listInheritedApps', 'listApps'] });
  const items = inherited.data?.inherited ?? [];
  if (items.length === 0) return null;
  const decide = (flagId: string, decision: 'shared' | 'retained' | 'archived', said: string) =>
    void review.run({ params: { flagId }, body: { decision } }).then((r) => r.ok && say(said));
  return (
    <Banner tone="warn" title={`${plural(items.length, 'app')} came to you`}>
      <div className={styles.stack}>
        <p>Their shares are suspended until you decide what happens to each.</p>
        {items.map((a) => (
          <div key={a.flagId} className={styles.card}>
            <span><strong>{a.name}</strong> <span className={styles.muted}>from {people.nameOf(a.transferredFrom)}, because {REASON[a.reason]}, <Time value={a.createdAt} /></span></span>
            <div className={styles.row}>
              <Button size="sm" blocked={review.blocked} onClick={() => decide(a.flagId, 'shared', 'Kept, with its shares')}>Keep its shares</Button>
              <Button size="sm" blocked={review.blocked} onClick={() => decide(a.flagId, 'retained', 'Kept; its shares ended')}>Keep it, end its shares</Button>
              <Button size="sm" variant="ghost" blocked={review.blocked} onClick={() => decide(a.flagId, 'archived', 'Archived')}>Archive it</Button>
            </div>
          </div>
        ))}
        {review.error !== undefined ? <ErrorMessage error={review.error} /> : null}
      </div>
    </Banner>
  );
}

/** A new app: blank, or a template over the organisation's own types; checked and previewed before it is made. */
function NewApp({ onClose, onCreate, pending, error }: {
  onClose: () => void; onCreate: (body: CreateBody) => Promise<{ ok: boolean }>; pending: boolean; error: unknown;
}) {
  const { data: vocabulary } = useVocabulary();
  const templates = useQuery('listAppTemplates', {});
  const actions = useQuery('listActionTypes', { query: { status: 'confirmed' } });
  const preview = useMutation('previewApp', { refresh: false });
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [objectTypeId, setObjectTypeId] = useState('');
  const [actionTypeId, setActionTypeId] = useState('');
  const [geoPropertyId, setGeoPropertyId] = useState('');
  const [measurePropertyId, setMeasurePropertyId] = useState('');
  const chosen: Template | undefined = templates.data?.templates.find((t) => t.name === template);
  const type = vocabulary?.objectTypes.find((t) => t.id === objectTypeId);
  const typeActions = (actions.data?.actionTypes ?? []).filter((a) => a.current?.objectTypeId === objectTypeId);
  const needs = (b: Template['requires'][number]) => chosen?.requires.includes(b) === true;
  const missing = chosen !== undefined && (objectTypeId === '' || (needs('actionTypeId') && actionTypeId === '') || (needs('geoPropertyId') && geoPropertyId === '') || (needs('measurePropertyId') && measurePropertyId === ''));
  const body: CreateBody = chosen === undefined ? { name: name.trim() } : {
    name: name.trim(),
    template: {
      name: chosen.name,
      bindings: {
        objectTypeId,
        ...(actionTypeId === '' ? {} : { actionTypeId }),
        ...(geoPropertyId === '' ? {} : { geoPropertyId }),
        ...(measurePropertyId === '' ? {} : { measurePropertyId }),
      },
    },
  };
  const ready = name.trim() !== '' && !missing;
  const shown = preview.data;
  return (
    <Dialog open onClose={onClose} title="New app" size="lg" busy={pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        if (ready) await onCreate(body);
      }}>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => {
          setName(e.target.value);
          preview.reset();
        }} data-autofocus />
        <SelectField label="Start from" value={template} onChange={(e) => {
          setTemplate(e.target.value);
          preview.reset();
        }} options={[{ value: '', label: 'A blank page' }, ...(templates.data?.templates ?? []).map((t) => ({ value: t.name, label: t.description }))]} />
        {chosen !== undefined ? (
          <div className={styles.fields}>
            <SelectField label="Over" required value={objectTypeId} placeholder="Choose an object type" onChange={(e) => {
              setObjectTypeId(e.target.value);
              setActionTypeId('');
              setGeoPropertyId('');
              setMeasurePropertyId('');
              preview.reset();
            }} options={(vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.pluralName }))} />
            {objectTypeId !== '' && (needs('actionTypeId') || typeActions.length > 0) ? (
              <SelectField label={needs('actionTypeId') ? 'Action' : 'Action (optional)'} required={needs('actionTypeId')} value={actionTypeId} placeholder="None"
                onChange={(e) => setActionTypeId(e.target.value)} options={typeActions.map((a) => ({ value: a.id, label: a.displayName }))}
                hint={needs('actionTypeId') && typeActions.length === 0 ? 'This type has no confirmed Action yet.' : undefined} />
            ) : null}
            {objectTypeId !== '' && needs('geoPropertyId') ? (
              <SelectField label="Where" required value={geoPropertyId} placeholder="Choose a property" onChange={(e) => setGeoPropertyId(e.target.value)}
                options={(type?.properties ?? []).filter((p) => p.dataType === 'geopoint' || p.dataType === 'geoshape').map((p) => ({ value: p.identityId, label: p.displayName }))} />
            ) : null}
            {objectTypeId !== '' && needs('measurePropertyId') ? (
              <SelectField label="Measure" required value={measurePropertyId} placeholder="Choose a property" onChange={(e) => setMeasurePropertyId(e.target.value)}
                options={(type?.properties ?? []).filter((p) => ['integer', 'decimal', 'money', 'duration'].includes(p.dataType)).map((p) => ({ value: p.identityId, label: p.displayName }))} />
            ) : null}
          </div>
        ) : null}
        {shown !== undefined ? (
          <Panel>
            <div className={styles.stackTight}>
              <strong>{shown.findings.length === 0 ? 'It validates.' : `${plural(shown.findings.length, 'thing')} to fix after it is made:`}</strong>
              {shown.findings.length > 0 ? <ul className={styles.plainList}>{shown.findings.map((f, i) => <li key={i}><span className={styles.mono}>{f.path}</span>: {f.message}</li>)}</ul> : null}
              {shown.rendered !== null ? (
                <>
                  <span className={styles.muted}>As you would see it: {plural(shown.rendered.widgets.length, 'widget')}{shown.rendered.withheld > 0 ? `, ${plural(shown.rendered.withheld, 'element')} withheld from you` : ''}.</span>
                  <ul className={styles.plainList}>{shown.rendered.widgets.filter((w) => w.status !== 'available').map((w) => (
                    <li key={w.id}><span className={styles.mono}>{w.id}</span>: {w.status === 'unavailable' ? 'not available' : w.status === 'disabled' ? 'disabled' : 'partly shown'}{w.reason !== null ? `, ${w.reason}` : ''}</li>
                  ))}</ul>
                  {shown.rendered.statement !== null ? <span className={styles.muted}>{shown.rendered.statement}</span> : null}
                </>
              ) : null}
            </div>
          </Panel>
        ) : null}
        {preview.error !== undefined ? <ErrorMessage error={preview.error} /> : null}
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button pending={preview.pending} blocked={preview.blocked} disabled={!ready} onClick={() => void preview.run({ body: body as never })}>Check it first</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={!ready}>Create the app</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

/** An app from another organisation's package (D231): its elements found here by API name; what is not, named. */
function ImportPackage({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const imp = useMutation('importAppPackage', { invalidates: ['listApps'] });
  const [file, setFile] = useState<File | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const made = imp.data;
  return (
    <Dialog open onClose={onClose} title="Import a package" size="md" busy={imp.pending}
      description="An app exported from another organisation or cell. Each object type, property, link, Function and Action it uses is found here by its API name.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        if (file === undefined) return;
        setProblem(undefined);
        let parsed: unknown;
        try {
          parsed = JSON.parse(await file.text());
        } catch {
          setProblem('That file is not a Silo app package.');
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setProblem('That file is not a Silo app package.');
          return;
        }
        await imp.run({ body: { package: parsed as never } });
      }}>
        <TextField label="Package file" type="file" accept=".json,application/json" onChange={(e) => {
          setFile(e.target.files?.[0]);
          imp.reset();
        }} error={problem} />
        {made !== undefined ? (
          <Banner tone={made.unmapped.length === 0 ? 'ok' : 'warn'} title={`${made.app.name} is a new draft`}>
            {made.unmapped.length === 0 ? `Every element it uses was found here (${made.mapped}).` : (
              <>
                {plural(made.unmapped.length, 'element')} it uses {made.unmapped.length === 1 ? 'is' : 'are'} not in this ontology:
                <ul className={styles.plainList}>{made.unmapped.map((u, i) => <li key={i}>{ELEMENT[u.kind] ?? u.kind} <span className={styles.mono}>{u.objectType === undefined ? u.apiName : `${u.objectType}.${u.apiName}`}</span></li>)}</ul>
              </>
            )}
          </Banner>
        ) : null}
        {imp.error !== undefined ? <ErrorMessage error={imp.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>{made === undefined ? 'Cancel' : 'Close'}</Button>
          {made === undefined
            ? <Button type="submit" variant="primary" pending={imp.pending} blocked={imp.blocked} disabled={file === undefined}>Import</Button>
            : <Button variant="primary" onClick={() => router.push(appEditorHref(made.app.id) as never)}>Open it in the editor</Button>}
        </FormActions>
      </form>
    </Dialog>
  );
}

