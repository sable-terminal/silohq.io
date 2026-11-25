'use client';

// What each Silo costs (spec 70.8): the provider's cost of what it holds, scans and sends, less
// what the plan includes, plus Silo's 10%; by month, with whether it is invoiced yet.

import { useState } from 'react';
import { Badge } from '../../components/badge.component.tsx';
import { SelectField } from '../../components/field.component.tsx';
import { Page, Panel, Properties } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { EmptyState } from '../../components/states.component.tsx';
import { DataTable } from '../../components/table.component.tsx';
import { useQuery } from '../../data/query.data.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber } from '../../utils/format.util.ts';
import { bytesOf } from './words.view.ts';
import styles from './siloes.view.module.css';

/** The last twelve months, newest first, as the cell names a period (YYYY-MM). */
function months(): { value: string; label: string }[] {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return { value: d.toISOString().slice(0, 7), label: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  });
}
const money = (s: string) => `£${formatNumber(Number(s), 2)}`;

export function Charges() {
  const [period, setPeriod] = useState('');
  const charges = useQuery('listSiloCharges', { query: period === '' ? {} : { period } }, { keepPrevious: true });
  usePageContext({ scope: { kind: 'page', page: 'siloes' }, scopeLabel: 'Silo charges' });
  return (
    <Page title="Charges" description="What each Silo costs: the provider's cost of what it holds, reads and sends, less what your plan includes, plus 10%." crumbs={[{ label: 'Siloes', href: '/siloes/overview/' }]}>
      <div className={styles.stack}>
        <div className={styles.rowEnd}>
          <SelectField label="Month" value={period} onChange={(e) => setPeriod(e.target.value)} options={[{ value: '', label: 'The latest' }, ...months()]} />
        </div>
        <QueryView query={charges} what="Charges" isEmpty={(d) => d.lines.length === 0} empty={<EmptyState icon="chart" title="No charges">Nothing was charged for Siloes in this month.</EmptyState>}>
          {(d) => (
            <div className={styles.stack}>
              <Panel>
                <Properties columns={3} items={[
                  ['Provider cost', money(d.totals.providerCost)], ['Silo\'s 10%', money(d.totals.uplift)], ['Charged', money(d.totals.amount)],
                ]} />
              </Panel>
              <DataTable label="Charges by Silo" rows={d.lines} rowKey={(l) => `${l.siloId}:${l.store}`} columns={[
                { id: 'silo', header: 'Silo', primary: true, cell: (l) => l.siloName },
                { id: 'store', header: 'Store', width: 'sm', cell: (l) => l.store },
                { id: 'held', header: 'Held (mean)', align: 'end', cell: (l) => bytesOf(l.meanBytesHeld) },
                { id: 'scanned', header: 'Read', align: 'end', cell: (l) => bytesOf(l.bytesScanned) },
                { id: 'sent', header: 'Sent', align: 'end', cell: (l) => bytesOf(l.bytesEgressed) },
                { id: 'cost', header: 'Provider cost', align: 'end', cell: (l) => money(l.providerCost) },
                { id: 'included', header: 'Included', align: 'end', cell: (l) => money(l.includedCost) },
                { id: 'amount', header: 'Charged', align: 'end', cell: (l) => money(l.amount) },
                { id: 'state', header: 'Invoice', width: 'sm', cell: (l) => (l.invoiceState === 'invoiced' ? <Badge tone="ok">Invoiced</Badge> : l.invoiceState === 'pending' ? <Badge tone="info">Pending</Badge> : <Badge>Not billed</Badge>) },
              ]} />
            </div>
          )}
        </QueryView>
      </div>
    </Page>
  );
}
