import { bech32 } from 'bech32';
import { blake2b } from '@noble/hashes/blake2.js';

const BECH32_LIMIT = 200;

function encodeAddress(hrp, bytes) {
  return bech32.encode(hrp, bech32.toWords(bytes), BECH32_LIMIT);
}

function rewardAddressFromHash(hash, isScript, networkId) {
  const header = (isScript ? 0xf0 : 0xe0) | networkId;
  return encodeAddress(networkId === 1 ? 'stake' : 'stake_test', Buffer.concat([Buffer.from([header]), hash]));
}

/**
 * Decodes a Shelley-era bech32 address. Byron (base58) and malformed values
 * return null so callers can skip them instead of throwing mid-snapshot.
 */
export function parseAddress(value) {
  if (typeof value !== 'string') return null;

  let decoded;
  try {
    decoded = bech32.decode(value.trim(), BECH32_LIMIT);
  } catch {
    return null;
  }

  const bytes = Buffer.from(bech32.fromWords(decoded.words));
  if (bytes.length < 29) return null;

  const type = bytes[0] >> 4;
  const networkId = bytes[0] & 0x0f;
  const result = {
    type,
    networkId,
    paymentIsScript: false,
    paymentHash: null,
    stakeIsScript: false,
    stakeHash: null,
    stakeAddress: null,
  };

  if (type <= 3) {
    if (bytes.length !== 57) return null;
    result.paymentIsScript = type === 1 || type === 3;
    result.stakeIsScript = type === 2 || type === 3;
    result.paymentHash = bytes.subarray(1, 29);
    result.stakeHash = bytes.subarray(29, 57);
  } else if (type === 4 || type === 5) {
    result.paymentIsScript = type === 5;
    result.paymentHash = bytes.subarray(1, 29);
  } else if (type === 6 || type === 7) {
    if (bytes.length !== 29) return null;
    result.paymentIsScript = type === 7;
    result.paymentHash = bytes.subarray(1, 29);
  } else if (type === 14 || type === 15) {
    if (bytes.length !== 29) return null;
    result.stakeIsScript = type === 15;
    result.stakeHash = bytes.subarray(1, 29);
  } else {
    return null;
  }

  if (result.stakeHash) {
    result.stakeAddress = rewardAddressFromHash(result.stakeHash, result.stakeIsScript, networkId);
  }
  return result;
}

export function isStakeAddress(value) {
  const parsed = parseAddress(value);
  return Boolean(parsed && (parsed.type === 14 || parsed.type === 15));
}

/** Enterprise address (no staking part) for a raw ed25519 public key. */
export function enterpriseAddressFromPublicKey(publicKey, networkId) {
  const keyHash = Buffer.from(blake2b(publicKey, { dkLen: 28 }));
  const header = 0x60 | networkId;
  return encodeAddress(networkId === 1 ? 'addr' : 'addr_test', Buffer.concat([Buffer.from([header]), keyHash]));
}

/**
 * True when `address` is a base address whose staking credential is
 * `stakeAddress`. Used to prove a payout address belongs to a verified wallet.
 */
export function addressBelongsToStake(address, stakeAddress) {
  const parsed = parseAddress(address);
  const stake = parseAddress(stakeAddress);
  if (!parsed?.stakeHash || !stake || stake.type < 14) return false;
  return parsed.type <= 3 && parsed.stakeAddress === stake.stakeAddress;
}
