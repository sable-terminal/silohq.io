// The pieces of Fleet's SBOM checks (spec 11.1) on their own: CVSS scores, version order per
// ecosystem, package URLs, whether an OSV record affects a version, SBOM and VEX reading, and
// zip archives read by range (zip64 included).

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { advisoryOf, affects } from '../../src/services/fleet-control/advisories.service.ts';
import { holdOf, inWindow, localTime } from '../../src/services/fleet-control/changeWindows.service.ts';
import { readSbom, readVex } from '../../src/services/fleet-control/sbom.service.ts';
import { cvss3BaseScore, ratingOf } from '../../src/utils/cvss.util.ts';
import { osvPackageOf, parsePurl, purlIdentity } from '../../src/utils/purl.util.ts';
import { compareApk, compareDpkg, comparePep440, compareSemver, type Comparator } from '../../src/utils/versions.util.ts';
import { zipContents, zipEntries } from '../../src/utils/zip.util.ts';
import { zipOf } from './zipWriter.helper.ts';

const ascending = (compare: Comparator, versions: string[]): void => {
  for (let i = 0; i + 1 < versions.length; i++) {
    assert.ok(compare(versions[i]!, versions[i + 1]!)! < 0, `${versions[i]} < ${versions[i + 1]}`);
    assert.ok(compare(versions[i + 1]!, versions[i]!)! > 0, `${versions[i + 1]} > ${versions[i]}`);
  }
};

describe('CVSS v3 base scores', () => {
  test('score as FIRST\'s calculator does, and rate', () => {
    for (const [vector, score] of [
      ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8], ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10],
      ['CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', 5.5], ['CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N', 3.1],
      ['CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0],
    ] as const) assert.equal(cvss3BaseScore(vector), score, vector);
    assert.equal(cvss3BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'), undefined);
    assert.equal(cvss3BaseScore('CVSS:3.1/AV:N/AC:L'), undefined);
    assert.deepEqual([9.8, 7, 6.9, 0.1, 0].map(ratingOf), ['critical', 'high', 'medium', 'low', 'none']);
  });
});

describe('version order', () => {
  test('Semantic Versioning, with a leading v and any number of parts', () => {
    ascending(compareSemver, ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.2.0', '1.10.0', '2.0.0.1']);
    assert.equal(compareSemver('v1.2.3', '1.2.3+build'), 0);
    assert.equal(compareSemver('one', '1.0.0'), undefined);
  });
  test('PEP 440', () => {
    ascending(comparePep440, ['1.0.dev0', '1.0a1.dev1', '1.0a1', '1.0b2', '1.0rc1', '1.0', '1.0+local', '1.0.post1', '1.1', '1!0.1']);
    assert.equal(comparePep440('1.0', '1.0.0'), 0);
    assert.equal(comparePep440('1.0-1', '1.0.post1'), 0);
  });
  test('dpkg', () => {
    ascending(compareDpkg, ['1.0~rc1', '1.0', '1.0-1', '1.0-1+b1', '2.4-1', '2.30-1', '3.0.11-1~deb12u1', '3.0.11-1~deb12u2', '1:0.5']);
    assert.equal(compareDpkg('0:1.0-1', '1.0-1'), 0);
    assert.equal(compareDpkg('x1', '1.0'), undefined);
  });
  test('apk', () => {
    ascending(compareApk, ['1.2.3_alpha1', '1.2.3_rc1', '1.2.3', '1.2.3-r1', '1.2.3_p1', '1.2.3a', '1.9', '1.10']);
  });
});

describe('package URLs', () => {
  test('read into parts and into the package an advisory names', () => {
    const scoped = parsePurl('pkg:npm/%40scope/pkg@2.0.5?arch=x#sub')!;
    assert.deepEqual([scoped.namespace, scoped.name, scoped.version], ['@scope', 'pkg', '2.0.5']);
    assert.deepEqual(osvPackageOf(scoped), { ecosystem: 'npm', name: '@scope/pkg' });
    assert.equal(parsePurl('pkg:npm/@scope/pkg')!.version, undefined);
    assert.deepEqual(osvPackageOf(parsePurl('pkg:deb/debian/openssl@3.0.11-1~deb12u1?distro=debian-12')!), { ecosystem: 'Debian:12', name: 'openssl' });
    assert.deepEqual(osvPackageOf(parsePurl('pkg:deb/debian/zlib@1?distro=bookworm')!), { ecosystem: 'Debian:12', name: 'zlib' });
    assert.deepEqual(osvPackageOf(parsePurl('pkg:apk/alpine/musl@1.2.4-r2?distro=3.19.1')!), { ecosystem: 'Alpine:v3.19', name: 'musl' });
    assert.deepEqual(osvPackageOf(parsePurl('pkg:pypi/Django_Rest.Framework@3.14')!), { ecosystem: 'PyPI', name: 'django-rest-framework' });
    assert.deepEqual(osvPackageOf(parsePurl('pkg:maven/org.apache/commons-text@1.9')!), { ecosystem: 'Maven', name: 'org.apache:commons-text' });
    assert.equal(osvPackageOf(parsePurl('pkg:rpm/redhat/curl@7.61')!), undefined);
    assert.equal(purlIdentity(scoped), 'pkg:npm/%40scope/pkg@2.0.5');
    assert.equal(purlIdentity(scoped, false), 'pkg:npm/%40scope/pkg');
    assert.equal(parsePurl('npm/left-pad'), undefined);
  });
});

describe('whether an advisory affects a version (OSV evaluation)', () => {
  const advisory = advisoryOf({
    id: 'GHSA-aaaa', modified: '2026-11-01T00:00:00Z', aliases: ['CVE-2026-0001'],
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
    affected: [
      { package: { ecosystem: 'npm', name: 'left-pad' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.3.0' }] }] },
      { package: { ecosystem: 'npm', name: 'other' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { last_affected: '2.1.0' }] }] },
      { package: { ecosystem: 'Maven', name: 'g:a' }, versions: ['1.0'], ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.0' }] }] },
      { package: { ecosystem: 'Maven', name: 'g:b' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.0' }] }] },
      { package: { ecosystem: 'Debian:12', name: 'openssl' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '3.0.11-1~deb12u2' }] }] },
    ],
  })!;

  test('rated from its vector', () => {
    assert.deepEqual([advisory.severity, advisory.score], ['critical', 9.8]);
    assert.equal(advisoryOf({ id: 'GHSA-b', modified: '2026-11-01T00:00:00Z', database_specific: { severity: 'MODERATE' } })!.severity, 'medium');
    assert.equal(advisoryOf({ id: 'MAL-2026-1', modified: '2026-11-01T00:00:00Z' })!.severity, 'critical', 'a malicious package is critical');
    assert.equal(advisoryOf({ id: 'DEBIAN-CVE-1', modified: '2026-11-01T00:00:00Z' })!.severity, 'unrated');
    assert.equal(advisoryOf({ id: 'X', modified: '2026-11-01T00:00:00Z', withdrawn: '2026-11-02T00:00:00Z' })!.withdrawn, '2026-11-02T00:00:00.000Z');
    assert.equal(advisoryOf({ modified: '2026-11-01' }), undefined);
  });

  test('ranges, last_affected, listed versions, and ranges that cannot be ordered', () => {
    assert.equal(affects(advisory, 'npm', 'left-pad', '1.2.0'), 'affected');
    assert.equal(affects(advisory, 'npm', 'left-pad', '1.3.0'), 'not_affected');
    assert.equal(affects(advisory, 'npm', 'other', '2.1.0'), 'affected');
    assert.equal(affects(advisory, 'npm', 'other', '2.1.1'), 'not_affected');
    assert.equal(affects(advisory, 'npm', 'other', '1.9.0'), 'not_affected');
    assert.equal(affects(advisory, 'Maven', 'g:a', '1.0'), 'affected', 'listed');
    assert.equal(affects(advisory, 'Maven', 'g:a', '1.5'), 'not_affected', 'the list is the whole of it');
    assert.equal(affects(advisory, 'Maven', 'g:b', '1.5'), 'unresolved', 'no order for Maven, and no list: never taken as safe');
    assert.equal(affects(advisory, 'Debian:12', 'openssl', '3.0.11-1~deb12u1'), 'affected');
    assert.equal(affects(advisory, 'Debian:12', 'openssl', '3.0.11-1~deb12u2'), 'not_affected');
    assert.equal(affects(advisory, 'npm', 'left-pad', 'not-a-version'), 'unresolved');
  });
});

describe('SBOMs and VEX documents', () => {
  test('CycloneDX components to any depth, and SPDX packages, by purl', () => {
    const cyclonedx = readSbom(JSON.stringify({
      bomFormat: 'CycloneDX', specVersion: '1.5',
      components: [{ purl: 'pkg:npm/left-pad@1.2.0', components: [{ purl: 'pkg:npm/%40scope/pkg@2.0.5' }] }, { name: 'no purl' }, { purl: 'pkg:npm/left-pad@1.2.0' }],
    }), 'cyclonedx');
    assert.deepEqual(cyclonedx.components.map((c) => [c.ecosystem, c.name, c.version]), [['npm', 'left-pad', '1.2.0'], ['npm', '@scope/pkg', '2.0.5']]);
    assert.equal(cyclonedx.withoutPurl, 1);
    const spdx = readSbom(JSON.stringify({
      spdxVersion: 'SPDX-2.3', packages: [{ name: 'openssl', externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl',
        referenceLocator: 'pkg:deb/debian/openssl@3.0.11-1~deb12u1?distro=debian-12' }] }, { name: 'bare' }],
    }), 'spdx');
    assert.deepEqual(spdx.components.map((c) => c.ecosystem), ['Debian:12']);
    assert.throws(() => readSbom('{"spdxVersion":"SPDX-2.3"}', 'cyclonedx'), { code: 'fleet.sbom_invalid' });
    assert.throws(() => readSbom('not json', 'spdx'), { code: 'fleet.document_invalid' });
  });

  test('OpenVEX and CycloneDX VEX statements; not_affected needs a justification', () => {
    const open = readVex(JSON.stringify({
      '@context': 'https://openvex.dev/ns/v0.2.0', statements: [{
        vulnerability: { name: 'GHSA-aaaa' }, status: 'not_affected', justification: 'vulnerable_code_not_in_execute_path',
        products: [{ '@id': 'pkg:oci/auth', subcomponents: [{ '@id': 'pkg:npm/left-pad@1.2.0?x=1' }] }],
      }],
    }));
    assert.deepEqual(open, [{ vulnerability: 'GHSA-aaaa', purl: 'pkg:npm/left-pad@1.2.0', status: 'not_affected', justification: 'vulnerable_code_not_in_execute_path', impactStatement: null }]);
    const cyclonedx = readVex(JSON.stringify({
      bomFormat: 'CycloneDX', specVersion: '1.5',
      vulnerabilities: [{ id: 'CVE-2026-0001', analysis: { state: 'resolved' }, affects: [{ ref: 'pkg:deb/debian/openssl?distro=debian-12' }] }],
    }));
    assert.deepEqual(cyclonedx.map((s) => [s.status, s.purl]), [['fixed', 'pkg:deb/debian/openssl']]);
    assert.throws(() => readVex(JSON.stringify({
      '@context': 'https://openvex.dev/ns/v0.2.0', statements: [{ vulnerability: 'GHSA-aaaa', status: 'not_affected', products: [{ '@id': 'pkg:npm/x@1' }] }],
    })), { code: 'fleet.vex_unjustified' });
  });
});

describe('change windows and freezes (spec 11.5)', () => {
  const at = (iso: string): number => Date.parse(iso);
  test('a window is local time, across a change of clocks and past midnight', () => {
    // 2026-03-29: the UK clocks go forward; Sunday 01:30 local is 00:30 UTC before, 01:30 BST is 00:30 UTC after.
    assert.deepEqual(localTime('Europe/London', at('2026-03-28T23:30:00Z')), { day: 6, minute: 23 * 60 + 30 });
    assert.deepEqual(localTime('Europe/London', at('2026-07-04T23:30:00Z')), { day: 7, minute: 30 }, 'BST: Sunday 00:30');
    const late = { timeZone: 'Europe/London', windows: [{ day: 6, start: '22:00', end: '02:00' }] };
    assert.equal(inWindow(late, at('2026-07-04T21:30:00Z')), true, 'Saturday 22:30 BST');
    assert.equal(inWindow(late, at('2026-07-05T00:30:00Z')), true, 'Sunday 01:30 BST, the same window past midnight');
    assert.equal(inWindow(late, at('2026-07-05T01:30:00Z')), false, 'Sunday 02:30 BST');
    assert.equal(inWindow({ timeZone: 'America/New_York', windows: [{ day: 3, start: '09:00', end: '10:00' }] }, at('2026-11-04T14:30:00Z')), true);
    assert.equal(inWindow({ timeZone: 'Europe/London', windows: [] }, at('2026-11-04T14:30:00Z')), true, 'no windows: any time');
  });
  test('the notice, then a freeze, then the window hold a release; the change authority\'s approval lets a security fix through a freeze', () => {
    const freeze = { id: 'f1', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z', reason: 'year end' };
    const policy = { timeZone: 'UTC', windows: [{ day: 3, start: '09:00', end: '10:00' }], changeAuthorityMembershipId: 'm1', freezes: [freeze], exceptions: [] };
    const wednesday = at('2026-11-04T09:30:00Z');
    const plain = { releaseId: 'r1', securityFix: false };
    const fix = { releaseId: 'r1', securityFix: true };
    assert.equal(holdOf(policy, plain, wednesday - 3_600_000, 72 * 3_600_000, wednesday), 'notice');
    assert.equal(holdOf(policy, fix, wednesday - 3_600_000, 72 * 3_600_000, wednesday), 'freeze', 'a security fix needs no notice period');
    const approved = { ...policy, exceptions: [{ releaseId: 'r1', freezeId: 'f1', approvedBy: 'm1', approvedAt: '2026-11-03T00:00:00Z', statement: 'ok' }] };
    assert.equal(holdOf(approved, fix, wednesday, 0, wednesday), null);
    assert.equal(holdOf(approved, plain, wednesday, 0, wednesday), 'freeze', 'only a security fix passes a freeze');
    assert.equal(holdOf(approved, fix, wednesday, 0, wednesday + 3_600_000), 'window');
    assert.equal(holdOf(undefined, plain, wednesday, 0, wednesday), null, 'no policy reported: after the notice, any time');
  });
});

describe('zip archives read by range', () => {
  const files = [
    { name: 'GHSA-1.json', body: Buffer.from('{"id":"GHSA-1"}') },
    { name: 'big.bin', body: randomBytes(200_000), store: true },
    { name: 'GHSA-2.json', body: Buffer.from(JSON.stringify({ id: 'GHSA-2', pad: 'x'.repeat(50_000) })) },
  ];
  for (const zip64 of [false, true]) {
    test(`reads every entry back, checked, in small batches${zip64 ? ' (zip64)' : ''}`, async () => {
      const archive = zipOf(files, { zip64 });
      let reads = 0;
      const source = { size: archive.length, read: async (start: number, end: number) => { reads += 1; return archive.subarray(start, end); } };
      const listed = await zipEntries(source);
      assert.deepEqual(listed.entries.map((e) => e.name), files.map((f) => f.name));
      const read: { name: string; body: Buffer }[] = [];
      for await (const { entry, body } of zipContents(source, listed, { batchBytes: 64 * 1024 })) read.push({ name: entry.name, body });
      assert.deepEqual(read.map((r) => r.name), files.map((f) => f.name));
      assert.ok(read.every((r, i) => r.body.equals(files[i]!.body)));
      assert.ok(reads >= 4, 'read in parts, never whole');
    });
  }
  test('an entry whose bytes do not match its CRC-32 is refused', async () => {
    const archive = zipOf([{ name: 'a.json', body: Buffer.from('{"id":"a"}'), store: true }]);
    archive[30 + 'a.json'.length + 2] = archive[30 + 'a.json'.length + 2]! ^ 1;
    const source = { size: archive.length, read: async (start: number, end: number) => archive.subarray(start, end) };
    await assert.rejects(async () => {
      for await (const _ of zipContents(source, await zipEntries(source))) void _;
    }, { code: 'zip.malformed' });
    await assert.rejects(zipEntries({ size: 10, read: async () => Buffer.alloc(10) }), { code: 'zip.malformed' });
  });
});
