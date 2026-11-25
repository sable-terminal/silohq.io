'use client';

// Types and links (spec 21, 25): the model as main holds it, or as a branch holds it while it is
// being changed. Every element by kind, each opening to the whole of it: an object type's
// systems and identifiers, its properties with each system's mapping and how sure that is,
// match keys, links and the Action types that target it. Main is never edited in place: a
// change is made on a branch (?branch=), proposed, reviewed and merged. On main a holder of
// ontology.manage deprecates an element, naming what replaces it and a retirement date at least
// 30 days ahead, and retires it from that date.

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import type { Input } from '../../api/client.api.ts';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { ConfirmDialog, Dialog } from '../../components/dialog.component.tsx';
import { Checkbox, fieldError, FormActions, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { SearchInput } from '../../components/search.component.tsx';
import { EmptyState, ErrorMessage, ErrorState, Loading } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, usePermits, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { connectionHref, typeHref } from '../../navigation/links.navigation.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { apiNameOf, CARDINALITY, DATA_TYPE, DATA_TYPES, ELEMENT_STATUS, KIND, type DataType, type ElementKind, type LinkType, type Manifest, type ObjectType } from './words.view.ts';
import styles from './ontology.view.module.css';

type Element = { kind: ElementKind; id: string; apiName: string; name: string; status: keyof typeof ELEMENT_STATUS; replacedById?: string | null | undefined; retireAfter?: string | undefined };
type TypeBody = Input<'putOntologyObjectType'>['body'];
type PropertyBody = TypeBody['properties'][number];
type LinkBody = Input<'putOntologyLinkType'>['body'];
type NewKind = 'object-type' | 'link-type' | 'interface' | 'shared-property' | 'function';

const NEW_KIND: Record<NewKind, ElementKind> = { 'object-type': 'object_type', 'link-type': 'link_type', interface: 'interface', 'shared-property': 'shared_property', function: 'function' };

export function elementsOf(m: Manifest): Element[] {
  return [
    ...m.objectTypes.map((t) => ({ kind: 'object_type' as const, id: t.id, apiName: t.apiName, name: t.displayName, status: t.status, replacedById: t.replacedById, retireAfter: t.retireAfter })),
    ...m.linkTypes.map((l) => ({ kind: 'link_type' as const, id: l.id, apiName: l.apiName, name: l.forwardName, status: l.status, replacedById: l.replacedById, retireAfter: l.retireAfter })),
    ...m.sharedProperties.map((p) => ({ kind: 'shared_property' as const, id: p.id, apiName: p.apiName, name: p.displayName, status: p.status, replacedById: p.replacedById, retireAfter: p.retireAfter })),
    ...m.interfaces.map((i) => ({ kind: 'interface' as const, id: i.id, apiName: i.apiName, name: i.displayName, status: i.status, replacedById: i.replacedById, retireAfter: i.retireAfter })),
    ...m.functions.map((f) => ({ kind: 'function' as const, id: f.id, apiName: f.apiName, name: f.apiName.replaceAll('_', ' '), status: f.status, replacedById: f.replacedById, retireAfter: f.retireAfter })),
  ];
}

/** Connections by id, for naming where a type's records come from. */
function useConnections() {
  const list = useQuery('listConnections', { query: { limit: 500 } }, { staleMs: 5 * 60_000 });
  return useMemo(() => {
    const all = (list.data?.connections ?? []).filter((c) => c.status !== 'revoked');
    const names = new Map((list.data?.connections ?? []).map((c) => [c.id, c.name]));
    return { all, nameOf: (id: string) => names.get(id) ?? 'a connected system' };
  }, [list.data]);
}

// ----------------------------------------------------------------------------- reading

function ObjectTypeView({ type, manifest }: { type: ObjectType; manifest: Manifest }) {
  const connections = useConnections();
  const actions = useQuery('listActionTypes', { query: { objectTypeId: type.id, limit: 100 } });
  const property = (identityId: string | null) => type.properties.find((p) => p.identityId === identityId)?.displayName ?? '—';
  const links = manifest.linkTypes.filter((l) => l.status !== 'retired' && (l.fromTypeId === type.id || l.toTypeId === type.id));
  const typeName = (id: string) => manifest.objectTypes.find((t) => t.id === id)?.displayName ?? 'another type';
  return (
    <div className={styles.stack}>
      {type.description !== null ? <p>{type.description}</p> : null}
      <Properties items={[
        ['Held in', type.contributingObjects.length === 0 ? 'No system yet' : <span key="h" className={styles.stackTight}>{type.contributingObjects.map((c) => (
          <span key={`${c.connectionId}:${c.sourceObject}`}><Link href={connectionHref(c.connectionId)}>{connections.nameOf(c.connectionId)}</Link>, {c.sourceObject}, identified by {c.identifierFieldPath}</span>
        ))}</span>],
        ['Resolution', type.resolutionClass === 'resolvable' ? `Across systems, matched on ${type.matchKeys.map((k) => property(k.propertyIdentityId)).join(' and ') || 'nothing yet'}` : 'One system'],
        ['Title', property(type.titlePropertyIdentityId)],
        ['Time', type.defaultTimeFieldPropertyIdentityId === null ? 'None' : property(type.defaultTimeFieldPropertyIdentityId)],
        ['Plural', type.pluralName],
        ['API name', <span key="a" className={styles.mono}>{type.apiName}</span>],
      ]} />
      <Section title="Properties">
        <DataTable label={`Properties of ${type.displayName}`} rows={type.properties.filter((p) => p.status !== 'retired')} rowKey={(p) => p.identityId} columns={[
          { id: 'name', header: 'Property', primary: true, sortValue: (p) => p.displayName, cell: (p) => (
            <span className={styles.row}>{p.displayName}{p.isMatchKey ? <Badge tone="accent">Match key</Badge> : null}{p.status === 'deprecated' ? <Badge tone="warn">Deprecated</Badge> : null}</span>
          ) },
          { id: 'type', header: 'Type', width: 'md', cell: (p) => `${DATA_TYPE[p.dataType]}${p.nullable ? '' : ', required'}` },
          { id: 'from', header: 'From', cell: (p) => (p.computedFunctionVersionId !== null ? 'Computed by a function' : (
            <span className={styles.stackTight}>{p.mappings.map((m) => (
              <span key={`${m.connectionId}:${m.fieldPath}`}>{connections.nameOf(m.connectionId)}: <span className={styles.mono}>{m.sourceObject}.{m.fieldPath}</span>
                {m.confidence < 1 ? <span className={styles.muted}> ({Math.round(m.confidence * 100)}% sure)</span> : null}</span>
            ))}</span>
          )) },
        ]} />
      </Section>
      {links.length > 0 ? (
        <Section title="Links">
          <ul className={styles.plainList}>{links.map((l) => (
            <li key={l.id}>{l.fromTypeId === type.id ? `${l.forwardName} → ${typeName(l.toTypeId)}` : `${l.reverseName} → ${typeName(l.fromTypeId)}`}
              <span className={styles.muted}> ({CARDINALITY[l.cardinality].toLowerCase()}, {plural(l.routes.length, 'route')})</span></li>
          ))}</ul>
        </Section>
      ) : null}
      <Section title="Action types" actions={<LinkButton href="/ontology/actions/" size="sm">Action types</LinkButton>}>
        {actions.data === undefined ? <Loading label="Reading" block={false} /> : actions.data.actionTypes.length === 0 ? <p className={styles.muted}>No Action type targets it.</p> : (
          <ul className={styles.plainList}>{actions.data.actionTypes.map((a) => <li key={a.id}><Link href={hrefWith('/ontology/actions/', { action: a.id })}>{a.displayName}</Link> <span className={styles.muted}>{a.status}</span></li>)}</ul>
        )}
      </Section>
      <MappingIds type={type} />
      <p><Link href={typeHref(type.id)}>Browse its objects in Explorer</Link></p>
    </div>
  );
}

/** The ids of a type's field mappings, which a source-field marking is applied to (D67). */
function MappingIds({ type }: { type: ObjectType }) {
  const [open, setOpen] = useState(false);
  const mappings = useQuery('listOntologyPropertyMappings', open ? { params: { objectTypeId: type.id } } : null);
  return (
    <details className={styles.details} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Field mappings, for markings on source fields</summary>
      {mappings.data === undefined ? (mappings.status === 'error' ? <ErrorMessage error={mappings.error} /> : <Loading label="Reading" block={false} />) : (
        <DataTable label="Field mappings" rows={mappings.data.mappings} rowKey={(m) => m.id} dense columns={[
          { id: 'property', header: 'Property', primary: true, cell: (m) => m.apiName },
          { id: 'field', header: 'Field', cell: (m) => <span className={styles.mono}>{m.sourceObject}.{m.fieldPath}</span> },
          { id: 'id', header: 'Mapping', cell: (m) => <span className={styles.mono}>{m.id}</span> },
        ]} />
      )}
    </details>
  );
}

function LinkTypeView({ link, manifest }: { link: LinkType; manifest: Manifest }) {
  const connections = useConnections();
  const typeName = (id: string) => manifest.objectTypes.find((t) => t.id === id)?.displayName ?? 'another type';
  return (
    <div className={styles.stack}>
      <p>{typeName(link.fromTypeId)} <strong>{link.forwardName}</strong> {typeName(link.toTypeId)}; read back, {typeName(link.toTypeId)} <strong>{link.reverseName}</strong> {typeName(link.fromTypeId)}. {CARDINALITY[link.cardinality]}.</p>
      <DataTable label="Routes" rows={link.routes} rowKey={(r) => r.id} columns={[
        { id: 'system', header: 'System', primary: true, cell: (r) => <span className={styles.row}>{connections.nameOf(r.connectionId)}{link.defaultRouteId === r.id ? <Badge>Default</Badge> : null}</span> },
        { id: 'key', header: 'Key', cell: (r) => <span className={styles.mono}>{r.sourceObject}.{r.foreignKeyField} → {r.referencedConnectionId != null ? `${r.referencedObject ?? ''}.${r.referencedField} in ${connections.nameOf(r.referencedConnectionId)}` : r.referencedField}{r.junctionObject !== null ? ` through ${r.junctionObject}` : ''}</span> },
        { id: 'origin', header: 'Declared by', width: 'md', cell: (r) => (r.origin === 'declared_fk' ? 'The system' : r.origin === 'inferred' ? 'Inferred from the data' : 'A person') },
      ]} />
      {link.routes.length > 1 && link.defaultRouteId === null ? <p className={styles.muted}>No default route: a question that follows this link asks which.</p> : null}
    </div>
  );
}

function ElementView({ element, manifest, elements }: { element: Element; manifest: Manifest; elements: Element[] }) {
  const replacement = elements.find((e) => e.id === element.replacedById);
  const shared = element.kind === 'shared_property' ? manifest.sharedProperties.find((p) => p.id === element.id) : undefined;
  const fn = element.kind === 'function' ? manifest.functions.find((f) => f.id === element.id) : undefined;
  const iface = element.kind === 'interface' ? manifest.interfaces.find((i) => i.id === element.id) : undefined;
  return (
    <div className={styles.stack}>
      {element.status === 'deprecated' ? (
        <Banner tone="warn" title="Deprecated">
          {replacement !== undefined ? `Use ${replacement.name} instead. ` : ''}It may be retired from {element.retireAfter === undefined ? 'a date not yet set' : <Time value={element.retireAfter} />}; everything that uses it is told before then.
        </Banner>
      ) : null}
      {element.kind === 'object_type' ? <ObjectTypeView type={manifest.objectTypes.find((t) => t.id === element.id)!} manifest={manifest} /> : null}
      {element.kind === 'link_type' ? <LinkTypeView link={manifest.linkTypes.find((l) => l.id === element.id)!} manifest={manifest} /> : null}
      {shared !== undefined ? <p>{shared.description ?? 'A property several types share.'} Its type is {DATA_TYPE[shared.dataType].toLowerCase()}.</p> : null}
      {fn !== undefined ? (
        <>
          <p>{fn.description ?? `A ${fn.kind.replaceAll('_', ' ')} function.`} Version {fn.version.version}, giving {DATA_TYPE[fn.version.outputType.dataType].toLowerCase()}.</p>
          <pre className={styles.code}>{fn.version.expression}</pre>
        </>
      ) : null}
      {iface !== undefined ? (
        <>
          {iface.description !== null ? <p>{iface.description}</p> : null}
          <p>Requires {iface.requiredSharedPropertyIds.map((id) => manifest.sharedProperties.find((p) => p.id === id)?.displayName ?? 'a shared property').join(', ') || 'no shared property'}
            {iface.requiredLinkTypeNames.length > 0 ? ` and the links ${iface.requiredLinkTypeNames.join(', ')}` : ''}.</p>
          <p>Implemented by {manifest.objectTypes.filter((t) => t.implements.some((i) => i.interfaceId === iface.id)).map((t) => t.displayName).join(', ') || 'no type yet'}.</p>
        </>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------------------- lifecycle on main

function DeprecateDialog({ element, elements, open, onClose }: { element: Element; elements: Element[]; open: boolean; onClose: () => void }) {
  const say = useToast();
  const deprecate = useMutation('deprecateOntologyElement', { invalidates: ['readOntology', 'readVocabulary', 'listOntologyVersions'] });
  const earliest = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const [retireAfter, setRetireAfter] = useState(earliest);
  const [replacement, setReplacement] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await deprecate.run({ params: { kind: element.kind, elementId: element.id }, body: { retireAfter, ...(replacement !== '' ? { replacedById: replacement } : {}) } });
    if (r.ok) {
      say(`${element.name} deprecated: owners of what uses it are told`);
      onClose();
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Deprecate ${element.name}`} size="md" busy={deprecate.pending}
      description="It stays usable, every question that uses it says it is deprecated, and owners of what depends on it are told now and seven days before it may be retired.">
      <form onSubmit={submit} className={styles.form}>
        <SelectField label="Replaced by" value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="Nothing replaces it"
          options={elements.filter((e) => e.kind === element.kind && e.id !== element.id && e.status === 'active').map((e) => ({ value: e.id, label: e.name }))} />
        <TextField label="Retire no earlier than" type="date" required min={earliest} value={retireAfter} onChange={(e) => setRetireAfter(e.target.value)}
          hint="At least 30 days ahead." error={fieldError(deprecate.error, 'retireAfter')} />
        {deprecate.error !== undefined && fieldError(deprecate.error, 'retireAfter') === undefined ? <ErrorMessage error={deprecate.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={deprecate.pending}>Cancel</Button>
          <Button type="submit" variant="danger" pending={deprecate.pending} blocked={deprecate.blocked}>Deprecate</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- editing on a branch

interface PropertyRow { key: string; previous: string | undefined; apiName: string; displayName: string; description: string; dataType: DataType; nullable: boolean; values: string; scale: string; typeParams: Record<string, unknown>; computed: string | undefined; shared: string | undefined; mappings: { connectionId: string; sourceObject: string; fieldPath: string }[] }

let rowSeq = 0;
const newKey = () => `row${(rowSeq += 1)}`;

/** A manifest's object type as the put body edits it: references by API name. */
function draftOf(type: ObjectType | undefined, manifest: Manifest): { body: Omit<TypeBody, 'properties'>; rows: PropertyRow[]; apiName: string } {
  if (type === undefined) {
    return { apiName: '', body: { displayName: '', pluralName: '', contributingObjects: [], title: '', matchKeys: [], timeFields: [], implements: [], disjointSources: false }, rows: [] };
  }
  const nameOf = (identityId: string | null) => type.properties.find((p) => p.identityId === identityId)?.apiName;
  const sharedName = (id: string | null) => (id === null ? undefined : manifest.sharedProperties.find((s) => s.id === id)?.apiName);
  return {
    apiName: type.apiName,
    body: {
      displayName: type.displayName, pluralName: type.pluralName, ...(type.description !== null ? { description: type.description } : {}),
      contributingObjects: type.contributingObjects.map((c) => ({ connectionId: c.connectionId, sourceObject: c.sourceObject, identifierFieldPath: c.identifierFieldPath })),
      ...(nameOf(type.primaryKeyPropertyIdentityId) !== undefined ? { primaryKey: nameOf(type.primaryKeyPropertyIdentityId)! } : {}),
      title: nameOf(type.titlePropertyIdentityId) ?? '',
      matchKeys: type.matchKeys.map((k) => ({ property: nameOf(k.propertyIdentityId) ?? '', ...(k.normalisation !== null ? { normalisation: k.normalisation } : {}) })).filter((k) => k.property !== ''),
      disjointSources: type.disjointSources ?? false,
      timeFields: type.timeFields.map((t) => ({ property: nameOf(t.propertyIdentityId) ?? '', meaning: t.meaning, isDefault: t.isDefault })).filter((t) => t.property !== ''),
      implements: type.implements.map((i) => ({
        interface: manifest.interfaces.find((x) => x.id === i.interfaceId)?.apiName ?? '',
        propertyBindings: Object.fromEntries(Object.entries(i.propertyBindings).map(([sharedId, identityId]) => [sharedName(sharedId) ?? sharedId, nameOf(identityId) ?? identityId])),
        linkBindings: Object.fromEntries(Object.entries(i.linkBindings).map(([name, linkId]) => [name, manifest.linkTypes.find((l) => l.id === linkId)?.apiName ?? linkId])),
      })).filter((i) => i.interface !== ''),
      visual: type.visual as never,
    },
    rows: type.properties.filter((p) => p.status !== 'retired').map((p) => ({
      key: newKey(), previous: p.apiName, apiName: p.apiName, displayName: p.displayName, description: p.description ?? '', dataType: p.dataType, nullable: p.nullable,
      values: Array.isArray(p.typeParams['values']) ? (p.typeParams['values'] as string[]).join(', ') : '',
      scale: typeof p.typeParams['scale'] === 'number' ? String(p.typeParams['scale']) : '', typeParams: p.typeParams,
      computed: p.computedFunctionVersionId ?? undefined, shared: sharedName(p.sharedPropertyId),
      mappings: p.mappings.map((m) => ({ connectionId: m.connectionId, sourceObject: m.sourceObject, fieldPath: m.fieldPath })),
    })),
  };
}

function rowBody(r: PropertyRow): PropertyBody {
  const typeParams: Record<string, unknown> = { ...r.typeParams };
  if (r.dataType === 'enum') typeParams['values'] = r.values.split(',').map((v) => v.trim()).filter(Boolean);
  if (r.dataType === 'decimal' && r.scale.trim() !== '') typeParams['scale'] = Number(r.scale);
  return {
    apiName: r.apiName, ...(r.previous !== undefined && r.previous !== r.apiName ? { previousApiName: r.previous } : {}), displayName: r.displayName,
    ...(r.description.trim() !== '' ? { description: r.description.trim() } : {}), dataType: r.dataType, typeParams: typeParams as never, nullable: r.nullable,
    ...(r.shared !== undefined ? { sharedProperty: r.shared } : {}), ...(r.computed !== undefined ? { computedFunctionVersionId: r.computed } : {}),
    ...(r.computed === undefined ? { mappings: r.mappings.filter((m) => m.fieldPath.trim() !== '') } : {}),
  };
}

/** Field paths a connection's profiles know, for suggesting where a property is read from. */
function FieldSuggestions({ id, connectionIds }: { id: string; connectionIds: readonly string[] }) {
  const first = connectionIds[0];
  const profiles = useQuery('listOntologyFieldProfiles', first === undefined ? null : { params: { connectionId: first }, query: {} }, { staleMs: 10 * 60_000 });
  return <datalist id={id}>{(profiles.data?.profiles ?? []).map((p) => <option key={`${p.sourceObject}.${p.fieldPath}`} value={p.fieldPath}>{p.sourceObject}</option>)}</datalist>;
}

function ObjectTypeEditor({ branchId, headVersionId, manifest, type, open, onClose }: { branchId: string; headVersionId: string | null; manifest: Manifest; type: ObjectType | undefined; open: boolean; onClose: () => void }) {
  const say = useToast();
  const [, set] = useParams();
  const connections = useConnections();
  const initial = useMemo(() => draftOf(type, manifest), [type, manifest]);
  const put = useMutation('putOntologyObjectType', { invalidates: ['readOntology', 'readOntologyBranch', 'readOntologyBranchChanges'] });
  const [apiName, setApiName] = useState(initial.apiName);
  const [body, setBody] = useState(initial.body);
  const [rows, setRows] = useState<PropertyRow[]>(initial.rows);
  const suggestions = `fields-${branchId}`;
  const names = rows.map((r) => r.apiName).filter(Boolean);
  const change = (key: string, patch: Partial<PropertyRow>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const sources = body.contributingObjects;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await put.run({ params: { branchId, apiName: apiName || apiNameOf(body.displayName) }, body: { ...body, ...(headVersionId !== null ? { expectedHeadVersionId: headVersionId } : {}), properties: rows.map(rowBody) } });
    if (r.ok) {
      say(`${r.data.element.displayName} saved on the branch`);
      onClose();
      set({ element: r.data.element.id, edit: undefined, new: undefined });
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={type === undefined ? 'New object type' : `Edit ${type.displayName}`} size="xl" busy={put.pending}
      description="Saved on the branch only. Main changes when a proposal from the branch is approved and merged.">
      <form onSubmit={submit} className={styles.form}>
        <div className={styles.split}>
          <TextField label="Name" required value={body.displayName} onChange={(e) => setBody({ ...body, displayName: e.target.value })} data-autofocus error={fieldError(put.error, 'displayName')} />
          <TextField label="Plural" required value={body.pluralName} onChange={(e) => setBody({ ...body, pluralName: e.target.value })} error={fieldError(put.error, 'pluralName')} />
          <TextField label="API name" required value={apiName || apiNameOf(body.displayName)} disabled={type !== undefined} onChange={(e) => setApiName(e.target.value)} spellCheck={false}
            hint={type !== undefined ? 'Fixed once made.' : 'Lower case and underscores; how code and questions name it.'} />
        </div>
        <TextArea label="Description" rows={2} value={body.description ?? ''} onChange={(e) => setBody({ ...body, description: e.target.value })} />
        <Section title="Where its records are" description="Each system and object that holds records of this type, and the field that identifies a record there.">
          {sources.map((c, i) => (
            <div key={i} className={styles.split}>
              <SelectField label="System" value={c.connectionId} onChange={(e) => setBody({ ...body, contributingObjects: sources.map((x, j) => (j === i ? { ...x, connectionId: e.target.value } : x)) })}
                placeholder="Choose a connection" options={connections.all.map((x) => ({ value: x.id, label: x.name }))} />
              <TextField label="Object" value={c.sourceObject} onChange={(e) => setBody({ ...body, contributingObjects: sources.map((x, j) => (j === i ? { ...x, sourceObject: e.target.value } : x)) })} />
              <TextField label="Identified by" value={c.identifierFieldPath} list={suggestions} onChange={(e) => setBody({ ...body, contributingObjects: sources.map((x, j) => (j === i ? { ...x, identifierFieldPath: e.target.value } : x)) })} />
              <Button size="sm" variant="ghost" onClick={() => setBody({ ...body, contributingObjects: sources.filter((_, j) => j !== i) })}>Remove</Button>
            </div>
          ))}
          <Button size="sm" icon="plus" onClick={() => setBody({ ...body, contributingObjects: [...sources, { connectionId: connections.all[0]?.id ?? '', sourceObject: '', identifierFieldPath: '' }] })}>Add a system</Button>
          <FieldSuggestions id={suggestions} connectionIds={sources.map((s) => s.connectionId).filter(Boolean)} />
        </Section>
        <Section title="Properties">
          <div className={styles.stack}>
            {rows.map((r) => (
              <Panel key={r.key}>
                <div className={styles.stack}>
                  <div className={styles.split}>
                    <TextField label="Property" required value={r.displayName} onChange={(e) => change(r.key, { displayName: e.target.value, ...(r.previous === undefined ? { apiName: apiNameOf(e.target.value) } : {}) })} />
                    <TextField label="API name" required value={r.apiName} spellCheck={false} onChange={(e) => change(r.key, { apiName: e.target.value })}
                      hint={r.previous !== undefined && r.previous !== r.apiName ? `Renamed from ${r.previous}` : undefined} />
                    <SelectField label="Type" value={r.dataType} onChange={(e) => change(r.key, { dataType: e.target.value as DataType })} options={DATA_TYPES.map((d) => ({ value: d, label: DATA_TYPE[d] }))} />
                  </div>
                  {r.dataType === 'enum' ? <TextField label="Values" value={r.values} onChange={(e) => change(r.key, { values: e.target.value })} hint="Separated by commas, in order." /> : null}
                  {r.dataType === 'decimal' ? <TextField label="Decimal places" type="number" min={0} max={18} value={r.scale} onChange={(e) => change(r.key, { scale: e.target.value })} /> : null}
                  {r.computed !== undefined ? <p className={styles.muted}>Computed by a function.</p> : sources.map((c) => {
                    const at = r.mappings.findIndex((m) => m.connectionId === c.connectionId && m.sourceObject === c.sourceObject);
                    const value = at === -1 ? '' : r.mappings[at]!.fieldPath;
                    return (
                      <TextField key={`${c.connectionId}:${c.sourceObject}`} label={`From ${connections.nameOf(c.connectionId)}, ${c.sourceObject || 'its object'}`} value={value} list={suggestions} spellCheck={false}
                        onChange={(e) => change(r.key, { mappings: at === -1 ? [...r.mappings, { connectionId: c.connectionId, sourceObject: c.sourceObject, fieldPath: e.target.value }]
                          : r.mappings.map((m, j) => (j === at ? { ...m, fieldPath: e.target.value } : m)) })} hint="The field path; empty if this system does not hold it." />
                    );
                  })}
                  <div className={styles.row}>
                    <Checkbox label="May be empty" checked={r.nullable} onChange={() => change(r.key, { nullable: !r.nullable })} />
                    <Button size="sm" variant="ghost" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>Remove</Button>
                  </div>
                </div>
              </Panel>
            ))}
            <Button size="sm" icon="plus" onClick={() => setRows([...rows, { key: newKey(), previous: undefined, apiName: '', displayName: '', description: '', dataType: 'string', nullable: true, values: '', scale: '', typeParams: {}, computed: undefined, shared: undefined, mappings: [] }])}>
              Add a property
            </Button>
          </div>
        </Section>
        <Section title="Identity">
          <div className={styles.split}>
            <SelectField label="Title" required value={body.title} onChange={(e) => setBody({ ...body, title: e.target.value })} placeholder="Choose a property" options={names.map((n) => ({ value: n, label: n }))}
              hint="What an object is called wherever it is shown." />
            <SelectField label="Primary key" value={body.primaryKey ?? ''} onChange={(e) => setBody({ ...body, ...(e.target.value === '' ? { primaryKey: undefined } : { primaryKey: e.target.value }) })}
              placeholder="None (resolved across systems)" options={names.map((n) => ({ value: n, label: n }))} />
          </div>
          <fieldset className={styles.choices}>
            <legend>Match keys: what makes records in different systems one object</legend>
            {names.map((n) => (
              <Checkbox key={n} label={n} checked={(body.matchKeys ?? []).some((k) => k.property === n)} onChange={() => {
                const keys = body.matchKeys ?? [];
                setBody({ ...body, matchKeys: keys.some((k) => k.property === n) ? keys.filter((k) => k.property !== n) : [...keys, { property: n }] });
              }} />
            ))}
          </fieldset>
          <SelectField label="Default time field" value={(body.timeFields ?? []).find((t) => t.isDefault)?.property ?? ''} placeholder="None"
            onChange={(e) => setBody({ ...body, timeFields: e.target.value === '' ? [] : [{ property: e.target.value, meaning: 'occurred', isDefault: true }] })}
            options={rows.filter((r) => r.dataType === 'date' || r.dataType === 'timestamp').map((r) => ({ value: r.apiName, label: r.apiName }))} />
        </Section>
        {put.error !== undefined ? <ErrorMessage error={put.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={put.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={put.pending} blocked={put.blocked} disabled={body.displayName.trim() === '' || body.title === '' || rows.length === 0}>Save on the branch</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function LinkTypeEditor({ branchId, headVersionId, manifest, link, open, onClose }: { branchId: string; headVersionId: string | null; manifest: Manifest; link: LinkType | undefined; open: boolean; onClose: () => void }) {
  const say = useToast();
  const [, set] = useParams();
  const connections = useConnections();
  const typeApi = (id: string) => manifest.objectTypes.find((t) => t.id === id)?.apiName ?? '';
  const put = useMutation('putOntologyLinkType', { invalidates: ['readOntology', 'readOntologyBranch', 'readOntologyBranchChanges'] });
  const [apiName, setApiName] = useState(link?.apiName ?? '');
  const [body, setBody] = useState<LinkBody>(() => (link === undefined
    ? { forwardName: '', reverseName: '', from: '', to: '', cardinality: 'one_to_many', routes: [] }
    : { forwardName: link.forwardName, reverseName: link.reverseName, from: typeApi(link.fromTypeId), to: typeApi(link.toTypeId), cardinality: link.cardinality,
      routes: link.routes.map((r) => ({ connectionId: r.connectionId, sourceObject: r.sourceObject, foreignKeyField: r.foreignKeyField, referencedField: r.referencedField,
        ...(r.junctionObject !== null ? { junctionObject: r.junctionObject } : {}), ...(r.referencedConnectionId != null ? { referencedConnectionId: r.referencedConnectionId } : {}),
        ...(r.referencedObject != null ? { referencedObject: r.referencedObject } : {}), origin: r.origin })),
      ...(link.defaultRouteId !== null ? { defaultRoute: link.routes.findIndex((r) => r.id === link.defaultRouteId) } : {}) }));
  const types = manifest.objectTypes.filter((t) => t.status !== 'retired');
  const routes = body.routes;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const r = await put.run({ params: { branchId, apiName: apiName || apiNameOf(body.forwardName) }, body: { ...body, ...(headVersionId !== null ? { expectedHeadVersionId: headVersionId } : {}) } });
    if (r.ok) {
      say(`${r.data.element.forwardName} saved on the branch`);
      onClose();
      set({ element: r.data.element.id, edit: undefined, new: undefined });
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={link === undefined ? 'New link type' : `Edit ${link.forwardName}`} size="lg" busy={put.pending}>
      <form onSubmit={submit} className={styles.form}>
        <div className={styles.split}>
          <SelectField label="From" required value={body.from} onChange={(e) => setBody({ ...body, from: e.target.value })} placeholder="Choose a type" options={types.map((t) => ({ value: t.apiName, label: t.displayName }))} />
          <TextField label="Read forwards" required value={body.forwardName} onChange={(e) => setBody({ ...body, forwardName: e.target.value })} placeholder="places" />
          <SelectField label="To" required value={body.to} onChange={(e) => setBody({ ...body, to: e.target.value })} placeholder="Choose a type" options={types.map((t) => ({ value: t.apiName, label: t.displayName }))} />
          <TextField label="Read back" required value={body.reverseName} onChange={(e) => setBody({ ...body, reverseName: e.target.value })} placeholder="placed by" />
        </div>
        <div className={styles.split}>
          <SelectField label="How many" value={body.cardinality} onChange={(e) => setBody({ ...body, cardinality: e.target.value as LinkBody['cardinality'] })}
            options={(Object.keys(CARDINALITY) as LinkBody['cardinality'][]).map((c) => ({ value: c, label: CARDINALITY[c] }))} />
          <TextField label="API name" required value={apiName || apiNameOf(body.forwardName)} disabled={link !== undefined} onChange={(e) => setApiName(e.target.value)} spellCheck={false} />
        </div>
        <Section title="Routes" description="Where each system says one record refers to another: a key field and the field it refers to.">
          {routes.map((r, i) => (
            <Panel key={i}>
              <div className={styles.split}>
                <SelectField label="System" value={r.connectionId} onChange={(e) => setBody({ ...body, routes: routes.map((x, j) => (j === i ? { ...x, connectionId: e.target.value } : x)) })}
                  placeholder="Choose a connection" options={connections.all.map((c) => ({ value: c.id, label: c.name }))} />
                <TextField label="Object" value={r.sourceObject} onChange={(e) => setBody({ ...body, routes: routes.map((x, j) => (j === i ? { ...x, sourceObject: e.target.value } : x)) })} />
                <TextField label="Key field" value={r.foreignKeyField} onChange={(e) => setBody({ ...body, routes: routes.map((x, j) => (j === i ? { ...x, foreignKeyField: e.target.value } : x)) })} />
                <TextField label="Refers to field" value={r.referencedField} onChange={(e) => setBody({ ...body, routes: routes.map((x, j) => (j === i ? { ...x, referencedField: e.target.value } : x)) })} />
                <TextField label="Through (optional)" value={r.junctionObject ?? ''} hint="A table between them, for many to many."
                  onChange={(e) => setBody({ ...body, routes: routes.map((x, j) => (j === i ? { ...x, ...(e.target.value === '' ? { junctionObject: undefined } : { junctionObject: e.target.value }) } : x)) })} />
              </div>
              <div className={styles.row}>
                <Checkbox label="The default route" checked={body.defaultRoute === i} onChange={() => setBody({ ...body, ...(body.defaultRoute === i ? { defaultRoute: undefined } : { defaultRoute: i }) })} />
                <Button size="sm" variant="ghost" onClick={() => setBody({ ...body, routes: routes.filter((_, j) => j !== i), defaultRoute: undefined })}>Remove</Button>
              </div>
            </Panel>
          ))}
          <Button size="sm" icon="plus" onClick={() => setBody({ ...body, routes: [...routes, { connectionId: connections.all[0]?.id ?? '', sourceObject: '', foreignKeyField: '', referencedField: '', origin: 'person_declared' }] })}>Add a route</Button>
        </Section>
        {put.error !== undefined ? <ErrorMessage error={put.error} /> : null}
        <FormActions>
          <Button onClick={onClose} disabled={put.pending}>Cancel</Button>
          <Button type="submit" variant="primary" pending={put.pending} blocked={put.blocked}
            disabled={body.from === '' || body.to === '' || body.forwardName.trim() === '' || body.reverseName.trim() === '' || routes.length === 0}>Save on the branch</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function SharedPropertyEditor({ branchId, headVersionId, existing, open, onClose }: { branchId: string; headVersionId: string | null; existing: Manifest['sharedProperties'][number] | undefined; open: boolean; onClose: () => void }) {
  const say = useToast();
  const put = useMutation('putOntologySharedProperty', { invalidates: ['readOntology', 'readOntologyBranch', 'readOntologyBranchChanges'] });
  const [name, setName] = useState(existing?.displayName ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [dataType, setDataType] = useState<DataType>(existing?.dataType ?? 'string');
  return (
    <Dialog open={open} onClose={onClose} title={existing === undefined ? 'New shared property' : `Edit ${existing.displayName}`} size="md" busy={put.pending}
      description="A property several types share, with one meaning; interfaces require them.">
      <form className={styles.form} onSubmit={async (event) => {
        event.preventDefault();
        const r = await put.run({ params: { branchId, apiName: existing?.apiName ?? apiNameOf(name) }, body: { displayName: name.trim(), dataType, ...(description.trim() !== '' ? { description: description.trim() } : {}), ...(headVersionId !== null ? { expectedHeadVersionId: headVersionId } : {}) } });
        if (r.ok) {
          say('Saved on the branch');
          onClose();
        }
      }}>
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        <SelectField label="Type" value={dataType} onChange={(e) => setDataType(e.target.value as DataType)} options={DATA_TYPES.map((d) => ({ value: d, label: DATA_TYPE[d] }))} />
        <TextArea label="What it means" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        {put.error !== undefined ? <ErrorMessage error={put.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={put.pending} blocked={put.blocked} disabled={name.trim() === ''}>Save on the branch</Button></FormActions>
      </form>
    </Dialog>
  );
}

function InterfaceEditor({ branchId, headVersionId, manifest, existing, open, onClose }: { branchId: string; headVersionId: string | null; manifest: Manifest; existing: Manifest['interfaces'][number] | undefined; open: boolean; onClose: () => void }) {
  const say = useToast();
  const put = useMutation('putOntologyInterface', { invalidates: ['readOntology', 'readOntologyBranch', 'readOntologyBranchChanges'] });
  const [name, setName] = useState(existing?.displayName ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [required, setRequired] = useState<Set<string>>(() => new Set((existing?.requiredSharedPropertyIds ?? []).map((id) => manifest.sharedProperties.find((s) => s.id === id)?.apiName ?? '').filter(Boolean)));
  const [links, setLinks] = useState((existing?.requiredLinkTypeNames ?? []).join(', '));
  return (
    <Dialog open={open} onClose={onClose} title={existing === undefined ? 'New interface' : `Edit ${existing.displayName}`} size="md" busy={put.pending}
      description="What a kind of object must have, so apps and Actions work on every type that implements it.">
      <form className={styles.form} onSubmit={async (event) => {
        event.preventDefault();
        const r = await put.run({ params: { branchId, apiName: existing?.apiName ?? apiNameOf(name) }, body: {
          displayName: name.trim(), ...(description.trim() !== '' ? { description: description.trim() } : {}), requiredSharedProperties: [...required],
          requiredLinkTypeNames: links.split(',').map((l) => l.trim()).filter(Boolean), ...(headVersionId !== null ? { expectedHeadVersionId: headVersionId } : {}),
        } });
        if (r.ok) {
          say('Saved on the branch');
          onClose();
        }
      }}>
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        <TextArea label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <fieldset className={styles.choices}>
          <legend>Shared properties it requires</legend>
          {manifest.sharedProperties.filter((s) => s.status !== 'retired').map((s) => (
            <Checkbox key={s.id} label={s.displayName} checked={required.has(s.apiName)} onChange={() => {
              const next = new Set(required);
              if (next.has(s.apiName)) next.delete(s.apiName);
              else next.add(s.apiName);
              setRequired(next);
            }} />
          ))}
        </fieldset>
        <TextField label="Links it requires" value={links} onChange={(e) => setLinks(e.target.value)} hint="Link names, separated by commas." />
        {put.error !== undefined ? <ErrorMessage error={put.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={put.pending} blocked={put.blocked} disabled={name.trim() === ''}>Save on the branch</Button></FormActions>
      </form>
    </Dialog>
  );
}

function FunctionEditor({ branchId, headVersionId, manifest, existing, open, onClose }: { branchId: string; headVersionId: string | null; manifest: Manifest; existing: Manifest['functions'][number] | undefined; open: boolean; onClose: () => void }) {
  const say = useToast();
  const put = useMutation('putOntologyFunction', { invalidates: ['readOntology', 'readOntologyBranch', 'readOntologyBranchChanges'] });
  const [name, setName] = useState(existing?.apiName ?? '');
  const [kind, setKind] = useState<'computed_property' | 'ranking' | 'validation'>(existing?.kind ?? 'computed_property');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [expression, setExpression] = useState(existing?.version.expression ?? '');
  const [output, setOutput] = useState<DataType>(existing?.version.outputType.dataType ?? 'decimal');
  const [types, setTypes] = useState<Set<string>>(() => new Set((existing?.version.inputs.objectTypeIds ?? []).map((id) => manifest.objectTypes.find((t) => t.id === id)?.apiName ?? '').filter(Boolean)));
  return (
    <Dialog open={open} onClose={onClose} title={existing === undefined ? 'New function' : `Edit ${existing.apiName.replaceAll('_', ' ')}`} size="lg" busy={put.pending}
      description="A CEL expression over an object's properties: a computed property, a ranking or a validation. Each save is a new version; what used the old one keeps it until changed.">
      <form className={styles.form} onSubmit={async (event) => {
        event.preventDefault();
        const r = await put.run({ params: { branchId, apiName: existing?.apiName ?? apiNameOf(name) }, body: {
          kind, expression, ...(description.trim() !== '' ? { description: description.trim() } : {}), inputs: { objectTypes: [...types] }, outputType: { dataType: output },
          ...(headVersionId !== null ? { expectedHeadVersionId: headVersionId } : {}),
        } });
        if (r.ok) {
          say('Saved on the branch');
          onClose();
        }
      }}>
        <div className={styles.split}>
          <TextField label="Name" required value={name} disabled={existing !== undefined} onChange={(e) => setName(e.target.value)} data-autofocus />
          <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} options={[
            { value: 'computed_property', label: 'Computed property' }, { value: 'ranking', label: 'Ranking' }, { value: 'validation', label: 'Validation' },
          ]} />
          <SelectField label="Gives" value={output} onChange={(e) => setOutput(e.target.value as DataType)} options={DATA_TYPES.map((d) => ({ value: d, label: DATA_TYPE[d] }))} />
        </div>
        <TextArea label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <TextArea label="Expression (CEL)" required rows={6} spellCheck={false} className={styles.code} value={expression} onChange={(e) => setExpression(e.target.value)} placeholder="object.amount * object.quantity" />
        <fieldset className={styles.choices}>
          <legend>Types it reads</legend>
          {manifest.objectTypes.filter((t) => t.status !== 'retired').map((t) => (
            <Checkbox key={t.id} label={t.displayName} checked={types.has(t.apiName)} onChange={() => {
              const next = new Set(types);
              if (next.has(t.apiName)) next.delete(t.apiName);
              else next.add(t.apiName);
              setTypes(next);
            }} />
          ))}
        </fieldset>
        {put.error !== undefined ? <ErrorMessage error={put.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={put.pending} blocked={put.blocked} disabled={name.trim() === '' || expression.trim() === '' || types.size === 0}>Save on the branch</Button></FormActions>
      </form>
    </Dialog>
  );
}

/** Choosing a branch to make a change on, when none is chosen yet. */
function ChooseBranchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [, set] = useParams();
  const branches = useQuery('listOntologyBranches', { query: { status: 'open', limit: 100 } });
  const openBranch = useMutation('openOntologyBranch', { invalidates: ['listOntologyBranches'] });
  const [name, setName] = useState('');
  const working = (branches.data?.branches ?? []).filter((b) => b.kind === 'working' && b.status === 'open');
  return (
    <Dialog open={open} onClose={onClose} title="Changes are made on a branch" size="md" busy={openBranch.pending}
      description="Main is never edited in place. Make the change on a branch, then propose it for review.">
      <div className={styles.stack}>
        {working.length > 0 ? (
          <ul className={styles.plainList}>{working.map((b) => <li key={b.id}><Button variant="link" onClick={() => set({ branch: b.id })}>{b.name}</Button>{b.behindMain ? <span className={styles.muted}> (behind main)</span> : null}</li>)}</ul>
        ) : null}
        <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          const r = await openBranch.run({ body: { name: name.trim() } });
          if (r.ok) set({ branch: r.data.id });
        }}>
          <TextField label="A new branch" value={name} onChange={(e) => setName(e.target.value)} placeholder="Add supplier ratings" />
          {openBranch.error !== undefined ? <ErrorMessage error={openBranch.error} /> : null}
          <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={openBranch.pending} blocked={openBranch.blocked} disabled={name.trim() === ''}>Open it</Button></FormActions>
        </form>
      </div>
    </Dialog>
  );
}

export function Model() {
  const [params, set] = useParams();
  const permits = usePermits();
  const branchId = params.get('branch') ?? undefined;
  const read = useQuery('readOntology', { query: branchId === undefined ? {} : { branchId } });
  const branch = useQuery('readOntologyBranch', branchId === undefined ? null : { params: { branchId } });
  const retire = useMutation('retireOntologyElement', { invalidates: ['readOntology', 'readVocabulary', 'listOntologyVersions'] });
  const say = useToast();
  const [filter, setFilter] = useState('');
  const [deprecating, setDeprecating] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const manifest = read.data;
  const elements = useMemo(() => (manifest === undefined ? [] : elementsOf(manifest)), [manifest]);
  const chosen = elements.find((e) => e.id === params.get('element'));
  const newKind = params.get('new') as NewKind | null;
  const editing = params.get('edit') !== null && chosen !== undefined;
  const onBranch = branch.data !== undefined && branch.data.status === 'open';
  usePageContext({ scope: { kind: 'page', page: 'ontology' }, scopeLabel: chosen?.name ?? 'the ontology' });

  if (manifest === undefined) {
    return <Page title="Types and links" crumbs={[{ label: 'Ontology' }]}>{read.status === 'error' ? <ErrorState error={read.error} what="The model" onRetry={read.refetch} /> : <Loading label="Reading the model" />}</Page>;
  }
  const q = filter.trim().toLowerCase();
  const head = branch.data?.headVersionId ?? null;
  const close = () => set({ new: undefined, edit: undefined });
  return (
    <Page title="Types and links" width="full" crumbs={[{ label: 'Ontology' }]}
      description={branchId === undefined ? `Main, version ${manifest.version.sequence}: what every question, app and Action uses now.` : undefined}
      actions={onBranch ? (
        <>
          <LinkButton href={hrefWith('/ontology/branches/', { branch: branchId })}>The branch's changes</LinkButton>
          <Button variant="primary" icon="plus" blocked={permits('putOntologyObjectType')} onClick={() => set({ new: 'object-type' })}>New object type</Button>
        </>
      ) : <Button icon="branch" blocked={permits('openOntologyBranch')} onClick={() => set({ new: 'object-type' })}>Change the model</Button>}>
      {branchId !== undefined ? (
        branch.data === undefined ? <Loading label="Reading the branch" block={false} /> : (
          <Banner tone={onBranch ? 'info' : 'warn'} title={`On the branch ${branch.data.name}`}
            action={<span className={styles.row}><Button size="sm" onClick={() => set({ branch: undefined, element: undefined })}>Back to main</Button></span>}>
            {onBranch ? 'Changes here are saved on the branch; main changes when a proposal from it is merged.' : `It is ${branch.data.status}: nothing more can be saved on it.`}
            {branch.data.behindMain ? ' Main has moved on since it was opened: rebase it before proposing.' : ''}
          </Banner>
        )
      ) : null}
      <div className={styles.layout}>
        <nav aria-label="Elements" className={styles.side}>
          <SearchInput label="Find an element" value={filter} onChange={setFilter} delayMs={0} />
          {elements.length === 0 ? <p className={styles.muted}>Empty. <Link href="/ontology/derive/">Derive types from a connected system</Link> to begin.</p> : null}
          {(Object.keys(KIND) as ElementKind[]).map((kind) => {
            const list = elements.filter((e) => e.kind === kind && e.status !== 'retired' && (q === '' || e.name.toLowerCase().includes(q) || e.apiName.includes(q)));
            if (list.length === 0) return null;
            return (
              <div key={kind}>
                <h2 className={styles.sideHeading}>{KIND[kind].many} <span className={styles.muted}>{list.length}</span></h2>
                <ul className={styles.sideList}>
                  {list.map((e) => (
                    <li key={e.id}>
                      <Link href={hrefWith('/ontology/model/', { branch: branchId, element: e.id }) as never} aria-current={e.id === chosen?.id ? 'page' : undefined} className={styles.sideLink}>
                        {e.name}{e.status === 'deprecated' ? <Badge tone="warn">Deprecated</Badge> : e.status === 'proposed' ? <Badge tone="info">New</Badge> : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {onBranch ? (
            <div className={styles.stackTight}>
              {(['link-type', 'shared-property', 'interface', 'function'] as const).map((k) => <Button key={k} size="sm" variant="ghost" icon="plus" onClick={() => set({ new: k })}>New {KIND[NEW_KIND[k]].one.toLowerCase()}</Button>)}
            </div>
          ) : null}
        </nav>
        <div className={styles.main}>
          {chosen === undefined ? <EmptyState icon="ontology" title="Choose an element">Every object type, link type, shared property, interface and function in {branchId === undefined ? 'main' : 'the branch'}.</EmptyState> : (
            <Section title={<span className={styles.row}>{chosen.name}<Badge tone={ELEMENT_STATUS[chosen.status].tone}>{ELEMENT_STATUS[chosen.status].label}</Badge></span>}
              description={<>{KIND[chosen.kind].one}, <span className={styles.mono}>{chosen.apiName}</span></>}
              actions={onBranch ? <Button icon="edit" onClick={() => set({ edit: '1' })}>Edit</Button> : branchId === undefined && chosen.status !== 'retired' ? (
                <span className={styles.row}>
                  {chosen.status === 'active' ? <Button variant="ghost" blocked={permits('deprecateOntologyElement')} onClick={() => setDeprecating(true)}>Deprecate</Button> : null}
                  {chosen.status === 'deprecated' ? <Button variant="ghost" blocked={permits('retireOntologyElement') ?? (chosen.retireAfter !== undefined && Date.parse(chosen.retireAfter) > Date.now() ? 'It may be retired only from its retirement date' : undefined)}
                    onClick={() => setRetiring(true)}>Retire</Button> : null}
                </span>
              ) : undefined}>
              <ElementView key={chosen.id} element={chosen} manifest={manifest} elements={elements} />
            </Section>
          )}
        </div>
      </div>
      {newKind !== null && !onBranch ? <ChooseBranchDialog open onClose={close} /> : null}
      {onBranch && branchId !== undefined ? (
        <>
          {newKind === 'object-type' || (editing && chosen?.kind === 'object_type')
            ? <ObjectTypeEditor branchId={branchId} headVersionId={head} manifest={manifest} type={newKind === 'object-type' ? undefined : manifest.objectTypes.find((t) => t.id === chosen?.id)} open onClose={close} /> : null}
          {newKind === 'link-type' || (editing && chosen?.kind === 'link_type')
            ? <LinkTypeEditor branchId={branchId} headVersionId={head} manifest={manifest} link={newKind === 'link-type' ? undefined : manifest.linkTypes.find((l) => l.id === chosen?.id)} open onClose={close} /> : null}
          {newKind === 'shared-property' || (editing && chosen?.kind === 'shared_property')
            ? <SharedPropertyEditor branchId={branchId} headVersionId={head} existing={newKind === 'shared-property' ? undefined : manifest.sharedProperties.find((s) => s.id === chosen?.id)} open onClose={close} /> : null}
          {newKind === 'interface' || (editing && chosen?.kind === 'interface')
            ? <InterfaceEditor branchId={branchId} headVersionId={head} manifest={manifest} existing={newKind === 'interface' ? undefined : manifest.interfaces.find((i) => i.id === chosen?.id)} open onClose={close} /> : null}
          {newKind === 'function' || (editing && chosen?.kind === 'function')
            ? <FunctionEditor branchId={branchId} headVersionId={head} manifest={manifest} existing={newKind === 'function' ? undefined : manifest.functions.find((f) => f.id === chosen?.id)} open onClose={close} /> : null}
        </>
      ) : null}
      {chosen !== undefined && deprecating ? <DeprecateDialog element={chosen} elements={elements} open onClose={() => setDeprecating(false)} /> : null}
      {chosen !== undefined ? (
        <ConfirmDialog open={retiring} onClose={() => setRetiring(false)} title={`Retire ${chosen.name}?`} confirmLabel="Retire" tone="danger" typeToConfirm={chosen.apiName}
          onConfirm={async () => {
            const r = await retire.run({ params: { kind: chosen.kind, elementId: chosen.id } });
            if (r.ok) say(`${chosen.name} retired from the new version`);
            return r;
          }}>
          <p>It leaves the vocabulary of the new main version. Earlier versions keep it, so a receipt or a saved answer that used it still reads.</p>
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}
