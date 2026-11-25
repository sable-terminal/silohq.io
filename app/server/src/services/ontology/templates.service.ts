// Concept templates (spec 22.7): Silo-authored names with field names, so a first proposal
// arrives with a recognisable name. Never a schema, never values, never applied on its own:
// a template changes what a proposal is called and says so in its evidence; a person still
// confirms, corrects or renames. Only reviewed templates are read (row-level security shows a
// tenant nothing else); Fleet writes them.

import type { ConceptTemplate } from '../../models/ontology/conceptTemplate.model.ts';

/** At least this many of a template's field names must be among the object's... */
export const MIN_MATCHED = 2;
/** ...and at least this share of them. */
export const MIN_SHARE = 0.5;

/** A field name compared without case or separators: invoice_number, InvoiceNumber and invoice-number are one. */
const folded = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface TemplateMatch { template: Pick<ConceptTemplate, 'id' | 'name' | 'fieldNames'>; matched: number; total: number }

/**
 * The template that names an object, by its field names (pure): the highest share of the
 * template's field names present, then the most present, then the name; none below the bounds.
 */
export function nameFor(templates: readonly Pick<ConceptTemplate, 'id' | 'name' | 'fieldNames'>[], fieldNames: readonly string[]): TemplateMatch | undefined {
  const fields = new Set(fieldNames.map(folded));
  let best: TemplateMatch | undefined;
  for (const template of templates) {
    const names = [...new Set(template.fieldNames.map(folded))];
    const matched = names.filter((n) => fields.has(n)).length;
    if (matched < MIN_MATCHED || matched / names.length < MIN_SHARE) continue;
    const candidate = { template, matched, total: names.length };
    const better = best === undefined || matched / names.length > best.matched / best.total
      || (matched / names.length === best.matched / best.total && (matched > best.matched || (matched === best.matched && template.name < best.template.name)));
    if (better) best = candidate;
  }
  return best;
}
