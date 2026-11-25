'use client';

// Tables of records: a real <table> (screen readers announce rows and columns), a header that
// stays in view, sortable columns that say how they are sorted (aria-sort), and rows that open
// through a link in their first cell, so they work with the keyboard, open in a new tab, and
// can be copied. Clicking anywhere else on a row follows the same link. Rows may be selected
// for an action on several at once.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Icon } from './icon.component.tsx';
import styles from './table.component.module.css';

export interface Column<R> {
  id: string;
  header: ReactNode;
  cell: (row: R) => ReactNode;
  /** Sorts in the browser by this value; a server-sorted list leaves it out. */
  sortValue?: (row: R) => string | number | null | undefined;
  width?: 'xs' | 'sm' | 'md' | 'lg' | 'auto';
  align?: 'start' | 'end';
  /** Read by assistive technology as the row's name (the first such column is the row header). */
  primary?: boolean;
}

export function DataTable<R>({ label, rows, rowKey, columns, rowHref, selection, dense = false, caption }: {
  label: string;
  rows: readonly R[];
  rowKey: (row: R) => string;
  columns: readonly Column<R>[];
  /** The page a row opens: its primary cell becomes the link. */
  rowHref?: ((row: R) => string | undefined) | undefined;
  selection?: { selected: ReadonlySet<string>; onChange: (selected: Set<string>) => void } | undefined;
  dense?: boolean;
  caption?: ReactNode;
}) {
  const router = useRouter();
  const [sort, setSort] = useState<{ id: string; dir: 'ascending' | 'descending' } | undefined>(undefined);
  const sorted = useMemo(() => {
    const column = columns.find((c) => c.id === sort?.id);
    if (column?.sortValue === undefined || sort === undefined) return rows;
    const value = column.sortValue;
    const factor = sort.dir === 'ascending' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en-GB', { numeric: true })) * factor;
    });
  }, [rows, columns, sort]);
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const allSelected = selection !== undefined && rows.length > 0 && rows.every((r) => selection.selected.has(rowKey(r)));

  const openRow = (event: MouseEvent<HTMLTableRowElement>, href: string | undefined) => {
    if (href === undefined) return;
    const target = event.target as HTMLElement;
    // A control in the row does its own thing; a selection of text is not a click.
    if (target.closest('a, button, input, select, textarea, label, [role="menuitem"]') !== null) return;
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    if (event.metaKey || event.ctrlKey) window.open(href, '_blank', 'noopener');
    else router.push(href as never);
  };

  return (
    <div className={styles.scroll}>
      <table className={[styles.table, dense ? styles.dense : ''].join(' ')} aria-label={caption === undefined ? label : undefined}>
        {caption !== undefined ? <caption className={styles.caption}>{caption}</caption> : null}
        <thead>
          <tr>
            {selection !== undefined ? (
              <th scope="col" className={styles.select}>
                <input type="checkbox" aria-label={allSelected ? 'Clear the selection' : `Select all ${rows.length}`} checked={allSelected}
                  onChange={() => selection.onChange(allSelected ? new Set() : new Set(rows.map(rowKey)))} />
              </th>
            ) : null}
            {columns.map((column) => {
              const sorting = sort?.id === column.id ? sort.dir : undefined;
              return (
                <th key={column.id} scope="col" aria-sort={column.sortValue !== undefined ? sorting ?? 'none' : undefined}
                  className={[styles[column.width ?? 'auto'], column.align === 'end' ? styles.end : ''].join(' ')}>
                  {column.sortValue !== undefined ? (
                    <button type="button" className={styles.sort} onClick={() => setSort(sorting === 'ascending'
                      ? { id: column.id, dir: 'descending' } : sorting === 'descending' ? undefined : { id: column.id, dir: 'ascending' })}>
                      {column.header}
                      <Icon name={sorting === 'ascending' ? 'chevronUp' : sorting === 'descending' ? 'chevronDown' : 'arrowUpDown'} size={12} />
                    </button>
                  ) : column.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            const href = rowHref?.(row);
            return (
              <tr key={key} className={href !== undefined ? styles.linked : undefined} aria-selected={selection?.selected.has(key) || undefined}
                onClick={(event) => openRow(event, href)}>
                {selection !== undefined ? (
                  <td className={styles.select}>
                    <input type="checkbox" aria-label="Select" checked={selection.selected.has(key)} onChange={() => {
                      const next = new Set(selection.selected);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      selection.onChange(next);
                    }} />
                  </td>
                ) : null}
                {columns.map((column) => {
                  const content = column.cell(row);
                  const cell = column === primary && href !== undefined ? <Link href={href as never} className={styles.rowLink}>{content}</Link> : content;
                  return column === primary
                    ? <th key={column.id} scope="row" className={[styles.primary, column.align === 'end' ? styles.end : ''].join(' ')}>{cell}</th>
                    : <td key={column.id} className={column.align === 'end' ? styles.end : undefined}>{cell}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
