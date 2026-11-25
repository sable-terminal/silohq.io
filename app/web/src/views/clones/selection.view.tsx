'use client';

// A selection of several clones (spec 29.6): who is in it, by name, and how many of them are
// hidden by the state filter or in the "not placed" tray, and which. An Action from here targets
// exactly the selection: its targets are resolved now, by the object view's rule, and listed by
// name before anything is proposed; those that cannot be targeted are listed with why. What
// comes back is the proposal's state; approvers decide in their inbox.

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type { Output } from '../../api/client.api.ts';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Checkbox, FormActions, SelectField, TextField } from '../../components/field.component.tsx';
import { Section } from '../../components/page.component.tsx';
import { ErrorMessage, Loading } from '../../components/states.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { formatNumber } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import styles from './clones.view.module.css';

type ActionType = Output<'listActionTypes'>['actionTypes'][number];
type Parameter = NonNullable<ActionType['current']>['parameters'][number];

const names = (ids: readonly string[], labelOf: (id: string) => string) => ids.slice(0, 20).map(labelOf).join(', ') + (ids.length > 20 ? ` and ${ids.length - 20} more` : '');

function valueOf(p: Parameter, text: string, checked: boolean): unknown {
  if (p.type === 'boolean') return checked;
  if (text === '') return undefined;
  if (p.type === 'integer') return Number.parseInt(text, 10);
  if (p.type === 'decimal') return Number(text);
  if (p.type === 'timestamp') return new Date(text).toISOString();
  return text;
}

function SelectionAction({ action, objectTypeId, ids, labelOf }: { action: ActionType; objectTypeId: string; ids: string[]; labelOf: (id: string) => string }) {
  const targets = useQuery('resolveActionTargets', { body: { objectTypeId, actionTypeId: action.id, objectIds: ids.slice(0, 10_000) } });
  const propose = useMutation('proposeMutation', { invalidates: ['listMutations', 'listApprovalInbox'] });
  const [values, setValues] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const parameters = action.current?.parameters ?? [];
  const t = targets.data;
  if (t === undefined) return targets.status === 'error' ? <ErrorMessage error={targets.error} onRetry={targets.refetch} /> : <Loading label="Reading the targets" block={false} />;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (t.targets.length === 0) return;
    const given: Record<string, unknown> = {};
    for (const p of parameters) {
      const v = valueOf(p, values[p.name] ?? '', checks[p.name] === true);
      if (v !== undefined) given[p.name] = v;
    }
    await propose.run({ body: { actionTypeId: action.id, parameters: given as never, objects: t.targets.map((x) => ({ connectionId: x.connectionId, reference: x.reference })) } });
  };
  const m = propose.data;
  return (
    <form onSubmit={submit} aria-label={action.displayName} className={styles.form}>
      <p>{action.displayName} would target {formatNumber(t.targets.length)}:</p>
      <ul className={styles.selectionList} aria-label="Targets">{t.targets.slice(0, 200).map((x) => <li key={x.objectId}>{labelOf(x.objectId)}</li>)}</ul>
      {t.excluded.length > 0 ? (
        <Banner tone="warn" title={`${t.excluded.length} cannot be targeted`}>
          <span className={styles.stackTight}>{t.excluded.slice(0, 50).map((x) => <span key={x.objectId}>{labelOf(x.objectId)}: {x.reason}</span>)}</span>
        </Banner>
      ) : null}
      {parameters.map((p) => (p.type === 'boolean'
        ? <Checkbox key={p.name} label={p.name.replaceAll('_', ' ')} checked={checks[p.name] === true} onChange={() => setChecks({ ...checks, [p.name]: !(checks[p.name] === true) })} />
        : p.type === 'enumeration'
          ? <SelectField key={p.name} label={p.name.replaceAll('_', ' ')} required={p.required} value={values[p.name] ?? ''} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} placeholder="Choose"
            options={(p.enumValues ?? []).map((v) => ({ value: v, label: v }))} />
          : <TextField key={p.name} label={p.name.replaceAll('_', ' ')} required={p.required} value={values[p.name] ?? ''} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
            type={p.type === 'integer' || p.type === 'decimal' ? 'number' : p.type === 'date' ? 'date' : p.type === 'timestamp' ? 'datetime-local' : 'text'} step={p.type === 'decimal' ? 'any' : undefined} />))}
      {propose.error !== undefined ? <ErrorMessage error={propose.error} /> : null}
      {m !== undefined ? (
        <Banner tone={m.status === 'refused' ? 'danger' : 'ok'}>
          {m.status === 'refused' ? `Refused at ${m.refusedStage ?? 'a check'}: ${m.refusalReason ?? 'no reason given'}` : m.status === 'awaiting_approval' ? `Proposed for ${t.targets.length}: it waits for approval.` : `Proposed for ${t.targets.length}: ${m.status.replaceAll('_', ' ')}.`}
          {' '}<Link href={hrefWith('/governance/changes/', { change: m.id })}>Follow it</Link>
        </Banner>
      ) : null}
      <FormActions>
        <Button type="submit" variant="primary" pending={propose.pending} blocked={propose.blocked} disabled={t.targets.length === 0 || m !== undefined}>Propose for {formatNumber(t.targets.length)}</Button>
      </FormActions>
    </form>
  );
}

export function SelectionPanel({ objectTypeId, typeName, ids, labelOf, hidden, notPlaced, onClear }: {
  objectTypeId: string; typeName: string; ids: string[]; labelOf: (id: string) => string; hidden: string[]; notPlaced: string[]; onClear: () => void;
}) {
  const list = useQuery('listActionTypes', { query: { status: 'confirmed', objectTypeId, limit: 200 } });
  const types = (list.data?.actionTypes ?? []).filter((t) => !t.isSystem && t.current !== null && !t.current.rules.some((r) => r.kind === 'create_object'));
  const [chosen, setChosen] = useState('');
  const action = types.find((t) => t.id === chosen);
  return (
    <div className={styles.stack} aria-label="Selection">
      <div className={styles.next}>
        <strong>{formatNumber(ids.length)} {typeName} selected</strong>
        <Button size="sm" variant="ghost" onClick={onClear}>Clear the selection</Button>
      </div>
      <ul className={styles.selectionList}>{ids.slice(0, 200).map((id) => <li key={id}>{labelOf(id)}</li>)}</ul>
      {ids.length > 200 ? <p className={styles.muted}>And {ids.length - 200} more.</p> : null}
      {hidden.length > 0 ? <Banner tone="info">{hidden.length} of the selection {hidden.length === 1 ? 'is' : 'are'} hidden by the state filter: {names(hidden, labelOf)}.</Banner> : null}
      {notPlaced.length > 0 ? <Banner tone="info">{notPlaced.length} of the selection {notPlaced.length === 1 ? 'is' : 'are'} not placed by this layout: {names(notPlaced, labelOf)}.</Banner> : null}
      <Section title="Act on the selection">
        {list.data === undefined ? <Loading label="Listing Actions" block={false} /> : types.length === 0 ? <p className={styles.muted}>No Action you may see acts on {typeName}.</p> : (
          <SelectField label="Action" value={chosen} onChange={(e) => setChosen(e.target.value)} placeholder="Choose an Action" options={types.map((t) => ({ value: t.id, label: t.displayName }))} />
        )}
        {action !== undefined ? <SelectionAction key={`${action.id}:${ids.join(',')}`} action={action} objectTypeId={objectTypeId} ids={ids} labelOf={labelOf} /> : null}
      </Section>
    </div>
  );
}
