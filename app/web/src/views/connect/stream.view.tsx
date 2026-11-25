'use client';

// A connection's change stream (spec 14.4, 17.2, 18): how each object's changes reach Silo, and
// whether it is live, polled (never called live) or read when asked; the webhook the system
// calls, with its secret shown once and rotated on request; change data capture, whose slot on
// the customer's database is created only on the owner's confirmation with its name shown; a
// polling fallback for an object that cannot stream; and the change-stream test that makes an
// object subscribable (decision 2026-11-15): live views, the Clone Canvas's live state and
// Crons with change conditions need it.

import { useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Badge, Status } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, IconButton } from '../../components/button.component.tsx';
import { CopyButton } from '../../components/copy.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, fieldError, FormActions, TextField } from '../../components/field.component.tsx';
import { JsonObjectField, useJsonObject } from '../../components/json.component.tsx';
import { Menu, type MenuEntry } from '../../components/menu.component.tsx';
import { Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { usePermits, useMutation, useQuery } from '../../data/query.data.ts';
import { useParam } from '../../hooks/params.hook.ts';
import { TestTable } from './tests.view.tsx';
import { CAPTURE_METHOD, currency, GAP, proposedSlot, STREAM_STATE, STREAM_TEST, type Connection } from './words.view.ts';
import styles from './connect.view.module.css';

type StreamView = Output<'readStream'>;
type StreamObject = StreamView['objects'][number];

/** A secret or address shown once: copy it now, it is not shown again. */
function ShownOnce({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.secret}>
      <span className={styles.secretLabel}>{label}</span>
      <code className={styles.mono}>{value}</code>
      <CopyButton value={value} label={`Copy the ${label.toLowerCase()}`} />
    </div>
  );
}

function EnableDialog({ connection, open, onClose }: { connection: Connection; open: boolean; onClose: () => void }) {
  const enable = useMutation('enableStream', { invalidates: ['readStream'] });
  const [secret, setSecret] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await enable.run({ params: { connectionId: connection.id }, body: secret.trim() === '' ? {} : { secret: secret.trim() } });
  };
  const done = enable.data;
  const close = () => {
    enable.reset();
    setSecret('');
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title="Stream its changes" size="md" busy={enable.pending}
      description="Silo starts taking the changes the system sends, and reading the ones it can ask for, for each object its connector streams.">
      {done !== undefined ? (
        <div className={styles.stack}>
          <Banner tone="ok" title="Streaming">Give the system what follows. The secret is shown only now: if it is lost, rotate it.</Banner>
          {done.webhook !== undefined ? (
            <>
              <ShownOnce label="Webhook address" value={`${window.location.origin}${done.webhook.path}`} />
              {done.webhook.secret !== undefined ? <ShownOnce label="Signing secret" value={done.webhook.secret} /> : <p className={styles.muted}>It signs with the secret you gave.</p>}
            </>
          ) : null}
          {done.email !== undefined ? <ShownOnce label="Forwarding address" value={done.email.address} /> : null}
          <FormActions><Button variant="primary" onClick={close}>Done</Button></FormActions>
        </div>
      ) : (
        <form onSubmit={submit} className={styles.form} autoComplete="off">
          <TextField label="The system's own signing secret (optional)" type="password" autoComplete="new-password" value={secret} minLength={16}
            onChange={(e) => setSecret(e.target.value)} error={fieldError(enable.error, 'secret')}
            hint="Where the system issues its own secret for signing webhooks, give it here. Otherwise Silo makes one and shows it once." />
          {enable.error !== undefined && fieldError(enable.error, 'secret') === undefined ? <ErrorMessage error={enable.error} /> : null}
          <FormActions>
            <Button onClick={close} disabled={enable.pending}>Cancel</Button>
            <Button type="submit" variant="primary" pending={enable.pending} blocked={enable.blocked}>Start streaming</Button>
          </FormActions>
        </form>
      )}
    </Dialog>
  );
}

function RotateDialog({ connection, open, onClose }: { connection: Connection; open: boolean; onClose: () => void }) {
  const rotate = useMutation('rotateWebhookSecret', { invalidates: ['readStream'] });
  const [secret, setSecret] = useState('');
  const close = () => {
    rotate.reset();
    setSecret('');
    onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await rotate.run({ params: { connectionId: connection.id }, body: secret.trim() === '' ? {} : { secret: secret.trim() } });
  };
  const done = rotate.data;
  return (
    <Dialog open={open} onClose={close} title="Rotate the webhook secret" size="md" busy={rotate.pending}
      description="Deliveries signed with the old secret are refused from now on: give the system the new one straight away.">
      {done !== undefined ? (
        <div className={styles.stack}>
          {done.secret !== undefined ? <ShownOnce label="New signing secret" value={done.secret} /> : <Banner tone="ok">Rotated to the secret you gave, ending {done.lastFour}.</Banner>}
          <FormActions><Button variant="primary" onClick={close}>Done</Button></FormActions>
        </div>
      ) : (
        <form onSubmit={submit} className={styles.form} autoComplete="off">
          <TextField label="The system's new secret (optional)" type="password" autoComplete="new-password" value={secret} minLength={16}
            onChange={(e) => setSecret(e.target.value)} hint="Leave empty and Silo makes one, shown once." error={fieldError(rotate.error, 'secret')} />
          {rotate.error !== undefined && fieldError(rotate.error, 'secret') === undefined ? <ErrorMessage error={rotate.error} /> : null}
          <FormActions>
            <Button onClick={close} disabled={rotate.pending}>Cancel</Button>
            <Button type="submit" variant="danger" pending={rotate.pending} blocked={rotate.blocked}>Rotate</Button>
          </FormActions>
        </form>
      )}
    </Dialog>
  );
}

function Webhook({ connection, stream }: { connection: Connection; stream: StreamView }) {
  const say = useToast();
  const permits = usePermits();
  const pause = useMutation('pauseStream', { invalidates: ['readStream'] });
  const resume = useMutation('resumeStream', { invalidates: ['readStream'] });
  const disable = useMutation('disableStream', { invalidates: ['readStream'] });
  const [rotating, setRotating] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const w = stream.webhook;
  if (w === null) return null;
  const error = pause.error ?? resume.error;
  return (
    <Section title="Webhook" description="The system calls Silo when its records change. Each delivery is checked against the signing secret.">
      <Panel>
        <div className={styles.next}>
          <Properties items={[
            ['State', <Badge key="s" tone={w.status === 'active' ? 'ok' : w.status === 'paused' ? 'warn' : 'neutral'}>{w.status === 'active' ? 'Taking deliveries' : w.status === 'paused' ? 'Paused' : 'Revoked'}</Badge>],
            ['Last delivery', w.lastDeliveryAt === null ? 'None yet' : <Time key="l" value={w.lastDeliveryAt} />],
            ['Refused', w.rejectedCount === 0 ? 'None' : `${w.rejectedCount}, unsigned or wrongly signed`],
            ['Secret', w.lastFour === null ? '—' : `Ends ${w.lastFour}`],
          ]} />
          {w.status !== 'revoked' ? (
            <div className={styles.row}>
              {w.status === 'active'
                ? <Button icon="pause" pending={pause.pending} blocked={pause.blocked} onClick={async () => {
                  const r = await pause.run({ params: { connectionId: connection.id } });
                  if (r.ok) say('Stream paused: deliveries are held, then taken in order on resume');
                }}>Pause</Button>
                : <Button icon="play" pending={resume.pending} blocked={resume.blocked} onClick={async () => {
                  const r = await resume.run({ params: { connectionId: connection.id } });
                  if (r.ok) say('Stream resumed');
                }}>Resume</Button>}
              <Menu label="More for the webhook" items={[
                { label: 'Rotate the secret', icon: 'key', onSelect: () => setRotating(true), blocked: permits('rotateWebhookSecret') },
                { separator: true },
                { label: 'Stop streaming…', icon: 'stop', tone: 'danger', onSelect: () => setDisabling(true), blocked: permits('disableStream') },
              ]} renderTrigger={(p) => <IconButton {...p} label="More for the webhook" icon="more" />} />
            </div>
          ) : null}
        </div>
        {error !== undefined ? <ErrorMessage error={error} /> : null}
      </Panel>
      {rotating ? <RotateDialog connection={connection} open onClose={() => setRotating(false)} /> : null}
      <ConfirmDialog open={disabling} onClose={() => setDisabling(false)} title="Stop streaming its changes?" confirmLabel="Stop streaming" tone="danger"
        onConfirm={async () => {
          const r = await disable.run({ params: { connectionId: connection.id } });
          if (r.ok) say('Streaming stopped: its objects are read when asked');
          return r;
        }}>
        <p>Its secret is revoked and deliveries are refused. Live views and Crons that wait for its changes stop seeing them; queries still read it when asked.</p>
      </ConfirmDialog>
    </Section>
  );
}

function CaptureDialog({ connection, open, onClose }: { connection: Connection; open: boolean; onClose: () => void }) {
  const say = useToast();
  const set = useMutation('setChangeCapture', { invalidates: ['readStream'] });
  const [slot, setSlot] = useState(() => proposedSlot(connection.name));
  const [publication, setPublication] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const valid = /^[a-z0-9_]{1,63}$/.test(slot) && (publication === '' || /^[a-z0-9_]{1,63}$/.test(publication));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await set.run({ params: { connectionId: connection.id }, body: { slotName: slot, ...(publication !== '' ? { publication } : {}), confirmed: true } });
    if (r.ok) {
      say(`Change capture set up: an agent creates the slot ${slot} on first read`);
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Set up change capture" size="md" busy={set.pending}
      description="A Silo Agent reads the database's own log of changes. For that it creates a replication slot on your database, with the read-only replication login the agent holds.">
      <form onSubmit={submit} className={styles.form}>
        <TextField label="Slot name" required value={slot} onChange={(e) => setSlot(e.target.value.trim())} maxLength={63} spellCheck={false}
          hint="Lower-case letters, digits and underscores. This is the name your database administrators will see." error={fieldError(set.error, 'slotName')} />
        <TextField label="Publication (Postgres only)" value={publication} onChange={(e) => setPublication(e.target.value.trim())} maxLength={63} spellCheck={false}
          hint="For logical replication: the publication made for the captured tables. Leave empty for MySQL, SQL Server, MQTT or OPC UA." error={fieldError(set.error, 'publication')} />
        <Checkbox label={`I confirm Silo may create the slot ${slot === '' ? '' : `“${slot}”`} on this database`} checked={confirmed} onChange={() => setConfirmed(!confirmed)}
          hint="A slot keeps the database's log until it is read. If capture is dropped, an agent drops the slot." />
        {set.error !== undefined && fieldError(set.error, 'slotName') === undefined && fieldError(set.error, 'publication') === undefined ? <ErrorMessage error={set.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={set.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={set.pending} blocked={set.blocked} disabled={!confirmed || !valid}>Set it up</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function Capture({ connection, stream }: { connection: Connection; stream: StreamView }) {
  const say = useToast();
  const drop = useMutation('dropChangeCapture', { invalidates: ['readStream'] });
  const setupBlocked = usePermits()('setChangeCapture');
  const [setting, setSetting] = useState(false);
  const [dropping, setDropping] = useState(false);
  const c = stream.capture;
  const declared = stream.objects.some((o) => o.declared.some((d) => d === 'cdc' || d === 'mqtt' || d === 'opcua'));
  if (c === null && !declared) return null;
  return (
    <Section title="Change capture" description="Changes read from the database's own log, or a plant system's subscription, by a Silo Agent inside your network.">
      {c === null ? (
        <Panel>
          <div className={styles.next}>
            <p className={styles.muted}>Its connector can capture changes, but capture is not set up.{connection.agentPoolId === null ? ' It needs the connection to run through a Silo Agent.' : ''}</p>
            {connection.status !== 'revoked' ? <Button variant="primary" blocked={setupBlocked ?? (connection.agentPoolId === null ? 'Change capture is read by a Silo Agent: this connection has none' : undefined)}
              onClick={() => setSetting(true)}>Set up change capture</Button> : null}
          </div>
        </Panel>
      ) : (
        <Panel>
          {c.lastGap !== null ? (
            <Banner tone="warn" title="Some changes were lost on the way">
              {GAP[c.lastGap.reason]}{c.lastGap.changes !== null ? ` (${c.lastGap.changes} changes)` : ''}, <Time value={c.lastGap.reportedAt} />. The records affected show correctly again when they next change.
            </Banner>
          ) : null}
          <div className={styles.next}>
            <Properties items={[
              ['Method', CAPTURE_METHOD[c.method]],
              ['Slot', <span key="s" className={styles.mono}>{c.slotName}</span>],
              c.publication !== null ? ['Publication', <span key="p" className={styles.mono}>{c.publication}</span>] : null,
              ['State', <Status key="st" tone={c.status === 'active' ? (c.reading ? 'ok' : 'warn') : c.status === 'lost' ? 'danger' : 'neutral'}>
                {c.status === 'active' ? (c.reading ? 'Being read' : 'Not being read') : c.status === 'lost' ? 'Slot lost' : 'Being dropped'}
              </Status>],
              ['Read up to', c.acknowledgedAt === null ? 'Nothing read yet' : <Time key="a" value={c.acknowledgedAt} />],
              ['Set up', <Time key="c" value={c.createdAt} />],
            ]} />
            {c.status !== 'dropping' ? <Button variant="ghost" icon="trash" blocked={drop.blocked} onClick={() => setDropping(true)}>Drop it</Button> : null}
          </div>
          {c.status === 'dropping' ? <p className={styles.muted}>An agent is dropping the slot. Until it reports back, the slot still holds your database's log.</p> : null}
        </Panel>
      )}
      {setting ? <CaptureDialog connection={connection} open onClose={() => setSetting(false)} /> : null}
      <ConfirmDialog open={dropping} onClose={() => setDropping(false)} title="Drop change capture?" confirmLabel="Drop it" tone="danger"
        onConfirm={async () => {
          const r = await drop.run({ params: { connectionId: connection.id } });
          if (r.ok) say('Dropping change capture: an agent drops the slot');
          return r;
        }}>
        <p>The reader stops, and an agent of the pool drops the slot {c === null ? '' : `“${c.slotName}”`} on your database. Objects captured this way are read when asked until it is set up again.</p>
      </ConfirmDialog>
    </Section>
  );
}

function PollingDialog({ connection, object, open, onClose }: { connection: Connection; object: StreamObject; open: boolean; onClose: () => void }) {
  const say = useToast();
  const set = useMutation('setPollingFallback', { invalidates: ['readStream'] });
  const [minutes, setMinutes] = useState(String(Math.max(5, Math.round((object.refreshEverySeconds ?? 900) / 60))));
  const n = Number(minutes);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await set.run({ params: { connectionId: connection.id, object: object.object }, body: { enabled: true, intervalMinutes: n } });
    if (r.ok) {
      say(`${object.object} is polled every ${n} min`);
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Poll ${object.object}`} size="sm" busy={set.pending}
      description="It cannot stream live, so Silo asks the system for what changed every few minutes. It is shown as polled, never as live.">
      <form onSubmit={submit} className={styles.form}>
        <TextField label="Every (minutes)" type="number" min={1} max={1440} required value={minutes} onChange={(e) => setMinutes(e.target.value)}
          hint="Never more often than its connector allows; polls share the connection's request budget with queries." error={fieldError(set.error, 'intervalMinutes')} />
        {set.error !== undefined && fieldError(set.error, 'intervalMinutes') === undefined ? <ErrorMessage error={set.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={set.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={set.pending} blocked={set.blocked} disabled={!Number.isInteger(n) || n < 1}>Poll it</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function StreamTestDialog({ connection, object, open, onClose }: { connection: Connection; object: StreamObject; open: boolean; onClose: () => void }) {
  const start = useMutation('startChangeStreamClass', { invalidates: ['readStream', 'listConformanceRuns'] });
  const create = useJsonObject();
  const first = useJsonObject();
  const second = useJsonObject();
  const ready = create.value !== undefined && first.value !== undefined && second.value !== undefined;
  const close = () => {
    start.reset();
    onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    await start.run({ params: { connectionId: connection.id }, body: { object: object.object, create: create.value as never, updates: [first.value as never, second.value as never] } }, { timeoutMs: 180_000 });
  };
  const run = start.data;
  return (
    <Dialog open={open} onClose={close} title={`Test ${object.object}'s change stream`} size="lg" busy={start.pending}
      description="Silo creates a test record in a sandbox, changes it twice and deletes it, and watches the stream: changes must arrive, in order, once each, resumably, with the delete. Passing makes the object subscribable.">
      {run !== undefined ? (
        <div className={styles.stack}>
          <Banner tone={run.gate.verified ? 'ok' : 'warn'} title={run.gate.verified ? 'Passed' : 'Did not pass'}>
            {run.gate.verified ? `${object.object} can now feed live views and Crons that wait for changes.` : 'Look at the tests that failed. Values the system refused can be corrected and tried again.'}
          </Banner>
          <TestTable tests={run.tests} label="Change-stream tests" />
          <FormActions><Button variant="primary" onClick={close}>Done</Button></FormActions>
        </div>
      ) : (
        <form onSubmit={submit} className={styles.form}>
          <JsonObjectField label="The test record" required state={create} hint="Values the system will accept for a new record; field names as the connector declares them." />
          <div className={styles.split}>
            <JsonObjectField label="First change" required state={first} rows={3} />
            <JsonObjectField label="Second change" required state={second} rows={3} />
          </div>
          {start.error !== undefined ? <ErrorMessage error={start.error} /> : null}
          <FormActions>
            <Button onClick={close} disabled={start.pending}>Cancel</Button>
            <Button type="submit" variant="primary" pending={start.pending} blocked={start.blocked} disabled={!ready}>Run the test</Button>
          </FormActions>
        </form>
      )}
    </Dialog>
  );
}

function Objects({ connection, stream }: { connection: Connection; stream: StreamView }) {
  const say = useToast();
  const permits = usePermits();
  const stopPolling = useMutation('setPollingFallback', { invalidates: ['readStream'] });
  const [polling, setPolling] = useState<StreamObject | undefined>(undefined);
  const [testing, setTesting] = useState<StreamObject | undefined>(undefined);
  const [focus] = useParam('object');
  const actions = (o: StreamObject): MenuEntry[] => {
    const items: MenuEntry[] = [];
    if (o.declared.some((d) => d !== 'poll')) {
      items.push({ label: 'Test its change stream', icon: 'play', onSelect: () => setTesting(o), blocked: permits('startChangeStreamClass') });
    }
    if (o.declared.includes('poll') && !o.subscribable) {
      if (o.mode === 'polled') {
        items.push({ label: 'Change how often it is polled', icon: 'clock', onSelect: () => setPolling(o), blocked: permits('setPollingFallback') });
        items.push({ label: 'Stop polling it', icon: 'stop', blocked: permits('setPollingFallback'), onSelect: async () => {
          const r = await stopPolling.run({ params: { connectionId: connection.id, object: o.object }, body: { enabled: false } });
          if (r.ok) say(`${o.object} is read when asked`);
        } });
      } else {
        items.push({ label: 'Poll it when it cannot stream', icon: 'clock', onSelect: () => setPolling(o), blocked: permits('setPollingFallback') });
      }
    }
    return items;
  };
  return (
    <Section title="Objects" description="Live means changes arrive as they happen and the object passed its change-stream test. Polled objects are never called live.">
      {stream.objects.length === 0 ? <EmptyState icon="table" title="No object is streamed">Each is read when asked.</EmptyState> : (
        <DataTable label="Streamed objects" rows={stream.objects} rowKey={(o) => o.object} columns={[
          { id: 'object', header: 'Object', primary: true, sortValue: (o) => o.object, cell: (o) => <span className={o.object === focus ? styles.focus : undefined}>{o.object}</span> },
          { id: 'how', header: 'How it stays current', cell: (o) => currency(o) },
          { id: 'state', header: 'State', width: 'md', sortValue: (o) => o.status, cell: (o) => (
            <span className={styles.stackTight}>
              <Status tone={STREAM_STATE[o.status].tone}>{STREAM_STATE[o.status].label}</Status>
              {o.reason !== null ? <span className={styles.muted}>{o.reason.replaceAll('_', ' ')}</span> : null}
            </span>
          ) },
          { id: 'subscribable', header: 'Subscribable', width: 'md', cell: (o) => (o.subscribable ? <Badge tone="ok" icon="check">Yes</Badge>
            : o.failedTests.length > 0 ? <span className={styles.muted} title={o.failedTests.map((t) => STREAM_TEST[t]).join('; ')}>No: {o.failedTests.map((t) => STREAM_TEST[t]).join('; ')}</span>
            : <span className={styles.muted}>Not tested</span>) },
          { id: 'last', header: 'Last change', width: 'sm', sortValue: (o) => o.lastDeltaAt, cell: (o) => (o.lastDeltaAt === null ? '—' : <Time value={o.lastDeltaAt} />) },
          { id: 'more', header: <span className="visually-hidden">Actions</span>, width: 'xs', align: 'end', cell: (o) => {
            const items = actions(o);
            return items.length === 0 || connection.status === 'revoked' ? null
              : <Menu label={`More for ${o.object}`} items={items} renderTrigger={(p) => <IconButton {...p} size="sm" label={`More for ${o.object}`} icon="more" />} />;
          } },
        ]} />
      )}
      {stopPolling.error !== undefined ? <ErrorMessage error={stopPolling.error} /> : null}
      {polling !== undefined ? <PollingDialog key={polling.object} connection={connection} object={polling} open onClose={() => setPolling(undefined)} /> : null}
      {testing !== undefined ? <StreamTestDialog key={testing.object} connection={connection} object={testing} open onClose={() => setTesting(undefined)} /> : null}
    </Section>
  );
}

export function Stream({ connection }: { connection: Connection }) {
  const read = useQuery('readStream', { params: { connectionId: connection.id } }, { refreshMs: 30_000 });
  const enableBlocked = usePermits()('enableStream');
  const [enabling, setEnabling] = useState(false);
  return (
    <QueryView query={read} what="Its change stream">
      {(stream) => {
        const streaming = stream.webhook !== null || stream.capture !== null || stream.objects.some((o) => o.mode !== 'unavailable');
        const canStream = stream.objects.some((o) => o.declared.length > 0);
        return (
          <div className={styles.stack}>
            {stream.webhook === null && canStream && connection.status !== 'revoked' ? (
              <Panel>
                <div className={styles.next}>
                  <div>
                    <h2 className={styles.subheading}>{streaming ? 'Take changes the system sends' : 'Not streamed yet'}</h2>
                    <p className={styles.muted}>Its connector can stream changes. Until it does, each object is read when someone asks, and nothing that waits for a change sees one.</p>
                  </div>
                  <Button variant="primary" blocked={enableBlocked} onClick={() => setEnabling(true)}>Stream its changes</Button>
                </div>
              </Panel>
            ) : null}
            <Webhook connection={connection} stream={stream} />
            <Capture connection={connection} stream={stream} />
            <Objects connection={connection} stream={stream} />
            {enabling ? <EnableDialog connection={connection} open onClose={() => setEnabling(false)} /> : null}
          </div>
        );
      }}
    </QueryView>
  );
}
