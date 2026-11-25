// An SFTP connection's address (spec 14.4), read the same wherever the server is reached from:
// the credential service in the cell, or the Silo Agent on the customer's network.

import { AppError } from './errors.util.ts';

const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** A pinned host key as OpenSSH prints it: "SHA256:" and base64. */
export const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}=?$/;

/** The sftp:// URL's host, port and base path, a {params.<name>} part taking one DNS label. */
export function sftpTarget(baseUrl: string, params: Record<string, string | undefined>): { host: string; port: number; basePath: string } {
  const filled = baseUrl.replace(/\{params\.([a-z][a-z0-9_]*)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || !LABEL.test(value)) throw new AppError('validation', `the parameter ${name} is not one DNS label`, { code: 'connection.parameter_invalid', details: { parameter: name } });
    return value;
  });
  const match = /^sftp:\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(\/[^?#]*)?$/.exec(filled);
  if (match === null) throw new AppError('validation', 'the connection\'s sftp address does not read', { code: 'sftp.address_invalid' });
  const port = match[2] === undefined ? 22 : Number(match[2]);
  if (port < 1 || port > 65_535) throw new AppError('validation', 'the sftp port is out of range', { code: 'sftp.address_invalid' });
  return { host: match[1]!.replace(/^\[|\]$/g, ''), port, basePath: (match[3] ?? '').replace(/\/+$/, '') };
}

