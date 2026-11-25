'use client';

// Support tickets (U4): raising one, following its replies, answering and closing it. Shown in
// the header's ticket panel (compact) and on the support page. A ticket carries references and
// the person's own words, never a record value (spec 8.5): the form warns as they type when
// something looks like a value, and the server refuses it. A failure the person was looking at
// (its correlation id) and the page they were on travel with the ticket, so support can find it.

import { usePathname } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge, type Tone } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { ConfirmDialog } from '../../components/dialog.component.tsx';
import { fieldError, FormActions, SelectField, TextArea, TextField } from '../../components/field.component.tsx';
import { Icon } from '../../components/icon.component.tsx';
import { PagesView, QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { type TabDef, TabPanel, Tabs } from '../../components/tabs.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useMutation, usePages, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { placeOf, trailOf } from '../../navigation/places.navigation.ts';
import { valueWarning } from '../../utils/values.util.ts';
import styles from './tickets.view.module.css';

type Ticket = Output<'listSupportTickets'>['tickets'][number];
type Category = NonNullable<Input<'raiseSupportTicket'>['body']>['category'];
type Severity = NonNullable<NonNullable<Input<'raiseSupportTicket'>['body']>['severity']>;

export const STATUS: Record<Ticket['status'], { label: string; tone: Tone }> = {
  waiting_on_silo: { label: 'With Silo support', tone: 'info' },
  waiting_on_customer: { label: 'Waiting on you', tone: 'warn' },
  resolved: { label: 'Resolved', tone: 'ok' },
  closed: { label: 'Closed', tone: 'neutral' },
};

const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'problem', label: 'Something is not working' }, { value: 'question', label: 'A question about Silo' },
  { value: 'access', label: 'Signing in or access' }, { value: 'billing', label: 'Billing' },
  { value: 'feature', label: 'An idea or a request' }, { value: 'security', label: 'A security concern' },
];
const SEVERITIES: { value: Severity; label: string }[] = [
  { value: 'low', label: 'Low: when there is time' }, { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High: work is held up' }, { value: 'urgent', label: 'Urgent: something important has stopped' },
];

export function TicketList({ onOpen, onNew, current }: { onOpen: (ticketId: string) => void; onNew: () => void; current?: string | undefined }) {
  const [state, setState] = useState<'open' | 'done'>('open');
  const tabs: TabDef<'open' | 'done'>[] = [{ id: 'open', label: 'Open' }, { id: 'done', label: 'Resolved and closed' }];
  const pages = usePages('listSupportTickets', (cursor) => ({ query: { state, limit: 30, ...(cursor === undefined ? {} : { cursor }) } }), (p) => p.nextCursor, [state]);
  const seesAll = pages.pages[0]?.seesAll === true;
  const people = useDirectory();
  return (
    <div className={styles.list}>
      <div className={styles.listHead}>
        <Button variant="primary" icon="plus" onClick={onNew}>New ticket</Button>
        <span className={styles.muted}>{seesAll ? 'Your organisation\'s tickets' : 'Your tickets'}</span>
      </div>
      <Tabs label="Tickets" tabs={tabs} current={state} onChange={setState} />
      <TabPanel id={state}>
        <PagesView pages={pages} what="Your tickets" isEmpty={(p) => p.every((x) => x.tickets.length === 0)}
          empty={<EmptyState icon="ticket" title={state === 'open' ? 'No open tickets' : 'Nothing resolved yet'}>Raise one whenever something is not as it should be.</EmptyState>}>
          {(list) => (
            <ul className={styles.items}>
              {list.flatMap((p) => p.tickets).map((t) => (
                <li key={t.id}>
                  <button type="button" className={styles.item} aria-current={t.id === current ? 'true' : undefined} onClick={() => onOpen(t.id)}>
                    <span className={styles.itemTop}>
                      <span className={styles.subject}>{t.subject}</span>
                      <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>
                    </span>
                    <span className={styles.muted}>
                      {t.reference} · <Time value={t.lastMessageAt} />{seesAll ? ` · ${people.nameOf(t.raisedByMembershipId)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PagesView>
      </TabPanel>
    </div>
  );
}

export function NewTicket({ correlationId, route, onRaised, onCancel }: {
  correlationId?: string | undefined;
  route?: string | undefined;
  onRaised: (ticketId: string) => void;
  onCancel: () => void;
}) {
  const pathname = usePathname();
  const where = placeOf(pathname);
  const raise = useMutation('raiseSupportTicket');
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<Category>(correlationId === undefined ? 'question' : 'problem');
  const [severity, setSeverity] = useState<Severity>('normal');
  const [body, setBody] = useState('');
  const [withPage, setWithPage] = useState(true);
  const warning = valueWarning(`${subject}\n${body}`);
  const place = withPage && /^\/[a-z0-9/_-]{0,199}$/.test(pathname) ? pathname : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const outcome = await raise.run({
      body: {
        subject: subject.trim(), category, severity, body: body.trim(), ...(place === undefined ? {} : { place }),
        correlationIds: correlationId === undefined ? [] : [correlationId],
      },
    });
    if (outcome.ok) onRaised(outcome.data.ticket.id);
  };

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)}>
      <Banner tone="info" title="Describe it, never paste data">
        Silo support never needs your records. Say what happened and what you expected; name things as they are named in Silo.
      </Banner>
      {correlationId !== undefined ? (
        <p className={styles.attached}><Icon name="link" size={14} /> The failure you saw is attached: reference <code>{correlationId}</code>{route !== undefined ? ` (${route})` : ''}.</p>
      ) : null}
      <SelectField label="What is it about?" value={category} onChange={(e) => setCategory(e.target.value as Category)} options={CATEGORIES} />
      <TextField label="Subject" required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus
        error={fieldError(raise.error, 'subject')} />
      <TextArea label="What happened, and what did you expect?" required rows={6} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)}
        error={fieldError(raise.error, 'body')} />
      {warning !== undefined ? <Banner tone="warn" urgent>{warning}</Banner> : null}
      <SelectField label="How much does it hold you up?" value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} options={SEVERITIES} />
      {where !== undefined ? (
        <label className={styles.check}>
          <input type="checkbox" checked={withPage} onChange={(e) => setWithPage(e.target.checked)} />
          <span>Say it was raised from {trailOf(where).join(' › ')}</span>
        </label>
      ) : null}
      {raise.error !== undefined && fieldError(raise.error, 'subject') === undefined && fieldError(raise.error, 'body') === undefined ? <ErrorMessage error={raise.error} /> : null}
      <FormActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" icon="send" pending={raise.pending} blocked={raise.blocked}
          disabled={subject.trim() === '' || body.trim() === '' || warning !== undefined}>Send to Silo support</Button>
      </FormActions>
    </form>
  );
}

export function TicketView({ ticketId, onBack }: { ticketId: string; onBack?: (() => void) | undefined }) {
  const ticket = useQuery('readSupportTicket', { params: { ticketId } }, { refreshMs: 60_000 });
  const reply = useMutation('replyToSupportTicket');
  const close = useMutation('closeSupportTicket');
  const people = useDirectory();
  const [text, setText] = useState('');
  const [closing, setClosing] = useState(false);
  useEffect(() => setText(''), [ticketId]);
  const warning = valueWarning(text);
  return (
    <QueryView query={ticket} what="The ticket">
      {({ ticket: t, messages }) => (
        <div className={styles.ticket}>
          <div className={styles.ticketHead}>
            {onBack !== undefined ? <Button size="sm" variant="ghost" icon="arrowLeft" onClick={onBack}>All tickets</Button> : null}
            <h3 className={styles.ticketTitle}>{t.subject}</h3>
            <span className={styles.meta}>
              <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>
              <span>{t.reference}</span>
              <span>Raised <Time value={t.createdAt} /> by {people.nameOf(t.raisedByMembershipId)}</span>
              {t.assignedTo !== null ? <span>Looked after by {t.assignedTo}</span> : null}
            </span>
          </div>
          <ol className={styles.messages}>
            {messages.map((m) => (
              <li key={m.id} className={m.authorKind === 'staff' ? styles.staff : styles.member}>
                <span className={styles.author}>{m.authorKind === 'staff' ? `${m.authorName ?? 'Silo support'}, Silo support` : people.nameOf(m.authorMembershipId)} · <Time value={m.createdAt} /></span>
                <p className={styles.body}>{m.body}</p>
              </li>
            ))}
          </ol>
          {t.status === 'closed' ? <p className={styles.muted}>This ticket is closed. Raise a new one if you need more help.</p> : (
            <form className={styles.form} onSubmit={(e) => {
              e.preventDefault();
              if (text.trim() === '' || warning !== undefined) return;
              void reply.run({ params: { ticketId }, body: { body: text.trim(), version: t.version } }).then((r) => r.ok && setText(''));
            }}>
              <TextArea label={t.status === 'waiting_on_customer' ? 'Your answer' : 'Add to the ticket'} rows={3} maxLength={4000} value={text}
                onChange={(e) => setText(e.target.value)} error={fieldError(reply.error, 'body')} />
              {warning !== undefined ? <Banner tone="warn" urgent>{warning}</Banner> : null}
              {reply.error !== undefined && fieldError(reply.error, 'body') === undefined ? <ErrorMessage error={reply.error} onRetry={ticket.refetch} /> : null}
              <FormActions>
                <Button variant="ghost" onClick={() => setClosing(true)} blocked={close.blocked}>Close the ticket</Button>
                <Button type="submit" variant="primary" icon="send" pending={reply.pending} blocked={reply.blocked} disabled={text.trim() === '' || warning !== undefined}>
                  {t.status === 'resolved' ? 'Reopen with this' : 'Send'}
                </Button>
              </FormActions>
            </form>
          )}
          <ConfirmDialog open={closing} onClose={() => setClosing(false)} title="Close this ticket?" confirmLabel="Close it"
            onConfirm={() => close.run({ params: { ticketId }, body: { version: t.version } })}>
            <p>Closing it tells support you need nothing more. A closed ticket cannot be reopened; raise a new one if you do.</p>
          </ConfirmDialog>
        </div>
      )}
    </QueryView>
  );
}

/** How many of the person's tickets wait on them: the header icon's count. */
export function useTicketsWaiting(): number | undefined {
  const list = useQuery('listSupportTickets', { query: { state: 'open', limit: 1 } }, { refreshMs: 120_000, staleMs: 60_000 });
  return list.data?.waitingOnYou;
}
