// Version order, per ecosystem, for deciding whether a component's version falls in an
// advisory's affected range (OSV schema, "Evaluation"). Each comparator returns a negative
// number, zero or a positive number, or undefined when either version cannot be read in
// that ecosystem's scheme: the caller then counts the match as unresolved, never as safe.
//
// - Semantic Versioning 2.0 precedence: npm, crates.io, Go (a leading "v" allowed), Hex,
//   Pub, NuGet and Packagist, with any number of numeric parts.
// - PEP 440: PyPI (epoch, release, pre-, post- and development releases, local labels).
// - dpkg (Debian Policy 5.6.12): Debian and Ubuntu, epoch:upstream-revision, "~" first.
// - apk: Alpine, numbers, a letter, suffixes (_alpha to _p) and -rN.
// An ecosystem without one here (Maven, RubyGems and others) is evaluated from the
// advisory's list of affected versions only.

export type Comparator = (a: string, b: string) => number | undefined;

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);
const compareBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

// ----------------------------------------------------------------------------- semver

interface Semver { numbers: bigint[]; pre: string[] }

function parseSemver(version: string): Semver | undefined {
  const text = version.trim().replace(/^v/i, '').split('+')[0]!;
  const dash = text.indexOf('-');
  const core = dash < 0 ? text : text.slice(0, dash);
  const pre = dash < 0 ? [] : text.slice(dash + 1).split('.');
  const parts = core.split('.');
  if (parts.length === 0 || parts.some((p) => !/^[0-9]+$/.test(p)) || pre.some((p) => p === '' || !/^[0-9A-Za-z-]+$/.test(p))) return undefined;
  return { numbers: parts.map((p) => BigInt(p)), pre };
}

export const compareSemver: Comparator = (a, b) => {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (x === undefined || y === undefined) return undefined;
  for (let i = 0; i < Math.max(x.numbers.length, y.numbers.length); i++) {
    const c = compareBig(x.numbers[i] ?? 0n, y.numbers[i] ?? 0n);
    if (c !== 0) return c;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^[0-9]+$/.test(p);
    const qn = /^[0-9]+$/.test(q);
    if (pn && qn) {
      const c = compareBig(BigInt(p), BigInt(q));
      if (c !== 0) return c;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
};

// ----------------------------------------------------------------------------- PEP 440

const PEP440 = new RegExp(
  '^v?(?:([0-9]+)!)?([0-9]+(?:\\.[0-9]+)*)'
  + '(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?([0-9]*))?'
  + '(?:-([0-9]+)|[-_.]?(post|rev|r)[-_.]?([0-9]*))?'
  + '(?:[-_.]?(dev)[-_.]?([0-9]*))?'
  + '(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$', 'i');

type Key = (number | string)[];

function pep440Key(version: string): { epoch: number; release: bigint[]; pre: [number, number]; post: number; dev: number; local: Key[] } | undefined {
  const m = PEP440.exec(version.trim());
  if (m === null) return undefined;
  const release = m[2]!.split('.').map((p) => BigInt(p));
  while (release.length > 1 && release[release.length - 1] === 0n) release.pop();
  const letter = m[3]?.toLowerCase();
  const rank = letter === undefined ? undefined : letter === 'a' || letter === 'alpha' ? 0 : letter === 'b' || letter === 'beta' ? 1 : 2;
  const hasPost = m[5] !== undefined || m[6] !== undefined;
  const post = m[5] !== undefined ? Number(m[5]) : m[6] !== undefined ? Number(m[7] || 0) : -Infinity;
  const hasDev = m[8] !== undefined;
  const dev = hasDev ? Number(m[9] || 0) : Infinity;
  // A development release with no pre- or post-release sorts before every pre-release.
  const pre: [number, number] = rank !== undefined ? [rank, Number(m[4] || 0)] : !hasPost && hasDev ? [-Infinity, 0] : [Infinity, 0];
  const local = m[10] === undefined ? [] : m[10].toLowerCase().split(/[-_.]/).map((s) => (/^[0-9]+$/.test(s) ? [1, Number(s)] : [0, s]));
  return { epoch: Number(m[1] ?? 0), release, pre, post, dev, local };
}

const compareKey = (a: Key, b: Key): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const p = a[i];
    const q = b[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
};

export const comparePep440: Comparator = (a, b) => {
  const x = pep440Key(a);
  const y = pep440Key(b);
  if (x === undefined || y === undefined) return undefined;
  if (x.epoch !== y.epoch) return sign(x.epoch - y.epoch);
  for (let i = 0; i < Math.max(x.release.length, y.release.length); i++) {
    const c = compareBig(x.release[i] ?? 0n, y.release[i] ?? 0n);
    if (c !== 0) return c;
  }
  const pre = compareKey(x.pre, y.pre);
  if (pre !== 0) return pre;
  if (x.post !== y.post) return x.post < y.post ? -1 : 1;
  if (x.dev !== y.dev) return x.dev < y.dev ? -1 : 1;
  if (x.local.length === 0 || y.local.length === 0) return sign(x.local.length - y.local.length);
  for (let i = 0; i < Math.max(x.local.length, y.local.length); i++) {
    const p = x.local[i];
    const q = y.local[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const c = compareKey(p, q);
    if (c !== 0) return c;
  }
  return 0;
};

// ----------------------------------------------------------------------------- dpkg

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

function order(c: string | undefined): number {
  if (c === undefined || isDigit(c)) return 0;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  if (c === '~') return -1;
  return c.charCodeAt(0) + 256;
}

function verrevcmp(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const x = order(i < a.length ? a[i] : undefined);
      const y = order(j < b.length ? b[j] : undefined);
      if (x !== y) return sign(x - y);
      i += 1;
      j += 1;
    }
    while (a[i] === '0') i += 1;
    while (b[j] === '0') j += 1;
    let firstDiff = 0;
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (firstDiff === 0) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
      i += 1;
      j += 1;
    }
    if (isDigit(a[i])) return 1;
    if (isDigit(b[j])) return -1;
    if (firstDiff !== 0) return sign(firstDiff);
  }
  return 0;
}

function parseDpkg(version: string): { epoch: number; upstream: string; revision: string } | undefined {
  const text = version.trim();
  const colon = text.indexOf(':');
  const epochText = colon < 0 ? '0' : text.slice(0, colon);
  if (!/^[0-9]+$/.test(epochText)) return undefined;
  const rest = colon < 0 ? text : text.slice(colon + 1);
  const dash = rest.lastIndexOf('-');
  const upstream = dash < 0 ? rest : rest.slice(0, dash);
  if (upstream === '' || !isDigit(upstream[0]) || !/^[A-Za-z0-9.+~:-]+$/.test(rest)) return undefined;
  return { epoch: Number(epochText), upstream, revision: dash < 0 ? '' : rest.slice(dash + 1) };
}

export const compareDpkg: Comparator = (a, b) => {
  const x = parseDpkg(a);
  const y = parseDpkg(b);
  if (x === undefined || y === undefined) return undefined;
  if (x.epoch !== y.epoch) return sign(x.epoch - y.epoch);
  return verrevcmp(x.upstream, y.upstream) || verrevcmp(x.revision, y.revision);
};

// ----------------------------------------------------------------------------- apk

const APK_SUFFIX: Record<string, number> = { alpha: 0, beta: 1, pre: 2, rc: 3, '': 4, cvs: 5, svn: 6, git: 7, hg: 8, p: 9 };
const APK = /^([0-9]+(?:\.[0-9]+)*)([a-z]?)((?:_(?:alpha|beta|pre|rc|cvs|svn|git|hg|p)[0-9]*)*)(?:-r([0-9]+))?$/;

function parseApk(version: string): { numbers: bigint[]; letter: string; suffixes: [number, bigint][]; revision: bigint } | undefined {
  const m = APK.exec(version.trim());
  if (m === null) return undefined;
  const suffixes = [...m[3]!.matchAll(/_([a-z]+)([0-9]*)/g)].map((s): [number, bigint] => [APK_SUFFIX[s[1]!]!, BigInt(s[2] || 0)]);
  return { numbers: m[1]!.split('.').map((p) => BigInt(p)), letter: m[2]!, suffixes, revision: BigInt(m[4] ?? 0) };
}

export const compareApk: Comparator = (a, b) => {
  const x = parseApk(a);
  const y = parseApk(b);
  if (x === undefined || y === undefined) return undefined;
  for (let i = 0; i < Math.max(x.numbers.length, y.numbers.length); i++) {
    const p = x.numbers[i];
    const q = y.numbers[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const c = compareBig(p, q);
    if (c !== 0) return c;
  }
  if (x.letter !== y.letter) return x.letter < y.letter ? -1 : 1;
  for (let i = 0; i < Math.max(x.suffixes.length, y.suffixes.length); i++) {
    const [pr, pn] = x.suffixes[i] ?? [APK_SUFFIX['']!, 0n];
    const [qr, qn] = y.suffixes[i] ?? [APK_SUFFIX['']!, 0n];
    if (pr !== qr) return sign(pr - qr);
    const c = compareBig(pn, qn);
    if (c !== 0) return c;
  }
  return compareBig(x.revision, y.revision);
};

// ----------------------------------------------------------------------------- by ecosystem

const SEMVER_ECOSYSTEMS = new Set(['npm', 'crates.io', 'Go', 'Hex', 'Pub', 'NuGet', 'Packagist']);

/** The comparator for an OSV ecosystem ("Debian:12" and "Alpine:v3.19" by their base), or undefined. */
export function comparatorFor(ecosystem: string): Comparator | undefined {
  const base = ecosystem.split(':')[0]!;
  if (SEMVER_ECOSYSTEMS.has(base)) return compareSemver;
  if (base === 'PyPI') return comparePep440;
  if (base === 'Debian' || base === 'Ubuntu') return compareDpkg;
  if (base === 'Alpine') return compareApk;
  return undefined;
}
