import { env } from '../config/env.config';
import { withTransaction } from '../infra/db.infra';
import { invalid, notFound } from '../utils/error.util';
import { looksSecret } from '../utils/secretShape.util';
import { unsafePattern, PATTERN_INPUT_MAX } from '../schemas/manifestPrimitives.schema';
import {
  DEFAULT_CREDENTIAL_FIELDS,
  type AuthStrategy,
  type SingleStrategyV2,
} from '../schemas/connectorAuth.schema';
import type { Manifest } from '../schemas/manifest.schema';
import { writesOf } from '../engine/read/capabilities.read';
import { loadManifest } from '../engine/compat/load.compat';
import * as connectionRepo from '../repos/connection.repo';
import type { Actor } from './scope.service';

/**
 * What connecting to a system asks for, read off its manifest.
 *
 * ONE ANSWER, FROM THE SERVER, FOR EVERY DOCUMENT VERSION. The app used to read
 * a connector's DRAFT to guess what to ask for — there was no endpoint for a
 * published manifest — so a prebuilt connector, which has no draft, offered no
 * form at all. The engine already holds every manifest as v2; this is that
 * manifest, turned into questions.
 *
 * NOTHING HERE IS A SECRET, AND NOTHING SECRET IS EVER RETURNED. It says which
 * fields to ask for and how to label them; the values go the other way, once,
 * and are sealed.
 */

export interface CredentialQuestion {
  /** The credential field's name, as the connection's sealed bag holds it. */
  name: string;
  label: string;
  help: string | null;
  secret: boolean;
  multiline: boolean;
  looksLike: string | null;
  optional: boolean;
}

export interface Alternative {
  strategy: string;
  label: string;
  /** A browser sign-in rather than typed fields. */
  signIn: boolean;
  fields: CredentialQuestion[];
}

export interface ParameterQuestion {
  name: string;
  label: string;
  help: string | null;
  looksLike: string | null;
  default: string | null;
  multiline: boolean;
  required: boolean;
}

export interface ConnectForm {
  manifestId: string;
  name: string;
  provider: string;
  credentialSharing: 'shareable' | 'per_user';
  alternatives: Alternative[];
  parameters: ParameterQuestion[];
  setup: Manifest['setup'] | null;
  inbound: 'inbound_webhook' | 'email_fallback' | null;
  /** Reached through the customer's agent rather than from Silo. */
  throughAgent: boolean;
  /** The addresses Silo's requests come from, for a system that only accepts known ones. Empty when not fixed. */
  egressAddresses: string[];
  objects: Array<{ name: string; identifier: string[]; fields: string[] }>;
  /** Verify-writes needs a record created and then removed or reversed. */
  writable: boolean;
}

const egressAddresses = (): string[] =>
  (env.EGRESS_IPS ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean);

/* What a credential field is called when the connector does not say. */
const LABELS: Record<string, { label: string; multiline?: boolean; secret?: boolean }> = {
  key: { label: 'API key' },
  token: { label: 'Token' },
  username: { label: 'Username', secret: false },
  password: { label: 'Password' },
  client_id: { label: 'Client ID', secret: false },
  client_secret: { label: 'Client secret' },
  private_key: { label: 'Private key', multiline: true },
  certificate: { label: 'Certificate', multiline: true, secret: false },
  passphrase: { label: 'Key passphrase' },
  secret: { label: 'Signing secret' },
  key_id: { label: 'Key ID', secret: false },
  access_key_id: { label: 'Access key ID', secret: false },
  secret_access_key: { label: 'Secret access key' },
  session_token: { label: 'Session token' },
  consumer_key: { label: 'Consumer key', secret: false },
  consumer_secret: { label: 'Consumer secret' },
  token_secret: { label: 'Token secret' },
};

const STRATEGY_LABELS: Record<string, string> = {
  none: 'No sign-in',
  oauth2_authorization_code: 'Sign in with your account',
  oauth2_pkce: 'Sign in with your account',
  oauth2_client_credentials: 'An application client ID and secret',
  oauth2_password: 'A username and password, exchanged for a token',
  api_key_header: 'An API key',
  api_key_query: 'An API key',
  bearer: 'An access token',
  basic: 'A username and password',
  ssh_key: 'A username and SSH key or password',
  mtls: 'A client certificate',
  placed: 'The values this system asks for',
  session: 'A username and password, used to log in',
  jwt_assertion: 'A private key that signs an assertion',
  signed: 'Keys that sign each request',
  ws_security: 'A web services username and password',
  ntlm: 'A Windows domain account',
  negotiate: 'Your network’s single sign-on',
  all_of: 'Several credentials together',
};

function questionsFor(manifest: Manifest, part: SingleStrategyV2): CredentialQuestion[] {
  const rename = part.fields ?? {};
  const defaults: string[] =
    part.strategy === 'placed'
      ? Object.keys(part.places)
      : part.strategy === 'session' && part.credentialPlacement !== 'basic'
        ? Object.keys(part.credentialPlacement)
        : [...(DEFAULT_CREDENTIAL_FIELDS as Record<string, readonly string[]>)[part.strategy]!];

  /* A held OAuth token is asked for by signing in; the client, only if the connector brings its own. */
  if ((part.strategy === 'oauth2_authorization_code' || part.strategy === 'oauth2_pkce') && !part.bringYourOwnClient) return [];
  /* The agent's own domain identity needs nothing typed. */
  if (part.strategy === 'negotiate' && part.useAgentIdentity) return [];

  const out: CredentialQuestion[] = [];
  for (const raw of defaults) {
    const optional = raw.endsWith('?');
    const base = raw.replace(/\?$/, '');
    const name = rename[base] ?? base;
    const declared = manifest.credentials[name];
    /* A fixed half — Freshdesk's password is the letter X — is never asked for. */
    if (declared?.fixed !== undefined) continue;
    const known = LABELS[base];
    out.push({
      name,
      label: declared?.label ?? known?.label ?? name.replace(/_/g, ' '),
      help: declared?.help ?? null,
      secret: declared?.secret ?? known?.secret ?? true,
      multiline: declared?.multiline ?? known?.multiline ?? false,
      looksLike: declared?.looksLike ?? null,
      optional,
    });
  }
  return out;
}

export function formFor(manifestId: string, manifest: Manifest): ConnectForm {
  const alternatives: Alternative[] = manifest.auth.map((alternative: AuthStrategy) => {
    const parts = alternative.strategy === 'all_of' ? alternative.parts : [alternative];
    const seen = new Set<string>();
    const fields = parts.flatMap((part) => questionsFor(manifest, part)).filter((q) => (seen.has(q.name) ? false : (seen.add(q.name), true)));
    return {
      strategy: alternative.strategy,
      label: STRATEGY_LABELS[alternative.strategy] ?? alternative.strategy,
      signIn: parts.some((p) => p.strategy === 'oauth2_authorization_code' || p.strategy === 'oauth2_pkce'),
      fields,
    };
  });

  const t = manifest.transport;
  return {
    manifestId,
    name: manifest.identity.name,
    provider: manifest.identity.provider,
    credentialSharing: manifest.credentialSharing,
    alternatives,
    parameters: Object.entries(manifest.parameters).map(([name, p]) => ({
      name,
      label: p.label,
      help: p.help ?? null,
      looksLike: p.looksLike ?? null,
      default: p.default ?? null,
      multiline: p.multiline,
      required: p.default === undefined,
    })),
    setup: manifest.setup ?? null,
    inbound: t.kind === 'inbound_webhook' || t.kind === 'email_fallback' ? t.kind : null,
    throughAgent: 'via' in t && t.via !== undefined,
    /* Through an agent, the request comes from inside the customer's own network instead. */
    egressAddresses: 'via' in t && t.via !== undefined ? [] : egressAddresses(),
    objects: manifest.objects.filter((o) => o.available).map((o) => ({ name: o.name, identifier: o.identifier, fields: o.fields.map((f) => f.name) })),
    writable: manifest.objects.some((o) => {
      const w = writesOf(manifest, o.name);
      return w.create && w.undoable;
    }),
  };
}

/** The connect form for a connector version this organisation may use. */
export async function connectForm(actor: Actor, manifestId: string): Promise<ConnectForm> {
  void actor;
  const stored = await withTransaction((db) => connectionRepo.manifestDocument(db, manifestId));
  if (!stored) throw notFound({ message: 'That connector does not exist.', code: 'missing.manifest' });
  const loaded = loadManifest(stored.document, stored.schemaVersion);
  if (!loaded.ok) {
    throw invalid({ message: 'This connector is not a valid manifest and cannot be connected to.', code: 'invalid.manifest_stored', detail: { issues: loaded.issues } });
  }
  return formFor(manifestId, loaded.manifest);
}

/* ── Checking what was typed ────────────────────────────────────────────── */

/**
 * The credential fields a connection is given, checked against what its
 * chosen alternative asks for. A required field left out is named; a field the
 * connector never asked for is refused rather than sealed and ignored.
 */
export function checkCredentialFields(manifest: Manifest, strategy: string, fields: Record<string, string>): void {
  const alternative = manifest.auth.find((a) => a.strategy === strategy);
  if (!alternative) throw invalid({ message: `This connector does not use ${strategy}.`, code: 'invalid.strategy_not_declared' });
  const parts = alternative.strategy === 'all_of' ? alternative.parts : [alternative];
  const questions = parts.flatMap((part) => questionsFor(manifest, part));
  const known = new Set(questions.map((q) => q.name));
  const missing = questions.filter((q) => !q.optional && !(fields[q.name] ?? '').trim()).map((q) => q.label);
  if (missing.length > 0) {
    throw invalid({ message: `Fill in ${missing.join(', ')}.`, code: 'invalid.credential_incomplete', detail: { missing } });
  }
  const unknown = Object.keys(fields).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw invalid({ message: `This connector does not ask for ${unknown.join(', ')}.`, code: 'invalid.credential_unknown_field', detail: { unknown } });
  }
}

/**
 * A connection's parameters, checked: every required one present, each
 * matching its declared pattern, and none that looks like a secret.
 */
export function checkParameters(manifest: Manifest, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, declared] of Object.entries(manifest.parameters)) {
    const value = (values[name] ?? '').trim() || declared.default;
    if (value === undefined || value === '') {
      throw invalid({ message: `Fill in ${declared.label}.`, code: 'invalid.parameter_missing', fields: { [name]: 'Required' } });
    }
    if (!declared.multiline && value.length > 512) {
      throw invalid({ message: `${declared.label} is too long.`, code: 'invalid.parameter_too_long', fields: { [name]: 'At most 512 characters' } });
    }
    if (declared.pattern && !unsafePattern(declared.pattern)) {
      if (!new RegExp(declared.pattern).test(value.slice(0, PATTERN_INPUT_MAX))) {
        throw invalid({
          message: `${declared.label} does not look right${declared.looksLike ? ` — it looks like ${declared.looksLike}` : ''}.`,
          code: 'invalid.parameter_pattern',
          fields: { [name]: 'Does not match' },
        });
      }
    }
    const secret = looksSecret(value);
    if (secret) {
      throw invalid({
        message: `${declared.label} looks like ${secret}. A setting is shown and logged; a secret goes in the credential, where it is sealed.`,
        code: 'invalid.parameter_secret',
        fields: { [name]: 'Looks like a secret' },
      });
    }
    out[name] = value;
  }
  const unknown = Object.keys(values).filter((name) => !(name in manifest.parameters));
  if (unknown.length > 0) {
    throw invalid({ message: `This connector does not ask for ${unknown.join(', ')}.`, code: 'invalid.parameter_unknown' });
  }
  return out;
}
