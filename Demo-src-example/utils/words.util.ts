/**
 * A system's name for something, as a person says it: `lifecycle_stage` →
 * "Lifecycle stage", `dealName` → "Deal name". Used wherever a connector's own
 * spelling would otherwise be shown to somebody who is not its author.
 */
export function labelOf(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/*
 * Fields a record is called by, in the order a person would reach for them.
 * By shape, not by system: every CRM, ledger and helpdesk names its records
 * with one of these, and none of it is a list of connectors.
 */
const CALLED = /^(name|full_?name|display_?name|title|subject|label|company_?name|deal_?name|account_?name|project_?name|product_?name)$/i;
const NAMEISH = /name$/i;
const NOT_A_NAME = /(user|file|host|domain|first|last|given|family|middle|sur)_?name$/i;

/**
 * What a record is called: its name-like field, or its first and last name, or
 * its email address — and its identifier only when it has none of those.
 * "447536063698" is how HubSpot keys a company; "Acme Ltd" is what it is.
 */
export function nameOf(fields: ReadonlyArray<{ fieldPath: string; value?: unknown }>, fallback: string): string {
  const text = (field?: { value?: unknown }) =>
    typeof field?.value === 'string' && field.value.trim() !== '' ? field.value.trim() : null;
  const find = (test: (path: string) => boolean) => text(fields.find((field) => test(field.fieldPath) && text(field)));

  const called = find((path) => CALLED.test(path)) ?? find((path) => NAMEISH.test(path) && !NOT_A_NAME.test(path));
  if (called) return called;

  const first = find((path) => /^(first|given)_?name$/i.test(path));
  const last = find((path) => /^(last|family|sur)_?name$/i.test(path));
  if (first || last) return [first, last].filter(Boolean).join(' ');

  return find((path) => /e_?mail/i.test(path)) ?? fallback;
}
