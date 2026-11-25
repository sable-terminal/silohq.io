// CIDR parsing, containment and overlap for private links and the egress.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cidrContains, cidrsOverlap, cidrWithin, isPrivateLinkRange, parseCidr } from '../../src/utils/network.util.ts';

const cidr = (text: string) => {
  const parsed = parseCidr(text);
  assert.ok(parsed, text);
  return parsed;
};

test('parses networks in CIDR notation, IPv4 and IPv6, and refuses host bits or nonsense', () => {
  assert.deepEqual(cidr('10.20.0.0/16'), { family: 4, base: 0x0a140000n, prefix: 16, text: '10.20.0.0/16' });
  assert.equal(cidr('FD00:1234:0:0::/48').text, 'fd00:1234::/48');
  assert.equal(cidr('fd00::/8').text, 'fd00::/8');
  assert.equal(cidr('2001:db8:0:1:0:0:0:0/64').text, '2001:db8:0:1::/64');
  assert.equal(cidr('10.0.0.1/32').text, '10.0.0.1/32');
  for (const bad of ['10.20.0.1/16', '10.0.0.0/33', '10.0.0.0', 'example.com/8', 'fd00::1/64', '10.0.0.0/-1', ' /8', '1.2.3.4/8x']) {
    assert.equal(parseCidr(bad), undefined, bad);
  }
});

test('containment and overlap', () => {
  const net = cidr('10.20.0.0/16');
  assert.ok(cidrContains(net, '10.20.255.1'));
  assert.ok(!cidrContains(net, '10.21.0.1'));
  assert.ok(cidrContains(net, '::ffff:10.20.3.4'), 'an IPv4-mapped address is the IPv4 address');
  assert.ok(!cidrContains(net, 'fd00::1'));
  assert.ok(cidrContains(cidr('fd00:1234::/48'), 'fd00:1234:0:ffff::9'));
  assert.ok(cidrsOverlap(cidr('10.0.0.0/8'), net));
  assert.ok(cidrsOverlap(net, cidr('10.20.128.0/17')));
  assert.ok(!cidrsOverlap(net, cidr('10.21.0.0/16')));
  assert.ok(!cidrsOverlap(net, cidr('fd00::/8')));
  assert.ok(cidrWithin(net, cidr('10.0.0.0/8')));
  assert.ok(!cidrWithin(cidr('10.0.0.0/8'), net));
});

test('a private link carries private space only', () => {
  for (const ok of ['10.20.0.0/16', '172.16.0.0/12', '172.31.5.0/24', '192.168.1.0/24', '100.64.0.0/16', 'fd00:1234::/48']) {
    assert.ok(isPrivateLinkRange(cidr(ok)), ok);
  }
  for (const no of ['8.8.8.0/24', '127.0.0.0/8', '169.254.0.0/16', '172.15.0.0/16', '0.0.0.0/0', '2001:db8::/32', 'fe80::/10', '172.0.0.0/8']) {
    assert.ok(!isPrivateLinkRange(cidr(no)), no);
  }
});
