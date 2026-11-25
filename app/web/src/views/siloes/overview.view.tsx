'use client';

// Siloes (Part X): the optional storage an organisation turns on, and only then. Every Silo says
// what it keeps, where, for how long and why, and that it can be wiped; its size as last measured;
// and how Siloes connect (holding the same type, or types linked to each other). A Silo opens with
// its retention (changed here), its kind's own page, and its purges. A new Capture, Import or
// Object Index Silo is made here; the Warehouse is made on its own page.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button, LinkButton } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage, Loading } from '../../components/states.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, useQuery } from '../../data/query.data.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useVocabulary } from '../../hooks/vocabulary.hook.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { plural } from '../../utils/format.util.ts';
import { hrefWith } from '../../utils/href.util.ts';
import { idFrom } from '../studio/kit.view.tsx';
import { PurgeDialog } from './purges.view.tsx';
import { bytesOf, KIND, STATUS, type Silo, type SiloKind } from './words.view.ts';
import styles from './siloes.view.module.css';

export const siloHref = (siloId: string) => hrefWith('/siloes/overview/', { silo: siloId });

/** The Silo a page acts on, from ?silo=, chosen among those of its kind; the only one is chosen for the person. */
export function useSiloChoice(kind?: SiloKind): { silo: Silo | undefined; picker: ReactNode; none: boolean } {
  const [params, set] = useParams();
  const list = useQuery('listSiloes', { query: {} });
  const candidates = (list.data?.siloes ?? []).filter((s) => (kind === undefined || s.kind === kind) && s.status !== 'disabled');
  const asked = params.get('silo');
  const silo = candidates.find((s) => s.id === asked) ?? (candidates.length === 1 ? candidates[0] : undefined);
  const none = list.data !== undefined && candidates.length === 0;
  const picker = list.data === undefined ? (list.status === 'error' ? <ErrorMessage error={list.error} onRetry={list.refetch} /> : <Loading label="Reading your Siloes" block={false} />)
    : candidates.length <= 1 ? null : (
      <div className={styles.rowEnd}>
        <SelectField label="Silo" value={silo?.id ?? ''} placeholder="Choose a Silo" onChange={(e) => set({ silo: e.target.value || undefined })}
          options={candidates.map((s) => ({ value: s.id, label: `${s.name} (${KIND[s.kind].label})` }))} />
      </div>
    );
  return { silo, picker, none };
}

/** /siloes/overview/: every Silo, or one. */
export function Overview() {
  const [params] = useParams();
  const open = params.get('silo');
  if (open !== null) {
    const id = idFrom(open);
    if (id !== undefined) return <SiloPage key={id} siloId={id} />;
  }
  return <AllSiloes />;
}

function AllSiloes() {
  const { lookup } = useVocabulary();
  const [params, set] = useParams();
  const setting = useQuery('getSiloesSetting', {});
  const enable = useMutation('setSiloesEnabled', { invalidates: ['getSiloesSetting', 'listSiloes', 'getSiloesWeb'] });
  const web = useQuery('getSiloesWeb', {});
  usePageContext({ scope: { kind: 'page', page: 'siloes' }, scopeLabel: 'Siloes' });
  const enabled = setting.data?.enabled === true;
  const nameOf = (id: string) => web.data?.siloes.find((s) => s.id === id)?.name ?? 'a Silo';
  return (
    <Page title="Siloes" description="What Silo keeps for you, where, for how long and why. Every Silo can be wiped."
      actions={enabled ? <Button variant="primary" icon="plus" onClick={() => set({ new: '1' })}>New Silo</Button> : undefined}>
      <div className={styles.stack}>
        {setting.data !== undefined ? (
          enabled ? <p className={styles.muted}>{setting.data.disclosure}</p> : (
            <Banner tone="info" title="Siloes are off" action={
              <Button variant="primary" pending={enable.pending} blocked={enable.blocked} onClick={() => void enable.run({ body: { enabled: true } })}>Turn Siloes on</Button>
            }>{setting.data.disclosure} They can be turned off again in Settings.</Banner>
          )
        ) : setting.error !== undefined ? <ErrorMessage error={setting.error} onRetry={setting.refetch} /> : null}
        {enable.error !== undefined ? <ErrorMessage error={enable.error} /> : null}
        <QueryView query={web} what="Siloes" isEmpty={(d) => d.siloes.length === 0}
          empty={<EmptyState icon="siloes" title="No Silo yet">{enabled ? 'A Silo keeps history, uploaded files, a search copy or an analysis copy, for as long as you say.' : 'Turn Siloes on first.'}</EmptyState>}>
          {(d) => (
            <ul className={styles.cards} aria-label="Siloes">
              {d.siloes.map((s) => {
                const links = d.links.filter((l) => l.from === s.id || l.to === s.id);
                return (
                  <li key={s.id} className={styles.card}>
                    <div className={styles.cardHead}>
                      <Link href={siloHref(s.id) as never}><strong>{s.name}</strong></Link>
                      <Badge>{KIND[s.kind].label}</Badge>
                      <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                    </div>
                    <span>{s.purpose}</span>
                    <span className={styles.muted}>Kept {plural(s.retentionDays, 'day')} in {s.location}{s.size !== null ? `; ${bytesOf(s.size.bytes)}` : ''}{s.lastUpdatedAt !== null ? '; last updated ' : ''}{s.lastUpdatedAt !== null ? <Time value={s.lastUpdatedAt} /> : null}</span>
                    {s.heldTypeIds.length > 0 ? <span className={styles.muted}>Holds {s.heldTypeIds.map((id) => lookup?.typeName(id, true) ?? 'a type').join(', ')}</span> : null}
                    {links.length > 0 ? (
                      <span className={styles.muted}>Connected to {links.map((l) => `${nameOf(l.from === s.id ? l.to : l.from)} (${l.why.map((w) => (w === 'same_type' ? 'same type' : 'linked types')).join(', ')})`).join('; ')}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </QueryView>
      </div>
      {params.get('new') !== null && enabled ? <NewSilo onClose={() => set({ new: undefined })} /> : null}
    </Page>
  );
}

function NewSilo({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const capture = useMutation('createCaptureSilo', { invalidates: ['listSiloes', 'getSiloesWeb'] });
  const imports = useMutation('createImportSilo', { invalidates: ['listSiloes', 'getSiloesWeb'] });
  const index = useMutation('createObjectIndex', { invalidates: ['listSiloes', 'getSiloesWeb'] });
  const [kind, setKind] = useState<'capture' | 'import' | 'object_index'>('capture');
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [retention, setRetention] = useState('365');
  const pending = capture.pending || imports.pending || index.pending;
  const error = capture.error ?? imports.error ?? index.error;
  return (
    <Dialog open onClose={onClose} title="New Silo" size="md" busy={pending} description="It keeps only what you choose, where your organisation's cell is, for as long as you say, and can be wiped.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const body = { name: name.trim(), purpose: purpose.trim(), retentionDays: Math.max(1, Math.min(36_500, Number(retention) || 365)) };
        const r = kind === 'capture' ? await capture.run({ body }) : kind === 'import' ? await imports.run({ body }) : await index.run({ body });
        if (r.ok) router.push(hrefWith(KIND[kind].href, { silo: r.data.id }) as never);
      }}>
        <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}
          options={(['capture', 'import', 'object_index'] as const).map((k) => ({ value: k, label: `${KIND[k].label}: ${KIND[k].what}` }))}
          hint="The Warehouse is made on its own page, with what it copies." />
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        <TextArea label="What it is for" required rows={2} maxLength={2000} value={purpose} onChange={(e) => setPurpose(e.target.value)} hint="Shown with it everywhere, so everyone knows why it keeps what it keeps." />
        <TextField label="Keep for (days)" required type="number" min={1} max={36_500} value={retention} onChange={(e) => setRetention(e.target.value)} />
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={pending} disabled={name.trim() === '' || purpose.trim() === ''}>Make the Silo</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function SiloPage({ siloId }: { siloId: string }) {
  const say = useToast();
  const { lookup } = useVocabulary();
  const read = useQuery('getSilo', { params: { siloId } });
  const change = useMutation('changeRetention', { invalidates: ['getSilo', 'listSiloes', 'getSiloesWeb'] });
  const [retention, setRetention] = useState('');
  const [purging, setPurging] = useState(false);
  const s = read.data;
  useEffect(() => {
    if (s !== undefined) setRetention(String(s.retentionDays));
  }, [s?.retentionDays]);
  usePageContext({ scope: { kind: 'page', page: 'siloes' }, scopeLabel: s?.name ?? 'a Silo' });
  if (s === undefined) return <Page title="Silo" crumbs={[{ label: 'Siloes', href: '/siloes/overview/' }]}><QueryView query={read} what="The Silo">{() => null}</QueryView></Page>;
  return (
    <Page title={s.name} documentTitle={s.name} description={s.purpose} crumbs={[{ label: 'Siloes', href: '/siloes/overview/' }]}
      meta={<span className={styles.row}><Badge>{KIND[s.kind].label}</Badge><Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge></span>}
      actions={
        <div className={styles.row}>
          <LinkButton href={hrefWith(KIND[s.kind].href, { silo: s.id })}>Open its {KIND[s.kind].label} page</LinkButton>
          <Button variant="danger" icon="trash" onClick={() => setPurging(true)}>Purge…</Button>
        </div>
      }>
      <div className={styles.stack}>
        <p className={styles.muted}>{s.disclosure}</p>
        <Panel>
          <Properties items={[
            ['It', KIND[s.kind].what],
            ['Where', s.location],
            ['Kept for', plural(s.retentionDays, 'day')],
            ['Size', s.size === null ? 'Not measured yet' : <span key="z">{bytesOf(s.size.bytes)}, measured <Time value={s.size.measuredAt} /></span>],
            ['Made', <Time key="m" value={s.createdAt} exact />],
            s.store !== null ? ['Store', s.store] : null,
            s.kind !== 'import' ? ['Action ledger', s.actionLedger === 'off' ? 'Off' : s.actionLedger === 'references' ? 'References only' : 'With values'] : null,
          ]} />
        </Panel>
        {s.objectTypes.length > 0 ? (
          <Section title="What it holds">
            <ul className={styles.plainList}>{s.objectTypes.map((t) => <li key={t.objectTypeId}>{lookup?.typeName(t.objectTypeId, true) ?? 'A type'}: {t.properties.length === 0 ? 'every property' : t.properties.join(', ')}</li>)}</ul>
          </Section>
        ) : null}
        <Section title="Retention" description="How long it keeps what it holds. Shorter, what is older is removed at the next sweep.">
          <form className={styles.rowEnd} onSubmit={async (e) => {
            e.preventDefault();
            const r = await change.run({ params: { siloId }, body: { retentionDays: Math.max(1, Math.min(36_500, Number(retention) || s.retentionDays)) } });
            if (r.ok) say(`Kept for ${plural(r.data.retentionDays, 'day')} now`);
          }}>
            <TextField label="Keep for (days)" type="number" min={1} max={36_500} value={retention} onChange={(e) => setRetention(e.target.value)} />
            <Button type="submit" pending={change.pending} blocked={change.blocked} disabled={Number(retention) === s.retentionDays}>Change retention</Button>
          </form>
          {change.error !== undefined ? <ErrorMessage error={change.error} /> : null}
        </Section>
        <Section title="Purges" actions={<LinkButton size="sm" variant="link" href={hrefWith('/siloes/purges/', { silo: s.id })}>Its purges and receipts</LinkButton>}>
          <p className={styles.muted}>A purge is previewed first, approved where your organisation asks for it, and leaves a receipt.</p>
        </Section>
      </div>
      {purging ? <PurgeDialog silo={s} onClose={() => setPurging(false)} /> : null}
    </Page>
  );
}

