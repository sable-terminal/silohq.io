// Reads a SAML identity provider's metadata document (SAML 2.0 metadata, OASIS) into the
// settings the credential service seals: its entity id, its HTTP-Redirect single sign-on
// address, its signing certificates (several during a rollover) and, where it lists one,
// a persistent NameID format. Reading only: whether a response is signed by one of these
// certificates is decided by @node-saml when the response arrives, never here.

import { XMLParser } from 'fast-xml-parser';
import { samlSettings, type SamlSettings } from '../../contracts/credential/identityProvider.contract.ts';
import { AppError } from '../../utils/errors.util.ts';

const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';

type Node = Record<string, unknown>;
const list = (value: unknown): Node[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]) as Node[];
const text = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && typeof (value as Node)['#text'] === 'string') return (value as Node)['#text'] as string;
  return undefined;
};

const unreadable = (reason: string): AppError =>
  new AppError('validation', 'the identity provider\'s metadata could not be read', { code: 'sso.metadata_invalid', details: { reason } });

/** As PEM, from the base64 DER a metadata document carries. */
function pemOf(base64: string): string {
  const body = base64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length < 64) throw unreadable('certificate');
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

export function parseSamlMetadata(xml: string): SamlSettings {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw unreadable('doctype');
  let document: Node;
  try {
    document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, processEntities: false })
      .parse(xml) as Node;
  } catch {
    throw unreadable('xml');
  }
  const entities = [...list(document['EntityDescriptor']), ...list((document['EntitiesDescriptor'] as Node | undefined)?.['EntityDescriptor'])];
  const entity = entities.find((e) => e['IDPSSODescriptor'] !== undefined);
  if (!entity) throw unreadable('idp_descriptor');
  const idp = list(entity['IDPSSODescriptor'])[0]!;
  const entityId = entity['@entityID'];
  if (typeof entityId !== 'string' || entityId === '') throw unreadable('entity_id');
  const sso = list(idp['SingleSignOnService']).find((s) => s['@Binding'] === REDIRECT);
  if (!sso || typeof sso['@Location'] !== 'string') throw unreadable('redirect_binding');
  const certificates = list(idp['KeyDescriptor'])
    .filter((k) => k['@use'] === undefined || k['@use'] === 'signing')
    .flatMap((k) => list((list(k['KeyInfo'])[0]?.['X509Data'] as Node | undefined)?.['X509Certificate']).map(text))
    .filter((c): c is string => c !== undefined)
    .map(pemOf);
  if (certificates.length === 0) throw unreadable('signing_certificate');
  const formats = list(idp['NameIDFormat']).map(text).filter((f): f is string => f !== undefined);
  // Single logout (spec 55.5), where it offers the HTTP-Redirect binding.
  const slo = list(idp['SingleLogoutService']).find((s) => s['@Binding'] === REDIRECT);
  const parsed = samlSettings.safeParse({
    entityId, ssoUrl: sso['@Location'], signingCertificates: [...new Set(certificates)].slice(0, 4),
    ...(slo !== undefined && typeof slo['@Location'] === 'string' ? { sloUrl: slo['@Location'] } : {}),
    ...(formats.length > 0 && !formats.includes(PERSISTENT) ? { nameIdFormat: formats[0] } : {}),
  });
  if (!parsed.success) throw unreadable('settings');
  return parsed.data;
}
