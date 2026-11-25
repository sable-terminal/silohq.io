import { handshakeHttp, type HttpSendOptions, type HttpWire } from '../../infra/network.infra';
import { refusal } from '../../utils/error.util';
import type { SocketAuth, WireResponse } from '../transports/contract.transport';
import { authenticateMessage, negotiateMessage, readChallenge } from './ntlm.auth';

/**
 * Windows authentication, performed by the agent on the connection itself.
 *
 * NTLM and Negotiate authenticate a SOCKET, not a request: a challenge comes
 * back on the connection and the answer must go back on the same one. So they
 * run where the socket is opened — inside the customer's network, in the
 * agent — and nowhere else. Silo places nothing for them; it tells the agent
 * which handshake to perform and with what (MANIFEST-V2 §9.1, F2).
 */

interface KerberosClient {
  step(challenge: string): Promise<string>;
}
interface KerberosModule {
  initializeClient(service: string, options?: Record<string, unknown>): Promise<KerberosClient>;
}

/** `DOMAIN\user` or `user@domain`, as Windows accounts are written. */
export function accountOf(username: string, domain: string | null): { user: string; domain: string } {
  const slash = username.indexOf('\\');
  if (slash > 0) return { domain: domain ?? username.slice(0, slash), user: username.slice(slash + 1) };
  const at = username.lastIndexOf('@');
  if (at > 0 && !domain) return { user: username.slice(0, at), domain: username.slice(at + 1) };
  return { user: username, domain: domain ?? '' };
}

const scheme = (headers: string[], name: string): string | null => {
  for (const header of headers) {
    for (const part of header.split(/,\s*(?=[A-Za-z]+(?:\s|$))/)) {
      const match = new RegExp(`^${name}(?:\\s+(\\S+))?$`, 'i').exec(part.trim());
      if (match) return match[1] ?? '';
    }
  }
  return null;
};

async function kerberos(): Promise<KerberosModule> {
  try {
    const name = 'kerberos';
    const loaded = (await import(name)) as KerberosModule & { default?: KerberosModule };
    return loaded.default ?? loaded;
  } catch {
    throw refusal({
      message: 'Kerberos needs the kerberos package installed beside the agent (npm install kerberos), and the machine joined to the domain or given a keytab.',
      code: 'refusal.agent_unsupported',
    });
  }
}

export async function sendWithHandshake(wire: HttpWire, socket: SocketAuth, options: HttpSendOptions & { inAgent: boolean }): Promise<WireResponse> {
  const handshake = socket.handshake!;
  if (!options.inAgent) {
    throw refusal({ message: 'Windows authentication is a handshake on the connection, so it runs inside your network, in the Silo agent.', code: 'refusal.agent_only' });
  }
  const url = new URL(wire.url);

  if (handshake.kind === 'ntlm') {
    const account = accountOf(socket.username ?? '', handshake.domain);
    const probe: HttpWire = { ...wire, headers: { ...wire.headers, authorization: `NTLM ${negotiateMessage()}`, 'content-length': '0' }, body: null };
    delete probe.headers['content-type'];
    return handshakeHttp(
      probe,
      async (challenges, status) => {
        const token = scheme(challenges, 'NTLM');
        if (status !== 401 || !token) return null;
        const message = authenticateMessage({ username: account.user, password: socket.password ?? '', domain: account.domain, workstation: handshake.workstation, challenge: readChallenge(token) });
        return { ...wire, headers: { ...wire.headers, authorization: `NTLM ${message}` } };
      },
      options,
    );
  }

  const module = await kerberos();
  const spn = handshake.servicePrincipal ?? `HTTP@${url.hostname}`;
  const account = socket.username && !handshake.useAgentIdentity ? accountOf(socket.username, null) : null;
  const client = await module.initializeClient(spn, account ? { user: account.user, domain: account.domain, password: socket.password } : {});
  const token = await client.step('');
  return handshakeHttp(
    { ...wire, headers: { ...wire.headers, authorization: `Negotiate ${token}` } },
    async (challenges, status) => {
      const answer = scheme(challenges, 'Negotiate');
      /* Mutual authentication on success: check the server's token; a continuation on 401: answer it. */
      if (answer) {
        const next = await client.step(answer);
        if (status === 401 && next) return { ...wire, headers: { ...wire.headers, authorization: `Negotiate ${next}` } };
      }
      return null;
    },
    options,
  );
}
