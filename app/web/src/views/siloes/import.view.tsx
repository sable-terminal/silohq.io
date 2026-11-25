'use client';

// Import Silos (spec 68): files and watched locations read into objects. A source is where files
// come in (uploaded here, or dropped at a watched location read on a schedule), each read by a
// published definition: from the catalogue, written by hand, or drafted from one of the Silo's
// own files (a table's header and value types; a document by the model under the carve-out, which
// is acknowledged for the Silo first) and probed against that file before it is published. What
// was read from a document as near or inferred waits for a person to confirm it.

import { useRef, useState } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, RadioGroup, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useData, useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatBytes, formatNumber, humanise, plural } from '../../utils/format.util.ts';
import { base64Of, ONE_REQUEST, sendSigned } from '../files/transfer.view.ts';
import { useSiloChoice } from './overview.view.tsx';
import type { Silo } from './words.view.ts';
import styles from './siloes.view.module.css';

type Source = Output<'listSiloSources'>['sources'][number];
type Definition = Output<'listSiloDefinitions'>['definitions'][number];
type Document = Definition['document'];
type Draft = Output<'draftSiloDefinition'>;
type Tab = 'files' | 'sources' | 'definitions' | 'confirm';
const TABS: TabDef<Tab>[] = [{ id: 'files', label: 'Files' }, { id: 'sources', label: 'Sources' }, { id: 'definitions', label: 'Definitions' }, { id: 'confirm', label: 'To confirm' }];
const FILE_STATUS: Record<'received' | 'processed' | 'failed' | 'purged', { label: string; tone: 'info' | 'ok' | 'danger' | 'neutral' }> = {
  received: { label: 'Received', tone: 'info' }, processed: { label: 'Read', tone: 'ok' }, failed: { label: 'Failed', tone: 'danger' }, purged: { label: 'Purged', tone: 'neutral' },
};
const METHOD: Record<'certain' | 'near' | 'inferred', string> = { certain: 'Read exactly', near: 'Near its label', inferred: 'Inferred by the model' };

export function ImportSiloes() {
  const { silo, picker, none } = useSiloChoice('import');
  usePageContext({ scope: { kind: 'page', page: 'siloes' }, scopeLabel: 'Import' });
  return (
    <Page title="Import" description="Files and watched locations read into objects, each by a definition you publish; anything read only near its label or inferred waits for a person."
      crumbs={[{ label: 'Siloes', href: '/siloes/overview/' }]}>
      <div className={styles.stack}>
        {picker}
        {none ? <EmptyState icon="upload" title="No Import Silo" action={<LinkButton href="/siloes/overview/?new=1" variant="primary">New Silo</LinkButton>}>Make an Import Silo to read files into objects.</EmptyState> : null}
        {silo !== undefined ? <ImportSilo key={silo.id} silo={silo} /> : null}
      </div>
    </Page>
  );
}

function ImportSilo({ silo }: { silo: Silo }) {
  const [tab, setTab] = useTab(TABS);
  const extractions = useQuery('listSiloExtractions', { params: { siloId: silo.id }, query: { unconfirmed: 'true' } });
  const waiting = extractions.data?.extractions.length ?? 0;
  const tabs = TABS.map((t) => (t.id === 'confirm' ? { ...t, count: waiting > 0 ? waiting : undefined } : t));
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>{silo.disclosure}</p>
      <Tabs label="Import" tabs={tabs} current={tab} onChange={setTab} />
      <TabPanel id={tab}>
        {tab === 'files' ? <Files silo={silo} /> : tab === 'sources' ? <Sources silo={silo} /> : tab === 'definitions' ? <Definitions silo={silo} /> : <ToConfirm silo={silo} />}
      </TabPanel>
    </div>
  );
}

function Files({ silo }: { silo: Silo }) {
  const [params] = useParams();
  const files = useQuery('listSiloFiles', { params: { siloId: silo.id } });
  const [uploading, setUploading] = useState(false);
  const named = params.get('file');
  return (
    <Section title="Files" actions={<Button variant="primary" icon="upload" onClick={() => setUploading(true)}>Upload</Button>}>
      <QueryView query={files} what="Files" isEmpty={(d) => d.files.length === 0}
        empty={<EmptyState icon="upload" title="No files yet">Upload a file, or drop one at a watched location.</EmptyState>}>
        {(d) => (
          <div className={styles.stackTight}>
            {named !== null && !d.files.some((f) => f.id === named) ? <Banner tone="info" title="That file is not in this Silo">It may have been purged, or be in another Silo.</Banner> : null}
            <DataTable label="Files" rows={d.files} rowKey={(f) => f.id} columns={[
              { id: 'name', header: 'File', primary: true, cell: (f) => <span className={styles.row}>{f.filename}{f.id === named ? <Badge tone="accent">The one you followed</Badge> : null}</span> },
              { id: 'kind', header: 'Read as', width: 'sm', cell: (f) => humanise(f.contentClass) },
              { id: 'size', header: 'Size', width: 'sm', align: 'end', cell: (f) => formatBytes(f.sizeBytes) },
              { id: 'state', header: 'State', width: 'sm', cell: (f) => <Badge tone={FILE_STATUS[f.status].tone}>{FILE_STATUS[f.status].label}</Badge> },
              { id: 'why', header: 'Why it failed', cell: (f) => (f.errorStage === null ? '' : humanise(f.errorStage)) },
              { id: 'when', header: 'Received', width: 'sm', cell: (f) => <Time value={f.receivedAt} /> },
            ]} />
          </div>
        )}
      </QueryView>
      {uploading ? <UploadDialog silo={silo} onClose={() => setUploading(false)} /> : null}
    </Section>
  );
}

/** A file into the Silo through an upload source, read by its definition. */
function UploadDialog({ silo, onClose }: { silo: Silo; onClose: () => void }) {
  const say = useToast();
  const { api, cache } = useData();
  const sources = useQuery('listSiloSources', { params: { siloId: silo.id } });
  const definitions = useQuery('listSiloDefinitions', { params: { siloId: silo.id } });
  const input = useRef<HTMLInputElement>(null);
  const [sourceId, setSourceId] = useState('');
  const [special, setSpecial] = useState<'' | 'site_plan' | 'asset_model'>('');
  const [state, setState] = useState<{ pending: boolean; error: unknown }>({ pending: false, error: undefined });
  const uploads = (sources.data?.sources ?? []).filter((s) => s.kind === 'upload' && s.disabledAt === null);
  const defName = (id: string | null) => (id === null ? 'no definition: kept, not read' : `definition version ${definitions.data?.definitions.find((d) => d.id === id)?.version ?? '?'}`);
  return (
    <Dialog open onClose={onClose} title={`Upload into ${silo.name}`} size="md" busy={state.pending}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const file = input.current?.files?.[0];
        if (file === undefined) return;
        setState({ pending: true, error: undefined });
        try {
          // An upload point without a definition is made the first time: the file is kept, and read once a definition is published for a source.
          const sid = sourceId !== '' ? sourceId : (await api.call('createSiloSource', { params: { siloId: silo.id }, body: { kind: 'upload' } })).id;
          const contentClass = special === '' ? {} : { contentClass: special };
          if (file.size <= ONE_REQUEST) {
            await api.call('uploadSiloFile', { params: { siloId: silo.id, sourceId: sid }, body: { filename: file.name, contentBase64: await base64Of(file), ...contentClass } }, { idempotencyKey: crypto.randomUUID() });
          } else {
            const transfer = await api.call('beginSiloUpload', { params: { siloId: silo.id, sourceId: sid }, body: { sizeBytes: file.size } });
            await sendSigned(transfer, file);
            await api.call('completeSiloUpload', { params: { siloId: silo.id, sourceId: sid, uploadId: transfer.uploadId }, body: { filename: file.name, ...contentClass } }, { idempotencyKey: crypto.randomUUID() });
          }
          cache.invalidateAfter('uploadSiloFile', ['listSiloFiles', 'listSiloSources']);
          say(`${file.name} received`);
          onClose();
        } catch (error) {
          setState({ pending: false, error });
        }
      }}>
        <SelectField label="Through" value={sourceId} onChange={(e) => setSourceId(e.target.value)}
          options={[{ value: '', label: 'A new upload point (no definition)' }, ...uploads.map((s) => ({ value: s.id, label: `Upload point made ${new Date(s.createdAt).toLocaleDateString('en-GB')}: ${defName(s.definitionId)}` }))]}
          hint="Its definition reads the file into objects. Make an upload point with a definition under Sources." />
        <label className={styles.stackTight}>
          <span>File</span>
          <input ref={input} type="file" required className={styles.fileInput} aria-label="File" />
        </label>
        <RadioGroup label="It is" name="special" value={special} onChange={(v) => setSpecial(v as typeof special)}
          options={[{ value: '', label: 'Data or a document' }, { value: 'site_plan', label: 'A site plan, for the Clone Canvas' }, { value: 'asset_model', label: 'A 3D model of an asset' }]} />
        {state.error !== undefined ? <ErrorMessage error={state.error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={state.pending}>Upload</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function Sources({ silo }: { silo: Silo }) {
  const say = useToast();
  const sources = useQuery('listSiloSources', { params: { siloId: silo.id } });
  const definitions = useQuery('listSiloDefinitions', { params: { siloId: silo.id } });
  const create = useMutation('createSiloSource', { invalidates: ['listSiloSources'] });
  const [making, setMaking] = useState(false);
  const [kind, setKind] = useState<'upload' | 'watched'>('upload');
  const [definitionId, setDefinitionId] = useState('');
  const [every, setEvery] = useState('60');
  const live = (definitions.data?.definitions ?? []).filter((d) => d.retiredAt === null);
  const defName = (id: string | null) => (id === null ? 'None' : `Version ${definitions.data?.definitions.find((d) => d.id === id)?.version ?? '?'}`);
  return (
    <Section title="Sources" description="Where files come in, and the definition that reads them." actions={<Button icon="plus" blocked={create.blocked} onClick={() => setMaking(true)}>New source</Button>}>
      <QueryView query={sources} what="Sources" isEmpty={(d) => d.sources.length === 0} empty={<p className={styles.muted}>No sources yet.</p>}>
        {(d) => (
          <DataTable label="Sources" rows={d.sources} rowKey={(s: Source) => s.id} columns={[
            { id: 'kind', header: 'Kind', primary: true, cell: (s: Source) => (s.kind === 'upload' ? 'Upload point' : `Watched, every ${plural(s.pollIntervalMinutes ?? 0, 'minute')}`) },
            { id: 'definition', header: 'Read by', cell: (s: Source) => defName(s.definitionId) },
            { id: 'location', header: 'Drop files at', cell: (s: Source) => (s.kind === 'watched' ? <span className={styles.mono}>{s.location}</span> : '—') },
            { id: 'polled', header: 'Last read', width: 'sm', cell: (s: Source) => (s.lastPolledAt === null ? '—' : <Time value={s.lastPolledAt} />) },
            { id: 'state', header: 'State', width: 'sm', cell: (s: Source) => (s.disabledAt === null ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>) },
          ]} />
        )}
      </QueryView>
      <Dialog open={making} onClose={() => setMaking(false)} title="New source" size="md" busy={create.pending}>
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.run({ params: { siloId: silo.id }, body: kind === 'upload'
            ? { kind, ...(definitionId === '' ? {} : { definitionId }) }
            : { kind, definitionId, pollIntervalMinutes: Math.max(5, Math.min(10_080, Number(every) || 60)) } });
          if (r.ok) {
            setMaking(false);
            say(r.data.kind === 'watched' ? 'Made: drop files at its location' : 'Made');
          }
        }}>
          <RadioGroup label="Kind" name="kind" value={kind} onChange={(v) => setKind(v as typeof kind)}
            options={[{ value: 'upload', label: 'An upload point', hint: 'People upload files here' }, { value: 'watched', label: 'A watched location', hint: 'Files dropped there are read on a schedule' }]} />
          <SelectField label="Read by" required={kind === 'watched'} value={definitionId} placeholder={kind === 'watched' ? 'Choose a definition' : 'No definition: keep files unread'}
            onChange={(e) => setDefinitionId(e.target.value)} options={live.map((d) => ({ value: d.id, label: `Version ${d.version} (${humanise(d.route).toLowerCase()})` }))}
            hint={live.length === 0 ? 'Publish a definition first.' : undefined} />
          {kind === 'watched' ? <TextField label="Read every (minutes)" type="number" min={5} max={10_080} value={every} onChange={(e) => setEvery(e.target.value)} /> : null}
          {create.error !== undefined ? <ErrorMessage error={create.error} /> : null}
          <FormActions>
            <Button onClick={() => setMaking(false)}>Cancel</Button>
            <Button type="submit" variant="primary" pending={create.pending} disabled={kind === 'watched' && definitionId === ''}>Make it</Button>
          </FormActions>
        </form>
      </Dialog>
    </Section>
  );
}

function Definitions({ silo }: { silo: Silo }) {
  const say = useToast();
  const definitions = useQuery('listSiloDefinitions', { params: { siloId: silo.id } });
  const prebuilt = useQuery('listPrebuiltDefinitions', {});
  const files = useQuery('listSiloFiles', { params: { siloId: silo.id } });
  const carveout = useMutation('acknowledgeCarveout');
  const draft = useMutation('draftSiloDefinition', { refresh: false });
  const publish = useMutation('publishSiloDefinition', { invalidates: ['listSiloDefinitions'] });
  const [dialog, setDialog] = useState<{ route: 'ai' | 'builder' | 'prebuilt'; document: Document; prebuilt?: string; probe?: Draft['probe'] } | 'draft' | 'prebuilt' | undefined>();
  const [fileId, setFileId] = useState('');
  return (
    <div className={styles.stack}>
      <Section title="Definitions" description="How a file becomes objects: each object, its identifier, and each field with where it is read from."
        actions={
          <div className={styles.row}>
            <Button onClick={() => setDialog('prebuilt')}>From the catalogue</Button>
            <Button onClick={() => setDialog({ route: 'builder', document: { objects: [{ name: 'Rows', fields: [{ name: 'name', type: 'string', extraction: { kind: 'column', column: 'name' } }] }] } })}>Write one</Button>
            <Button variant="primary" icon="sparkle" onClick={() => setDialog('draft')}>Draft from a file</Button>
          </div>
        }>
        <QueryView query={definitions} what="Definitions" isEmpty={(d) => d.definitions.length === 0} empty={<p className={styles.muted}>No definition yet: files are kept but not read.</p>}>
          {(d) => (
            <DataTable label="Definitions" rows={d.definitions} rowKey={(x) => x.id} columns={[
              { id: 'version', header: 'Version', width: 'sm', primary: true, cell: (x) => String(x.version) },
              { id: 'objects', header: 'Objects', cell: (x) => x.document.objects.map((o) => `${o.name} (${plural(o.fields.length, 'field')})`).join(', ') },
              { id: 'route', header: 'Made', width: 'sm', cell: (x) => (x.route === 'ai' ? 'Drafted by the model' : x.route === 'prebuilt' ? 'From the catalogue' : 'By hand') },
              { id: 'model', header: 'Model', width: 'sm', cell: (x) => (x.requiresModel ? 'Reads with the model' : 'No model') },
              { id: 'when', header: 'Published', width: 'sm', cell: (x) => <Time value={x.publishedAt} /> },
              { id: 'state', header: 'State', width: 'sm', cell: (x) => (x.retiredAt === null ? <Badge tone="ok">Live</Badge> : <Badge>Retired</Badge>) },
            ]} />
          )}
        </QueryView>
      </Section>
      <Section title="Documents read by the model" description="A document's definition is drafted, and its values read, by a model under the carve-out (62.5): what it reads is sent to the model provider, and values read near their label or inferred wait for a person.">
        <div className={styles.row}>
          <Button pending={carveout.pending} blocked={carveout.blocked} onClick={() => void carveout.run({ params: { siloId: silo.id } }).then((r) => r.ok && say('Acknowledged for this Silo'))}>Acknowledge the carve-out for this Silo</Button>
          {carveout.data !== undefined ? <span className={styles.muted}>Acknowledged <Time value={carveout.data.acknowledgedAt} />.</span> : null}
        </div>
        {carveout.data !== undefined ? <p className={styles.muted}>{carveout.data.disclosure}</p> : null}
        {carveout.error !== undefined ? <ErrorMessage error={carveout.error} /> : null}
      </Section>
      <Dialog open={dialog === 'draft'} onClose={() => setDialog(undefined)} title="Draft a definition from a file" size="md" busy={draft.pending}
        description="A table is read from its header and value types without a model; a document is read by the model, once the carve-out is acknowledged. Nothing is published until you do.">
        <form className={styles.form} onSubmit={async (e) => {
          e.preventDefault();
          const r = await draft.run({ params: { siloId: silo.id }, body: { fileId } });
          if (r.ok) setDialog({ route: 'ai', document: r.data.document, probe: r.data.probe });
        }}>
          <SelectField label="File" required value={fileId} placeholder={files.data === undefined ? 'Listing…' : 'Choose one of its files'} onChange={(e) => setFileId(e.target.value)}
            options={(files.data?.files ?? []).filter((f) => f.status !== 'purged').map((f) => ({ value: f.id, label: `${f.filename} (${humanise(f.contentClass).toLowerCase()})` }))} />
          {draft.error !== undefined ? <ErrorMessage error={draft.error} /> : null}
          <FormActions>
            <Button onClick={() => setDialog(undefined)}>Cancel</Button>
            <Button type="submit" variant="primary" pending={draft.pending} blocked={draft.blocked} disabled={fileId === ''}>Draft it</Button>
          </FormActions>
        </form>
      </Dialog>
      <Dialog open={dialog === 'prebuilt'} onClose={() => setDialog(undefined)} title="From the catalogue" size="md">
        <QueryView query={prebuilt} what="The catalogue" isEmpty={(d) => d.definitions.length === 0} empty={<p className={styles.muted}>The catalogue is empty.</p>}>
          {(d) => (
            <ul className={styles.plainList}>{d.definitions.map((x) => (
              <li key={x.key} className={styles.stackTight}>
                <span className={styles.row}><strong>{x.name}</strong><Badge>{humanise(x.reads)}</Badge>{x.requiresModel ? <Badge tone="info">Uses the model</Badge> : null}</span>
                <span className={styles.muted}>{x.description}</span>
                <Button size="sm" onClick={() => setDialog({ route: 'prebuilt', document: x.document, prebuilt: x.key })}>Review and publish</Button>
              </li>
            ))}</ul>
          )}
        </QueryView>
      </Dialog>
      {typeof dialog === 'object' ? (
        <PublishDialog draft={dialog} pending={publish.pending} error={publish.error} onClose={() => setDialog(undefined)}
          onPublish={(document) => void publish.run({ params: { siloId: silo.id }, body: { route: dialog.route, document, ...(dialog.prebuilt === undefined ? {} : { prebuilt: dialog.prebuilt }) } }).then((r) => {
            if (!r.ok) return;
            setDialog(undefined);
            say(`Version ${r.data.version} published: make a source that reads with it`);
          })} />
      ) : null}
    </div>
  );
}

/** A definition reviewed as JSON before it is published, with its probe against the file it was drafted from. */
function PublishDialog({ draft, pending, error, onClose, onPublish }: {
  draft: { route: 'ai' | 'builder' | 'prebuilt'; document: Document; probe?: Draft['probe'] }; pending: boolean; error: unknown; onClose: () => void; onPublish: (d: Document) => void;
}) {
  const [text, setText] = useState(JSON.stringify(draft.document, null, 2));
  const [problem, setProblem] = useState<string | undefined>();
  const locked = draft.route === 'prebuilt';
  return (
    <Dialog open onClose={onClose} title={draft.route === 'prebuilt' ? 'Publish from the catalogue' : draft.route === 'ai' ? 'Review the draft' : 'Write a definition'} size="lg" busy={pending}>
      <form className={styles.form} onSubmit={(e) => {
        e.preventDefault();
        try {
          const parsed = JSON.parse(text) as Document;
          if (!Array.isArray(parsed.objects)) throw new Error('no objects');
          setProblem(undefined);
          onPublish(parsed);
        } catch {
          setProblem('Not a definition: it is an object with a list of objects, each with its fields.');
        }
      }}>
        {draft.probe !== undefined ? (
          <Panel>
            <div className={styles.stackTight}>
              <strong>Probed against the file: {plural(draft.probe.rows, 'row')}{draft.probe.identifierUnique === false ? '; its identifier repeats' : ''}</strong>
              <Properties columns={2} items={draft.probe.fields.map((f) => [f.field, `${formatNumber(f.present)} present${f.unreadable > 0 ? `, ${formatNumber(f.unreadable)} unreadable` : ''}`] as const)} />
            </div>
          </Panel>
        ) : null}
        <TextArea label="Definition" className={styles.mono} rows={18} value={text} readOnly={locked} onChange={(e) => setText(e.target.value)} error={problem}
          hint={locked ? 'Published exactly as the catalogue holds it.' : 'Each field is read from a column, near a label, or (in prose) by an instruction. It is validated when published, and refused rather than repaired.'} />
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={pending}>Publish</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function ToConfirm({ silo }: { silo: Silo }) {
  const say = useToast();
  const list = useQuery('listSiloExtractions', { params: { siloId: silo.id }, query: { unconfirmed: 'true' } });
  const confirm = useMutation('confirmSiloExtraction', { invalidates: ['listSiloExtractions'] });
  const [open, setOpen] = useState<string | undefined>();
  const one = useQuery('getSiloExtraction', open === undefined ? null : { params: { siloId: silo.id, extractionId: open } });
  return (
    <Section title="To confirm" description="Values read near their label, or inferred by the model: each waits for a person before it is relied on.">
      <QueryView query={list} what="Values to confirm" isEmpty={(d) => d.extractions.length === 0} empty={<EmptyState icon="check" title="Nothing waiting">Every value read from its documents is confirmed or exact.</EmptyState>}>
        {(d) => (
          <DataTable label="Values to confirm" rows={d.extractions} rowKey={(x) => x.id} columns={[
            { id: 'from', header: 'From', primary: true, cell: (x) => <span>{x.filename} <span className={styles.muted}>({x.location})</span></span> },
            { id: 'field', header: 'Field', cell: (x) => `${x.object}.${x.field}` },
            { id: 'how', header: 'How it was read', cell: (x) => `${METHOD[x.method]}${x.modelScore !== null ? ` (score ${x.modelScore.toFixed(2)})` : ''}` },
            { id: 'act', header: <span className="visually-hidden">Act</span>, align: 'end', cell: (x) => <Button size="sm" onClick={() => setOpen(x.id)}>Check it</Button> },
          ]} />
        )}
      </QueryView>
      <Dialog open={open !== undefined} onClose={() => setOpen(undefined)} title="Check the value" size="md" busy={confirm.pending}>
        <QueryView query={one} what="The value">
          {(x) => (
            <div className={styles.stack}>
              <Properties columns={1} items={[
                ['From', `${x.filename}, ${x.location}`],
                ['Field', `${x.object}.${x.field}`],
                ['Read', <span key="v" className={styles.mono}>{typeof x.value === 'object' ? JSON.stringify(x.value) : String(x.value)}</span>],
                ['How', METHOD[x.method]],
              ]} />
              {confirm.error !== undefined ? <ErrorMessage error={confirm.error} /> : null}
              <FormActions>
                <Button onClick={() => setOpen(undefined)}>Not now</Button>
                <Button variant="primary" pending={confirm.pending} blocked={confirm.blocked} onClick={() => void confirm.run({ params: { siloId: silo.id, extractionId: x.id } }).then((r) => {
                  if (!r.ok) return;
                  setOpen(undefined);
                  say('Confirmed');
                })}>Confirm it</Button>
              </FormActions>
            </div>
          )}
        </QueryView>
      </Dialog>
    </Section>
  );
}
