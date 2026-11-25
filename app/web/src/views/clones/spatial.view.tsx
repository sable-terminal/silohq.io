'use client';

// Site plans and models (spec 29.4, 29.5): drawings and 3D models of where things stand, kept in
// an Import Silo, that canvases lay clones on. A plan is registered from an image file, with
// control points (pixel to latitude and longitude) where it should line up with a map; a model
// from a glTF binary, its named parts what clones stand on. Anchors say where: an object at a
// point of a plan or on a part of a model, or every object a rule matches. A plan or model is
// purged from the Silo for good.

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { FormActions, RadioGroup, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { ObjectPicker, type PickedObject } from '../../components/objectPicker.component.tsx';
import { Page, Panel, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, usePermits, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatBytes, plural } from '../../utils/format.util.ts';
import styles from './clones.view.module.css';

type Assets = Output<'listSpatialAssets'>;
type Anchor = Assets['anchors'][number];

/** Files in the organisation's Import Siloes, of the class asked for. */
function useSiloFiles(contentClass: 'site_plan' | 'asset_model') {
  const siloes = useQuery('listSiloes', { query: {} }, { staleMs: 5 * 60_000 });
  const imports = (siloes.data?.siloes ?? []).filter((s) => s.kind === 'import' && s.status === 'active');
  const [siloId, setSiloId] = useState('');
  const chosen = siloId || imports[0]?.id || '';
  const files = useQuery('listSiloFiles', chosen === '' ? null : { params: { siloId: chosen } });
  return {
    imports, siloId: chosen, setSiloId,
    files: (files.data?.files ?? []).filter((f) => f.contentClass === contentClass && f.status === 'processed'),
    loading: files.status === 'loading',
  };
}

function RegisterDialog({ kind, open, onClose }: { kind: 'plan' | 'model'; open: boolean; onClose: () => void }) {
  const say = useToast();
  const siloFiles = useSiloFiles(kind === 'plan' ? 'site_plan' : 'asset_model');
  const plan = useMutation('registerSpatialPlan', { invalidates: ['listSpatialAssets'] });
  const model = useMutation('registerAssetModel', { invalidates: ['listSpatialAssets'] });
  const [fileId, setFileId] = useState('');
  const [name, setName] = useState('');
  const [points, setPoints] = useState('');
  const error = kind === 'plan' ? plan.error : model.error;
  const parsePoints = () => points.split('\n').map((l) => l.split(',').map((x) => Number(x.trim()))).filter((p) => p.length === 4 && p.every((x) => Number.isFinite(x)))
    .map(([x, y, lat, lon]) => ({ x: x!, y: y!, lat: lat!, lon: lon! }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = kind === 'plan'
      ? await plan.run({ body: { siloFileId: fileId, name: name.trim(), ...(parsePoints().length >= 3 ? { controlPoints: parsePoints() } : {}) } })
      : await model.run({ body: { siloFileId: fileId, name: name.trim() } });
    if (r.ok) {
      say(kind === 'plan' ? 'Plan registered: anchor objects to it next' : 'Model registered: anchor objects to its parts next');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={kind === 'plan' ? 'Register a site plan' : 'Register a 3D model'} size="md" busy={plan.pending || model.pending}
      description={kind === 'plan' ? 'An image of a floor or a site, kept in an Import Silo.' : 'A glTF binary (.glb), checked and kept in an Import Silo; its named parts are what clones stand on.'}>
      <form className={styles.form} onSubmit={submit}>
        {siloFiles.imports.length === 0 ? <p className={styles.muted}>There is no Import Silo yet. <Link href="/siloes/import/?new=1">Make one</Link> and upload the file to it.</p> : (
          <>
            {siloFiles.imports.length > 1 ? <SelectField label="Silo" value={siloFiles.siloId} onChange={(e) => siloFiles.setSiloId(e.target.value)} options={siloFiles.imports.map((s) => ({ value: s.id, label: s.name }))} /> : null}
            <SelectField label="File" required value={fileId} onChange={(e) => {
              setFileId(e.target.value);
              if (name === '') setName(siloFiles.files.find((f) => f.id === e.target.value)?.filename.replace(/\.[^.]+$/, '') ?? '');
            }} placeholder={siloFiles.loading ? 'Reading the Silo' : siloFiles.files.length === 0 ? `No ${kind === 'plan' ? 'plan image' : 'model'} in this Silo yet` : 'Choose a file'}
              options={siloFiles.files.map((f) => ({ value: f.id, label: `${f.filename} (${formatBytes(f.sizeBytes)})` }))} />
          </>
        )}
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
        {kind === 'plan' ? (
          <TextArea label="Control points (optional)" rows={4} value={points} onChange={(e) => setPoints(e.target.value)} spellCheck={false} placeholder={'120, 340, 51.5072, -0.1276\n880, 340, 51.5074, -0.1251\n500, 900, 51.5061, -0.1264'}
            hint="Three or more, one per line: pixel x, pixel y, latitude, longitude. With them the plan lines up with a map and located objects place themselves." />
        ) : null}
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={plan.pending || model.pending} blocked={kind === 'plan' ? plan.blocked : model.blocked}
          disabled={fileId === '' || name.trim() === ''}>Register</Button></FormActions>
      </form>
    </Dialog>
  );
}

function AnchorDialog({ assets, open, onClose }: { assets: Assets; open: boolean; onClose: () => void }) {
  const say = useToast();
  const { data: vocabulary } = useVocabulary();
  const anchor = useMutation('setSpatialAnchor', { invalidates: ['listSpatialAssets'] });
  const [target, setTarget] = useState('');
  const [typeId, setTypeId] = useState('');
  const [mode, setMode] = useState<'object' | 'rule'>('object');
  const [object, setObject] = useState<PickedObject | undefined>(undefined);
  const [rule, setRule] = useState('');
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [node, setNode] = useState('');
  const [kind, id] = target.split(':') as ['plan' | 'model' | '', string | undefined];
  const chosenModel = kind === 'model' ? assets.models.find((m) => m.id === id) : undefined;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await anchor.run({ body: {
      ...(kind === 'plan' ? { planId: id!, planX: Number(x), planY: Number(y) } : { assetModelId: id!, modelNodeName: node }),
      objectTypeId: mode === 'object' && object !== undefined ? object.objectTypeId : typeId,
      ...(mode === 'object' && object !== undefined ? { objectRef: object.objectId } : { matchRule: rule.trim() }),
    } });
    if (r.ok) {
      say('Anchored');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Anchor objects" size="md" busy={anchor.pending} description="Say where objects stand: one object, or every object a rule matches.">
      <form className={styles.form} onSubmit={submit}>
        <SelectField label="On" required value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Choose a plan or a model" options={[
          ...assets.plans.filter((p) => p.purgedAt === null).map((p) => ({ value: `plan:${p.id}`, label: `Plan: ${p.name}` })),
          ...assets.models.filter((m) => m.purgedAt === null).map((m) => ({ value: `model:${m.id}`, label: `Model: ${m.name}` })),
        ]} />
        <RadioGroup name="anchor-mode" label="Which objects" value={mode} onChange={setMode} options={[{ value: 'object', label: 'One object' }, { value: 'rule', label: 'Every object a rule matches' }]} />
        {mode === 'object' ? <ObjectPicker label="Object" value={object} onChange={setObject} /> : (
          <>
            <SelectField label="Of type" required value={typeId} onChange={(e) => setTypeId(e.target.value)} placeholder="Choose a type" options={(vocabulary?.objectTypes ?? []).map((t) => ({ value: t.id, label: t.pluralName }))} />
            <TextField label="Rule (CEL)" required value={rule} onChange={(e) => setRule(e.target.value)} spellCheck={false} placeholder={'self.zone == "North hall"'} />
          </>
        )}
        {kind === 'plan' ? (
          <div className={styles.split}>
            <TextField label="Pixel x" type="number" required value={x} onChange={(e) => setX(e.target.value)} />
            <TextField label="Pixel y" type="number" required value={y} onChange={(e) => setY(e.target.value)} />
          </div>
        ) : kind === 'model' ? (
          <SelectField label="Part" required value={node} onChange={(e) => setNode(e.target.value)} placeholder="Choose a named part" options={(chosenModel?.nodeNames ?? []).map((n) => ({ value: n, label: n }))} />
        ) : null}
        {anchor.error !== undefined ? <ErrorMessage error={anchor.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={anchor.pending} blocked={anchor.blocked}
          disabled={target === '' || (mode === 'object' ? object === undefined : typeId === '' || rule.trim() === '') || (kind === 'plan' ? x === '' || y === '' : node === '')}>Anchor</Button></FormActions>
      </form>
    </Dialog>
  );
}

export function Spatial() {
  const say = useToast();
  const people = useDirectory();
  const permits = usePermits();
  const { lookup } = useVocabulary();
  const [params, set] = useParams();
  const assets = useQuery('listSpatialAssets', {});
  const removeAnchor = useMutation('removeSpatialAnchor', { invalidates: ['listSpatialAssets'] });
  const purgePlan = useMutation('purgeSpatialPlan', { invalidates: ['listSpatialAssets'] });
  const purgeModel = useMutation('purgeAssetModel', { invalidates: ['listSpatialAssets'] });
  const planBlocked = useBlocked('registerSpatialPlan');
  const [purging, setPurging] = useState<{ kind: 'plan' | 'model'; id: string; name: string } | undefined>(undefined);
  usePageContext({ scope: { kind: 'page', page: 'clones' }, scopeLabel: 'Site plans and models' });
  const register = params.get('new') as 'plan' | 'model' | null;
  const anchorName = (a: Anchor, d: Assets) => (a.planId !== null ? d.plans.find((p) => p.id === a.planId)?.name : d.models.find((m) => m.id === a.assetModelId)?.name) ?? '—';
  return (
    <Page title="Site plans and models" description="Drawings and 3D models of where things stand, that canvases lay clones on." crumbs={[{ label: 'Clones' }]}
      actions={<>
        <Button icon="plus" blocked={planBlocked} onClick={() => set({ new: 'plan' })}>Register a plan</Button>
        <Button icon="plus" blocked={permits('registerAssetModel')} onClick={() => set({ new: 'model' })}>Register a model</Button>
        <Button variant="primary" blocked={permits('setSpatialAnchor')} onClick={() => set({ anchor: '1' })}>Anchor objects</Button>
      </>}>
      <QueryView query={assets} what="Plans and models" isEmpty={(d) => d.plans.length === 0 && d.models.length === 0}
        empty={<EmptyState icon="cube" title="No plan or model yet" action={<Button variant="primary" blocked={planBlocked} onClick={() => set({ new: 'plan' })}>Register a plan</Button>}>Upload a plan image or a .glb model to an Import Silo, then register it here.</EmptyState>}>
        {(d) => (
          <div className={styles.stack}>
            {d.withheld > 0 ? <p className={styles.muted}>{plural(d.withheld, 'more')} you may not see.</p> : null}
            <Section title="Site plans">
              <DataTable label="Site plans" rows={d.plans} rowKey={(p) => p.id} columns={[
                { id: 'name', header: 'Plan', primary: true, cell: (p) => p.name },
                { id: 'size', header: 'Size', width: 'md', cell: (p) => `${p.widthPx} × ${p.heightPx} px` },
                { id: 'geo', header: 'On a map', width: 'sm', cell: (p) => (p.controlPoints === null ? 'No' : `Yes, ${p.controlPoints.length} points`) },
                { id: 'anchors', header: 'Anchors', width: 'sm', align: 'end', cell: (p) => String(d.anchors.filter((a) => a.planId === p.id).length) },
                { id: 'by', header: 'Registered', width: 'md', cell: (p) => <span>{people.nameOf(p.uploadedBy)}, <Time value={p.uploadedAt} /></span> },
                { id: 'act', header: <span className="visually-hidden">Purge</span>, width: 'sm', align: 'end', cell: (p) => (p.purgedAt !== null ? <Badge>Purged</Badge>
                  : <Button size="sm" variant="ghost" blocked={purgePlan.blocked} onClick={() => setPurging({ kind: 'plan', id: p.id, name: p.name })}>Purge</Button>) },
              ]} />
            </Section>
            <Section title="3D models">
              <DataTable label="3D models" rows={d.models} rowKey={(m) => m.id} columns={[
                { id: 'name', header: 'Model', primary: true, cell: (m) => m.name },
                { id: 'parts', header: 'Named parts', width: 'sm', align: 'end', cell: (m) => String(m.nodeNames.length) },
                { id: 'size', header: 'Size', width: 'md', cell: (m) => `${formatBytes(Number(m.bytes))}, ${plural(m.levels.length, 'level')} of detail` },
                { id: 'anchors', header: 'Anchors', width: 'sm', align: 'end', cell: (m) => String(d.anchors.filter((a) => a.assetModelId === m.id).length) },
                { id: 'by', header: 'Registered', width: 'md', cell: (m) => <span>{people.nameOf(m.uploadedBy)}, <Time value={m.uploadedAt} /></span> },
                { id: 'act', header: <span className="visually-hidden">Purge</span>, width: 'sm', align: 'end', cell: (m) => (m.purgedAt !== null ? <Badge>Purged</Badge>
                  : <Button size="sm" variant="ghost" blocked={purgeModel.blocked} onClick={() => setPurging({ kind: 'model', id: m.id, name: m.name })}>Purge</Button>) },
              ]} />
            </Section>
            <Section title="Anchors">
              {d.anchors.length === 0 ? <p className={styles.muted}>Nothing anchored yet.</p> : (
                <DataTable label="Anchors" rows={d.anchors} rowKey={(a) => a.id} dense columns={[
                  { id: 'on', header: 'On', primary: true, cell: (a) => anchorName(a, d) },
                  { id: 'what', header: 'What', cell: (a) => (a.matchRule !== null ? <span>Every {lookup?.typeName(a.objectTypeId).toLowerCase() ?? 'object'} where <span className={styles.mono}>{a.matchRule}</span></span> : `One ${lookup?.typeName(a.objectTypeId).toLowerCase() ?? 'object'}`) },
                  { id: 'where', header: 'Where', width: 'md', cell: (a) => (a.modelNodeName !== null ? a.modelNodeName : `${a.planX}, ${a.planY}`) },
                  { id: 'act', header: <span className="visually-hidden">Remove</span>, width: 'sm', align: 'end', cell: (a) => <Button size="sm" variant="ghost" blocked={removeAnchor.blocked} onClick={async () => {
                    const r = await removeAnchor.run({ params: { anchorId: a.id } });
                    if (r.ok) say('Anchor removed');
                  }}>Remove</Button> },
                ]} />
              )}
            </Section>
            {params.get('anchor') !== null ? <AnchorDialog assets={d} open onClose={() => set({ anchor: undefined })} /> : null}
          </div>
        )}
      </QueryView>
      {register !== null ? <RegisterDialog kind={register === 'model' ? 'model' : 'plan'} open onClose={() => set({ new: undefined })} /> : null}
      <ConfirmDialog open={purging !== undefined} onClose={() => setPurging(undefined)} title={`Purge ${purging?.name ?? ''}?`} confirmLabel="Purge" tone="danger" typeToConfirm="purge"
        onConfirm={async () => {
          const r = purging!.kind === 'plan' ? await purgePlan.run({ params: { planId: purging!.id } }) : await purgeModel.run({ params: { assetModelId: purging!.id } });
          if (r.ok) say('Purged from the Silo');
          return r;
        }}><p>The file is removed from the Silo for good, with its anchors. Canvases laid out on it fall back to another layout.</p></ConfirmDialog>
      <Panel><p className={styles.muted}>Upload plans and models in <Link href="/siloes/import/">Import Siloes</Link>.</p></Panel>
    </Page>
  );
}
