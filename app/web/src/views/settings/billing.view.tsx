'use client';

// Billing (spec 71–74): the plan and what it entitles the organisation to, its invoices, changing
// the plan at the payment provider's checkout and managing payment in its portal; buying tokens
// (in hundreds, never expiring) and simulations; every token spent, by whom and on what; each
// member's allowance this period and whether it tops itself up; and enterprise contracts with
// how much of their allocation is used.

import { useState } from 'react';
import type { Input, Output } from '../../api/client.api.ts';
import { Badge, type Tone } from '../../components/badge.component.tsx';
import { Banner } from '../../components/banner.component.tsx';
import { Button } from '../../components/button.component.tsx';
import { Dialog } from '../../components/dialog.component.tsx';
import { FormActions, RadioGroup, SelectField, Switch, TextField } from '../../components/field.component.tsx';
import { Page, Panel, Properties, Section, Toolbar } from '../../components/page.component.tsx';
import { PagesView, QueryView } from '../../components/query.component.tsx';
import { EmptyState, ErrorMessage } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useToast } from '../../components/toast.component.tsx';
import { useMutation, usePages, useQuery } from '../../data/query.data.ts';
import { useDirectory } from '../../hooks/directory.hook.ts';
import { useParams } from '../../hooks/params.hook.ts';
import { useWorkspace } from '../../shell/context.shell.tsx';
import { formatBytes, humanise } from '../../utils/format.util.ts';
import styles from './settings.view.module.css';

type Billing = Output<'readBilling'>;
type Plan = NonNullable<Input<'startCheckout'>['body']>['plan'];
type Term = NonNullable<Input<'startCheckout'>['body']>['term'];
const crumbs = [{ label: 'Settings', href: '/settings/' }];
const STATUS: Record<Billing['billingStatus'], { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'ok' }, past_due: { label: 'Payment overdue', tone: 'warn' }, suspended: { label: 'Suspended', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
const INVOICE: Record<Billing['invoices'][number]['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' }, open: { label: 'Open', tone: 'info' }, overdue: { label: 'Overdue', tone: 'danger' }, paid: { label: 'Paid', tone: 'ok' }, void: { label: 'Void', tone: 'neutral' },
};
const DISCOUNT: Record<NonNullable<Billing['subscription']>['discountTier'], string> = {
  list: 'List price', tier_25_99: '25 to 99 seats', tier_100_249: '100 to 249 seats', tier_250_499: '250 to 499 seats', quoted: 'Quoted',
};
const money = (amount: string, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));
const count = (n: number | string) => Number(n).toLocaleString();

/** /settings/billing/: the plan, its entitlement, invoices, checkout, the portal and purchases. */
export function Billing() {
  const say = useToast();
  const read = useQuery('readBilling', {});
  const portal = useMutation('openBillingPortal');
  const [changing, setChanging] = useState(false);
  const [buying, setBuying] = useState(false);
  return (
    <Page title="Plan and invoices" description="Your plan, what it gives your organisation, and what you have been charged." crumbs={crumbs} width="full"
      actions={
        <div className={styles.row}>
          <Button blocked={portal.blocked} pending={portal.pending} onClick={() => void portal.run({}).then((r) => {
            if (r.ok) window.location.assign(r.data.portalUrl);
          })}>Payment details</Button>
          <Button onClick={() => setBuying(true)}>Buy tokens or simulations</Button>
          <Button variant="primary" onClick={() => setChanging(true)}>Change plan</Button>
        </div>
      }>
      <QueryView query={read} what="Billing">
        {(b) => (
          <div className={styles.stack}>
            {portal.error !== undefined ? <ErrorMessage error={portal.error} /> : null}
            {b.billingStatus === 'past_due' ? <Banner tone="warn" title="Payment is overdue">Update your payment details to keep everything running.</Banner> : null}
            {b.billingStatus === 'suspended' ? <Banner tone="danger" urgent title="Your organisation is suspended">Its data is safe and can be exported; Actions, Crons and connections are paused until payment is made.</Banner> : null}
            <Section title="Plan">
              <Panel>
                {b.subscription === null ? <p className={styles.muted}>No subscription: your organisation is billed under a contract or sovereign terms.</p> : (
                  <Properties columns={3} items={[
                    ['Plan', humanise(b.subscription.plan)],
                    ['State', <Badge key="s" tone={STATUS[b.billingStatus].tone}>{STATUS[b.billingStatus].label}</Badge>],
                    ['Seats', count(b.subscription.seatCount)],
                    ['Billed', b.subscription.term === 'annual' ? 'Yearly' : 'Monthly'],
                    ['Price', DISCOUNT[b.subscription.discountTier]],
                    ['This period', <span key="p"><Time value={b.subscription.currentPeriodStart} /> to <Time value={b.subscription.currentPeriodEnd} /></span>],
                  ]} />
                )}
              </Panel>
            </Section>
            {b.entitlement !== null ? (
              <Section title="What it gives you" description={`From ${b.entitlement.source === 'subscription' ? 'your subscription' : b.entitlement.source === 'contract' ? 'your contract' : 'your sovereign terms'}.`}>
                <Panel>
                  <Properties columns={3} items={[
                    ['Seats', count(b.entitlement.seats)],
                    ['Tokens a seat each period', count(b.entitlement.tokensPerSeatPeriod)],
                    ['Simulations a seat each period', count(b.entitlement.simulationsPerSeatPeriod)],
                    ['Tokens a person a day', count(b.entitlement.dailyTokenLimit)],
                    ['Storage included', formatBytes(Number(b.entitlement.storageIncludedBytes))],
                    ['Connections', b.entitlement.connectionsLimit === null ? 'No limit' : count(b.entitlement.connectionsLimit)],
                    ['Also', b.entitlement.capabilities.length === 0 ? '—' : b.entitlement.capabilities.map((c) => humanise(c)).join(', ')],
                    ['Since', <Time key="f" value={b.entitlement.effectiveFrom} />],
                  ]} />
                </Panel>
              </Section>
            ) : null}
            <Section title="Invoices">
              {b.invoices.length === 0 ? <p className={styles.muted}>No invoices yet.</p> : (
                <DataTable label="Invoices" rows={b.invoices} rowKey={(i) => i.id} columns={[
                  { id: 'period', header: 'For', primary: true, cell: (i) => i.periodCovered },
                  { id: 'amount', header: 'Amount', align: 'end', cell: (i) => money(i.amount, i.currency), sortValue: (i) => Number(i.amount) },
                  { id: 'due', header: 'Due', cell: (i) => <Time value={i.dueDate} />, sortValue: (i) => i.dueDate },
                  { id: 'state', header: 'State', width: 'sm', cell: (i) => <Badge tone={INVOICE[i.status].tone}>{INVOICE[i.status].label}</Badge> },
                  { id: 'paid', header: 'Paid', cell: (i) => (i.paidAt !== null ? <Time value={i.paidAt} /> : '—') },
                ]} />
              )}
              <p className={styles.muted}>Invoices to download, and receipts, are in Payment details.</p>
            </Section>
          </div>
        )}
      </QueryView>
      {changing ? <ChangePlan current={read.data?.subscription ?? null} onClose={() => setChanging(false)} /> : null}
      {buying ? <Buy onClose={() => setBuying(false)} onBought={(text) => say(text)} /> : null}
    </Page>
  );
}

function ChangePlan({ current, onClose }: { current: Billing['subscription']; onClose: () => void }) {
  const checkout = useMutation('startCheckout');
  const [plan, setPlan] = useState<Plan>(current?.plan ?? 'standard');
  const [term, setTerm] = useState<Term>(current?.term ?? 'annual');
  const [seats, setSeats] = useState(String(current?.seatCount ?? 5));
  return (
    <Dialog open onClose={onClose} title="Change plan" size="sm" busy={checkout.pending} description="You finish at the payment provider's checkout and come back here; nothing changes until you do.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = await checkout.run({ body: { plan, term, seats: Math.max(1, Number(seats) || 1) } });
        if (r.ok) window.location.assign(r.data.checkoutUrl);
      }}>
        <RadioGroup label="Plan" name="plan" value={plan} onChange={setPlan} options={[{ value: 'standard', label: 'Standard' }, { value: 'business', label: 'Business' }]} />
        <RadioGroup label="Billed" name="term" value={term} onChange={setTerm} options={[{ value: 'annual', label: 'Yearly' }, { value: 'monthly', label: 'Monthly' }]} />
        <TextField label="Seats" type="number" min={1} required value={seats} onChange={(e) => setSeats(e.target.value)} hint="Larger organisations pay less a seat." />
        {checkout.error !== undefined ? <ErrorMessage error={checkout.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={checkout.pending} blocked={checkout.blocked}>Go to checkout</Button></FormActions>
      </form>
    </Dialog>
  );
}

function Buy({ onClose, onBought }: { onClose: () => void; onBought: (text: string) => void }) {
  const people = useDirectory();
  const { session } = useWorkspace();
  const buy = useMutation('purchase', { invalidates: ['readBilling', 'readMemberAllowance', 'listTokenLedger'] });
  const [kind, setKind] = useState<'tokens' | 'simulations'>('tokens');
  const [quantity, setQuantity] = useState('500');
  const [beneficiary, setBeneficiary] = useState(session.membershipId);
  const n = Number(quantity) || 0;
  const tokensValid = n >= 100 && n % 100 === 0 && n <= 100_000;
  const valid = kind === 'tokens' ? tokensValid : n >= 1 && n <= 1_000;
  return (
    <Dialog open onClose={onClose} title="Buy tokens or simulations" size="sm" busy={buy.pending} description="Charged now to your organisation's payment method. What you buy never expires.">
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        const r = await buy.run({ body: { kind, quantity: n, ...(beneficiary !== session.membershipId ? { beneficiaryMembershipId: beneficiary } : {}) } });
        if (r.ok) {
          onBought(`Bought ${count(r.data.quantity)} ${r.data.kind} for ${money(r.data.amount, r.data.currency)}`);
          onClose();
        }
      }}>
        <RadioGroup label="What" name="kind" value={kind} onChange={(k) => { setKind(k); setQuantity(k === 'tokens' ? '500' : '10'); }}
          options={[{ value: 'tokens', label: 'Tokens, £20 a hundred' }, { value: 'simulations', label: 'Simulations, at your agreed price' }]} />
        <TextField label="How many" type="number" required min={kind === 'tokens' ? 100 : 1} max={kind === 'tokens' ? 100_000 : 1_000} step={kind === 'tokens' ? 100 : 1}
          value={quantity} onChange={(e) => setQuantity(e.target.value)}
          error={quantity !== '' && !valid ? (kind === 'tokens' ? 'Tokens are bought in hundreds, up to 100,000' : 'From 1 to 1,000 at once') : undefined}
          hint={kind === 'tokens' && tokensValid ? `£${count((n / 100) * 20)}` : undefined} />
        <SelectField label="For" value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)}
          options={people.members.filter((m) => m.status === 'active').map((m) => ({ value: m.membershipId, label: m.membershipId === session.membershipId ? `${m.displayName} (you)` : m.displayName }))} />
        {buy.error !== undefined ? <ErrorMessage error={buy.error} /> : null}
        <FormActions><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" pending={buy.pending} blocked={buy.blocked} disabled={!valid}>Buy</Button></FormActions>
      </form>
    </Dialog>
  );
}

type Entry = Output<'listTokenLedger'>['transactions'][number];
const OPERATION: Record<Entry['operation'], string> = {
  compile: 'Ask', advanced_compile: 'Ask, advanced', connector_generation: 'Making a connector', document_extraction: 'Reading a document',
  repair_proposal: 'Proposing a repair', simulation: 'A simulation', simulation_rerun: 'A simulation run again',
};

/** /settings/tokens/: every token and simulation spent, and each member's allowance this period. */
export function Tokens() {
  const people = useDirectory();
  const [params, set] = useParams();
  const member = params.get('member') ?? '';
  const pages = usePages('listTokenLedger', (cursor) => ({ query: {
    limit: 100, ...(member !== '' ? { membershipId: member } : {}), ...(cursor !== undefined ? JSON.parse(cursor) as { beforeOccurredAt: string; beforeId: string } : {}),
  } }), (p) => (p.next === null ? null : JSON.stringify(p.next)), [member]);
  return (
    <Page title="Tokens and allowances" description="What each person may use this period, what they have used, and every charge, by whom and on what." crumbs={crumbs} width="full">
      <div className={styles.stack}>
        <Toolbar>
          <SelectField label="Person" value={member} placeholder="Everyone" onChange={(e) => set({ member: e.target.value === '' ? undefined : e.target.value })}
            options={people.members.map((m) => ({ value: m.membershipId, label: m.displayName }))} />
        </Toolbar>
        {member !== '' ? <Allowance key={member} membershipId={member} /> : null}
        <Section title="Charges">
          <PagesView pages={pages} what="The token ledger" isEmpty={(ps) => ps.every((p) => p.transactions.length === 0)} empty={<EmptyState icon="chart" title="Nothing charged yet">Tokens are charged when Ask, documents, connectors, repairs and simulations use a model.</EmptyState>}>
            {(ps) => (
              <DataTable label="Charges" rows={ps.flatMap((p) => p.transactions)} rowKey={(t) => t.id} columns={[
                { id: 'when', header: 'When', primary: true, cell: (t) => <Time value={t.occurredAt} exact /> },
                { id: 'who', header: 'Person', cell: (t) => (t.membershipId !== null ? <button type="button" className={styles.linkButton} onClick={() => set({ member: t.membershipId! })}>{people.nameOf(t.membershipId)}</button> : 'Silo, for your organisation') },
                { id: 'what', header: 'On', cell: (t) => OPERATION[t.operation] },
                { id: 'weight', header: 'Charged', align: 'end', cell: (t) => `${t.weight} ${t.pool === 'tokens' ? 'tokens' : 'simulations'}` },
                { id: 'from', header: 'From', cell: (t) => humanise(t.source) },
              ]} />
            )}
          </PagesView>
        </Section>
      </div>
    </Page>
  );
}

function Allowance({ membershipId }: { membershipId: string }) {
  const say = useToast();
  const people = useDirectory();
  const read = useQuery('readMemberAllowance', { params: { membershipId } });
  const topup = useMutation('setAutoTopup', { invalidates: ['readMemberAllowance'] });
  return (
    <Section title={`${people.nameOf(membershipId)} this period`}>
      <QueryView query={read} what="Their allowance">
        {(a) => (
          <Panel>
            <div className={styles.stack}>
              <span className={styles.muted}><Time value={a.period.start} /> to <Time value={a.period.end} /></span>
              <Properties columns={3} items={[
                ['Tokens', a.tokens === null ? 'No seat this period' : `${count(a.tokens.remaining)} of ${count(a.tokens.granted)} left`],
                ['Today', a.tokens === null ? '—' : `${count(a.tokens.dailyRemaining)} of ${count(a.tokens.dailyLimit)} left`],
                ['Simulations', a.simulations === null ? '—' : `${count(a.simulations.remaining)} of ${count(a.simulations.granted)} left`],
                ['Welcome grant left', count(a.balance.onboardingGrantRemaining)],
                ['Bought tokens left', count(a.balance.purchasedRemaining)],
                ['Bought simulations left', count(a.balance.simulationsPurchasedRemaining)],
              ]} />
              <Switch label="Top up automatically" checked={a.balance.autoTopup} disabled={topup.pending} blocked={topup.blocked}
                hint="When they run out, the fewest hundreds of tokens that cover the charge are bought at £20 a hundred, so their work goes on."
                onChange={(on) => void topup.run({ params: { membershipId }, body: { enabled: on } }).then((r) => r.ok && say(on ? 'Automatic top-up on' : 'Automatic top-up off'))} />
              {topup.error !== undefined ? <ErrorMessage error={topup.error} /> : null}
            </div>
          </Panel>
        )}
      </QueryView>
    </Section>
  );
}

type Contract = Output<'readContracts'>['contracts'][number];
const CONTRACT: Record<Contract['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' }, awaiting_margin_approval: { label: 'Being approved', tone: 'info' }, active: { label: 'Active', tone: 'ok' },
  expired: { label: 'Expired', tone: 'neutral' }, terminated: { label: 'Ended', tone: 'neutral' },
};

/** /settings/contracts/: enterprise contracts, what they allocate, and how much is used. */
export function Contracts() {
  const read = useQuery('readContracts', {});
  const [open, setOpen] = useState<string | undefined>();
  return (
    <Page title="Contracts" description="Your enterprise contracts with Silo: their terms, what they allocate, and how much is used." crumbs={crumbs} width="full">
      <QueryView query={read} what="Contracts" isEmpty={(d) => d.contracts.length === 0} empty={<EmptyState icon="document" title="No contracts">Your organisation is billed by subscription; see Plan and invoices.</EmptyState>}>
        {(d) => (
          <DataTable label="Contracts" rows={d.contracts} rowKey={(c) => c.id} columns={[
            { id: 'term', header: 'Term', primary: true, cell: (c) => <button type="button" className={styles.linkButton} onClick={() => setOpen(c.id)}><Time value={c.termStart} /> to <Time value={c.termEnd} /></button> },
            { id: 'state', header: 'State', width: 'sm', cell: (c) => <Badge tone={CONTRACT[c.status].tone}>{CONTRACT[c.status].label}</Badge> },
            { id: 'seats', header: 'Seats', align: 'end', cell: (c) => count(c.seatCount) },
            { id: 'tokens', header: 'Tokens', align: 'end', cell: (c) => count(c.tokenAllocation) },
            { id: 'renewal', header: 'Renewal', cell: (c) => humanise(c.renewalState) },
            { id: 'po', header: 'Purchase order', cell: (c) => c.purchaseOrderRef ?? '—' },
          ]} />
        )}
      </QueryView>
      {open !== undefined ? <ContractDrawer contract={read.data?.contracts.find((c) => c.id === open)} onClose={() => setOpen(undefined)} /> : null}
    </Page>
  );
}

function ContractDrawer({ contract, onClose }: { contract: Contract | undefined; onClose: () => void }) {
  const usage = useQuery('readContractUsage', contract === undefined ? null : { params: { contractId: contract.id } });
  if (contract === undefined) return null;
  const c = contract;
  return (
    <Dialog open drawer onClose={onClose} title="Contract" size="lg">
      <div className={styles.stack}>
        <Properties columns={2} items={[
          ['State', <Badge key="s" tone={CONTRACT[c.status].tone}>{CONTRACT[c.status].label}</Badge>],
          ['Term', <span key="t"><Time value={c.termStart} /> to <Time value={c.termEnd} /></span>],
          ['Platform fee', c.platformFee],
          ['Seats', `${count(c.seatCount)} at ${c.seatRate}`],
          ['Tokens for the term', count(c.tokenAllocation)],
          ['Tokens a person a day', count(c.dailyTokenLimit)],
          ['Simulations', count(c.simulationAllocation)],
          ['Storage', `${formatBytes(Number(c.storageIncludedBytes))} included, then ${c.storageRate}`],
          ['Also', c.capabilities.length === 0 ? '—' : c.capabilities.map((x) => humanise(x)).join(', ')],
          ['Sovereign', c.sovereign ? 'Yes' : 'No'],
          ['Payment terms', c.paymentTerms],
          ['Purchase order', c.purchaseOrderRef ?? '—'],
          ['Signed by', c.signedBy ?? '—'],
          ['Countersigned', c.countersignedAt !== null ? <Time key="c" value={c.countersignedAt} /> : '—'],
        ]} />
        <Section title="Use so far">
          <QueryView query={usage} what="Its use">
            {(u) => (
              <Panel>
                <div className={styles.stack}>
                  <Properties columns={2} items={[
                    ['Months', `${u.monthsElapsed} of ${u.termMonths}`],
                    ['Tokens used', count(u.tokensUsed)],
                    ['Allocated to date', count(u.tokensAllocatedToDate)],
                    ['Allocated for the term', count(u.tokensAllocatedForTerm)],
                  ]} />
                  {u.overage > 0 ? <Banner tone="warn" title="Over the allocation">{count(u.overage)} tokens more than allocated to date; this is settled as the contract says.</Banner> : null}
                </div>
              </Panel>
            )}
          </QueryView>
        </Section>
      </div>
    </Dialog>
  );
}
