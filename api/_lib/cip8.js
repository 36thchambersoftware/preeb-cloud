import nacl from 'tweetnacl';
import { bech32 } from 'bech32';
import { decodeCbor } from './cbor.js';

/**
 * Verifies a CIP-30 `signData` result (CIP-8 COSE_Sign1) against an expected
 * plaintext challenge, and derives the stake address that actually produced
 * the signature (never trusts a client-supplied stake address).
 */

function cborHead(majorType, length) {
  const mt = majorType << 5;
  if (length < 24) return Buffer.from([mt | length]);
  if (length < 256) return Buffer.from([mt | 24, length]);
  if (length < 65536) {
    const b = Buffer.alloc(3);
    b[0] = mt | 25;
    b.writeUInt16BE(length, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = mt | 26;
  b.writeUInt32BE(length, 1);
  return b;
}

function cborTextHead(str) {
  const bytes = Buffer.from(str, 'utf8');
  return Buffer.concat([cborHead(3, bytes.length), bytes]);
}

function buildSigStructure(protectedBytes, payloadBytes) {
  return Buffer.concat([
    cborHead(4, 4),
    cborTextHead('Signature1'),
    cborHead(2, protectedBytes.length), protectedBytes,
    cborHead(2, 0),
    cborHead(2, payloadBytes.length), payloadBytes,
  ]);
}

function rewardAddressBytesToBech32(addressBytes) {
  const networkTag = addressBytes[0] & 0x0f;
  const hrp = networkTag === 1 ? 'stake' : 'stake_test';
  const words = bech32.toWords(addressBytes);
  return bech32.encode(hrp, words);
}

export function verifyCip8Signature({ signatureHex, keyHex, expectedPayload }) {
  const sigMessageBytes = Buffer.from(String(signatureHex || ''), 'hex');
  const keyBytes = Buffer.from(String(keyHex || ''), 'hex');

  if (sigMessageBytes.length === 0 || keyBytes.length === 0) {
    throw new Error('Missing signature or key');
  }

  const coseSign1 = decodeCbor(sigMessageBytes).value;
  if (!Array.isArray(coseSign1) || coseSign1.length !== 4) {
    throw new Error('Invalid COSE_Sign1 structure');
  }

  const [protectedBytesRaw, unprotectedMap, payloadField, signatureBytesRaw] = coseSign1;
  const protectedBytes = Buffer.from(protectedBytesRaw);
  const protectedMap = decodeCbor(protectedBytes).value;

  const addressField =
    (protectedMap instanceof Map && protectedMap.get('address')) ||
    (unprotectedMap instanceof Map && unprotectedMap.get('address'));

  if (!addressField) {
    throw new Error('Signed payload missing address header');
  }
  const addressBytes = Buffer.from(addressField);

  const coseKey = decodeCbor(keyBytes).value;
  const publicKeyField = coseKey instanceof Map ? coseKey.get(-2) : null;
  if (!publicKeyField) {
    throw new Error('Public key missing from COSE_Key');
  }
  const publicKeyBytes = Buffer.from(publicKeyField);

  const expectedPayloadBytes = Buffer.from(String(expectedPayload || ''), 'utf8');
  const payloadBytes = payloadField != null ? Buffer.from(payloadField) : expectedPayloadBytes;

  if (!payloadBytes.equals(expectedPayloadBytes)) {
    throw new Error('Signed message does not match expected challenge');
  }

  const sigStructure = buildSigStructure(protectedBytes, payloadBytes);
  const signatureBytes = Buffer.from(signatureBytesRaw);

  const verified = nacl.sign.detached.verify(
    new Uint8Array(sigStructure),
    new Uint8Array(signatureBytes),
    new Uint8Array(publicKeyBytes)
  );

  if (!verified) {
    throw new Error('Signature verification failed');
  }

  return {
    stakeAddress: rewardAddressBytesToBech32(addressBytes),
  };
}
