// The PKCS#11 HSM adapter (decision 2026-11-14; the Luna profile D206).
//
// Against a fake module, everywhere: it behaves as Thales documents a Luna partition in FIPS
// mode (an IV from the caller refused; one generated and returned after the ciphertext and
// tag, 16 bytes before firmware 7.9.3 and the asked-for length from it; the Crypto User's
// login), or as a generic module (the caller's IV used), and can drop its session as a
// network HSM's failover does. Against a real module when one is given (skipped otherwise,
// like the Cloud KMS test), under the profile the cell will use, so commissioning a Luna proves
// its Crypto User login and the IV it generates (docs/siloOperations.doc.md section 9):
//   TEST_PKCS11_MODULE        the vendor library (Luna's libCryptoki2_64.so; SoftHSM's libsofthsm2.so)
//   TEST_PKCS11_PIN           the user's PIN (Luna: the partition's Crypto User)
//   TEST_PKCS11_PROFILE       generic (default) or luna
//   TEST_PKCS11_TOKEN_LABEL   the partition or token by label (required for luna); else TEST_PKCS11_SLOT, default 0
//   TEST_PKCS11_WRAP_LABEL    the AES wrapping key (default silo-wrap)
//   TEST_PKCS11_MAC_LABEL     the HMAC key (default silo-mac)
//   TEST_PKCS11_IMPORT_LABEL  the RSA import key pair, checked when given

import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import type { KmsConfig } from '../../src/config/kms.config.ts';
import {
  chooseSlot, decodeWrapped, encodeWrapped, labelOf, LUNA_CKU_CRYPTO_USER, pkcs11KeyManagement, splitHsmIv,
} from '../../src/infra/pkcs11.infra.ts';

const module = process.env['TEST_PKCS11_MODULE'];

class Pkcs11Error extends Error {
  readonly code: number;
  constructor(code: number, name: string) {
    super(name);
    this.code = code;
  }
}
const CKR_MECHANISM_PARAM_INVALID = 0x71;
const CKR_ENCRYPTED_DATA_INVALID = 0x40;
const CKR_SESSION_HANDLE_INVALID = 0xb3;
const CKR_PIN_INCORRECT = 0xa0;

/** A PKCS#11 module as graphene presents it: one token per slot, keys found by label. */
function fakeHsm(behaviour: { fips: false } | { fips: true; firmware: '7.8.4' | '7.9.3' }, options: { pin?: string } = {}) {
  const keys = new Map([['silo-wrap', { key: randomBytes(32), encrypt: true, decrypt: true, sign: false }], ['silo-mac', { key: randomBytes(32), encrypt: false, decrypt: false, sign: true }]]);
  const state = { opened: 0, logins: [] as number[], live: 0, refuseOpen: false };
  const collection = <T>(items: T[]) => ({ length: items.length, items: (i: number) => items[i]! });
  const live = (id: number) => {
    if (id !== state.live) throw new Pkcs11Error(CKR_SESSION_HANDLE_INVALID, 'CKR_SESSION_HANDLE_INVALID');
  };
  const openSession = () => {
    if (state.refuseOpen) throw new Pkcs11Error(0x30, 'CKR_DEVICE_ERROR');
    const id = ++state.opened;
    state.live = id;
    return {
      login(pin: string, type: number) {
        live(id);
        if (pin !== (options.pin ?? 'pin')) throw new Pkcs11Error(CKR_PIN_INCORRECT, 'CKR_PIN_INCORRECT');
        state.logins.push(type);
      },
      logout() {},
      close() {},
      find(q: { class: number; label: string }) {
        live(id);
        const k = q.class === 4 ? keys.get(q.label) : undefined;
        return collection(k === undefined ? [] : [{ ...k, toType: () => k, getAttribute: () => ({ encrypt: k.encrypt, decrypt: k.decrypt, sign: k.sign }) }]);
      },
      createCipher(alg: { params: { iv: Buffer; aad: Buffer; tagBits: number } }, key: { key: Buffer }) {
        live(id);
        let iv = alg.params.iv;
        if (behaviour.fips) {
          // FIPS mode: the caller's IV is refused, the HSM makes its own.
          if (iv.some((b) => b !== 0)) throw new Pkcs11Error(CKR_MECHANISM_PARAM_INVALID, 'CKR_MECHANISM_PARAM_INVALID');
          iv = randomBytes(behaviour.firmware === '7.8.4' ? 16 : iv.length);
        }
        const c = createCipheriv('aes-256-gcm', key.key, iv, { authTagLength: alg.params.tagBits / 8 }).setAAD(alg.params.aad);
        return {
          update: (data: Buffer) => c.update(data),
          final: () => Buffer.concat([c.final(), c.getAuthTag(), behaviour.fips ? iv : Buffer.alloc(0)]),
        };
      },
      createDecipher(alg: { params: { iv: Buffer; aad: Buffer } }, key: { key: Buffer }) {
        live(id);
        const parts: Buffer[] = [];
        return {
          update: (data: Buffer) => {
            parts.push(Buffer.from(data));
            return Buffer.alloc(0);
          },
          final: () => {
            const all = Buffer.concat(parts);
            const d = createDecipheriv('aes-256-gcm', key.key, alg.params.iv).setAAD(alg.params.aad);
            d.setAuthTag(all.subarray(all.length - 16));
            try {
              return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
            } catch {
              throw new Pkcs11Error(CKR_ENCRYPTED_DATA_INVALID, 'CKR_ENCRYPTED_DATA_INVALID');
            }
          },
        };
      },
      createSign(_alg: string, key: { key: Buffer }) {
        live(id);
        return { once: (data: Buffer) => createHmac('sha256', key.key).update(data).digest() };
      },
    };
  };
  const slots = [{ getToken: () => ({ label: 'another-partition' }), open: openSession }, { getToken: () => ({ label: 'silo-sov-ha                     ' }), open: openSession }];
  const graphene = {
    Module: { load: () => ({ initialize() {}, finalize() {}, getSlots: () => collection(slots) }) },
    SessionFlag: { SERIAL_SESSION: 4, RW_SESSION: 2 },
    ObjectClass: { SECRET_KEY: 4, PUBLIC_KEY: 2, PRIVATE_KEY: 3 },
    AesGcmParams: class {
      iv: Buffer;
      aad: Buffer;
      tagBits: number;
      constructor(iv: Buffer, aad: Buffer, tagBits: number) {
        this.iv = iv;
        this.aad = aad;
        this.tagBits = tagBits;
      }
    },
  };
  return {
    state,
    /** The HSM fails over: every open session is gone. */
    drop: () => { state.live = -1; },
    load: async () => graphene as never,
  };
}

const luna: KmsConfig = { provider: 'pkcs11_hsm', vaultTransitMount: 'transit', pkcs11ModulePath: '/usr/safenet/lunaclient/lib/libCryptoki2_64.so', pkcs11Pin: 'pin',
  pkcs11Profile: 'luna', pkcs11TokenLabel: 'silo-sov-ha' };
const generic: KmsConfig = { provider: 'pkcs11_hsm', vaultTransitMount: 'transit', pkcs11ModulePath: '/usr/lib/softhsm/libsofthsm2.so', pkcs11Pin: 'pin', pkcs11Slot: 0 };
const WRAP = 'pkcs11:object=silo-wrap';
const binding = Buffer.from('table:id:column');

describe('PKCS#11 HSM (decision 2026-11-14)', () => {
  test('a key URI names its object by label; a slot by number or by its token\'s label', () => {
    assert.equal(labelOf('pkcs11:object=silo-wrap'), 'silo-wrap');
    assert.throws(() => labelOf('pkcs11:token=x'), { code: 'kms.pkcs11_hsm.uri' });
    const slots = { length: 2, items: (i: number) => ({ i, getToken: () => ({ label: ['a', 'silo-sov-ha  '][i]! }) }) };
    assert.equal(chooseSlot(slots, { tokenLabel: 'silo-sov-ha' }).i, 1);
    assert.equal(chooseSlot(slots, { slot: 0 }).i, 0);
    assert.throws(() => chooseSlot(slots, { tokenLabel: 'nope' }), { code: 'kms.pkcs11_hsm.token_missing' });
    assert.throws(() => chooseSlot(slots, { slot: 5 }), { code: 'kms.pkcs11_hsm.slot_missing' });
  });

  test('a wrapped key carries its IV\'s length; Luna\'s IV is read from after the tag, and never zeros', () => {
    const iv = randomBytes(16);
    const body = randomBytes(48);
    assert.deepEqual(decodeWrapped(encodeWrapped(iv, body)), { iv, body });
    assert.throws(() => decodeWrapped(Buffer.concat([Buffer.from([13]), randomBytes(60)])), { code: 'kms.pkcs11_hsm.unwrap_refused' });
    assert.throws(() => decodeWrapped(Buffer.from([12, 1, 2])), { code: 'kms.pkcs11_hsm.unwrap_refused' });
    assert.deepEqual(splitHsmIv(Buffer.concat([body, iv]), 32), { iv, body });
    assert.throws(() => splitHsmIv(body, 32), { code: 'kms.pkcs11_hsm.iv_not_generated' });
    assert.throws(() => splitHsmIv(Buffer.concat([body, Buffer.alloc(12)]), 32), { code: 'kms.pkcs11_hsm.iv_not_generated' });
  });

  for (const firmware of ['7.8.4', '7.9.3'] as const) {
    test(`the luna profile on a Luna in FIPS mode (firmware ${firmware}): the partition by label, the Crypto User, the HSM's own IV`, async () => {
      const hsm = fakeHsm({ fips: true, firmware });
      const kms = await pkcs11KeyManagement(luna, hsm.load);
      try {
        assert.deepEqual(hsm.state.logins, [LUNA_CKU_CRYPTO_USER], 'the Crypto User: keys used, never created');
        assert.equal(await kms.verifyKey(WRAP, 'wrap'), 'ok', 'proved by a wrap and an unwrap at start');
        const wrapper = kms.wrapper({ id: 'v1', keyUri: WRAP });
        const dek = randomBytes(32);
        const wrapped = await wrapper.wrap(dek, binding);
        assert.equal(wrapped[0], firmware === '7.8.4' ? 16 : 12, 'the IV the HSM made, at its length');
        assert.equal(wrapped.length, 1 + wrapped[0]! + 32 + 16);
        assert.deepEqual(await wrapper.unwrap(wrapped, binding), dek);
        await assert.rejects(wrapper.unwrap(wrapped, Buffer.from('another:binding')), { code: 'kms.pkcs11_hsm.unwrap_refused' });
        assert.equal((await kms.mac('pkcs11:object=silo-mac', Buffer.from('x'))).length, 32);
      } finally {
        await kms.close();
      }
    });
  }

  test('a profile that does not match the HSM fails at start, saying which way', async () => {
    // The generic profile's own IV, refused by a Luna in FIPS mode: the key is unusable as configured.
    const onLuna = await pkcs11KeyManagement({ ...generic, pkcs11Slot: undefined, pkcs11TokenLabel: 'silo-sov-ha' }, fakeHsm({ fips: true, firmware: '7.9.3' }).load);
    assert.equal(await onLuna.verifyKey(WRAP, 'wrap'), 'unusable');
    // The luna profile on a module that used the zeros it was given: nothing is wrapped under them.
    const notLuna = await pkcs11KeyManagement(luna, fakeHsm({ fips: false }).load);
    await assert.rejects(notLuna.verifyKey(WRAP, 'wrap'), { code: 'kms.pkcs11_hsm.iv_not_generated' });
    await assert.rejects(notLuna.wrapper({ id: 'v1', keyUri: WRAP }).wrap(randomBytes(32), binding), { code: 'kms.pkcs11_hsm.iv_not_generated' });
    // A partition that is not there, or a wrong PIN: unavailable or misconfigured at start.
    await assert.rejects(pkcs11KeyManagement({ ...luna, pkcs11TokenLabel: 'missing' }, fakeHsm({ fips: true, firmware: '7.9.3' }).load), { code: 'kms.pkcs11_hsm.token_missing' });
    await assert.rejects(pkcs11KeyManagement(luna, fakeHsm({ fips: true, firmware: '7.9.3' }, { pin: 'other' }).load), { code: 'kms.pkcs11_hsm.unavailable' });
  });

  test('a session lost to a failover is opened again once; an HSM still gone is unavailable', async () => {
    const hsm = fakeHsm({ fips: false });
    const kms = await pkcs11KeyManagement(generic, hsm.load);
    const wrapper = kms.wrapper({ id: 'v1', keyUri: WRAP });
    const dek = randomBytes(32);
    const wrapped = await wrapper.wrap(dek, binding);
    hsm.drop();
    assert.deepEqual(await wrapper.unwrap(wrapped, binding), dek);
    assert.deepEqual([hsm.state.opened, hsm.state.logins.length], [2, 2], 'opened and logged in again');
    hsm.drop();
    hsm.state.refuseOpen = true;
    await assert.rejects(wrapper.wrap(dek, binding), { code: 'kms.pkcs11_hsm.unavailable' });
    hsm.state.refuseOpen = false;
    assert.deepEqual(await wrapper.unwrap(wrapped, binding), dek, 'back once the HSM is');
  });

  test('wraps and unwraps in a real HSM under the cell\'s profile, bound to its context; MACs there', { skip: module === undefined ? 'TEST_PKCS11_MODULE is not set' : false }, async () => {
    const env = process.env;
    const profile = env['TEST_PKCS11_PROFILE'] === 'luna' ? 'luna' : 'generic';
    const tokenLabel = env['TEST_PKCS11_TOKEN_LABEL'];
    if (profile === 'luna') assert.ok(tokenLabel !== undefined, 'a Luna partition is named by its label: set TEST_PKCS11_TOKEN_LABEL');
    const kms = await pkcs11KeyManagement({
      provider: 'pkcs11_hsm', vaultTransitMount: 'transit', pkcs11ModulePath: module, pkcs11Pin: env['TEST_PKCS11_PIN'] ?? '1234', pkcs11Profile: profile,
      ...(tokenLabel !== undefined ? { pkcs11TokenLabel: tokenLabel } : { pkcs11Slot: Number(env['TEST_PKCS11_SLOT'] ?? 0) }),
    });
    const wrapUri = `pkcs11:object=${env['TEST_PKCS11_WRAP_LABEL'] ?? 'silo-wrap'}`;
    try {
      assert.equal(await kms.verifyKey(wrapUri, 'wrap'), 'ok');
      const wrapper = kms.wrapper({ id: 'v1', keyUri: wrapUri });
      const dek = Buffer.alloc(32, 7);
      const wrapped = await wrapper.wrap(dek, binding);
      assert.deepEqual(await wrapper.unwrap(wrapped, binding), dek);
      await assert.rejects(wrapper.unwrap(wrapped, Buffer.from('another:binding')), { code: 'kms.pkcs11_hsm.unwrap_refused' });
      // Each wrap its own IV, whoever makes it (the host, or a Luna in FIPS mode).
      assert.notDeepEqual(decodeWrapped(await wrapper.wrap(dek, binding)).iv, decodeWrapped(wrapped).iv);
      const macUri = `pkcs11:object=${env['TEST_PKCS11_MAC_LABEL'] ?? 'silo-mac'}`;
      assert.equal(await kms.verifyKey(macUri, 'mac'), 'ok');
      assert.equal((await kms.mac(macUri, Buffer.from('x'))).length, 32);
      const importLabel = env['TEST_PKCS11_IMPORT_LABEL'];
      if (importLabel !== undefined) {
        assert.equal(await kms.verifyKey(`pkcs11:object=${importLabel}`, 'import'), 'ok');
        assert.match(await kms.importPublicKey(`pkcs11:object=${importLabel}`), /^-----BEGIN PUBLIC KEY-----/);
      }
    } finally {
      await kms.close();
    }
  });
});
