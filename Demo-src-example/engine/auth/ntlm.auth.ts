import { createHmac, randomBytes } from 'node:crypto';

/**
 * NTLMv2 message building (MS-NLMP), for the agent's handshake with a Windows
 * system on the customer's own network.
 *
 * ── WHY IT IS WRITTEN OUT ─────────────────────────────────────────────────
 *
 * NTLM's password hash is MD4, and OpenSSL 3 — so Node — no longer provides it.
 * The algorithm is tiny and fixed, so it is here rather than a dependency, and
 * the whole exchange is checked against the specification's own test vector
 * (MS-NLMP §4.2.4) rather than against a server's willingness to accept it.
 *
 * ONLY v2. NTLMv1 and LM responses are breakable offline and are never sent.
 */

/* ── MD4 (RFC 1320) ─────────────────────────────────────────────────────── */

export function md4(input: Buffer): Buffer {
  const bitLength = input.length * 8;
  const padded = Buffer.alloc(Math.ceil((input.length + 9) / 64) * 64);
  input.copy(padded);
  padded[input.length] = 0x80;
  padded.writeUInt32LE(bitLength >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor(bitLength / 2 ** 32), padded.length - 4);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
  const G = (x: number, y: number, z: number) => (x & y) | (x & z) | (y & z);
  const H = (x: number, y: number, z: number) => x ^ y ^ z;

  for (let offset = 0; offset < padded.length; offset += 64) {
    const X = Array.from({ length: 16 }, (_, i) => padded.readUInt32LE(offset + i * 4));
    const [aa, bb, cc, dd] = [a, b, c, d];
    for (const i of [0, 4, 8, 12]) {
      a = rotl((a + F(b, c, d) + X[i]!) | 0, 3);
      d = rotl((d + F(a, b, c) + X[i + 1]!) | 0, 7);
      c = rotl((c + F(d, a, b) + X[i + 2]!) | 0, 11);
      b = rotl((b + F(c, d, a) + X[i + 3]!) | 0, 19);
    }
    for (const i of [0, 1, 2, 3]) {
      a = rotl((a + G(b, c, d) + X[i]! + 0x5a827999) | 0, 3);
      d = rotl((d + G(a, b, c) + X[i + 4]! + 0x5a827999) | 0, 5);
      c = rotl((c + G(d, a, b) + X[i + 8]! + 0x5a827999) | 0, 9);
      b = rotl((b + G(c, d, a) + X[i + 12]! + 0x5a827999) | 0, 13);
    }
    for (const i of [0, 2, 1, 3]) {
      a = rotl((a + H(b, c, d) + X[i]! + 0x6ed9eba1) | 0, 3);
      d = rotl((d + H(a, b, c) + X[i + 8]! + 0x6ed9eba1) | 0, 9);
      c = rotl((c + H(d, a, b) + X[i + 4]! + 0x6ed9eba1) | 0, 11);
      b = rotl((b + H(c, d, a) + X[i + 12]! + 0x6ed9eba1) | 0, 15);
    }
    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  [a, b, c, d].forEach((v, i) => out.writeInt32LE(v, i * 4));
  return out;
}

/* ── Messages ───────────────────────────────────────────────────────────── */

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');
const utf16 = (text: string) => Buffer.from(text, 'utf16le');
const hmac = (key: Buffer, ...data: Buffer[]) => createHmac('md5', key).update(Buffer.concat(data)).digest();

/** UNICODE | OEM | REQUEST_TARGET | NTLM | ALWAYS_SIGN | EXTENDED_SESSIONSECURITY | TARGET_INFO | 128 | 56. */
const FLAGS = 0x00000001 | 0x00000002 | 0x00000004 | 0x00000200 | 0x00008000 | 0x00080000 | 0x00800000 | 0x20000000 | 0x80000000;

export function negotiateMessage(): string {
  const message = Buffer.alloc(32);
  SIGNATURE.copy(message);
  message.writeUInt32LE(1, 8);
  message.writeUInt32LE(FLAGS >>> 0, 12);
  /* No domain or workstation supplied: both fields empty, at the end of the fixed part. */
  message.writeUInt32LE(32, 20);
  message.writeUInt32LE(32, 28);
  return message.toString('base64');
}

export interface Challenge {
  serverChallenge: Buffer;
  targetInfo: Buffer;
  flags: number;
  /** MsvAvTimestamp, when the server sent one: the response must use it, and LMv2 must be zero. */
  timestamp: Buffer | null;
}

export function readChallenge(base64: string): Challenge {
  const message = Buffer.from(base64, 'base64');
  if (message.length < 32 || !message.subarray(0, 8).equals(SIGNATURE) || message.readUInt32LE(8) !== 2) {
    throw new Error('The server’s NTLM challenge is not an NTLM challenge.');
  }
  const flags = message.readUInt32LE(20);
  const serverChallenge = message.subarray(24, 32);
  let targetInfo = Buffer.alloc(0);
  if (message.length >= 48) {
    const length = message.readUInt16LE(40);
    const offset = message.readUInt32LE(44);
    if (offset + length <= message.length) targetInfo = message.subarray(offset, offset + length);
  }
  let timestamp: Buffer | null = null;
  for (let at = 0; at + 4 <= targetInfo.length; ) {
    const id = targetInfo.readUInt16LE(at);
    const length = targetInfo.readUInt16LE(at + 2);
    if (id === 0) break;
    if (id === 7 && length === 8) timestamp = targetInfo.subarray(at + 4, at + 12);
    at += 4 + length;
  }
  return { serverChallenge, targetInfo, flags, timestamp };
}

/** Windows FILETIME: hundreds of nanoseconds since 1601, little-endian. */
export function filetime(date: Date): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE((BigInt(date.getTime()) + 11_644_473_600_000n) * 10_000n);
  return out;
}

export interface Responses {
  lm: Buffer;
  nt: Buffer;
  ntProof: Buffer;
}

/** The NTLMv2 responses (MS-NLMP §3.3.2). */
export function responses(input: { username: string; password: string; domain: string; challenge: Challenge; clientChallenge: Buffer; time: Buffer }): Responses {
  const ntHash = md4(utf16(input.password));
  const ntowf = hmac(ntHash, utf16(input.username.toUpperCase() + input.domain));
  const time = input.challenge.timestamp ?? input.time;
  const temp = Buffer.concat([Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), time, input.clientChallenge, Buffer.alloc(4), input.challenge.targetInfo, Buffer.alloc(4)]);
  const ntProof = hmac(ntowf, input.challenge.serverChallenge, temp);
  const lm = input.challenge.timestamp ? Buffer.alloc(24) : Buffer.concat([hmac(ntowf, input.challenge.serverChallenge, input.clientChallenge), input.clientChallenge]);
  return { lm, nt: Buffer.concat([ntProof, temp]), ntProof };
}

export function authenticateMessage(input: { username: string; password: string; domain: string | null; workstation: string | null; challenge: Challenge; now?: Date }): string {
  const domain = input.domain ?? '';
  const { lm, nt } = responses({
    username: input.username,
    password: input.password,
    domain,
    challenge: input.challenge,
    clientChallenge: randomBytes(8),
    time: filetime(input.now ?? new Date()),
  });
  const fields = [lm, nt, utf16(domain), utf16(input.username), utf16(input.workstation ?? ''), Buffer.alloc(0)];
  const header = Buffer.alloc(64);
  SIGNATURE.copy(header);
  header.writeUInt32LE(3, 8);
  let offset = 64;
  fields.forEach((field, i) => {
    header.writeUInt16LE(field.length, 12 + i * 8);
    header.writeUInt16LE(field.length, 14 + i * 8);
    header.writeUInt32LE(offset, 16 + i * 8);
    offset += field.length;
  });
  header.writeUInt32LE((input.challenge.flags & FLAGS) >>> 0 || FLAGS >>> 0, 60);
  return Buffer.concat([header, ...fields]).toString('base64');
}
