// WS-Security's UsernameToken (OASIS Web Services Security UsernameToken Profile 1.1), for a
// SOAP connection whose manifest names the ws_security strategy (spec 15.1). Built here, in
// the mediator callback, so the password never leaves the credential service: the runtime
// sends the envelope without a header, and the token is placed in it on the way out.
//
// - Password text (over TLS) or the profile's digest: Base64(SHA-1(nonce + created + password)),
//   with a fresh 16-byte nonce and the creation time, so a captured token cannot be replayed
//   past the source's window. SHA-1 is the profile's, not a choice made here.
// - Values are escaped XML text; the header goes immediately before the Body of the envelope
//   the runtime built, which this checks is the runtime's own shape, never a free-form insert.
// - A UsernameToken is not a signature: nothing here signs or verifies XML.

import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../utils/errors.util.ts';

const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const PROFILE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0';
const BASE64_BINARY = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

const escape = (text: string): string => {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(text)) {
    throw new AppError('validation', 'a credential holds a character XML cannot carry', { code: 'credential.ws_security_invalid_character' });
  }
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
};

/** The wsse:Security header for one request (the soap prefix is the runtime's envelope's). */
export function usernameToken(username: string, password: string, mode: 'text' | 'digest', now: Date, nonce: Buffer = randomBytes(16)): string {
  const created = now.toISOString();
  const secret = mode === 'text'
    ? `<wsse:Password Type="${PROFILE}#PasswordText">${escape(password)}</wsse:Password>`
    : `<wsse:Password Type="${PROFILE}#PasswordDigest">${createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')])).digest('base64')}</wsse:Password>`
      + `<wsse:Nonce EncodingType="${BASE64_BINARY}">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created>`;
  return `<soap:Header><wsse:Security xmlns:wsse="${WSSE}" xmlns:wsu="${WSU}" soap:mustUnderstand="1">`
    + `<wsse:UsernameToken><wsse:Username>${escape(username)}</wsse:Username>${secret}</wsse:UsernameToken></wsse:Security></soap:Header>`;
}

const ENVELOPE_START = /^<\?xml version="1\.0" encoding="utf-8"\?><soap:Envelope xmlns:soap="[^"]+">/;

/** The envelope with the header placed before its Body; refused where the envelope is not the runtime's shape. */
export function withHeader(envelope: string, header: string): string {
  const start = ENVELOPE_START.exec(envelope);
  if (start === null || !envelope.startsWith('<soap:Body>', start[0].length)) {
    throw new AppError('integrity', 'the SOAP envelope is not the runtime\'s: no header is placed in it', { code: 'credential.ws_security_envelope' });
  }
  return envelope.slice(0, start[0].length) + header + envelope.slice(start[0].length);
}
