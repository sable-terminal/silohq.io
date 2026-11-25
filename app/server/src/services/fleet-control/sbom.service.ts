// Reading SBOMs and VEX documents (spec 11.1), as fleet-control receives them for a
// release. Both are JSON.
//
// SBOMs: CycloneDX (any 1.x, components nested to any depth) and SPDX 2.x (packages with
// a package-manager purl reference). Each component is kept by its package URL, with the
// OSV ecosystem and name an advisory would name it by (utils/purl.util.ts); a component
// without a purl is counted and matched to nothing.
//
// VEX: OpenVEX (statements naming a vulnerability, products and their subcomponents by
// purl, a status and a justification) and CycloneDX VEX (vulnerabilities with affects and
// an analysis). CycloneDX's states map onto OpenVEX's: exploitable is affected, resolved is
// fixed, in_triage is under investigation, and false_positive is not affected.

import { osvPackageOf, parsePurl, purlIdentity } from '../../utils/purl.util.ts';
import { AppError } from '../../utils/errors.util.ts';

export interface SbomComponent { purl: string; ecosystem: string | null; name: string; version: string }

const invalid = (code: string, message: string): AppError => new AppError('validation', message, { code });

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid('fleet.document_invalid', `the ${what} is not JSON`);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The components of an SBOM, by purl, each once, and how many listed no purl. */
export function readSbom(text: string, format: 'spdx' | 'cyclonedx'): { components: SbomComponent[]; withoutPurl: number } {
  const document = parseJson(text, 'SBOM');
  if (!isObject(document)) throw invalid('fleet.sbom_invalid', 'the SBOM is not a JSON object');
  const purls: string[] = [];
  let withoutPurl = 0;
  if (format === 'cyclonedx') {
    if (document['bomFormat'] !== 'CycloneDX' || typeof document['specVersion'] !== 'string' || !document['specVersion'].startsWith('1.')) {
      throw invalid('fleet.sbom_invalid', 'not a CycloneDX 1.x JSON SBOM');
    }
    const walk = (list: unknown): void => {
      for (const component of asArray(list)) {
        if (!isObject(component)) continue;
        if (typeof component['purl'] === 'string') purls.push(component['purl']);
        else withoutPurl += 1;
        walk(component['components']);
      }
    };
    walk(document['components']);
  } else {
    if (typeof document['spdxVersion'] !== 'string' || !document['spdxVersion'].startsWith('SPDX-2.')) {
      throw invalid('fleet.sbom_invalid', 'not an SPDX 2.x JSON SBOM');
    }
    for (const pkg of asArray(document['packages'])) {
      if (!isObject(pkg)) continue;
      const reference = asArray(pkg['externalRefs']).find((r) => isObject(r) && r['referenceType'] === 'purl'
        && (r['referenceCategory'] === 'PACKAGE-MANAGER' || r['referenceCategory'] === 'PACKAGE_MANAGER') && typeof r['referenceLocator'] === 'string');
      if (isObject(reference)) purls.push(reference['referenceLocator'] as string);
      else withoutPurl += 1;
    }
  }
  const components = new Map<string, SbomComponent>();
  for (const text of purls) {
    const purl = parsePurl(text);
    if (purl === undefined || purl.version === undefined) {
      withoutPurl += 1;
      continue;
    }
    const osv = osvPackageOf(purl);
    components.set(text, { purl: text, ecosystem: osv?.ecosystem ?? null, name: osv?.name ?? purl.name, version: purl.version });
  }
  return { components: [...components.values()], withoutPurl };
}

export const VEX_STATUSES = ['not_affected', 'affected', 'fixed', 'under_investigation'] as const;
export const VEX_JUSTIFICATIONS = [
  'component_not_present', 'vulnerable_code_not_present', 'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary', 'inline_mitigations_already_exist',
] as const;

export interface VexEntry {
  vulnerability: string;
  /** Without qualifiers; without a version, it covers every version of the package. */
  purl: string;
  status: (typeof VEX_STATUSES)[number];
  justification: (typeof VEX_JUSTIFICATIONS)[number] | null;
  impactStatement: string | null;
}

const CYCLONEDX_STATES: Record<string, VexEntry['status']> = {
  not_affected: 'not_affected', false_positive: 'not_affected', exploitable: 'affected', resolved: 'fixed',
  resolved_with_pedigree: 'fixed', in_triage: 'under_investigation',
};
const CYCLONEDX_JUSTIFICATIONS: Record<string, VexEntry['justification']> = {
  code_not_present: 'vulnerable_code_not_present', code_not_reachable: 'vulnerable_code_not_in_execute_path',
  requires_configuration: 'vulnerable_code_cannot_be_controlled_by_adversary', requires_dependency: 'component_not_present',
  requires_environment: 'vulnerable_code_cannot_be_controlled_by_adversary', protected_by_compiler: 'inline_mitigations_already_exist',
  protected_at_runtime: 'inline_mitigations_already_exist', protected_at_perimeter: 'inline_mitigations_already_exist',
  protected_by_mitigating_control: 'inline_mitigations_already_exist',
};

const identityOf = (text: string): string | undefined => {
  const purl = parsePurl(text);
  return purl === undefined ? undefined : purlIdentity(purl);
};

/** The statements a VEX document makes, one per vulnerability and component. */
export function readVex(text: string): VexEntry[] {
  const document = parseJson(text, 'VEX document');
  if (!isObject(document)) throw invalid('fleet.vex_invalid', 'the VEX document is not a JSON object');
  const out: VexEntry[] = [];
  const add = (vulnerability: unknown, purl: string, status: VexEntry['status'] | undefined,
    justification: VexEntry['justification'] | undefined, impact: unknown): void => {
    if (typeof vulnerability !== 'string' || vulnerability === '' || status === undefined) {
      throw invalid('fleet.vex_invalid', 'a VEX statement needs a vulnerability and a status');
    }
    const identity = identityOf(purl);
    if (identity === undefined) throw invalid('fleet.vex_invalid', `a VEX statement names ${purl}, which is not a package URL`);
    const impactStatement = typeof impact === 'string' && impact.trim() !== '' ? impact.trim().slice(0, 4000) : null;
    if (status === 'not_affected' && justification == null && impactStatement === null) {
      throw invalid('fleet.vex_unjustified', `the statement that ${identity} is not affected by ${vulnerability} gives no justification`);
    }
    out.push({ vulnerability, purl: identity, status, justification: justification ?? null, impactStatement });
  };

  if (typeof document['@context'] === 'string' && document['@context'].includes('openvex')) {
    for (const statement of asArray(document['statements'])) {
      if (!isObject(statement)) continue;
      const vulnerability = isObject(statement['vulnerability']) ? statement['vulnerability']['name'] : statement['vulnerability'];
      const status = VEX_STATUSES.find((s) => s === statement['status']);
      const justification = statement['justification'] === undefined ? null : VEX_JUSTIFICATIONS.find((j) => j === statement['justification']);
      if (statement['justification'] !== undefined && justification === undefined) throw invalid('fleet.vex_invalid', 'an OpenVEX justification is not one OpenVEX defines');
      const targets: string[] = [];
      for (const product of asArray(statement['products'])) {
        if (!isObject(product)) continue;
        const subcomponents = asArray(product['subcomponents']).filter(isObject).map((s) => s['@id']).filter((id): id is string => typeof id === 'string');
        if (subcomponents.length > 0) targets.push(...subcomponents);
        else if (typeof product['@id'] === 'string') targets.push(product['@id']);
      }
      if (targets.length === 0) throw invalid('fleet.vex_invalid', 'an OpenVEX statement names no component by package URL');
      for (const target of targets) add(vulnerability, target, status, justification, statement['impact_statement']);
    }
  } else if (document['bomFormat'] === 'CycloneDX') {
    for (const vulnerability of asArray(document['vulnerabilities'])) {
      if (!isObject(vulnerability)) continue;
      const analysis = isObject(vulnerability['analysis']) ? vulnerability['analysis'] : {};
      const status = CYCLONEDX_STATES[String(analysis['state'])];
      const justification = analysis['justification'] === undefined ? null : CYCLONEDX_JUSTIFICATIONS[String(analysis['justification'])];
      const refs = asArray(vulnerability['affects']).filter(isObject).map((a) => a['ref']).filter((r): r is string => typeof r === 'string');
      if (refs.length === 0) throw invalid('fleet.vex_invalid', 'a CycloneDX VEX vulnerability affects no component by package URL');
      for (const ref of refs) add(vulnerability['id'], ref, status, justification, analysis['detail']);
    }
  } else {
    throw invalid('fleet.vex_invalid', 'not an OpenVEX or CycloneDX VEX document');
  }
  if (out.length === 0) throw invalid('fleet.vex_invalid', 'the VEX document makes no statements');
  return out;
}
