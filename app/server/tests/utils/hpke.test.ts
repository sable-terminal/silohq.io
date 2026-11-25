// HPKE (RFC 9180; src/utils/hpke.util.ts): what is sealed opens only with the right key and
// the same info, and nothing altered opens. And it is the standard: Go's crypto/hpke, which the
// Silo Agent opens with, opens what this seals, and this opens what Go seals. That part is
// skipped where no Go toolchain is installed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { hpkeOpen, hpkeSeal, x25519PublicKey } from '../../src/utils/hpke.util.ts';

const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const pair = () => generateKeyPairSync('x25519');
const raw = (key: ReturnType<typeof pair>['publicKey']): Buffer => Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url');

describe('HPKE, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM', () => {
  test('sealed to a key opens with it, under the same info only', () => {
    const { publicKey, privateKey } = pair();
    const info = Buffer.from('silo.test.v1');
    const sealed = hpkeSeal(publicKey, info, Buffer.from('a database password'));
    assert.equal(sealed.length, 32 + 'a database password'.length + 16);
    assert.equal(hpkeOpen(privateKey, info, sealed).toString(), 'a database password');
    assert.throws(() => hpkeOpen(privateKey, Buffer.from('silo.test.v2'), sealed));
    assert.throws(() => hpkeOpen(pair().privateKey, info, sealed));
    for (const at of [0, 31, 32, sealed.length - 1]) {
      const altered = Buffer.from(sealed);
      altered[at]! ^= 1;
      assert.throws(() => hpkeOpen(privateKey, info, altered), `byte ${at} altered`);
    }
    assert.notDeepEqual(hpkeSeal(publicKey, info, Buffer.from('x')), hpkeSeal(publicKey, info, Buffer.from('x')), 'a fresh key each time');
    assert.ok(x25519PublicKey(raw(publicKey)).equals(publicKey));
    assert.throws(() => x25519PublicKey(Buffer.alloc(31)));
  });

  describe('the same as Go\'s crypto/hpke', { skip: hasGo ? false : 'no Go toolchain here' }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'silo-hpke-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, 'go.mod'), 'module hpketest\n\ngo 1.26\n');
    writeFileSync(path.join(dir, 'main.go'), `package main

import (
	"crypto/ecdh"
	"crypto/hpke"
	"encoding/hex"
	"fmt"
	"os"
)

func must(b []byte, err error) []byte {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	return b
}

func main() {
	kem := hpke.DHKEM(ecdh.X25519())
	key, _ := hex.DecodeString(os.Args[2])
	info, _ := hex.DecodeString(os.Args[3])
	data, _ := hex.DecodeString(os.Args[4])
	switch os.Args[1] {
	case "open":
		priv, err := kem.NewPrivateKey(key)
		if err != nil {
			panic(err)
		}
		fmt.Print(hex.EncodeToString(must(hpke.Open(priv, hpke.HKDFSHA256(), hpke.AES256GCM(), info, data))))
	case "seal":
		pub, err := kem.NewPublicKey(key)
		if err != nil {
			panic(err)
		}
		fmt.Print(hex.EncodeToString(must(hpke.Seal(pub, hpke.HKDFSHA256(), hpke.AES256GCM(), info, data))))
	}
}
`);
    const binary = path.join(dir, 'hpketest');
    const go = (...args: string[]): string => execFileSync(binary, args, { encoding: 'utf8' });

    test('Go opens what this seals, and this opens what Go seals', () => {
      execFileSync('go', ['build', '-o', binary, '.'], { cwd: dir, stdio: 'pipe' });
      const { publicKey, privateKey } = pair();
      const secret = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
      const info = Buffer.from('silo.agent_credential.v1\u0000{"agentId":"a"}');
      const plaintext = Buffer.from('{"password":"s3cret"}');

      const ours = hpkeSeal(publicKey, info, plaintext);
      assert.equal(go('open', secret.toString('hex'), info.toString('hex'), ours.toString('hex')), plaintext.toString('hex'));
      assert.throws(() => go('open', secret.toString('hex'), Buffer.from('other').toString('hex'), ours.toString('hex')), 'Go refuses other info');

      const theirs = Buffer.from(go('seal', raw(publicKey).toString('hex'), info.toString('hex'), plaintext.toString('hex')), 'hex');
      assert.equal(hpkeOpen(privateKey, info, theirs).toString(), plaintext.toString());
    });
  });
});
