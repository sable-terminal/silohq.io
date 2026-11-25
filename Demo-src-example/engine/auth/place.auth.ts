import { refusal } from '../../utils/error.util';
import type { AuthSurface } from '../transports/contract.transport';

/**
 * Put a value where a `place` string says, on whatever wire this is.
 *
 * `header:x-api-key`, `query:key`, `body:auth.token`, `cookie:session`,
 * `form:password`, `soap:Header/Security/UsernameToken`, `socket:password`. One grammar for every
 * strategy that places anything, and a refusal — never a no-op — for a place
 * this wire has no room for, because a credential silently not sent produces a
 * 401 that looks like a wrong key.
 */
type SocketField = 'username' | 'password' | 'accessToken' | 'privateKey' | 'passphrase' | 'registryUsername' | 'registryPassword';
const SOCKET_FIELDS: ReadonlySet<string> = new Set<SocketField>(['username', 'password', 'accessToken', 'privateKey', 'passphrase', 'registryUsername', 'registryPassword']);

export function place(surface: AuthSurface, where: string, value: string): void {
  const colon = where.indexOf(':');
  const kind = where.slice(0, colon);
  const name = where.slice(colon + 1);

  switch (kind) {
    case 'header':
      return surface.setHeader(name, value);
    case 'query':
      return surface.setQuery(name, value);
    case 'body':
      return surface.setBodyPath(name, value);
    case 'cookie':
      return surface.setCookie(name, value);
    case 'form':
      return surface.setForm(name, value);
    case 'soap':
      return surface.setSoapHeader(name, value);
    case 'socket':
      /*
       * A VALUE THE PROTOCOL TAKES ON THE CONNECTION, under a name the connector
       * chose: a database login in fields called `db_user`, a Kafka schema
       * registry's own key. Only these names; the socket's TLS and handshake are
       * never a placement.
       */
      if (!SOCKET_FIELDS.has(name)) {
        throw refusal({ message: `socket:${name} is not something a connection carries.`, code: 'refusal.auth_place_unsupported' });
      }
      surface.socket[name as SocketField] = value;
      return;
    default:
      throw refusal({
        message: `This connector places a credential at ${where}, which is not a place Silo knows.`,
        code: 'refusal.auth_place_unsupported',
      });
  }
}
