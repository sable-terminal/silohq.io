'use client';

// Machine learning models (D240): a model learns a property of a saved set's objects from others,
// a number (regression) or a category (classification). The owner trains it into versions, each
// scored on a fifth of the objects held out, and publishes one; anyone it is shared with sees how
// it scored and predicts with it, over objects they may read, with how far those have drifted
// from what it learnt from. Nothing predicted is kept. Notebooks and apps predict with it too.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Menu } from '../../components/menu.component.tsx';
import { Page, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { ShareDialog } from '../../components/share.component.tsx';
import { ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { useTab } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { objectHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber, plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { Directory, FILTERS, HELD, idFrom, NotFound, sharesFor } from './kit.view.tsx';
import { ChartView } from './notebooks.view.tsx';
import styles from './studio.view.module.css';

type Model = Output<'getMlModel'>;
type Version = Output<'listMlModelVersions'>['versions'][number];
type Definition = Pick<Model, 'name' | 'description' | 'task' | 'objectSetId' | 'featurePropertyIds' | 'labelPropertyId'>;
const modelHref = (id: string) => hrefWith('/studio/models/', { model: id });
const NUMERIC = ['integer', 'decimal', 'money', 'duration'];
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const num = (v: number) => formatNumber(v, 3);
const ACCESS = [{ value: 'view' as const, label: 'See and predict with it', hint: 'A version marked more closely than they are cleared for stays closed to them' }];
const ready = (d: Definition) => d.name.trim() !== '' && d.objectSetId !== '' && d.featurePropertyIds.length > 0 && d.labelPropertyId !== '';

function metricsLine(v: Version): string {
  if (v.status === 'failed') return `Did not train: ${v.failure ?? 'no reason was given'}`;
  const m = v.metrics!;
  const rows = `${formatNumber(v.rowsTrained ?? 0)} learnt from, ${formatNumber(v.rowsTested ?? 0)} held out`;
  return m.kind === 'regression' ? `Error (RMSE) ${num(m.rmse)}, mean absolute ${num(m.mae)}, R² ${num(m.r2)}; ${rows}`
    : `Accuracy ${pct(m.accuracy)}, macro F1 ${pct(m.macroF1)} over ${m.classes} classes; ${rows}`;
}

/** /studio/models/: the directory, or a model open. */
export function Models() {
  const [params] = useParams();
  const open = params.get('model');
  if (open === null) return <ModelDirectory />;
  const id = idFrom(open);
  return id === undefined ? <NotFound title="ML models" what="a model" icon="chart" href="/studio/models/" /> : <ModelEditor key={id} mlModelId={id} />;
}

function ModelDirectory() {
  const { lookup } = useVocabulary();
  const [filter, setFilter] = useTab(FILTERS, 'filter');
  const list = useQuery('listMlModels', { query: { filter } }, { keepPrevious: true });
  const create = useMutation('createMlModel', { invalidates: ['listMlModels'] });
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: 'ML models' });
  return (
    <Directory title="ML models" what="model" icon="chart" description="Models that learn a property of your objects from others, trained and scored here, predicting for whoever asks over what they may read."
      filter={filter} onFilter={setFilter} query={list} rows={(d) => d.mlModels} hrefOf={modelHref} createBlocked={create.blocked}
      columns={[
        { id: 'predicts', header: 'Predicts', cell: (m) => `${lookup?.propertyName(m.labelPropertyId) ?? '…'} (${m.task === 'regression' ? 'a number' : 'a category'})` },
        { id: 'published', header: 'Published', width: 'sm', cell: (m) => (m.publishedVersionId === null ? <Badge>Not yet</Badge> : <Badge tone="ok">Yes</Badge>) },
      ]}
      renderNew={(close) => <NewModel onClose={close} />}
      emptyMine="A model learns one property of your objects from the others, and predicts it for objects that do not have it yet." />
  );
}

function NewModel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const create = useMutation('createMlModel', { invalidates: ['listMlModels'] });
  const [draft, setDraft] = useState<Definition>({ name: '', description: '', task: 'classification', objectSetId: '', featurePropertyIds: [], labelPropertyId: '' });
  return (
    <Dialog open onClose={onClose} title="New model" size="lg" busy={create.pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = await create.run({ body: draft });
        if (r.ok) router.push(modelHref(r.data.id) as never);
      }}>
        <DefinitionForm value={draft} onChange={setDraft} />
        {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={create.pending} blocked={create.blocked} disabled={!ready(draft)}>Make the model</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function DefinitionForm({ value, onChange }: { value: Definition; onChange: (d: Definition) => void }) {
  const { data: vocabulary } = useVocabulary();
  const sets = useQuery('listOntologyObjectSets', { query: {} });
  const type = vocabulary?.objectTypes.find((t) => t.id === sets.data?.objectSets.find((s) => s.id === value.objectSetId)?.baseTypeId);
  const labels = (type?.properties ?? []).filter((p) => value.task === 'classification' || NUMERIC.includes(p.dataType));
  return (
    <div className={styles.stack}>
      <div className={styles.fields}>
        <TextField label="Name" required value={value.name} maxLength={200} onChange={(e) => onChange({ ...value, name: e.target.value })} />
        <SelectField label="It predicts" value={value.task} onChange={(e) => onChange({ ...value, task: e.target.value as Definition['task'], labelPropertyId: '' })}
          options={[{ value: 'classification', label: 'A category (classification)' }, { value: 'regression', label: 'A number (regression)' }]} />
        <SelectField label="Learning from" required value={value.objectSetId} placeholder={sets.data === undefined ? 'Listing…' : 'Choose a saved set'}
          onChange={(e) => onChange({ ...value, objectSetId: e.target.value, featurePropertyIds: [], labelPropertyId: '' })}
          options={(sets.data?.objectSets ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        <SelectField label="The property it predicts" required value={value.labelPropertyId} placeholder="Choose a property"
          onChange={(e) => onChange({ ...value, labelPropertyId: e.target.value, featurePropertyIds: value.featurePropertyIds.filter((p) => p !== e.target.value) })}
          options={labels.map((p) => ({ value: p.identityId, label: p.displayName }))}
          hint={type !== undefined && labels.length === 0 ? 'This type has no number to predict.' : undefined} />
      </div>
      <TextField label="Description" value={value.description} maxLength={2000} onChange={(e) => onChange({ ...value, description: e.target.value })} />
      {type !== undefined ? (
        <fieldset className={styles.fieldset}>
          <legend>From these properties</legend>
          <div className={styles.checks}>{type.properties.filter((p) => p.identityId !== value.labelPropertyId).map((p) => (
            <Checkbox key={p.identityId} label={p.displayName} checked={value.featurePropertyIds.includes(p.identityId)}
              onChange={(e) => onChange({ ...value, featurePropertyIds: e.target.checked ? [...value.featurePropertyIds, p.identityId] : value.featurePropertyIds.filter((x) => x !== p.identityId) })} />
          ))}</div>
        </fieldset>
      ) : null}
    </div>
  );
}

function ModelEditor({ mlModelId }: { mlModelId: string }) {
  const router = useRouter();
  const say = useToast();
  const read = useQuery('getMlModel', { params: { mlModelId } });
  const versions = useQuery('listMlModelVersions', { params: { mlModelId } });
  const save = useMutation('saveMlModel', { invalidates: ['getMlModel', 'listMlModels'] });
  const train = useMutation('trainMlModel', { invalidates: ['listMlModelVersions'] });
  const publish = useMutation('publishMlModelVersion', { invalidates: ['getMlModel', 'listMlModelVersions', 'listMlModels'] });
  const archive = useMutation('archiveMlModel', { invalidates: ['getMlModel', 'listMlModels'] });
  const shares = useQuery('listMlModelShares', read.data?.access === 'owner' ? { params: { mlModelId } } : null);
  const share = useMutation('shareMlModel', { invalidates: ['listMlModelShares', 'getMlModel'] });
  const revoke = useMutation('revokeMlModelShare', { invalidates: ['listMlModelShares', 'getMlModel'] });
  const [dialog, setDialog] = useState<'define' | 'share' | 'archive' | undefined>();
  const [detail, setDetail] = useState<string | undefined>();
  const m = read.data;
  usePageContext({ scope: { kind: 'page', page: 'studio' }, scopeLabel: m?.name ?? 'a model' });
  if (m === undefined) {
    return <Page title="Model" crumbs={[{ label: 'Studio' }, { label: 'ML models', href: '/studio/models/' }]}><QueryView query={read} what="The model">{() => null}</QueryView></Page>;
  }
  const owner = m.access === 'owner';
  const archived = m.archivedAt !== null;
  const editable = owner && !archived;
  return (
    <Page title={m.name} documentTitle={m.name} crumbs={[{ label: 'Studio' }, { label: 'ML models', href: '/studio/models/' }]} description={m.description || undefined}
      meta={<span className={styles.row}>{archived ? <Badge>Archived</Badge> : null}{!owner ? <Badge tone="info">{HELD[m.access]}</Badge> : null}{m.publishedVersionId === null ? <Badge>Not published</Badge> : <Badge tone="ok">Published</Badge>}</span>}
      actions={
        <div className={styles.row}>
          {editable ? (
            <Button variant="primary" icon="play" pending={train.pending} blocked={train.blocked}
              onClick={() => void train.run({ params: { mlModelId } }).then((r) => r.ok && say(r.data.status === 'trained' ? `Version ${r.data.version} trained` : `Version ${r.data.version} did not train`))}>Train a version</Button>
          ) : null}
          {editable ? <Button icon="edit" blocked={save.blocked} onClick={() => setDialog('define')}>What it learns</Button> : null}
          {owner ? <Button icon="share" blocked={share.blocked} onClick={() => setDialog('share')}>Share</Button> : null}
          <Menu label="More" items={[
            { label: 'Archive', icon: 'trash', tone: 'danger', disabled: !owner || archived, blocked: archive.blocked, onSelect: () => setDialog('archive') },
          ]} renderTrigger={(x) => <IconButton {...x} label="More" icon="more" />} />
        </div>
      }>
      <div className={styles.stack}>
        {archived ? <Banner tone="info" title="Archived">It predicts no more; its versions stay readable.</Banner> : null}
        {train.error !== undefined ? <ErrorMessage error={train.error} /> : null}
        {publish.error !== undefined ? <ErrorMessage error={publish.error} /> : null}
        <Section title="Versions" description="Each scored on a fifth of the objects, held out from what it learnt from.">
          <QueryView query={versions} what="Versions" isEmpty={(d) => d.versions.length === 0} empty={<p className={styles.muted}>Not trained yet.</p>}>
            {(d) => (
              <DataTable label="Versions" rows={d.versions} rowKey={(v) => v.id} columns={[
                { id: 'version', header: 'Version', width: 'sm', primary: true, cell: (v) => (
                  <span className={styles.row}>{v.version}{v.published ? <Badge tone="ok">Published</Badge> : null}{v.markingIds.length > 0 ? <Badge tone="warn">Marked</Badge> : null}</span>
                ) },
                { id: 'scored', header: 'How it scored', cell: (v) => (v.status === 'failed' ? <span className={styles.muted}>{metricsLine(v)}</span> : metricsLine(v)) },
                { id: 'when', header: 'Trained', width: 'sm', cell: (v) => <Time value={v.trainedAt} /> },
                { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (v) => v.status !== 'trained' ? null : (
                  <Menu label={`Version ${v.version}`} items={[
                    { label: 'What it learnt', icon: 'chart', onSelect: () => setDetail(v.id) },
                    { label: 'Publish this version', icon: 'check', disabled: !editable || v.published, blocked: publish.blocked,
                      onSelect: () => void publish.run({ params: { mlModelId, versionId: v.id } }).then((r) => r.ok && say(`Version ${v.version} published`)) },
                  ]} renderTrigger={(x) => <IconButton {...x} size="sm" label={`Version ${v.version} actions`} icon="more" />} />
                ) },
              ]} />
            )}
          </QueryView>
        </Section>
        {m.publishedVersionId !== null && !archived ? <Predict model={m} /> : null}
      </div>
      {detail !== undefined ? <VersionDetail mlModelId={mlModelId} versionId={detail} onClose={() => setDetail(undefined)} /> : null}
      {dialog === 'define' ? (
        <Define model={m} pending={save.pending} error={save.error} onClose={() => setDialog(undefined)}
          onSave={(definition) => void save.run({ params: { mlModelId }, body: { definition, lockVersion: m.lockVersion } }).then((r) => {
            if (!r.ok) return;
            setDialog(undefined);
            say('Saved: train a version to learn it');
          })} />
      ) : null}
      <ShareDialog open={dialog === 'share'} onClose={() => setDialog(undefined)} title={`Share ${m.name}`} what="this model" access={ACCESS}
        shares={sharesFor(shares.data?.shares)} shareBlocked={share.blocked} revokeBlocked={revoke.blocked}
        onShare={(grantee) => share.run({ params: { mlModelId }, body: { grantee } })}
        onRevoke={(shareId) => revoke.run({ params: { mlModelId, shareId } })} />
      <ConfirmDialog open={dialog === 'archive'} onClose={() => setDialog(undefined)} title={`Archive ${m.name}?`} confirmLabel="Archive" tone="danger"
        onConfirm={async () => {
          const r = await archive.run({ params: { mlModelId } });
          if (r.ok) {
            say('Archived');
            router.push('/studio/models/' as never);
          }
          return r;
        }}><p>Notebooks and apps that predict with it say it is archived.</p></ConfirmDialog>
    </Page>
  );
}

function Define({ model, pending, error, onClose, onSave }: { model: Model; pending: boolean; error: unknown; onClose: () => void; onSave: (d: Definition) => void }) {
  const [draft, setDraft] = useState<Definition>({ name: model.name, description: model.description, task: model.task, objectSetId: model.objectSetId, featurePropertyIds: model.featurePropertyIds, labelPropertyId: model.labelPropertyId });
  return (
    <Dialog open onClose={onClose} title="What it learns" size="lg" busy={pending} description="A change applies from the next version trained; published versions keep what they learnt.">
      <form className={styles.form} onSubmit={(e) => {
        e.preventDefault();
        if (ready(draft)) onSave(draft);
      }}>
        <DefinitionForm value={draft} onChange={setDraft} />
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={!ready(draft)}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function VersionDetail({ mlModelId, versionId, onClose }: { mlModelId: string; versionId: string; onClose: () => void }) {
  const read = useQuery('getMlModelVersion', { params: { mlModelId, versionId } });
  return (
    <Dialog open onClose={onClose} drawer title={read.data === undefined ? 'What it learnt' : `What version ${read.data.version} learnt`}>
      <QueryView query={read} what="The version">
        {(d) => (
          <div className={styles.stack}>
            <p className={styles.muted}>How much each property weighs in its predictions.</p>
            <ChartView chart={{ kind: 'chart', bars: d.importance.map((i) => ({ label: i.feature, value: Math.round(i.weight * 1000) / 10 })), omitted: 0 }} />
            {d.classes !== null && d.confusion !== null ? (
              <div className={styles.tableWrap}>
                <table className={styles.dataTable} aria-label="Confusion">
                  <caption className={styles.muted}>On the held-out fifth: each row the class it was, each column the class predicted</caption>
                  <thead><tr><th scope="col">Was</th>{d.classes.map((c) => <th key={c.label} scope="col">{c.label}</th>)}<th scope="col">Precision</th><th scope="col">Recall</th></tr></thead>
                  <tbody>{d.classes.map((c, i) => (
                    <tr key={c.label}><th scope="row">{c.label}</th>{d.confusion![i]!.map((n, j) => <td key={j} className={styles.number}>{formatNumber(n)}</td>)}<td>{pct(c.precision)}</td><td>{pct(c.recall)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            ) : null}
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

function Predict({ model }: { model: Model }) {
  const { lookup } = useVocabulary();
  const sets = useQuery('listOntologyObjectSets', { query: {} });
  const predict = useMutation('predictMlModel', { refresh: false });
  const [setId, setSetId] = useState('');
  const type = lookup?.properties.get(model.labelPropertyId)?.type;
  const label = lookup?.propertyName(model.labelPropertyId) ?? 'Prediction';
  const out = predict.data;
  const shifted = out?.drift.filter((d) => d.level !== 'stable') ?? [];
  return (
    <Section title="Predict" description="With the published version, over objects you may read. Nothing predicted is kept.">
      <div className={styles.stack}>
        <form className={styles.rowEnd} aria-label="Predict" onSubmit={(e) => {
          e.preventDefault();
          void predict.run({ params: { mlModelId: model.id }, body: setId === '' ? {} : { objectSetId: setId } });
        }}>
          <SelectField label="For" value={setId} onChange={(e) => setSetId(e.target.value)}
            options={[{ value: '', label: 'The objects it learnt from' }, ...(sets.data?.objectSets ?? []).filter((s) => s.baseTypeId === type?.id && s.id !== model.objectSetId).map((s) => ({ value: s.id, label: s.name }))]} />
          <Button type="submit" icon="play" pending={predict.pending} blocked={predict.blocked}>Predict</Button>
        </form>
        {predict.error !== undefined ? <ErrorMessage error={predict.error} /> : null}
        {out !== undefined ? (
          <>
            <p role="status">{plural(out.total, 'object')}{out.truncated ? `; the first ${formatNumber(out.predictions.length)} predicted` : ''}.{out.withheld > 0 ? ` ${plural(out.withheld, 'property', 'properties')} withheld from you, so predicted as if missing.` : ''}</p>
            {shifted.length > 0
              ? <Banner tone="warn" title="Unlike what it learnt from">These objects differ in {shifted.map((d) => `${d.feature} (${d.level})`).join(', ')}: its predictions may be less sound.</Banner>
              : <p className={styles.muted}>They resemble what it learnt from.</p>}
            <DataTable label="Predictions" rows={out.predictions.slice(0, 200)} rowKey={(p) => p.objectId} columns={[
              { id: 'object', header: 'Object', primary: true, cell: (p) => (out.objectTypeId === null ? <span className={styles.mono}>{p.objectId.slice(0, 8)}</span>
                : <LinkButton size="sm" variant="link" href={objectHref({ objectTypeId: out.objectTypeId, objectId: p.objectId })}>Open</LinkButton>) },
              { id: 'value', header: label, cell: (p) => (typeof p.value === 'number' ? num(p.value) : String(p.value)) },
              ...(model.task === 'classification' ? [{ id: 'confidence', header: 'Confidence', width: 'sm' as const, align: 'end' as const, cell: (p: (typeof out.predictions)[number]) => (p.probability === null ? '' : pct(p.probability)) }] : []),
            ]} />
            {out.predictions.length > 200 ? <p className={styles.muted}>The first 200 shown; a notebook's predictions cell exports them all.</p> : null}
          </>
        ) : null}
      </div>
    </Section>
  );
}
