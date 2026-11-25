// Prebuilt definitions (spec 68.3): common export formats shipped as definitions. They hold
// structure only (objects, fields, types and how each field is read), never a value and never
// a domain model (invariant 3): a "supplier" here is a label on an invoice, not an object type
// of anyone's ontology. Publishing one names its key, and the document published must be the
// catalogue's own; a person who changes it publishes through the builder instead.
//
// Documents (structured) read labelled fields, so their values are near and need the carve-out
// acknowledged (62.5); exports (tabular) read columns, certain, and never reach a model.

import type { DefinitionDocument } from '../../contracts/siloes/import.contract.ts';

export interface PrebuiltDefinition {
  key: string;
  name: string;
  description: string;
  /** What files it reads: tabular exports, or documents with labelled fields. */
  reads: 'tabular' | 'structured';
  document: DefinitionDocument;
}

type Field = DefinitionDocument['objects'][number]['fields'][number];
const label = (name: string, type: Field['type'], text: string): Field => ({ name, type, extraction: { kind: 'label', label: text } });
const column = (name: string, type: Field['type'], header: string): Field => ({ name, type, extraction: { kind: 'column', column: header } });

export const PREBUILT: readonly PrebuiltDefinition[] = [
  {
    key: 'invoice', name: 'Invoice', reads: 'structured',
    description: 'A supplier invoice: its number, the supplier, dates, net, tax and total, currency and purchase order.',
    document: { objects: [{ name: 'Invoice', identifier: 'invoice_number', fields: [
      label('invoice_number', 'string', 'Invoice number'), label('supplier', 'string', 'Supplier'), label('invoice_date', 'date', 'Invoice date'),
      label('due_date', 'date', 'Due date'), label('net_amount', 'decimal', 'Net'), label('tax_amount', 'decimal', 'VAT'),
      label('total_amount', 'decimal', 'Total'), label('currency', 'string', 'Currency'), label('purchase_order', 'string', 'PO number'),
    ] }] },
  },
  {
    key: 'purchase_order', name: 'Purchase order', reads: 'structured',
    description: 'A purchase order: its number, buyer and supplier, order and delivery dates, total and currency.',
    document: { objects: [{ name: 'Purchase order', identifier: 'po_number', fields: [
      label('po_number', 'string', 'PO number'), label('buyer', 'string', 'Buyer'), label('supplier', 'string', 'Supplier'),
      label('order_date', 'date', 'Order date'), label('delivery_date', 'date', 'Delivery date'), label('total_amount', 'decimal', 'Total'),
      label('currency', 'string', 'Currency'),
    ] }] },
  },
  {
    key: 'delivery_note', name: 'Delivery note', reads: 'structured',
    description: 'A delivery note: its number, the order it fulfils, the delivery date, carrier and the number of packages.',
    document: { objects: [{ name: 'Delivery note', identifier: 'delivery_note_number', fields: [
      label('delivery_note_number', 'string', 'Delivery note number'), label('order_reference', 'string', 'Order reference'),
      label('delivery_date', 'date', 'Delivery date'), label('carrier', 'string', 'Carrier'), label('packages', 'integer', 'Packages'),
    ] }] },
  },
  {
    key: 'receipt', name: 'Receipt', reads: 'structured',
    description: 'A purchase receipt: its number, the merchant, when, the total and tax, and how it was paid.',
    document: { objects: [{ name: 'Receipt', identifier: 'receipt_number', fields: [
      label('receipt_number', 'string', 'Receipt number'), label('merchant', 'string', 'Merchant'), label('paid_at', 'timestamp', 'Date'),
      label('total_amount', 'decimal', 'Total'), label('tax_amount', 'decimal', 'VAT'), label('payment_method', 'string', 'Payment method'),
    ] }] },
  },
  {
    key: 'bank_statement', name: 'Bank statement export', reads: 'tabular',
    description: 'A bank statement exported as CSV: one row per transaction with its date, description, amount and balance.',
    document: { objects: [{ name: 'Bank transaction', fields: [
      column('date', 'date', 'Date'), column('description', 'string', 'Description'), column('amount', 'decimal', 'Amount'), column('balance', 'decimal', 'Balance'),
    ] }] },
  },
  {
    key: 'timesheet', name: 'Timesheet export', reads: 'tabular',
    description: 'A timesheet exported as CSV: one row per entry with the employee, date, project and hours.',
    document: { objects: [{ name: 'Timesheet entry', fields: [
      column('employee', 'string', 'Employee'), column('date', 'date', 'Date'), column('project', 'string', 'Project'), column('hours', 'decimal', 'Hours'),
    ] }] },
  },
];

export const prebuiltOf = (key: string): PrebuiltDefinition | undefined => PREBUILT.find((p) => p.key === key);
