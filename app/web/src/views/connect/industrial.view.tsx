'use client';

// Industrial (spec 20, 47): the OPC UA servers and MQTT brokers a connection reaches through its
// Silo Agent, and what Silo may change on them. Endpoints are verified before they serve: a
// signed OPC UA endpoint is one application whose certificate the customer trusts on the
// server, with the server's own certificate pinned. Writable points say which nodes may be
// written, each with its value check and read-back; the actuation allow-list says exactly what
// may be actuated, each entry requested by one person and approved by another, then signed so
// the agent refuses anything not on it. Interlocks and safety functions are never listed.

import { useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { CopyButton } from '../../components/copy.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, fieldError, FormActions, RadioGroup, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { ObjectPicker, type PickedObject } from '../../components/objectPicker.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { TabPanel, Tabs, useTab, type TabDef } from '../../components/tabs.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useBlocked, useMutation, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useWorkspace, usePageContext } from '../../shell/context.shell.tsx';
import styles from './connect.view.module.css';

type Connection = Output<'listConnections'>['connections'][number];
type Endpoint = Output<'listIndustrialEndpoints'>['endpoints'][number];
type Point = Output<'listWritablePoints'>['points'][number];
type Entry = Output<'listAllowlist'>['entries'][number];
type Pending = Output<'listAllowlist'>['pending'][number];
type EntryInput = Input<'requestAllowlistEntry'>['body'];
type ArgumentType = NonNullable<EntryInput['arguments']>[number]['dataType'];

const ENDPOINT_STATE: Record<Endpoint['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  active: { label: 'Verified', tone: 'ok' },
  untrusted: { label: 'Not yet trusted', tone: 'warn' },
  unreachable: { label: 'Unreachable', tone: 'danger' },
  revoked: { label: 'Revoked', tone: 'neutral' },
};

const VERIFY: Record<Output<'verifyIndustrialEndpoint'>['outcome'], string> = {
  trusted: 'The server accepted Silo\'s application: the endpoint is verified.',
  untrusted: 'The server has not trusted Silo\'s application yet. Trust its certificate on the server, then verify again.',
  server_certificate_mismatch: 'The server presented a certificate other than the one pinned. Check the thumbprint, or the server.',
  policy_not_offered: 'The server does not offer that security policy.',
  login_refused: 'The server refused the login.',
  unreachable: 'The agent could not reach the server.',
};

const OPCUA_POLICIES = ['Basic256Sha256 SignAndEncrypt', 'Basic256Sha256 Sign', 'Aes128_Sha256_RsaOaep SignAndEncrypt', 'Aes256_Sha256_RsaPss SignAndEncrypt', 'None'];
const ARGUMENT_TYPES: readonly ArgumentType[] = ['Boolean', 'SByte', 'Byte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'Float', 'Double', 'String'];

// ----------------------------------------------------------------------------- endpoints

function AddEndpointDialog({ connection, open, onClose }: { connection: Connection; open: boolean; onClose: () => void }) {
  const say = useToast();
  const create = useMutation('createIndustrialEndpoint', { invalidates: ['listIndustrialEndpoints'] });
  const [plugin, setPlugin] = useState<'opcua' | 'mqtt'>('opcua');
  const [url, setUrl] = useState('');
  const [policy, setPolicy] = useState(OPCUA_POLICIES[0]!);
  const [thumbprint, setThumbprint] = useState('');
  const [exception, setException] = useState(false);
  const mqttPolicy = url.startsWith('ssl://') || url.startsWith('mqtts://') ? 'tls' : 'plain';
  const securityPolicy = plugin === 'mqtt' ? mqttPolicy : policy;
  const signed = plugin === 'opcua' && policy !== 'None';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await create.run({
      params: { connectionId: connection.id },
      body: { plugin, endpointUrl: url.trim(), securityPolicy, ...(signed && thumbprint.trim() !== '' ? { serverCertificateThumbprint: thumbprint.trim() } : {}), ...(plugin === 'opcua' && policy === 'None' && exception ? { insecureException: true } : {}) },
    });
    if (r.ok) {
      say('Endpoint added: verify it next');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`An endpoint for ${connection.name}`} size="md" busy={create.pending}
      description="Reached through the connection's Silo Agent, inside your network: no inbound firewall rule is added.">
      <form onSubmit={submit} className={styles.form}>
        <RadioGroup name="plugin" label="System" value={plugin} onChange={setPlugin} options={[
          { value: 'opcua', label: 'OPC UA server' },
          { value: 'mqtt', label: 'MQTT broker' },
        ]} />
        <TextField label="Address" required value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false}
          placeholder={plugin === 'opcua' ? 'opc.tcp://plc-01.plant.local:4840' : 'ssl://broker.plant.local:8883'}
          hint={plugin === 'mqtt' ? `No credentials in the address. ${mqttPolicy === 'tls' ? 'Secured with TLS.' : 'Plain, inside your network only.'}` : 'No credentials in the address.'}
          error={fieldError(create.error, 'endpointUrl')} />
        {plugin === 'opcua' ? (
          <>
            <SelectField label="Security policy and mode" value={policy} onChange={(e) => setPolicy(e.target.value)} options={OPCUA_POLICIES.map((p) => ({ value: p, label: p }))}
              error={fieldError(create.error, 'securityPolicy')} />
            {signed ? (
              <TextField label="The server's certificate thumbprint" value={thumbprint} onChange={(e) => setThumbprint(e.target.value)} spellCheck={false}
                hint="As the server's configuration shows it, SHA-1 or SHA-256. The agent refuses any other server." error={fieldError(create.error, 'serverCertificateThumbprint')} />
            ) : (
              <Checkbox label="Record an exception: this server is on a segregated network" checked={exception} onChange={() => setException(!exception)}
                hint="Policy None is refused without it. The exception is recorded against you and shown on every clone from this connection." />
            )}
          </>
        ) : null}
        {create.error !== undefined && ['endpointUrl', 'securityPolicy', 'serverCertificateThumbprint'].every((f) => fieldError(create.error, f) === undefined) ? <ErrorMessage error={create.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={create.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={create.pending} blocked={create.blocked}
            disabled={url.trim() === '' || (plugin === 'opcua' && policy === 'None' && !exception)}>Add the endpoint</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function EndpointRow({ connection, endpoint }: { connection: Connection; endpoint: Endpoint }) {
  const verify = useMutation('verifyIndustrialEndpoint', { invalidates: ['listIndustrialEndpoints'] });
  const outcome = verify.data;
  return (
    <Panel>
      <div className={styles.stack}>
        <div className={styles.next}>
          <div>
            <h3 className={styles.subheading}><span className={styles.mono}>{endpoint.endpointUrl}</span></h3>
            <span className={styles.row}>
              <Badge tone={ENDPOINT_STATE[endpoint.status].tone}>{ENDPOINT_STATE[endpoint.status].label}</Badge>
              <span className={styles.muted}>{endpoint.plugin === 'opcua' ? 'OPC UA' : 'MQTT'}, {endpoint.securityPolicy}</span>
              {endpoint.insecureExceptionBy !== null ? <Badge tone="danger" icon="warning">Unsecured by exception</Badge> : null}
            </span>
          </div>
          {endpoint.status !== 'revoked' ? (
            <Button icon="refresh" pending={verify.pending} blocked={verify.blocked} onClick={() => void verify.run({ params: { connectionId: connection.id, endpointId: endpoint.id } }, { timeoutMs: 60_000 })}>
              Verify
            </Button>
          ) : null}
        </div>
        {outcome !== undefined ? (
          <Banner tone={outcome.outcome === 'trusted' ? 'ok' : 'warn'}>
            {VERIFY[outcome.outcome]}
            {outcome.presented !== undefined ? <> It presented SHA-1 <span className={styles.mono}>{outcome.presented.sha1}</span>, SHA-256 <span className={styles.mono}>{outcome.presented.sha256}</span>.</> : null}
          </Banner>
        ) : null}
        {verify.error !== undefined ? <ErrorMessage error={verify.error} /> : null}
        <Properties items={[
          ['Verified', endpoint.verifiedAt === null ? 'Not yet' : <Time key="v" value={endpoint.verifiedAt} />],
          endpoint.serverCertificateThumbprint !== null ? ['Server certificate pinned', <span key="t" className={styles.mono}>{endpoint.serverCertificateThumbprint}</span>] : null,
          endpoint.namespaceUris.length > 0 ? ['Namespaces', endpoint.namespaceUris.join(', ')] : null,
          ['Added', <Time key="c" value={endpoint.createdAt} />],
        ]} />
        {endpoint.applicationCertificate !== null ? (
          <div className={styles.secret}>
            <span className={styles.secretLabel}>Silo's application certificate: trust it on the server (thumbprint {endpoint.applicationCertificate.thumbprint})</span>
            <code className={styles.mono}>{endpoint.applicationCertificate.pem.slice(0, 120)}…</code>
            <CopyButton value={endpoint.applicationCertificate.pem} label="Copy the certificate" />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function Endpoints({ connection }: { connection: Connection }) {
  const list = useQuery('listIndustrialEndpoints', { params: { connectionId: connection.id } });
  const blocked = useBlocked('createIndustrialEndpoint');
  const [adding, setAdding] = useState(false);
  return (
    <Section title="Endpoints" actions={<Button icon="plus" blocked={blocked ?? (connection.agentPoolId === null ? 'An industrial endpoint is reached through a Silo Agent: this connection has none' : undefined)}
      onClick={() => setAdding(true)}>Add an endpoint</Button>}>
      <QueryView query={list} what="Endpoints" isEmpty={(d) => d.endpoints.length === 0}
        empty={<EmptyState icon="building" title="No endpoint yet">Add the OPC UA server or MQTT broker this connection reads.</EmptyState>}>
        {(d) => <div className={styles.stack}>{d.endpoints.map((e) => <EndpointRow key={e.id} connection={connection} endpoint={e} />)}</div>}
      </QueryView>
      {adding ? <AddEndpointDialog connection={connection} open onClose={() => setAdding(false)} /> : null}
    </Section>
  );
}

// ----------------------------------------------------------------------------- writable points

function DeclarePointDialog({ connection, open, onClose }: { connection: Connection; open: boolean; onClose: () => void }) {
  const say = useToast();
  const declare = useMutation('declareWritablePoint', { invalidates: ['listWritablePoints'] });
  const [address, setAddress] = useState('');
  const [check, setCheck] = useState('');
  const [feedback, setFeedback] = useState('');
  const [settle, setSettle] = useState('5');
  const [physical, setPhysical] = useState(true);
  const [testSafe, setTestSafe] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await declare.run({
      params: { connectionId: connection.id },
      body: { address: address.trim(), valueCheck: { cel: check.trim() }, riskClass: physical ? 'physical' : 'standard', settleSeconds: Number(settle), testSafe,
        ...(feedback.trim() !== '' ? { feedbackAddress: feedback.trim() } : {}) },
    });
    if (r.ok) {
      say('Writable point declared');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Declare a writable point" size="lg" busy={declare.pending}
      description="A node, topic or webhook action Silo may write, against the connector version the connection runs. Nothing is written until an allow-list entry for it is approved.">
      <form onSubmit={submit} className={styles.form}>
        <TextField label="Address" required value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} placeholder="ns=2;s=Line1.Pump1.Setpoint"
          hint="The node id, topic or webhook action name." error={fieldError(declare.error, 'address')} />
        <TextArea label="Value check" required rows={3} value={check} onChange={(e) => setCheck(e.target.value)} spellCheck={false} placeholder="value >= 0.0 && value <= 80.0 && abs(value - prior) <= 5.0"
          hint="A CEL expression over value and prior. A point without one cannot be written." error={fieldError(declare.error, 'valueCheck.cel')} />
        <div className={styles.split}>
          <TextField label="Read back from (optional)" value={feedback} onChange={(e) => setFeedback(e.target.value)} spellCheck={false}
            hint="The node that shows the write took effect." error={fieldError(declare.error, 'feedbackAddress')} />
          <TextField label="Wait for it to settle (seconds)" type="number" min={0} max={3600} value={settle} onChange={(e) => setSettle(e.target.value)} error={fieldError(declare.error, 'settleSeconds')} />
        </div>
        <Checkbox label="Physical: it drives equipment" checked={physical} onChange={() => setPhysical(!physical)}
          hint="MQTT and OPC UA points are physical whatever is chosen; a risk class can be raised later, never lowered." />
        <Checkbox label="Safe for conformance writes" checked={testSafe} onChange={() => setTestSafe(!testSafe)} hint="Silo's tests may write test values to it." />
        {declare.error !== undefined && ['address', 'valueCheck.cel', 'feedbackAddress', 'settleSeconds'].every((f) => fieldError(declare.error, f) === undefined) ? <ErrorMessage error={declare.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={declare.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={declare.pending} blocked={declare.blocked} disabled={address.trim() === '' || check.trim() === ''}>Declare</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function Points({ connection }: { connection: Connection }) {
  const say = useToast();
  const people = useDirectory();
  const [params, set] = useParams();
  const retiredToo = params.get('retired') === '1';
  const list = useQuery('listWritablePoints', { params: { connectionId: connection.id }, query: retiredToo ? { includeRetired: 'true' } : {} });
  const raise = useMutation('raiseWritablePointRisk', { invalidates: ['listWritablePoints'] });
  const safe = useMutation('setWritablePointTestSafe', { invalidates: ['listWritablePoints'] });
  const retire = useMutation('retireWritablePoint', { invalidates: ['listWritablePoints'] });
  const blocked = useBlocked('declareWritablePoint');
  const [declaring, setDeclaring] = useState(false);
  const [retiring, setRetiring] = useState<Point | undefined>(undefined);
  const error = raise.error ?? safe.error;
  return (
    <Section title="Writable points" description="What may be written on this connection, each with the check its values must pass and where the result is read back."
      actions={<Button icon="plus" blocked={blocked} onClick={() => setDeclaring(true)}>Declare a point</Button>}>
      <Toolbar><Checkbox label="Show retired points" checked={retiredToo} onChange={() => set({ retired: retiredToo ? undefined : '1' })} /></Toolbar>
      <QueryView query={list} what="Writable points" isEmpty={(d) => d.points.length === 0}
        empty={<EmptyState icon="edit" title="No writable point">Nothing on this connection may be written.</EmptyState>}>
        {(d) => (
          <DataTable label="Writable points" rows={d.points} rowKey={(p) => p.id} columns={[
            { id: 'address', header: 'Address', primary: true, sortValue: (p) => p.address, cell: (p) => <span className={styles.mono}>{p.address}</span> },
            { id: 'check', header: 'Value check', cell: (p) => <span className={styles.mono}>{p.valueCheck}</span> },
            { id: 'risk', header: 'Risk', width: 'sm', cell: (p) => (p.riskClass === 'physical' ? <Badge tone="danger">Physical</Badge> : <Badge>Standard</Badge>) },
            { id: 'back', header: 'Read back', width: 'md', cell: (p) => (p.feedbackAddress === null ? '—' : <span className={styles.stackTight}><span className={styles.mono}>{p.feedbackAddress}</span><span className={styles.muted}>after {p.settleSeconds}s</span></span>) },
            { id: 'safe', header: 'Test-safe', width: 'sm', cell: (p) => (p.testSafe ? 'Yes' : 'No') },
            { id: 'by', header: 'Declared', width: 'md', cell: (p) => <span>{people.nameOf(p.declaredBy)}, <Time value={p.declaredAt} /></span> },
            { id: 'act', header: <span className="visually-hidden">Change</span>, width: 'md', align: 'end', cell: (p) => (p.retiredAt !== null ? <Badge>Retired</Badge> : (
              <span className={styles.row}>
                {p.riskClass === 'standard' ? <Button size="sm" variant="ghost" blocked={raise.blocked} onClick={async () => {
                  const r = await raise.run({ params: { pointId: p.id }, body: { riskClass: 'physical' } });
                  if (r.ok) say('Raised to physical');
                }}>Make physical</Button> : null}
                <Button size="sm" variant="ghost" blocked={safe.blocked} onClick={() => void safe.run({ params: { pointId: p.id }, body: { testSafe: !p.testSafe } })}>
                  {p.testSafe ? 'Not test-safe' : 'Test-safe'}
                </Button>
                <Button size="sm" variant="ghost" blocked={retire.blocked} onClick={() => setRetiring(p)}>Retire</Button>
              </span>
            )) },
          ]} />
        )}
      </QueryView>
      {error !== undefined ? <ErrorMessage error={error} /> : null}
      {declaring ? <DeclarePointDialog connection={connection} open onClose={() => setDeclaring(false)} /> : null}
      <ConfirmDialog open={retiring !== undefined} onClose={() => setRetiring(undefined)} title="Retire this point?" confirmLabel="Retire" tone="danger"
        onConfirm={async () => {
          const r = await retire.run({ params: { pointId: retiring!.id } });
          if (r.ok) say('Point retired: it can no longer be written');
          return r;
        }}>
        <p>It can no longer be written, and allow-list entries for it stop working. It stays in the history; declare it again to use it.</p>
      </ConfirmDialog>
    </Section>
  );
}

// ----------------------------------------------------------------------------- allow-list

interface ArgumentDraft { name: string; dataType: ArgumentType; minValue: string; maxValue: string; values: string }

function RequestEntryDialog({ connection, points, open, onClose }: { connection: Connection; points: readonly Point[]; open: boolean; onClose: () => void }) {
  const say = useToast();
  const request = useMutation('requestAllowlistEntry', { invalidates: ['listAllowlist'] });
  const physical = points.filter((p) => p.retiredAt === null && p.riskClass === 'physical');
  const [node, setNode] = useState(physical[0]?.address ?? '');
  const [kind, setKind] = useState<EntryInput['kind']>('setpoint');
  const [dataType, setDataType] = useState('Double');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [step, setStep] = useState('');
  const [gap, setGap] = useState('60');
  const [inverse, setInverse] = useState('');
  const [simulator, setSimulator] = useState('');
  const [object, setObject] = useState<PickedObject | undefined>(undefined);
  const [args, setArgs] = useState<ArgumentDraft[]>([]);
  const opt = (v: string) => (v.trim() === '' ? undefined : v.trim());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (object === undefined) return;
    const body: EntryInput = {
      nodeAddress: node, kind, dataType, minIntervalSeconds: Number(gap), objectId: object.objectId,
      ...(kind === 'setpoint' && opt(min) !== undefined ? { minValue: opt(min)! } : {}),
      ...(kind === 'setpoint' && opt(max) !== undefined ? { maxValue: opt(max)! } : {}),
      ...(kind === 'setpoint' && opt(step) !== undefined ? { maxStep: opt(step)! } : {}),
      ...(kind === 'command' && opt(inverse) !== undefined ? { inverseCommand: opt(inverse)! } : {}),
      ...(opt(simulator) !== undefined ? { simulatorAddress: opt(simulator)! } : {}),
      ...(kind === 'method' && args.length > 0 ? {
        arguments: args.map((a) => ({
          name: a.name.trim(), dataType: a.dataType,
          ...(opt(a.minValue) !== undefined ? { minValue: opt(a.minValue)! } : {}),
          ...(opt(a.maxValue) !== undefined ? { maxValue: opt(a.maxValue)! } : {}),
          ...(a.dataType === 'String' && a.values.trim() !== '' ? { values: a.values.split(',').map((v) => v.trim()).filter(Boolean) } : {}),
        })),
      } : {}),
    };
    const r = await request.run({ params: { connectionId: connection.id }, body });
    if (r.ok) {
      say('Requested: someone else who may approve actuation decides it');
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Request an allow-list entry" size="lg" busy={request.pending}
      description="Exactly what Silo may actuate on this node, and within what bounds. Another person approves it; you cannot approve your own. Never an interlock, safety function, alarm limit or protection setting.">
      {physical.length === 0 ? <Banner tone="warn">Declare a physical writable point first: an entry is for one of them.</Banner> : (
        <form onSubmit={submit} className={styles.form}>
          <SelectField label="Node" required value={node} onChange={(e) => setNode(e.target.value)} options={physical.map((p) => ({ value: p.address, label: p.address }))} />
          <RadioGroup name="entry-kind" label="Kind" value={kind} onChange={setKind} options={[
            { value: 'setpoint', label: 'A setpoint', hint: 'A value written within a range, by no more than a step at a time.' },
            { value: 'command', label: 'A command', hint: 'Sent as is; name its inverse so it can be undone.' },
            { value: 'method', label: 'An OPC UA method', hint: 'Called with arguments, each within its bounds.' },
          ]} />
          <TextField label="Data type" required value={dataType} onChange={(e) => setDataType(e.target.value)} hint="As the server declares it: Double, Int32, Boolean…" />
          {kind === 'setpoint' ? (
            <div className={styles.split}>
              <TextField label="Lowest value" value={min} onChange={(e) => setMin(e.target.value)} />
              <TextField label="Highest value" value={max} onChange={(e) => setMax(e.target.value)} />
              <TextField label="Largest step" value={step} onChange={(e) => setStep(e.target.value)} />
            </div>
          ) : null}
          {kind === 'command' ? <TextField label="Inverse command" value={inverse} onChange={(e) => setInverse(e.target.value)} hint="What undoes it." /> : null}
          {kind === 'method' ? (
            <fieldset className={styles.choices}>
              <legend>Arguments, in the method's order</legend>
              {args.map((a, i) => (
                <div key={i} className={styles.split}>
                  <TextField label={`Argument ${i + 1} name`} value={a.name} onChange={(e) => setArgs(args.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <SelectField label="Type" value={a.dataType} onChange={(e) => setArgs(args.map((x, j) => (j === i ? { ...x, dataType: e.target.value as ArgumentType } : x)))}
                    options={ARGUMENT_TYPES.map((t) => ({ value: t, label: t }))} />
                  {a.dataType === 'String'
                    ? <TextField label="Values allowed" value={a.values} hint="Separated by commas." onChange={(e) => setArgs(args.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))} />
                    : a.dataType === 'Boolean' ? null : (
                      <>
                        <TextField label="Lowest" value={a.minValue} onChange={(e) => setArgs(args.map((x, j) => (j === i ? { ...x, minValue: e.target.value } : x)))} />
                        <TextField label="Highest" value={a.maxValue} onChange={(e) => setArgs(args.map((x, j) => (j === i ? { ...x, maxValue: e.target.value } : x)))} />
                      </>
                    )}
                </div>
              ))}
              <div className={styles.row}>
                <Button size="sm" icon="plus" disabled={args.length >= 10} onClick={() => setArgs([...args, { name: '', dataType: 'Double', minValue: '', maxValue: '', values: '' }])}>Add an argument</Button>
                {args.length > 0 ? <Button size="sm" variant="ghost" onClick={() => setArgs(args.slice(0, -1))}>Remove the last</Button> : null}
              </div>
            </fieldset>
          ) : null}
          <div className={styles.split}>
            <TextField label="Least time between writes (seconds)" type="number" min={0} max={86400} required value={gap} onChange={(e) => setGap(e.target.value)} />
            <TextField label="Simulator node (optional)" value={simulator} onChange={(e) => setSimulator(e.target.value)} hint="For dry runs." />
          </div>
          <ObjectPicker label="The clone it belongs to" value={object} onChange={setObject} hint="The digital clone object this node is part of." />
          {request.error !== undefined ? <ErrorMessage error={request.error} /> : null}
          <FormActions>
            <Button onClick={onClose} disabled={request.pending}>Cancel</Button>
            <Button type="submit" variant="primary" pending={request.pending} blocked={request.blocked}
              disabled={node === '' || dataType.trim() === '' || object === undefined || (kind === 'method' && args.some((a) => a.name.trim() === ''))}>Request</Button>
          </FormActions>
        </form>
      )}
    </Dialog>
  );
}

function bounds(e: { kind: string; minValue?: string | null | undefined; maxValue?: string | null | undefined; maxStep?: string | null | undefined; inverseCommand?: string | null | undefined }): string {
  if (e.kind === 'setpoint') return `${e.minValue ?? '…'} to ${e.maxValue ?? '…'}${e.maxStep != null ? `, steps of at most ${e.maxStep}` : ''}`;
  if (e.kind === 'command') return e.inverseCommand != null ? `Undone by ${e.inverseCommand}` : 'No inverse';
  return 'Method';
}

function Allowlist({ connection }: { connection: Connection }) {
  const say = useToast();
  const people = useDirectory();
  const workspace = useWorkspace();
  const list = useQuery('listAllowlist', { params: { connectionId: connection.id } });
  const points = useQuery('listWritablePoints', { params: { connectionId: connection.id }, query: {} });
  const decide = useMutation('decideAllowlistRequest', { invalidates: ['listAllowlist'] });
  const remove = useMutation('removeAllowlistEntry', { invalidates: ['listAllowlist'] });
  const blocked = useBlocked('requestAllowlistEntry');
  const [requesting, setRequesting] = useState(false);
  const [removing, setRemoving] = useState<Entry | undefined>(undefined);
  const pending = (list.data?.pending ?? []).filter((p) => p.status === 'pending');
  return (
    <Section title="Actuation allow-list" description="Signed by Silo once approved: the agent refuses any write to a node not on the current signed list, whatever the cell asks."
      actions={<Button icon="plus" blocked={blocked} onClick={() => setRequesting(true)}>Request an entry</Button>}>
      {pending.length > 0 ? (
        <Section title="Waiting for a decision">
          <DataTable label="Requested entries" rows={pending} rowKey={(p: Pending) => p.id} columns={[
            { id: 'node', header: 'Node', primary: true, cell: (p) => <span className={styles.mono}>{p.entry.nodeAddress}</span> },
            { id: 'kind', header: 'Kind', width: 'sm', cell: (p) => p.entry.kind },
            { id: 'bounds', header: 'Bounds', cell: (p) => bounds(p.entry) },
            { id: 'by', header: 'Requested', width: 'md', cell: (p) => <span>{people.nameOf(p.requestedBy)}, <Time value={p.createdAt} /></span> },
            { id: 'decide', header: <span className="visually-hidden">Decide</span>, width: 'md', align: 'end', cell: (p) => (p.requestedBy === workspace.session.membershipId
              ? <span className={styles.muted}>Another person decides</span> : (
                <span className={styles.row}>
                  <Button size="sm" variant="primary" blocked={decide.blocked} onClick={async () => {
                    const r = await decide.run({ params: { requestId: p.id }, body: { decision: 'approve' } });
                    if (r.ok) say('Approved and signed');
                  }}>Approve</Button>
                  <Button size="sm" variant="ghost" blocked={decide.blocked} onClick={async () => {
                    const r = await decide.run({ params: { requestId: p.id }, body: { decision: 'reject' } });
                    if (r.ok) say('Rejected');
                  }}>Reject</Button>
                </span>
              )) },
          ]} />
          {decide.error !== undefined ? <ErrorMessage error={decide.error} /> : null}
        </Section>
      ) : null}
      <QueryView query={list} what="The allow-list" isEmpty={(d) => d.entries.filter((e) => e.removedAt === null).length === 0}
        empty={<EmptyState icon="shield" title="Nothing may be actuated">Request an entry for a physical writable point.</EmptyState>}>
        {(d) => (
          <DataTable label="Allow-list entries" rows={d.entries.filter((e) => e.removedAt === null)} rowKey={(e) => e.id} columns={[
            { id: 'node', header: 'Node', primary: true, sortValue: (e) => e.nodeAddress, cell: (e) => <span className={styles.mono}>{e.nodeAddress}</span> },
            { id: 'via', header: 'Via', width: 'sm', cell: (e) => (e.transport === 'opcua' ? 'OPC UA' : e.transport === 'mqtt' ? 'MQTT' : 'Webhook') },
            { id: 'kind', header: 'Kind', width: 'sm', cell: (e) => e.kind },
            { id: 'bounds', header: 'Bounds', cell: (e) => <span className={styles.stackTight}>{bounds(e)}<span className={styles.muted}>At most every {e.minIntervalSeconds}s</span></span> },
            { id: 'who', header: 'Requested and approved', width: 'lg', cell: (e) => <span>{people.nameOf(e.addedBy)}; {people.nameOf(e.approvedBy)}, <Time value={e.approvedAt} /></span> },
            { id: 'remove', header: <span className="visually-hidden">Remove</span>, width: 'sm', align: 'end', cell: (e) => <Button size="sm" variant="ghost" blocked={remove.blocked} onClick={() => setRemoving(e)}>Remove</Button> },
          ]} />
        )}
      </QueryView>
      {requesting ? <RequestEntryDialog connection={connection} points={points.data?.points ?? []} open onClose={() => setRequesting(false)} /> : null}
      <ConfirmDialog open={removing !== undefined} onClose={() => setRemoving(undefined)} title="Remove this entry?" confirmLabel="Remove" tone="danger"
        onConfirm={async () => {
          const r = await remove.run({ params: { entryId: removing!.id } });
          if (r.ok) say('Removed: the agent refuses writes to it from the next signed list');
          return r;
        }}>
        <p>Silo signs a new list without it, and the agent refuses writes to it. An entry is never edited: to change its bounds, remove it and request a new one.</p>
      </ConfirmDialog>
    </Section>
  );
}

export function Industrial() {
  const [params, set] = useParams();
  const list = useQuery('listConnections', { query: { limit: 500 } });
  usePageContext({ scope: { kind: 'page', page: 'connect' }, scopeLabel: 'Industrial' });
  const candidates = (list.data?.connections ?? []).filter((c) => c.status !== 'revoked' && c.agentPoolId !== null);
  const connection = candidates.find((c) => c.id === params.get('connection')) ?? candidates[0];
  const tabs: readonly TabDef<'endpoints' | 'points' | 'allowlist'>[] = [
    { id: 'endpoints', label: 'Endpoints' }, { id: 'points', label: 'Writable points' }, { id: 'allowlist', label: 'Allow-list' },
  ];
  const [tab, setTab] = useTab(tabs);
  return (
    <Page title="Industrial" description="OPC UA servers and MQTT brokers reached through your Silo Agents, and exactly what Silo may change on them."
      crumbs={[{ label: 'Connect' }]}>
      <QueryView query={list} what="Connections" isEmpty={() => candidates.length === 0}
        empty={<EmptyState icon="building" title="No connection runs through a Silo Agent">Plant systems are reached through an agent inside your network. Create a connection on an agent pool first.</EmptyState>}>
        {() => (connection === undefined ? null : (
          <>
            <Toolbar>
              <SelectField label="Connection" value={connection.id} onChange={(e) => set({ connection: e.target.value })} options={candidates.map((c) => ({ value: c.id, label: c.name }))} />
            </Toolbar>
            <Tabs label="Industrial" tabs={tabs} current={tab} onChange={setTab} />
            <TabPanel id={tab}>
              {tab === 'endpoints' ? <Endpoints key={connection.id} connection={connection} /> : null}
              {tab === 'points' ? <Points key={connection.id} connection={connection} /> : null}
              {tab === 'allowlist' ? <Allowlist key={connection.id} connection={connection} /> : null}
            </TabPanel>
          </>
        ))}
      </QueryView>
    </Page>
  );
}
