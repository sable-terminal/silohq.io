'use client';

// Object view layouts (spec 34.6): the layout an object view of a type opens with. Every type has a
// generated default from its structure alone; a custom layout is a Studio app of its own kind, one
// page bound to the object, reviewed and approved like any app version and then the type's one
// active layout. Here: the custom layouts in force, and those an ontology change broke (the
// generated default shows instead until one is fixed or replaced; its author is told, and the
// notification opens it here); a person's own layout drafts; what any type's object view opens
// with for them; and a new layout from the generated default, with an Action button if one is
// named, checked before it is made.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { humanise, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { AppEditor } from './appEditor.view.tsx';
import { idFrom } from './kit.view.tsx';
import styles from './studio.view.module.css';

const editorHref = (appId: string) => hrefWith('/studio/layouts/', { edit: appId });

/** /studio/layouts/: the directory, or a layout's editor. */
export function Layouts() {
  const [params] = useParams();
  const edit = params.get('edit');
  if (edit !== null) {
    const id = idFrom(edit);
    return id === undefined ? (
      <Page title="Object view layouts" crumbs={[{ label: 'Studio' }]}>
        <EmptyState icon="panelRight" title="This address does not name a layout" action={<LinkButton href="/studio/layouts/">All layouts</LinkButton>}>Check the link you followed.</EmptyState>
      </Page>
    ) : <AppEditor key={id} appId={id} />;
  }
  return <Directory />;
}

function Directory() {
  const router = useRouter();
  const { lookup } = useVocabulary();
  const people = useDirectory();
  const [params, set] = useParams();
  const inForce = useQuery('listObjectViewLayouts', {});
  const mine = useQuery('listApps', { query: { filter: 'mine' } });
  const create = useMutation('createObjectViewLayout', { invalidates: ['listApps'] });
  const [typeId, setTypeId] = useState('');
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: 'Object view layouts' });
  const named = params.get('layout');
  const flagged = inForce.data?.layouts.find((l) => l.id === named);
  const drafts = (mine.data?.apps ?? []).filter((a) => a.kind === 'object_view_layout' && a.archivedAt === null);

  return (
    <Page title="Object view layouts" description="How an object's page is laid out for your organisation. Every type has a generated layout; a custom one replaces it once it is approved."
      crumbs={[{ label: 'Studio' }]}
      actions={<Button variant="primary" icon="plus" blocked={create.blocked} onClick={() => set({ new: '1' })}>New layout</Button>}>
      {named !== null && inForce.data !== undefined ? (
        flagged === undefined
          ? <Banner tone="info" title="That layout no longer applies">It was replaced or archived since you were told about it.</Banner>
          : flagged.status === 'invalid' ? (
            <Banner tone="warn" title={lookup === undefined ? 'A layout needs review' : `The ${lookup.typeName(flagged.objectTypeId)} layout needs review`}
              action={<LinkButton href={editorHref(flagged.appId)} variant="primary">Open it to fix</LinkButton>}>
              An ontology change means version {flagged.version} no longer validates, so object views use the generated layout. Fix its draft and send it for review.
            </Banner>
          ) : <Banner tone="ok" title="That layout applies">It validates against the ontology as it is now.</Banner>
      ) : null}
      <Section title="In force" description="The custom layout each type opens with, and those an ontology change broke.">
        <QueryView query={inForce} what="Layouts" isEmpty={(d) => d.layouts.length === 0} empty={<p className={styles.muted}>No custom layouts: every type opens with its generated layout.</p>}>
          {(d) => (
            <DataTable label="Layouts in force" rows={d.layouts} rowKey={(l) => l.id} rowHref={(l) => editorHref(l.appId)} columns={[
              { id: 'type', header: 'Type', primary: true, cell: (l) => lookup?.typeName(l.objectTypeId) ?? '…' },
              { id: 'version', header: 'Version', width: 'sm', cell: (l) => String(l.version) },
              { id: 'state', header: 'State', width: 'md', cell: (l) => (l.status === 'active' ? <Badge tone="ok">Applies</Badge> : <Badge tone="warn">No longer validates</Badge>) },
              { id: 'by', header: 'Made by', cell: (l) => (l.createdBy === null ? '—' : people.nameOf(l.createdBy)) },
              { id: 'when', header: 'Changed', width: 'sm', cell: (l) => <Time value={l.updatedAt} /> },
            ]} />
          )}
        </QueryView>
      </Section>
      <Section title="Your layouts" description="Layouts you made, with their drafts.">
        <QueryView query={mine} what="Your layouts" isEmpty={() => drafts.length === 0} empty={<p className={styles.muted}>None yet.</p>}>
          {() => (
            <DataTable label="Your layouts" rows={drafts} rowKey={(a) => a.id} rowHref={(a) => editorHref(a.id)} columns={[
              { id: 'name', header: 'Layout', primary: true, cell: (a) => a.name },
              { id: 'state', header: 'State', cell: (a) => (a.draft === null ? (a.currentVersionId === null ? 'Not approved' : 'Approved') : `Draft ${a.draft.version} ${a.draft.state === 'review' ? 'in review' : humanise(a.draft.state).toLowerCase()}${a.draft.findings > 0 ? `, ${plural(a.draft.findings, 'thing')} to fix` : ''}`) },
              { id: 'when', header: 'Changed', width: 'sm', cell: (a) => <Time value={a.updatedAt} /> },
            ]} />
          )}
        </QueryView>
      </Section>
      <Section title="What a type opens with" description="As you would see it: the generated layout, or the custom one in force with anything withheld from you counted.">
        <div className={styles.stack}>
          <SelectField label="Type" value={typeId} placeholder="Choose a type" onChange={(e) => setTypeId(e.target.value)}
            options={[...(lookup?.types.values() ?? [])].map((t) => ({ value: t.id, label: t.displayName }))} />
          {typeId !== '' ? <TypeLayout objectTypeId={typeId} /> : null}
        </div>
      </Section>
      {params.get('new') !== null ? (
        <NewLayout onClose={() => set({ new: undefined })} pending={create.pending} error={create.error} blocked={create.blocked}
          onCreate={async (body) => {
            const r = await create.run({ body });
            if (r.ok) router.push(editorHref(r.data.app.id) as never);
          }} />
      ) : null}
    </Page>
  );
}

function TypeLayout({ objectTypeId }: { objectTypeId: string }) {
  const { lookup } = useVocabulary();
  const read = useQuery('getObjectViewLayout', { params: { objectTypeId } });
  return (
    <QueryView query={read} what="The layout">
      {(l) => l.custom !== null ? (
        <Panel>
          <div className={styles.stackTight}>
            <Properties items={[
              ['Layout', <span key="k" className={styles.row}><Badge tone="accent">Custom</Badge> version {l.custom.version}</span>],
              ['Widgets', `${plural(l.custom.widgets.length, 'widget')}${l.custom.widgets.some((w) => w.status !== 'available') ? `, ${l.custom.widgets.filter((w) => w.status !== 'available').length} not fully shown to you` : ''}`],
            ]} />
            {l.custom.statement !== null ? <p className={styles.muted}>{l.custom.statement}</p> : null}
            <LinkButton href={editorHref(l.custom.appId)} variant="link">Open its editor</LinkButton>
          </div>
        </Panel>
      ) : l.layout !== null ? (
        <Panel>
          <Properties columns={1} items={[
            ['Layout', <Badge key="k">Generated</Badge>],
            ['Properties, in order', l.layout.properties.map((id) => lookup?.propertyName(id) ?? '…').join(', ') || 'None'],
            ['Link groups', l.layout.linkGroups.map((g) => {
              const link = lookup?.links.get(g.linkTypeId);
              return link === undefined ? 'a link you cannot see' : g.direction === 'outgoing' ? link.forwardName : link.reverseName;
            }).join(', ') || 'None'],
            ['Then', l.layout.sections.map((s) => humanise(s)).join(', ')],
          ]} />
        </Panel>
      ) : null}
    </QueryView>
  );
}

function NewLayout({ onClose, onCreate, pending, error, blocked }: {
  onClose: () => void; onCreate: (body: { objectTypeId: string; name?: string; definition?: Record<string, never> }) => Promise<void>; pending: boolean; error: unknown;
  blocked: ReturnType<typeof useMutation>['blocked'];
}) {
  const { data: vocabulary } = useVocabulary();
  const actions = useQuery('listActionTypes', { query: { status: 'confirmed' } });
  const preview = useMutation('previewApp', { refresh: false });
  const [objectTypeId, setObjectTypeId] = useState('');
  const [actionTypeId, setActionTypeId] = useState('');
  const [name, setName] = useState('');
  const type = vocabulary?.objectTypes.find((t) => t.id === objectTypeId);
  const typeActions = (actions.data?.actionTypes ?? []).filter((a) => a.current?.objectTypeId === objectTypeId);
  const named = name.trim() === '' ? `${type?.displayName ?? 'Type'} layout` : name.trim();
  const check = () => preview.run({ body: { name: named, layout: { objectTypeId, ...(actionTypeId === '' ? {} : { actionTypeId }) } } });
  const shown = preview.data;
  return (
    <Dialog open onClose={onClose} title="New layout" size="md" busy={pending || preview.pending}
      description="It starts from the type's generated layout; you change it in the editor, then send it for review.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        if (objectTypeId === '') return;
        // With an Action named, the starting point carries its button: checked here, made from what was checked.
        if (actionTypeId !== '') {
          const r = shown ?? (await check().then((x) => (x.ok ? x.data : undefined)));
          if (r === undefined) return;
          await onCreate({ objectTypeId, name: named, definition: r.definition as Record<string, never> });
        } else {
          await onCreate({ objectTypeId, name: named });
        }
      }}>
        <SelectField label="For" required value={objectTypeId} placeholder="Choose a type" onChange={(e) => {
          setObjectTypeId(e.target.value);
          setActionTypeId('');
          preview.reset();
        }} options={(vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.displayName }))} />
        {objectTypeId !== '' ? (
          <SelectField label="With an Action button (optional)" value={actionTypeId} placeholder="None" onChange={(e) => {
            setActionTypeId(e.target.value);
            preview.reset();
          }} options={typeActions.map((a) => ({ value: a.id, label: a.displayName }))} />
        ) : null}
        <TextField label="Name (optional)" value={name} maxLength={200} placeholder={`${type?.displayName ?? 'Type'} layout`} onChange={(e) => setName(e.target.value)} />
        {shown !== undefined ? (
          <Banner tone={shown.findings.length === 0 ? 'ok' : 'warn'} title={shown.findings.length === 0 ? 'It validates' : `${plural(shown.findings.length, 'thing')} to fix after it is made`}>
            {shown.findings.length > 0 ? <ul className={styles.plainList}>{shown.findings.map((f, i) => <li key={i}><span className={styles.mono}>{f.path}</span>: {f.message}</li>)}</ul> : null}
            {shown.rendered !== null && shown.rendered.withheld > 0 ? `${plural(shown.rendered.withheld, 'element')} of it would be withheld from you.` : null}
          </Banner>
        ) : null}
        {preview.error !== undefined ? <ErrorMessage error={preview.error} /> : null}
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button pending={preview.pending} blocked={preview.blocked} disabled={objectTypeId === ''} onClick={() => void check()}>Check it first</Button>
          <Button type="submit" variant="primary" pending={pending} blocked={blocked} disabled={objectTypeId === ''}>Make the layout</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
