// Address ranges in CIDR notation, for private links (contracts/connect-registry/
// privateLink) and the egress that honours them. Pure: parsing, containment and overlap,
// IPv4 and IPv6 alike, with addresses as integers.

import { isIP } from 'node:net';

export interface Cidr {
  family: 4 | 6;
  /** The network's first address, as an integer. */
  base: bigint;
  prefix: number;
  /** Canonical text: the network address and prefix, IPv6 lower-cased and compressed as written by Postgres. */
  text: string;
}

const BITS = { 4: 32, 6: 128 } as const;

function ipv4ToInt(address: string): bigint {
  return address.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
}

function ipv6ToInt(address: string): bigint | undefined {
  let text = address.toLowerCase();
  // An embedded IPv4 tail (::ffff:10.0.0.1) becomes two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (tail !== undefined) {
    const v4 = ipv4ToInt(tail);
    text = `${text.slice(0, -tail.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : halves[1]!.split(':')) : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  return groups.reduce((n, group) => (n << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

/** The address as an integer, and its family; undefined for anything that is not an IP address. */
export function addressToInt(address: string): { family: 4 | 6; value: bigint } | undefined {
  const family = isIP(address);
  if (family === 4) return { family, value: ipv4ToInt(address) };
  if (family === 6) {
    const value = ipv6ToInt(address);
    return value === undefined ? undefined : { family, value };
  }
  return undefined;
}

function intToText(family: 4 | 6, value: bigint): string {
  if (family === 4) return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');
  const groups = Array.from({ length: 8 }, (_, i) => ((value >> BigInt(112 - i * 16)) & 0xffffn).toString(16));
  // The longest run of two or more zero groups becomes ::.
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i += 1; continue; }
    let j = i;
    while (j < 8 && groups[j] === '0') j += 1;
    if (j - i > best.length && j - i >= 2) best = { start: i, length: j - i };
    i = j;
  }
  if (best.start === -1) return groups.join(':');
  return `${groups.slice(0, best.start).join(':')}::${groups.slice(best.start + best.length).join(':')}`;
}

const maskOf = (family: 4 | 6, prefix: number): bigint => {
  const bits = BigInt(BITS[family]);
  return ((1n << bits) - 1n) ^ ((1n << (bits - BigInt(prefix))) - 1n);
};

/** A network in CIDR notation, or undefined when it is not one. Host bits must be zero, as Postgres's cidr type requires. */
export function parseCidr(text: string): Cidr | undefined {
  const match = /^([^/\s]+)\/(\d{1,3})$/.exec(text.trim());
  if (!match) return undefined;
  const address = addressToInt(match[1]!);
  const prefix = Number(match[2]);
  if (address === undefined || prefix > BITS[address.family]) return undefined;
  if ((address.value & maskOf(address.family, prefix)) !== address.value) return undefined;
  return { family: address.family, base: address.value, prefix, text: `${intToText(address.family, address.value)}/${prefix}` };
}

/** Whether the network holds the address. */
export function cidrContains(network: Cidr, address: string): boolean {
  const parsed = addressToInt(address);
  if (parsed === undefined) return false;
  // An IPv4-mapped IPv6 address is the IPv4 address.
  const value = parsed.family === 6 && network.family === 4 && parsed.value >> 32n === 0xffffn ? parsed.value & 0xffffffffn : parsed.value;
  const family = parsed.family === 6 && network.family === 4 && parsed.value >> 32n === 0xffffn ? 4 : parsed.family;
  return family === network.family && (value & maskOf(network.family, network.prefix)) === network.base;
}

/** Whether two networks share any address. */
export function cidrsOverlap(a: Cidr, b: Cidr): boolean {
  if (a.family !== b.family) return false;
  const prefix = Math.min(a.prefix, b.prefix);
  const mask = maskOf(a.family, prefix);
  return (a.base & mask) === (b.base & mask);
}

/** Whether every address of the inner network is in the outer one. */
export function cidrWithin(inner: Cidr, outer: Cidr): boolean {
  return inner.family === outer.family && inner.prefix >= outer.prefix && (inner.base & maskOf(outer.family, outer.prefix)) === outer.base;
}

// The ranges a private link may carry: RFC 1918, shared address space (RFC 6598), and IPv6
// unique local addresses (RFC 4193). Never loopback, link-local, metadata or public space.
export const PRIVATE_LINK_SPACE: readonly Cidr[] = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7']
  .map((text) => parseCidr(text)!);

/** Whether a network lies wholly inside the space a private link may carry. */
export function isPrivateLinkRange(network: Cidr): boolean {
  return PRIVATE_LINK_SPACE.some((space) => cidrWithin(network, space));
}
