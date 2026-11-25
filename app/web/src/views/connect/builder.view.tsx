'use client';

// The connector builder (spec 16.3, 16.4, 16.6): a connector for a system the catalogue does not
// have. From documentation, the AI route: an OpenAPI, WSDL, GraphQL or OData description, a
// documentation page or text, sample emails, or the base URL alone, drafted into a private
// connector and a sandbox connection, then probed, reconciled, tested and mapped, stage by stage,
// with the person confirming each object's mapping. By hand, the visual route: the manifest as
// YAML, checked step by step, tried against the sandbox (the rows read go back to the person
// and nowhere else), then published, which runs the conformance suite. A half-built connector
// stays a draft the editor can open.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, fieldError, FormActions, RadioGroup, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useData, useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useRefreshWhile } from '../../hooks/refresh.hook.ts';
import { connectionHref } from '../../navigation/links.navigation.ts';
import { usePageContext, useWorkspace } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './connect.view.module.css';

type Connector = Output<'listConnectors'>['connectors'][number];
type Build = Output<'getBuild'>;
type Stage = Build['stages'][number];
type Documentation = Input<'draftConnector'>['body']['documentation'];
type Issue = Output<'validateDraft'>['issues'][number];
type Step = NonNullable<Input<'validateDraft'>['body']['step']>;
type Doc = Record<string, unknown>;

const STAGE: Record<Stage['stage'], string> = {
  parse: 'Reading the description', probe: 'Reading the system', reconcile: 'Matching what it said with what it does', conform: 'Testing',
  propose_mapping: 'Proposing object types', confirm: 'Your confirmation', verify: 'Verification', recheck: 'Re-checking',
};
const STEP: Record<Step, string> = {
  transport: 'Transport', auth: 'Sign-in', objects: 'Objects', records: 'Records', fields: 'Fields', paging: 'Paging', pushdown: 'Filtering at the source', errors: 'Errors',
};
const ROUTE: Record<Connector['sourceRoute'], string> = { ai: 'From documentation', visual: 'By hand', catalogue: 'Catalogue', silo: 'Silo' };

const slugOf = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'connector';

/** A first manifest to start from by hand: one REST object, read with a bearer token. */
const STARTER = (name: string, provider: string): Doc => ({
  schemaVersion: '1',
  identity: { name, provider, version: '0.1.0' },
  transport: { viaAgent: false, baseUrl: 'https://api.example.com' },
  protocol: { kind: 'rest' },
  auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
  objects: [{
    name: 'records', identifier: ['id'],
    fields: [{ name: 'id', type: 'string' }, { name: 'name', type: 'string' }],
    source: { kind: 'rest', request: { method: 'GET', path: '/v1/records' }, records: { jsonata: 'results' } },
  }],
});

/** Rows read in a try or a preview, as a table: shown to the person only. */
function Rows({ rows, label }: { rows: readonly Record<string, unknown>[]; label: string }) {
  const keys = useMemo(() => [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 12), [rows]);
  if (rows.length === 0) return <p className={styles.muted}>No rows came back.</p>;
  return (
    <DataTable label={label} rows={rows.map((r, i) => ({ i, r }))} rowKey={(x) => String(x.i)} dense columns={keys.map((k, n) => ({
      id: k, header: k, primary: n === 0, cell: (x: { r: Record<string, unknown> }) => {
        const v = x.r[k];
        return <span className={styles.mono}>{v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>;
      },
    }))} />
  );
}

function Issues({ issues }: { issues: readonly Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className={styles.plainList} aria-label="Problems">
      {issues.map((i, n) => (
        <li key={n}><span className={styles.mono}>{i.path || '(document)'}{i.line !== undefined ? `, line ${i.line}${i.column !== undefined ? `:${i.column}` : ''}` : ''}</span>: {i.message}</li>
      ))}
    </ul>
  );
}

/** A sandbox's credentials, as its manifest's auth declares them: sealed, never shown again. */
function SandboxSecrets({ connectionId, fields }: { connectionId: string; fields: readonly { name: string; kind: string; label: string }[] }) {
  const say = useToast();
  const save = useMutation('setBuildSecrets');
  const [values, setValues] = useState<Record<string, string>>({});
  const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
  if (fields.length === 0) return <p className={styles.muted}>Its manifest declares no credentials.</p>;
  return (
    <form className={styles.form} autoComplete="off" onSubmit={async (event) => {
      event.preventDefault();
      const r = await save.run({ params: { connectionId }, body: { values: given } });
      if (r.ok) {
        setValues({});
        say('Sandbox credentials sealed');
      }
    }}>
      {fields.map((f) => {
        const last = save.data?.fields.find((x) => x.name === f.name)?.lastFour;
        return <TextField key={f.name} label={f.label} type={f.kind === 'secret' ? 'password' : 'text'} autoComplete={f.kind === 'secret' ? 'new-password' : 'off'}
          value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} hint={last != null ? `Sealed; ends ${last}` : undefined} />;
      })}
      {save.error !== undefined ? <ErrorMessage error={save.error} /> : null}
      <FormActions><Button type="submit" pending={save.pending} blocked={save.blocked} disabled={Object.keys(given).length === 0}>Save credentials</Button></FormActions>
    </form>
  );
}

// ----------------------------------------------------------------------------- new connector

function NewConnectorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const say = useToast();
  const [, set] = useParams();
  const scopes = useQuery('listMyPermittedScopes', { query: { permission: 'connection.create' } });
  const draft = useMutation('draftConnector', { invalidates: ['listConnectors', 'listConnections'] });
  const create = useMutation('createConnector', { invalidates: ['listConnectors'] });
  const [route, setRoute] = useState<'ai' | 'visual'>('ai');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | undefined>(undefined);
  const [provider, setProvider] = useState('');
  const [kind, setKind] = useState<Documentation['kind']>('openapi');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [scopeId, setScopeId] = useState('');
  const slugValue = slug ?? slugOf(name);
  const documentation = (): Documentation => {
    switch (kind) {
      case 'openapi': case 'wsdl': case 'graphql': case 'odata': return { kind, text };
      case 'text': return { kind, title: title.trim() || name.trim(), text };
      case 'email': return { kind, samples: text.split(/\n-{3,}\n/).map((s) => s.trim()).filter(Boolean) };
      case 'url': return { kind, url: url.trim() };
      case 'base_url': return { kind };
    }
  };
  const scope = scopeId || (scopes.data?.scopes.length === 1 ? scopes.data.scopes[0]!.id : '');
  const error = route === 'ai' ? draft.error : create.error;
  const pending = draft.pending || create.pending;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (route === 'ai') {
      const r = await draft.run({
        body: { name: name.trim(), slug: slugValue, provider: provider.trim(), documentation: documentation(), ...(baseUrl.trim() !== '' ? { baseUrl: baseUrl.trim() } : {}),
          sandbox: { name: `${name.trim()} (sandbox)`, owningScopeId: scope } },
      }, { timeoutMs: 180_000 });
      if (r.ok) {
        say('Drafted: give the sandbox its credentials, then probe it');
        set({ new: undefined, build: r.data.connectionId }, { push: true });
      }
    } else {
      const r = await create.run({ body: { name: name.trim(), slug: slugValue, provider: provider.trim(), sourceRoute: 'visual' } });
      if (r.ok) set({ new: undefined, edit: r.data.id }, { push: true });
    }
  };
  const needsText = kind === 'openapi' || kind === 'wsdl' || kind === 'graphql' || kind === 'odata' || kind === 'text' || kind === 'email';
  return (
    <Dialog open={open} onClose={onClose} title="New connector" size="lg" busy={pending}>
      <form onSubmit={submit} className={styles.form}>
        <RadioGroup name="route" label="How" value={route} onChange={setRoute} options={[
          { value: 'ai', label: 'From its documentation', hint: 'Silo drafts the connector and a sandbox connection, reads the system, tests it and proposes object types for you to confirm.' },
          { value: 'visual', label: 'By hand', hint: 'Write the manifest yourself, step by step, and try it against a sandbox as you go.' },
        ]} />
        <div className={styles.split}>
          <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} data-autofocus error={fieldError(error, 'name')} />
          <TextField label="System maker" required maxLength={200} value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="Acme Corp" error={fieldError(error, 'provider')} />
          <TextField label="Short name" required value={slugValue} onChange={(e) => setSlug(e.target.value)} spellCheck={false}
            hint="Lower-case letters, digits and hyphens." error={fieldError(error, 'slug')} />
        </div>
        {route === 'ai' ? (
          <>
            <SelectField label="What you have" value={kind} onChange={(e) => setKind(e.target.value as Documentation['kind'])} options={[
              { value: 'openapi', label: 'An OpenAPI description' }, { value: 'url', label: 'The address of its documentation or description' },
              { value: 'text', label: 'Documentation, pasted' }, { value: 'wsdl', label: 'A WSDL (SOAP)' }, { value: 'graphql', label: 'A GraphQL schema' },
              { value: 'odata', label: 'An OData $metadata document' }, { value: 'email', label: 'Sample emails (a system with no API)' }, { value: 'base_url', label: 'Only its address' },
            ]} />
            {kind === 'text' ? <TextField label="Documentation title" value={title} onChange={(e) => setTitle(e.target.value)} /> : null}
            {needsText ? (
              <TextArea label={kind === 'email' ? 'Sample emails, whole, separated by a line of ---' : 'Paste it here'} required rows={10} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
                hint={kind === 'email' ? 'Drafted in your cell, never by a model; only counts are kept, never a sample.' : kind === 'text' ? 'Documentation written for people: never record values.' : undefined}
                error={fieldError(error, 'documentation.text')} />
            ) : null}
            {kind === 'url' ? <TextField label="Address" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} error={fieldError(error, 'documentation.url')} /> : null}
            <TextField label={kind === 'base_url' || kind === 'graphql' || kind === 'odata' ? 'The system\'s address' : 'The system\'s address (if the description gives none or another)'}
              required={kind === 'base_url' || kind === 'graphql' || kind === 'odata'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com"
              error={fieldError(error, 'baseUrl')} />
            <SelectField label="Sandbox owned by" required value={scope} onChange={(e) => setScopeId(e.target.value)} placeholder="Choose a scope"
              options={(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))} hint="The sandbox connection the build reads through." />
          </>
        ) : null}
        {error !== undefined && ['name', 'provider', 'slug', 'baseUrl', 'documentation.text', 'documentation.url'].every((f) => fieldError(error, f) === undefined) ? <ErrorMessage error={error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={pending} blocked={route === 'ai' ? draft.blocked : create.blocked}
            disabled={name.trim() === '' || provider.trim() === '' || (route === 'ai' && (scope === '' || (needsText && text.trim() === '') || (kind === 'url' && url.trim() === '')))}>
            {route === 'ai' ? 'Draft it' : 'Create and open the editor'}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- the AI route's build

function BuildPage({ connectionId }: { connectionId: string }) {
  const say = useToast();
  const read = useQuery('getBuild', { params: { connectionId } });
  const b = read.data;
  useRefreshWhile(b?.running === true || b?.status === 'running', read.refetch, 3000);
  const setup = useQuery('getConnectorSetup', b === undefined ? null : { params: { connectorId: b.connectorId }, query: { manifestId: b.manifest.id } });
  const connector = useQuery('getConnector', b === undefined ? null : { params: { connectorId: b.connectorId } });
  const probe = useMutation('probeBuild', { invalidates: ['getBuild'] });
  const preview = useMutation('previewBuild');
  const confirm = useMutation('confirmBuild', { invalidates: ['getBuild', 'listConnections'] });
  const [object, setObject] = useState('');
  const [decisions, setDecisions] = useState<Record<string, { accept: boolean; objectType: string; identifier: string }>>({});
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: connector.data?.name ?? 'A connector build' });
  if (b === undefined) {
    return <Page title="Connector build" crumbs={[{ label: 'Connect' }, { label: 'Connector builder', href: '/connect/builder/' }]}>
      {read.status === 'error' ? <ErrorMessage error={read.error} onRetry={read.refetch} /> : <Loading label="Reading the build" />}
    </Page>;
  }
  const decision = (p: Build['proposals'][number]) => decisions[p.object] ?? { accept: true, objectType: p.objectType, identifier: p.identifier.join(', ') };
  const confirmable = b.proposals.length > 0 && !b.running && b.connectionStatus !== 'verified';
  return (
    <Page title={connector.data?.name ?? 'Connector build'} crumbs={[{ label: 'Connect' }, { label: 'Connector builder', href: '/connect/builder/' }]}
      meta={<span className={styles.row}><Badge tone={b.status === 'failed' ? 'danger' : b.running ? 'info' : 'ok'}>{b.running ? 'Working' : b.status === 'failed' ? 'Stopped' : 'Ready'}</Badge>
        <span>Version {b.manifest.version}</span><span>Sandbox {b.connectionStatus}</span></span>}
      actions={<>
        <LinkButton href={hrefWith('/connect/builder/', { edit: b.connectorId, connection: b.connectionId })} icon="edit">Open in the editor</LinkButton>
        <LinkButton href={connectionHref(b.connectionId)}>Sandbox connection</LinkButton>
      </>}>
      <Section title="Stages">
        <ol className={styles.plainList}>
          {b.stages.map((s, i) => (
            <li key={`${s.stage}${i}`}>
              <span className={styles.row}>
                <Status tone={s.status === 'completed' ? 'ok' : s.status === 'failed' ? 'danger' : 'info'}>{STAGE[s.stage]}</Status>
                <span className={styles.muted}><Time value={s.startedAt} />{s.completedAt !== null ? '' : ', still going'}</span>
              </span>
              {s.status === 'failed' && s.errors !== null ? <span className={styles.muted}>{typeof s.errors === 'string' ? s.errors : JSON.stringify(s.errors).slice(0, 300)}</span> : null}
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Sandbox credentials" description="Sealed for the sandbox connection the build reads through; the builder never keeps them.">
        {setup.data === undefined ? <Loading label="Reading its sign-in" block={false} /> : <SandboxSecrets connectionId={connectionId} fields={setup.data.auth.fields} />}
      </Section>
      <Panel>
        <div className={styles.next}>
          <p className={styles.muted}>Probing reads each object whole, matches it with the description, tests it and proposes object types. It goes on after you leave.</p>
          <Button variant="primary" icon="play" pending={probe.pending} blocked={probe.blocked} disabled={b.running} onClick={async () => {
            const r = await probe.run({ params: { connectionId } });
            if (r.ok) say('Probing: this page follows it');
          }}>{b.stages.some((s) => s.stage === 'probe') ? 'Probe again' : 'Probe it'}</Button>
        </div>
        {probe.error !== undefined ? <ErrorMessage error={probe.error} /> : null}
      </Panel>
      {setup.data !== undefined && setup.data.objects.length > 0 ? (
        <Section title="Look at its records" description="Read now, shown to you, and kept nowhere.">
          <Toolbar end={<Button pending={preview.pending} blocked={preview.blocked} disabled={object === ''} onClick={() => void preview.run({ params: { connectionId }, body: { object, limit: 10 } })}>Read 10</Button>}>
            <SelectField label="Object" value={object} onChange={(e) => setObject(e.target.value)} placeholder="Choose an object" options={setup.data.objects.map((o) => ({ value: o.name, label: o.label ?? o.name }))} />
          </Toolbar>
          {preview.error !== undefined ? <ErrorMessage error={preview.error} /> : null}
          {preview.data !== undefined ? <Rows rows={preview.data.rows} label={`Records of ${object}`} /> : null}
        </Section>
      ) : null}
      {b.proposals.length > 0 ? (
        <Section title="Object types it proposes" description="Accept or correct each. Someone who may verify connectors then confirms the connection.">
          <div className={styles.stack}>
            {b.proposals.map((p) => {
              const d = decision(p);
              const put = (change: Partial<typeof d>) => setDecisions({ ...decisions, [p.object]: { ...d, ...change } });
              return (
                <Panel key={p.object}>
                  <div className={styles.stack}>
                    <Checkbox label={<><span className={styles.mono}>{p.object}</span> as an object type</>} checked={d.accept} onChange={() => put({ accept: !d.accept })}
                      hint={`${Math.round(p.confidence * 100)}% sure; ${plural(p.properties.length, 'property', 'properties')}, ${plural(p.links.length, 'link')}`} />
                    {d.accept ? (
                      <div className={styles.split}>
                        <TextField label="Type name" value={d.objectType} onChange={(e) => put({ objectType: e.target.value })} />
                        <TextField label="Identified by" value={d.identifier} onChange={(e) => put({ identifier: e.target.value })} hint="Fields, separated by commas." />
                      </div>
                    ) : null}
                  </div>
                </Panel>
              );
            })}
            {confirm.error !== undefined ? <ErrorMessage error={confirm.error} /> : null}
            <FormActions>
              <Button variant="primary" pending={confirm.pending} blocked={confirm.blocked} disabled={!confirmable} onClick={async () => {
                const r = await confirm.run({ params: { connectionId }, body: { decisions: b.proposals.map((p) => {
                  const d = decision(p);
                  return d.accept
                    ? { object: p.object, accept: true, objectType: d.objectType.trim(), identifier: d.identifier.split(',').map((x) => x.trim()).filter(Boolean) }
                    : { object: p.object, accept: false };
                }) } });
                if (r.ok) say('Mapping confirmed: verify the connection next');
              }}>Confirm the mapping</Button>
            </FormActions>
          </div>
        </Section>
      ) : null}
    </Page>
  );
}

// ----------------------------------------------------------------------------- the visual route's editor

function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (document: Doc, notes: readonly string[]) => void }) {
  const importing = useMutation('importDraft');
  const [kind, setKind] = useState<'graphql' | 'odata' | 'wsdl'>('wsdl');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await importing.run({ body: { kind, text, name: name.trim(), provider: provider.trim(), ...(baseUrl.trim() !== '' ? { baseUrl: baseUrl.trim() } : {}) } });
    if (r.ok && r.data.issues.length === 0) {
      onImported(r.data.document, r.data.notes);
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Start from a service description" size="lg" busy={importing.pending}
      description="Compiled without a model. What could not be carried over is named. It replaces what is in the editor.">
      <form onSubmit={submit} className={styles.form}>
        <RadioGroup name="import-kind" label="Description" value={kind} onChange={setKind} options={[
          { value: 'wsdl', label: 'WSDL (SOAP)' }, { value: 'graphql', label: 'GraphQL schema or introspection' }, { value: 'odata', label: 'OData $metadata' },
        ]} />
        <div className={styles.split}>
          <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
          <TextField label="System maker" required value={provider} onChange={(e) => setProvider(e.target.value)} />
          <TextField label="The system's address" required={kind !== 'wsdl'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" />
        </div>
        <TextArea label="Paste it here" required rows={10} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        {importing.data !== undefined && importing.data.issues.length > 0 ? <Banner tone="warn" title="It could not be compiled"><Issues issues={importing.data.issues} /></Banner> : null}
        {importing.error !== undefined ? <ErrorMessage error={importing.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={importing.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={importing.pending} blocked={importing.blocked} disabled={text.trim() === '' || name.trim() === '' || provider.trim() === ''}>Import</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function InferPanel({ connectionId }: { connectionId: string }) {
  const infer = useMutation('inferConnection');
  const out = infer.data;
  return (
    <Section title="What the sandbox holds" description="Silo reads a sample of each object and works out its fields, identifier, paging and relationships, to help you write them.">
      <Toolbar end={<Button icon="search" pending={infer.pending} blocked={infer.blocked} onClick={() => void infer.run({ params: { connectionId }, body: {} }, { timeoutMs: 120_000 })}>Work it out</Button>} />
      {infer.error !== undefined ? <ErrorMessage error={infer.error} /> : null}
      {out !== undefined ? (
        <div className={styles.stack}>
          {out.failures.length > 0 ? <Banner tone="warn" title="Some objects could not be read">{out.failures.map((f) => `${f.object}: ${f.meaning ?? f.code}`).join('; ')}</Banner> : null}
          {out.schema.objects.map((o) => (
            <Panel key={o.name}>
              <h3 className={styles.subheading}>{o.name} <span className={styles.muted}>({plural(o.sampled, 'record')} sampled{o.recordsPath !== null ? `, records at ${o.recordsPath}` : ''})</span></h3>
              <p className={styles.muted}>
                Identified by {o.identifier === null ? 'nothing found unique' : `${o.identifier.fields.join(', ')} (${Math.round(o.identifier.confidence * 100)}%)`}
                {o.paging.length > 0 ? `; pages by ${o.paging[0]!.style} at ${o.paging[0]!.path}` : ''}
              </p>
              <DataTable label={`Fields of ${o.name}`} rows={o.fields} rowKey={(f) => f.path} dense columns={[
                { id: 'name', header: 'Field', primary: true, cell: (f) => <span className={styles.mono}>{f.name}</span> },
                { id: 'path', header: 'Path', cell: (f) => <span className={styles.mono}>{f.path}</span> },
                { id: 'type', header: 'Type', width: 'sm', cell: (f) => `${f.type}${f.format !== null ? ` (${f.format})` : ''}${f.nullable ? ', may be empty' : ''}` },
                { id: 'sure', header: 'Sure', width: 'xs', align: 'end', cell: (f) => `${Math.round(f.confidence * 100)}%` },
              ]} />
              {o.relationships.length > 0 ? <p className={styles.muted}>Refers to: {o.relationships.map((r) => `${r.field} → ${r.targetObject}.${r.targetField}`).join('; ')}</p> : null}
            </Panel>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function Editor({ connectorId }: { connectorId: string }) {
  const say = useToast();
  const router = useRouter();
  const { api } = useData();
  const workspace = useWorkspace();
  const [params, set] = useParams();
  const connector = useQuery('getConnector', { params: { connectorId } });
  const versions = useQuery('listConnectorVersions', { params: { connectorId } });
  const connections = useQuery('listConnections', { query: { limit: 500 } });
  const scopes = useQuery('listMyPermittedScopes', { query: { permission: 'connection.create' } });
  const sandboxes = (connections.data?.connections ?? []).filter((c) => c.connectorId === connectorId && c.status !== 'revoked');
  const sandboxId = params.get('connection') ?? sandboxes[0]?.id;
  const latest = versions.data?.versions[0];
  const opened = useQuery('getConnectorDocument', latest === undefined ? null : { params: { connectorId, versionId: latest.id } });
  const validate = useMutation('validateDraft');
  const attempt = useMutation('tryDraft', { invalidates: ['listConnectorVersions', 'listConnections'] });
  const publish = useMutation('publishDraft', { invalidates: ['listConnectorVersions', 'listConnections'] });
  const save = useMutation('createManifestVersion', { invalidates: ['listConnectorVersions'] });
  const [yaml, setYaml] = useState<string | undefined>(undefined);
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  const [notes, setNotes] = useState<readonly string[]>([]);
  const [step, setStep] = useState<Step | ''>('');
  const [object, setObject] = useState('');
  const [newScope, setNewScope] = useState('');
  const [importing, setImporting] = useState(false);
  const [parsed, setParsed] = useState<Doc | undefined>(undefined);
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: connector.data?.name ?? 'Connector editor' });

  // The editor opens the latest version, or a starter for a connector with none.
  useEffect(() => {
    if (yaml !== undefined || versions.data === undefined || connector.data === undefined) return;
    if (latest !== undefined && opened.data === undefined) return;
    const doc = opened.data?.document ?? STARTER(connector.data.name, connector.data.provider);
    void api.call('convertDraft', { body: { to: 'yaml', document: doc as never } }).then((r) => {
      setYaml(r.yaml ?? '');
      setParsed(doc);
    }, () => setYaml(JSON.stringify(doc, null, 2)));
  }, [yaml, versions.data, connector.data, latest, opened.data, api]);

  /** The editor's text as a document, or its problems placed at their lines. */
  const toDocument = async (): Promise<Doc | undefined> => {
    try {
      const r = await api.call('convertDraft', { body: { to: 'json', yaml: yaml ?? '' } });
      setIssues(r.issues);
      if (r.document !== null) setParsed(r.document);
      return r.document ?? undefined;
    } catch (e) {
      setIssues([{ path: '', code: 'convert', message: e instanceof Error ? e.message : 'It could not be read.' }]);
      return undefined;
    }
  };
  const objects = Array.isArray(parsed?.['objects']) ? (parsed['objects'] as { name?: unknown }[]).map((o) => String(o.name ?? '')).filter(Boolean) : [];
  const authFields = (((parsed?.['auth'] as { fields?: unknown } | undefined)?.fields) ?? []) as { name: string; kind: string; label: string }[];

  const check = async () => {
    const doc = await toDocument();
    if (doc === undefined) return;
    const r = await validate.run({ body: { document: doc as never, ...(step !== '' ? { step } : {}), ...(object !== '' && step !== '' && ['records', 'fields', 'paging', 'pushdown'].includes(step) ? { object } : {}) } });
    if (r.ok) {
      setIssues(r.data.issues);
      if (r.data.issues.length === 0) say(r.data.complete ? (r.data.valid ? 'A complete, valid manifest' : 'Complete, with problems') : 'No problems in that step');
    }
  };
  const tryIt = async () => {
    const doc = await toDocument();
    if (doc === undefined || object === '') return;
    const scope = newScope || (scopes.data?.scopes.length === 1 ? scopes.data.scopes[0]!.id : '');
    const r = await attempt.run({
      body: { connectorId, document: doc as never, object, limit: 10, ...(sandboxId !== undefined ? { connectionId: sandboxId }
        : { connection: { name: `${connector.data?.name ?? 'Connector'} (sandbox)`, owningScopeId: scope } }) },
    }, { timeoutMs: 120_000 });
    if (r.ok && sandboxId === undefined) set({ connection: r.data.connection.id });
  };
  const publishIt = async () => {
    const doc = await toDocument();
    if (doc === undefined || sandboxId === undefined) return;
    const r = await publish.run({ body: { connectorId, connectionId: sandboxId, document: doc as never } });
    if (r.ok) {
      say(`Version ${r.data.manifest.version} published: its tests are running`);
      router.push(hrefWith('/connect/connections/', { connection: r.data.connection.id, tab: 'tests', run: r.data.conformanceRunId }) as never);
    }
  };
  const saveVersion = async () => {
    const doc = await toDocument();
    if (doc === undefined) return;
    const r = await save.run({ params: { connectorId }, body: { document: doc as never, ...(latest !== undefined ? { parentVersionId: latest.id } : {}) } });
    if (r.ok) say(`Saved as version ${r.data.version}`);
  };
  const tried = attempt.data;
  const own = connector.data?.organisationId === workspace.session.organisationId;
  const error = validate.error ?? publish.error ?? save.error;

  return (
    <Page title={connector.data?.name ?? 'Connector'} width="full" crumbs={[{ label: 'Connect' }, { label: 'Connector builder', href: '/connect/builder/' }]}
      meta={latest !== undefined ? <span className={styles.row}><span>Latest version {latest.version}</span><Time value={latest.createdAt} /></span> : <span>No version yet</span>}
      actions={<>
        <Button icon="upload" onClick={() => setImporting(true)}>Start from a description</Button>
        <Button pending={save.pending} blocked={save.blocked} disabled={yaml === undefined} onClick={() => void saveVersion()}>Save as a version</Button>
        <Button variant="primary" pending={publish.pending} blocked={publish.blocked ?? (sandboxId === undefined ? 'Try it once first: that makes its sandbox connection' : undefined)}
          disabled={yaml === undefined} onClick={() => void publishIt()}>Publish</Button>
      </>}>
      {connector.data !== undefined && !own ? <Banner tone="warn">Only your organisation's own connectors are edited here.</Banner> : null}
      {notes.length > 0 ? <Banner tone="info" title="Carried over with notes">{notes.join('; ')}</Banner> : null}
      <div className={styles.split}>
        <Section title="Manifest" description="The connector as YAML: transport, sign-in, objects, their records, fields, paging, filtering and errors.">
          {yaml === undefined ? <Loading label="Opening the manifest" /> : (
            <TextArea label="Manifest (YAML)" hideLabel rows={28} spellCheck={false} value={yaml} className={styles.code} onChange={(e) => setYaml(e.target.value)} />
          )}
          <Toolbar end={<Button pending={validate.pending} onClick={() => void check()}>Check</Button>}>
            <SelectField label="Step" value={step} onChange={(e) => setStep(e.target.value as Step | '')} placeholder="The whole manifest"
              options={(Object.keys(STEP) as Step[]).map((s) => ({ value: s, label: STEP[s] }))} />
          </Toolbar>
          {issues.length > 0 ? <Banner tone="warn" title={plural(issues.length, 'problem')}><Issues issues={issues} /></Banner> : null}
          {error !== undefined ? <ErrorMessage error={error} /> : null}
        </Section>
        <div className={styles.stack}>
          <Section title="Try it" description="Saves a draft version, moves the sandbox to it and reads one object. The rows are shown to you and kept nowhere.">
            <div className={styles.form}>
              <SelectField label="Sandbox connection" value={sandboxId ?? ''} onChange={(e) => set({ connection: e.target.value })}
                placeholder={sandboxes.length === 0 ? 'Made on the first try' : undefined} options={sandboxes.map((c) => ({ value: c.id, label: `${c.name} (${c.status})` }))} />
              {sandboxId === undefined ? (
                <SelectField label="Sandbox owned by" value={newScope || (scopes.data?.scopes.length === 1 ? scopes.data.scopes[0]!.id : '')} onChange={(e) => setNewScope(e.target.value)}
                  placeholder="Choose a scope" options={(scopes.data?.scopes ?? []).map((s) => ({ value: s.id, label: s.name }))} />
              ) : null}
              <SelectField label="Object" value={object} onChange={(e) => setObject(e.target.value)} placeholder={objects.length === 0 ? 'Check the manifest to list its objects' : 'Choose an object'}
                options={objects.map((o) => ({ value: o, label: o }))} />
              <FormActions><Button variant="primary" icon="play" pending={attempt.pending} blocked={attempt.blocked} disabled={object === '' || yaml === undefined} onClick={() => void tryIt()}>Try it</Button></FormActions>
            </div>
            {attempt.error !== undefined ? <ErrorMessage error={attempt.error} /> : null}
            {tried !== undefined ? (
              tried.outcome === 'refused' ? (
                <Banner tone="warn" title="The system refused the read">{tried.failure?.meaning ?? tried.failure?.code ?? 'It gave no reason.'}</Banner>
              ) : (
                <>
                  <p className={styles.muted}>Draft {tried.manifest.version}: {plural(tried.rows.length, 'row')}{tried.stats !== null ? ` from ${plural(tried.stats.pages, 'page')}, ${tried.stats.typeMismatches} type mismatches, ${tried.stats.retries} retries` : ''}.</p>
                  <Rows rows={tried.rows} label={`Rows of ${object}`} />
                </>
              )
            ) : null}
          </Section>
          {sandboxId !== undefined ? (
            <>
              <Section title="Sandbox credentials"><SandboxSecrets connectionId={sandboxId} fields={authFields} /></Section>
              <InferPanel connectionId={sandboxId} />
              <p className={styles.muted}><Link href={connectionHref(sandboxId)}>Open the sandbox connection</Link></p>
            </>
          ) : null}
          <Section title="Versions">
            <QueryView query={versions} what="Versions" isEmpty={(d) => d.versions.length === 0} empty={<p className={styles.muted}>None yet.</p>}>
              {(d) => (
                <DataTable label="Versions" rows={d.versions} rowKey={(v) => v.id} dense columns={[
                  { id: 'version', header: 'Version', primary: true, cell: (v) => v.version },
                  { id: 'route', header: 'Made', width: 'sm', cell: (v) => ROUTE[v.sourceRoute] },
                  { id: 'used', header: 'First used', width: 'sm', cell: (v) => (v.firstUsedAt === null ? 'Not yet' : <Time value={v.firstUsedAt} />) },
                  { id: 'at', header: 'Saved', width: 'sm', cell: (v) => <Time value={v.createdAt} /> },
                ]} />
              )}
            </QueryView>
          </Section>
        </div>
      </div>
      {importing ? <ImportDialog open onClose={() => setImporting(false)} onImported={(doc, n) => {
        setNotes(n);
        setParsed(doc);
        void api.call('convertDraft', { body: { to: 'yaml', document: doc as never } }).then((r) => setYaml(r.yaml ?? JSON.stringify(doc, null, 2)), () => setYaml(JSON.stringify(doc, null, 2)));
      }} /> : null}
    </Page>
  );
}

// ----------------------------------------------------------------------------- the list

function ConnectorList() {
  const [params, set] = useParams();
  const workspace = useWorkspace();
  const list = useQuery('listConnectors', { query: { limit: 200 } });
  const connections = useQuery('listConnections', { query: { limit: 500 } });
  const blocked = useBlocked('draftConnector');
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: 'Connector builder' });
  const own = (list.data?.connectors ?? []).filter((c) => c.kind === 'private' && c.organisationId === workspace.session.organisationId);
  const sandboxOf = (c: Connector) => (connections.data?.connections ?? []).find((x) => x.connectorId === c.id && (x.status === 'draft' || x.status === 'probing'));
  return (
    <Page title="Connector builder" description="Build a connector for a system the catalogue does not have: from its documentation, or by hand."
      crumbs={[{ label: 'Connect' }]}
      actions={<Button variant="primary" icon="plus" blocked={blocked} onClick={() => set({ new: '1' })}>New connector</Button>}>
      <QueryView query={list} what="Connectors" isEmpty={() => own.length === 0}
        empty={<EmptyState icon="edit" title="No connector of your own yet" action={<Button variant="primary" blocked={blocked} onClick={() => set({ new: '1' })}>Build one</Button>}>
          Start from an OpenAPI description, a documentation page, a WSDL, GraphQL or OData description, sample emails, or write it by hand.
        </EmptyState>}>
        {() => (
          <DataTable label="Your connectors" rows={own} rowKey={(c) => c.id} rowHref={(c) => (c.sourceRoute === 'ai' && sandboxOf(c) !== undefined
            ? hrefWith('/connect/builder/', { build: sandboxOf(c)!.id }) : hrefWith('/connect/builder/', { edit: c.id }))} columns={[
            { id: 'name', header: 'Connector', primary: true, sortValue: (c) => c.name, cell: (c) => c.name },
            { id: 'provider', header: 'System', width: 'md', cell: (c) => c.provider },
            { id: 'route', header: 'Made', width: 'md', cell: (c) => ROUTE[c.sourceRoute] },
            { id: 'state', header: 'State', width: 'md', cell: (c) => (c.currentManifestId === null ? <Badge>Draft</Badge> : c.status === 'active' ? <Badge tone="ok">Published</Badge> : <Badge>{c.status}</Badge>) },
            { id: 'building', header: 'Building', width: 'md', cell: (c) => (sandboxOf(c) === undefined ? '—' : <Link href={hrefWith('/connect/builder/', { edit: c.id, connection: sandboxOf(c)!.id })}>Sandbox {sandboxOf(c)!.status}</Link>) },
            { id: 'at', header: 'Created', width: 'sm', sortValue: (c) => c.createdAt, cell: (c) => <Time value={c.createdAt} /> },
          ]} />
        )}
      </QueryView>
      {params.get('new') !== null ? <NewConnectorDialog open onClose={() => set({ new: undefined })} /> : null}
    </Page>
  );
}

export function Builder() {
  const [params] = useParams();
  const build = params.get('build');
  const edit = params.get('edit');
  if (build !== null) return <BuildPage key={build} connectionId={build} />;
  if (edit !== null) return <Editor key={edit} connectorId={edit} />;
  return <ConnectorList />;
}
