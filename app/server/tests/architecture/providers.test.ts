// Connections are data; protocols are code (decision 2026-11-01). A connection to a named
// system (HubSpot, Sage, a customer's Postgres, their BigQuery) is a validated manifest
// executed by a generic protocol engine. Adding a system never needs a code change, so no
// code may hold logic for a named provider: "if provider === 'hubspot'" belongs in the
// manifest.
//
// The build fails on:
// - a known provider or vendor name in code, as a string or an object key: a comparison,
//   a case label, a lookup table or an argument that picks a provider is a branch on it;
// - a comparison or switch on a provider, vendor, slug or connector field against any
//   value, which catches names this list does not know. The exceptions are Silo's own
//   deployment adapters (KMS, object storage, bus, model routes; spec 6), and only in
//   config and infra.
// - a switch on a SQL dialect outside the SQL engines: dialects are variants of the SQL
//   protocol, and only the SQL modules may tell them apart.
// Comments, import specifiers and data files (manifests, catalogue) are not code.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { all, isImportSpecifier, scan, SQL_BUILDER, SQL_MODULES, type Literal, type Scanned } from './source.helper.ts';

// Source systems and identity providers. Not exhaustive: the discriminant rule catches the rest.
const VENDORS = [
  'hubspot', 'salesforce', 'sage', 'xero', 'quickbooks', 'intuit', 'netsuite', 'dynamics', 'dynamics365', 'entra', 'azuread',
  'okta', 'auth0', 'onelogin', 'zendesk', 'freshdesk', 'intercom', 'jira', 'atlassian', 'servicenow', 'shopify', 'workday',
  'pipedrive', 'zoho', 'mailchimp', 'asana', 'airtable', 'twilio', 'sendgrid', 'bamboohr', 'sharepoint', 'dropbox',
  'mongodb', 'dynamodb', 'redshift', 'oracle', 'snowflake', 'databricks', 'mysql', 'mariadb', 'sqlserver', 'mssql',
];
// Names that are both a vendor and a word too common to match with a suffix.
const EXACT_VENDORS = ['sap'];
// SQL dialect vendors: the SQL engines must tell these apart.
const DIALECT_VENDORS = ['oracle', 'snowflake', 'databricks', 'mysql', 'mariadb', 'sqlserver', 'mssql', 'redshift'];
// Protocols are code: an engine dispatches on them.
const PROTOCOLS = ['rest', 'graphql', 'soap', 'sql', 'odata', 'sap_rfc', 'sap_idoc', 'idoc', 'sftp', 'file_drop', 'email',
  'mqtt', 'opc_ua', 'bigquery', 'oidc', 'saml', 'scim'];
// Silo's own deployment adapters, chosen by configuration (spec 6.5), in config and infra only.
const PLATFORM_ADAPTERS = ['local', 'vault_transit', 'gcp_kms', 'pkcs11_hsm', 'uk_hsm', 's3', 'gcs', 'pubsub', 'jetstream',
  'vertex_ai', 'self_hosted',
  // Mobile push and Ask's web search (decision 2026-11-14), and an adapter switched off.
  'fcm', 'apns', 'brave', 'none'];
const PLATFORM_HOMES = ['config/', 'infra/'];

const VENDOR = new RegExp(`^(?:(?:${VENDORS.join('|')})(?:[-_.][a-z0-9][a-z0-9_.-]*)?|${EXACT_VENDORS.join('|')})$`, 'i');
const DISCRIMINANT = /^(?:provider|vendor|slug|connector|connectorslug|connectorid|connectorname|vendorname|providername|providerid|system|systemname)$/i;

const inAny = (file: string, prefixes: readonly string[]): boolean => prefixes.some((p) => file.startsWith(p) || file === p);
const sqlEngine = (file: string): boolean => inAny(file, SQL_MODULES) || file === SQL_BUILDER;
const vendorAllowed = (file: string, name: string): boolean =>
  sqlEngine(file) && DIALECT_VENDORS.includes(name.toLowerCase().split(/[-_.]/)[0]!);

// The last name of an expression: c.kms?.provider gives provider.
const lastName = (expression: string): string => expression.replace(/[?!()\]]/g, '').split('.').pop() ?? '';

// switch (x) { ... } blocks, with their discriminant.
function switches(blank: string): { from: number; to: number; on: string }[] {
  const found: { from: number; to: number; on: string }[] = [];
  for (const m of blank.matchAll(/\bswitch\s*\(([^)]*)\)\s*\{/g)) {
    let depth = 0;
    const open = m.index + m[0].length - 1;
    for (let k = open; k < blank.length; k++) {
      if (blank[k] === '{') depth += 1;
      else if (blank[k] === '}' && --depth === 0) {
        found.push({ from: open, to: k, on: m[1]!.trim() });
        break;
      }
    }
  }
  return found;
}

// What a literal is compared with, if anything.
function discriminantOf(scanned: Scanned, literal: Literal, blocks: { from: number; to: number; on: string }[]): string | undefined {
  const before = scanned.blank.slice(Math.max(0, literal.start - 120), literal.start);
  const after = scanned.blank.slice(literal.end, literal.end + 120);
  const compared = /([\w$.?!\])]+)\s*[!=]==?\s*$/.exec(before)?.[1] ?? /^\s*[!=]==?\s*([\w$.?!]+)/.exec(after)?.[1];
  if (compared !== undefined) return compared;
  if (/\bcase\s*$/.test(before)) {
    const inner = blocks.filter((b) => b.from < literal.start && literal.start < b.to).sort((a, b) => b.from - a.from)[0];
    return inner?.on;
  }
  return undefined;
}

export function providerViolations(file: string, source: string): string[] {
  const scanned = scan(source);
  const blocks = switches(scanned.blank);
  const out: string[] = [];
  for (const literal of scanned.literals) {
    if (literal.interpolated || isImportSpecifier(scanned, literal)) continue;
    const value = literal.text.trim();
    if (VENDOR.test(value) && !vendorAllowed(file, value)) {
      out.push(`${file}: names the provider '${value}' in code (that belongs in the manifest)`);
      continue;
    }
    const on = discriminantOf(scanned, literal, blocks);
    if (on === undefined) continue;
    const name = lastName(on);
    if (DISCRIMINANT.test(name)) {
      const platform = PLATFORM_ADAPTERS.includes(value) && inAny(file, PLATFORM_HOMES);
      if (!platform && !PROTOCOLS.includes(value)) out.push(`${file}: branches on ${name} = '${value}' (that belongs in the manifest)`);
    } else if (/^dialect$/i.test(name) && !sqlEngine(file)) {
      out.push(`${file}: branches on a SQL dialect outside the SQL engines`);
    }
  }
  for (const m of scanned.blank.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*:/g)) {
    if (VENDOR.test(m[1]!) && !vendorAllowed(file, m[1]!)) out.push(`${file}: a lookup keyed by the provider '${m[1]}' (that belongs in the manifest)`);
  }
  return out;
}

describe('connections are data, not code', () => {
  test('no code holds logic for a named provider', () => {
    assert.deepEqual(all.flatMap(({ file, source }) => providerViolations(file, source)), []);
  });

  test('catches provider branches in their common forms', () => {
    const runtime = 'services/connect-runtime/run.service.ts';
    const caught: [string, string][] = [
      ["if (connection.provider === 'hubspot') retry();", 'comparison with a known vendor'],
      ["if ('salesforce' !== manifest.vendor) return;", 'reversed comparison'],
      ["switch (manifest.vendor) {\n  case 'acme':\n    break;\n}", 'switch on vendor, unknown name'],
      ["if (slug === 'xero-uk') parse();", 'connector slug with a suffix'],
      ['const handlers = { salesforce: readSalesforce };', 'lookup table'],
      ["const handlers = { 'netsuite': read };", 'quoted lookup key'],
      ["callConnector('zendesk');", 'argument'],
      ["if (kind === 'sap') useRfc();", 'exact vendor'],
      ["if (kms.provider === 'gcp_kms') x();", 'a platform adapter outside config and infra'],
      ["if (dialect === 'snowflake') quote();", 'a dialect outside the SQL engines'],
      ["if (c.connector?.slug === 'my-crm') y();", 'optional chaining, unknown name'],
    ];
    for (const [code, why] of caught) assert.ok(providerViolations(runtime, code).length >= 1, why);
  });

  test('lets through protocols, platform adapters in config and infra, dialects in the SQL engines, and prose', () => {
    const allowed: [string, string][] = [
      ['services/connect-runtime/run.service.ts', "if (manifest.protocol === 'graphql') useGraphql();"],
      ['services/connect-runtime/run.service.ts', "if (identityProvider.provider === 'oidc') discover();"],
      ['services/connect-runtime/run.service.ts', '// HubSpot pages with an after cursor; the manifest says so.'],
      ['services/connect-runtime/run.service.ts', "import { BigQuery } from '@google-cloud/bigquery';"],
      ['services/connect-runtime/run.service.ts', "if (protocol === 'sap_rfc') viaAgent();"],
      ['config/kms.config.ts', "if (c.kms?.provider === 'gcp_kms') check();"],
      ['infra/kms.infra.ts', "switch (config.provider) {\n  case 'vault_transit':\n    break;\n}"],
      ['services/connect-runtime/protocols/sql/dialect.protocol.ts', "switch (dialect) {\n  case 'oracle':\n    break;\n}"],
      ['utils/sqlBuilder.util.ts', "const RULES = { snowflake: 1, databricks: 2 };"],
      ['services/billing/invoice.service.ts', "if (row.status === 'open') pay();"],
    ];
    for (const [file, code] of allowed) assert.deepEqual(providerViolations(file, code), [], `${file}: ${code}`);
  });
});
