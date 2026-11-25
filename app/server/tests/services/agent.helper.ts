// Silo Agent material for tests (spec 10.2): a CA as a deployment holds one, an agent's
// signing request made from a key that stays with it, the agent endpoint's own TLS
// certificate, and a fake agent speaking the tunnel's frames. Built with the library the cell
// signs with; tests only.

import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';
import { connect, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

const pkcs8Pem = async (key: webcrypto.CryptoKey): Promise<string> =>
  `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await webcrypto.subtle.exportKey('pkcs8', key)).toString('base64')}\n-----END PRIVATE KEY-----\n`;

/** A CA as a deployment would hold one: its certificate and its key in PKCS#8 PEM. */
export async function testAgentCa(): Promise<{ certificatePem: string; keyPem: string }> {
  const keys = await webcrypto.subtle.generateKey(P256, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01', name: 'CN=Silo agent CA test-cell', notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 365 * 86_400_000),
    keys, signingAlgorithm: SIGN, extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)],
  });
  return { certificatePem: certificate.toString('pem'), keyPem: await pkcs8Pem(keys.privateKey) };
}

/** An agent's request, as the agent makes it from a key that never leaves it. */
export async function testAgentRequest(algorithm: 'P-256' | 'RSA' = 'P-256'): Promise<string> {
  const rsa = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' } as const;
  const keys = await webcrypto.subtle.generateKey(algorithm === 'RSA' ? rsa : P256, false, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  const request = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=agent', keys, signingAlgorithm: algorithm === 'RSA' ? rsa : SIGN,
  });
  return request.toString('pem');
}


/** The agent endpoint's own certificate: self-signed, for agent.<cell> and 127.0.0.1. */
export async function testEndpointTls(hostname: string): Promise<{ cert: string; key: string }> {
  const keys = await webcrypto.subtle.generateKey(P256, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '02', name: `CN=${hostname}`, notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 30 * 86_400_000),
    keys, signingAlgorithm: SIGN,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: hostname }, { type: 'ip', value: '127.0.0.1' }], false)],
  });
  return { cert: certificate.toString('pem'), key: await pkcs8Pem(keys.privateKey) };
}

/** An agent's key pair, kept by the test as the agent keeps its own: the request and the private key to present. */
export async function testAgentKey(): Promise<{ csr: string; keyPem: string }> {
  const keys = await webcrypto.subtle.generateKey(P256, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  const request = await x509.Pkcs10CertificateRequestGenerator.create({ name: 'CN=agent', keys, signingAlgorithm: SIGN });
  return { csr: request.toString('pem'), keyPem: await pkcs8Pem(keys.privateKey) };
}

export interface FakeWork { id: string; kind: string; payload: Record<string, unknown> }
export type FakeAnswer = (work: FakeWork) => unknown[] | undefined;

/** An agent as the Go agent behaves on the wire: one tunnel, heartbeats, an answer stream per piece of work. */
export interface FakeAgent {
  agentId: string;
  session: ClientHttp2Session;
  tunnel: ClientHttp2Stream;
  closes: string[];
  works: FakeWork[];
  status: Promise<number>;
  load: { activeCalls: number };
  beating: boolean;
  answer: FakeAnswer;
  respond(workId: string, frames: unknown[]): Promise<number>;
  close(): void;
}

/** Opens a fake agent's tunnel to an agent endpoint and keeps it beating. */
export function startFakeAgent(options: {
  port: number; serverCert: string; servername: string; beatMs: number;
  identity: { agentId: string; cert: string; key: string }; version: string; activeCalls: number;
}): FakeAgent {
  const { identity, version } = options;
  const session = connect(`https://127.0.0.1:${options.port}`, {
    ca: options.serverCert, cert: identity.cert, key: identity.key, servername: options.servername, minVersion: 'TLSv1.3',
  });
  session.on('error', () => undefined);
  const tunnel = session.request({ ':method': 'POST', ':path': '/v1/tunnel', 'content-type': 'application/x-ndjson' }, { endStream: false });
  tunnel.on('error', () => undefined);
  const agent: FakeAgent = {
    agentId: identity.agentId, session, tunnel, closes: [], works: [], load: { activeCalls: options.activeCalls }, beating: true,
    status: new Promise((resolve) => tunnel.once('response', (headers) => resolve(Number(headers[':status'])))),
    answer: (work) => (work.kind === 'ping' ? [{ type: 'pong', version }] : undefined),
    respond(workId, frames) {
      return new Promise((resolve) => {
        const stream = session.request({ ':method': 'POST', ':path': `/v1/work/${workId}`, 'content-type': 'application/x-ndjson' });
        stream.on('response', (headers) => resolve(Number(headers[':status'])));
        stream.on('error', () => resolve(0));
        stream.resume();
        stream.end(frames.map((f) => `${JSON.stringify(f)}\n`).join(''));
      });
    },
    close() {
      clearInterval(timer);
      tunnel.close();
      session.destroy();
    },
  };
  const beat = (): void => {
    if (agent.beating) tunnel.write(`${JSON.stringify({ type: 'heartbeat', version, activeCalls: agent.load.activeCalls, cdcReaders: 0, discoveryDisabled: false })}\n`);
  };
  beat();
  const timer = setInterval(beat, options.beatMs);
  let carry = '';
  tunnel.on('data', (chunk: Buffer) => {
    carry += chunk.toString();
    let newline = carry.indexOf('\n');
    while (newline >= 0) {
      const frame = JSON.parse(carry.slice(0, newline)) as { type: string; reason?: string } & FakeWork;
      carry = carry.slice(newline + 1);
      if (frame.type === 'close') agent.closes.push(frame.reason!);
      if (frame.type === 'work') {
        agent.works.push(frame);
        const frames = agent.answer(frame);
        if (frames !== undefined) void agent.respond(frame.id, frames);
      }
      newline = carry.indexOf('\n');
    }
  });
  return agent;
}
