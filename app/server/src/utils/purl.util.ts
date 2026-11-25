// Package URLs (purl specification, ECMA-427): how an SBOM names a component, read into
// its parts and into the OSV ecosystem and package name an advisory names it by.
//
//   pkg:type/namespace/name@version?qualifiers#subpath
//
// Only the types Silo's images and binaries can hold have an ecosystem: npm, PyPI, Go,
// crates.io, Maven, NuGet, RubyGems, Packagist, Hex, Pub, and Debian and Alpine packages
// (their release from the distro qualifier). Any other type is kept but matched to nothing.

export interface Purl {
  type: string;
  namespace: string | undefined;
  name: string;
  version: string | undefined;
  qualifiers: Record<string, string>;
}

const decode = (part: string): string => decodeURIComponent(part);

export function parsePurl(text: string): Purl | undefined {
  if (!text.startsWith('pkg:')) return undefined;
  let rest = text.slice(4).replace(/^\/+/, '');
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  const qualifiers: Record<string, string> = {};
  const question = rest.indexOf('?');
  if (question >= 0) {
    for (const pair of rest.slice(question + 1).split('&')) {
      const eq = pair.indexOf('=');
      if (eq > 0) qualifiers[pair.slice(0, eq).toLowerCase()] = decode(pair.slice(eq + 1));
    }
    rest = rest.slice(0, question);
  }
  let version: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at > rest.lastIndexOf('/')) {
    version = decode(rest.slice(at + 1));
    rest = rest.slice(0, at);
  }
  const parts = rest.split('/').filter((p) => p !== '');
  if (parts.length < 2) return undefined;
  const type = parts.shift()!.toLowerCase();
  if (!/^[a-z][a-z0-9.+-]*$/.test(type)) return undefined;
  try {
    const name = decode(parts.pop()!);
    const namespace = parts.length === 0 ? undefined : parts.map(decode).join('/');
    if (name === '') return undefined;
    return { type, namespace, name, version: version === '' ? undefined : version, qualifiers };
  } catch {
    return undefined;
  }
}

/** PyPI names compare after PEP 503 normalisation, in advisories and SBOMs alike. */
export const normalisePypiName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

const DEBIAN_CODENAMES: Record<string, string> = { buster: '10', bullseye: '11', bookworm: '12', trixie: '13', forky: '14' };

function debianRelease(distro: string | undefined): string | undefined {
  if (distro === undefined) return undefined;
  const text = distro.toLowerCase().replace(/^debian-/, '');
  if (text in DEBIAN_CODENAMES) return DEBIAN_CODENAMES[text];
  const m = /^([0-9]+)(?:\.[0-9]+)*$/.exec(text);
  return m?.[1];
}

function alpineRelease(distro: string | undefined): string | undefined {
  const m = /^(?:alpine-)?v?([0-9]+\.[0-9]+)(?:\.[0-9]+)?$/i.exec(distro ?? '');
  return m === null ? undefined : `v${m[1]}`;
}

/** The OSV ecosystem and package name of a purl, or undefined where Silo has none to match. */
export function osvPackageOf(purl: Purl): { ecosystem: string; name: string } | undefined {
  const scoped = (separator: string): string => (purl.namespace === undefined ? purl.name : `${purl.namespace}${separator}${purl.name}`);
  switch (purl.type) {
    case 'npm': return { ecosystem: 'npm', name: scoped('/') };
    case 'pypi': return { ecosystem: 'PyPI', name: normalisePypiName(purl.name) };
    case 'golang': return { ecosystem: 'Go', name: scoped('/') };
    case 'cargo': return { ecosystem: 'crates.io', name: purl.name };
    case 'maven': return purl.namespace === undefined ? undefined : { ecosystem: 'Maven', name: scoped(':') };
    case 'nuget': return { ecosystem: 'NuGet', name: purl.name };
    case 'gem': return { ecosystem: 'RubyGems', name: purl.name };
    case 'composer': return { ecosystem: 'Packagist', name: scoped('/') };
    case 'hex': return { ecosystem: 'Hex', name: purl.name };
    case 'pub': return { ecosystem: 'Pub', name: purl.name };
    case 'deb': {
      if ((purl.namespace ?? '').toLowerCase() !== 'debian') return undefined;
      const release = debianRelease(purl.qualifiers['distro']);
      return release === undefined ? undefined : { ecosystem: `Debian:${release}`, name: purl.name };
    }
    case 'apk': {
      if ((purl.namespace ?? '').toLowerCase() !== 'alpine') return undefined;
      const release = alpineRelease(purl.qualifiers['distro']);
      return release === undefined ? undefined : { ecosystem: `Alpine:${release}`, name: purl.name };
    }
    default: return undefined;
  }
}

/** A purl without its qualifiers and subpath, the type in lower case: the form VEX statements are matched in. */
export function purlIdentity(purl: Purl, withVersion = true): string {
  const path = [purl.namespace, purl.name].filter((p): p is string => p !== undefined).map((p) => p.split('/').map(encodeURIComponent).join('/')).join('/');
  return `pkg:${purl.type}/${path}${withVersion && purl.version !== undefined ? `@${encodeURIComponent(purl.version)}` : ''}`;
}
