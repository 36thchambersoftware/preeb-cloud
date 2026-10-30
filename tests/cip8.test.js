import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'tweetnacl';
import { blake2b } from '@noble/hashes/blake2.js';
import { bech32 } from 'bech32';
import { verifyCip8Signature } from '../api/_lib/cip8.js';

function head(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  return Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
}
const bstr = (buffer) => Buffer.concat([head(2, buffer.length), buffer]);
const text = (value) => Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);

function stakeAddressBytes(publicKey, header = 0xe1) {
  return Buffer.concat([Buffer.from([header]), Buffer.from(blake2b(publicKey, { dkLen: 28 }))]);
}

// A CIP-30 signData result: COSE_Sign1 over the payload, plus the COSE_Key.
function signData({ signerKeys, addressBytes, payload, addressInProtected = true }) {
  const protectedMap = addressInProtected
    ? Buffer.concat([Buffer.from([0xa2, 0x01, 0x27]), text('address'), bstr(addressBytes)])
    : Buffer.from([0xa1, 0x01, 0x27]);
  const protectedBytes = bstr(protectedMap);
  const payloadBytes = Buffer.from(payload);
  const sigStructure = Buffer.concat([
    Buffer.from([0x84]), text('Signature1'), protectedBytes, Buffer.from([0x40]), bstr(payloadBytes),
  ]);
  const signature = nacl.sign.detached(sigStructure, signerKeys.secretKey);
  const unprotected = addressInProtected
    ? Buffer.from([0xa0])
    : Buffer.concat([Buffer.from([0xa1]), text('address'), bstr(addressBytes)]);
  const coseSign1 = Buffer.concat([Buffer.from([0x84]), protectedBytes, unprotected, bstr(payloadBytes), bstr(Buffer.from(signature))]);
  const coseKey = Buffer.concat([Buffer.from([0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21]), bstr(Buffer.from(signerKeys.publicKey))]);
  return { signatureHex: coseSign1.toString('hex'), keyHex: coseKey.toString('hex') };
}

const stakeOf = (bytes) => bech32.encode('stake', bech32.toWords(bytes), 200);
const PAYLOAD = 'PREEB Claim\ncampaign:abcdefghjk\nstake:x\nnonce:1';

test('a signature from the stake key of the signed address verifies and names that stake address', () => {
  const keys = nacl.sign.keyPair();
  const address = stakeAddressBytes(keys.publicKey);
  const { signatureHex, keyHex } = signData({ signerKeys: keys, addressBytes: address, payload: PAYLOAD });
  assert.equal(verifyCip8Signature({ signatureHex, keyHex, expectedPayload: PAYLOAD }).stakeAddress, stakeOf(address));
});

test('a throwaway key cannot sign as someone else\'s stake address', () => {
  const victim = stakeAddressBytes(nacl.sign.keyPair().publicKey);
  const attacker = nacl.sign.keyPair();

  const protectedHeader = signData({ signerKeys: attacker, addressBytes: victim, payload: PAYLOAD });
  assert.throws(() => verifyCip8Signature({ ...protectedHeader, expectedPayload: PAYLOAD }), /does not belong/);

  // The unprotected map is not covered by the signature, so it cannot be used to smuggle an address in either.
  const unprotectedHeader = signData({ signerKeys: attacker, addressBytes: victim, payload: PAYLOAD, addressInProtected: false });
  assert.throws(() => verifyCip8Signature({ ...unprotectedHeader, expectedPayload: PAYLOAD }), /does not belong/);
});

test('payment-key signatures and base or script addresses are not accepted as stake ownership', () => {
  const keys = nacl.sign.keyPair();
  const hash = Buffer.from(blake2b(keys.publicKey, { dkLen: 28 }));

  const base = Buffer.concat([Buffer.from([0x01]), hash, hash]);
  assert.throws(() => verifyCip8Signature({ ...signData({ signerKeys: keys, addressBytes: base, payload: PAYLOAD }), expectedPayload: PAYLOAD }), /stake address/);

  const script = stakeAddressBytes(keys.publicKey, 0xf1);
  assert.throws(() => verifyCip8Signature({ ...signData({ signerKeys: keys, addressBytes: script, payload: PAYLOAD }), expectedPayload: PAYLOAD }), /stake address/);
});

test('the signed message must be exactly the expected challenge', () => {
  const keys = nacl.sign.keyPair();
  const signed = signData({ signerKeys: keys, addressBytes: stakeAddressBytes(keys.publicKey), payload: PAYLOAD });
  assert.throws(() => verifyCip8Signature({ ...signed, expectedPayload: `${PAYLOAD}!` }), /does not match/);
});

import { decodeCbor } from '../api/_lib/cbor.js';

test('hostile or truncated CBOR is rejected quickly instead of looping or allocating', () => {
  for (const hexInput of ['9f', '9affffffff', '5affffffff00', 'bf', 'bf01', '5f', '7f6161', '82', 'a1', '1b', '19', '1bffffffffffffffff']) {
    assert.throws(() => decodeCbor(Buffer.from(hexInput, 'hex')), undefined, hexInput);
  }
  // Deep nesting and oversized input are refused as well.
  assert.throws(() => decodeCbor(Buffer.from('81'.repeat(40) + '00', 'hex')), /deeply/);
  assert.throws(() => decodeCbor(Buffer.alloc(9000)), /too large/);
  assert.throws(() => verifyCip8Signature({ signatureHex: '9f', keyHex: '00', expectedPayload: 'x' }));
  assert.throws(() => verifyCip8Signature({ signatureHex: 'aa'.repeat(3000), keyHex: '00', expectedPayload: 'x' }), /too large/);
  // Ordinary structures still decode.
  assert.deepEqual(decodeCbor(Buffer.from('83010203', 'hex')).value, [1, 2, 3]);
});
