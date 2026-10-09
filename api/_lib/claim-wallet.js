import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import { enterpriseAddressFromPublicKey } from './cardano-address.js';
// Imported for its side effect: it loads `.env.local` for local development.
import './discord-auth.js';

/**
 * Every claim campaign gets its own funding wallet. The wallet's 32-byte
 * ed25519 seed is stored in MongoDB encrypted with AES-256-GCM. The encryption
 * secret lives only in the server environment, so a copy of the database alone
 * cannot move funds. The campaign id is bound in as additional authenticated
 * data, so a ciphertext cannot be swapped between campaigns.
 */

const KEY_VERSION = 1;
const HKDF_INFO = 'preeb-claim-wallet-v1';

function getEncryptionKey() {
  const secret = process.env.CLAIM_WALLET_KEY_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('CLAIM_WALLET_KEY_SECRET must be configured with at least 32 characters');
  }
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'preeb-cloud', HKDF_INFO, 32));
}

export function networkIdFor(network) {
  return network === 'mainnet' ? 1 : 0;
}

export function encryptSeed(seed, campaignId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  cipher.setAAD(Buffer.from(campaignId));
  const data = Buffer.concat([cipher.update(seed), cipher.final()]);
  return {
    version: KEY_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptSeed(encrypted, campaignId) {
  if (encrypted?.version !== KEY_VERSION) throw new Error('Unsupported claim wallet key version');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(encrypted.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(campaignId));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]);
}

/** Fresh random wallet. The seed is returned once so the caller can encrypt it. */
export function generateClaimWallet(network, campaignId) {
  const seed = crypto.randomBytes(32);
  const { publicKey } = nacl.sign.keyPair.fromSeed(seed);
  return {
    address: enterpriseAddressFromPublicKey(publicKey, networkIdFor(network)),
    publicKeyHex: Buffer.from(publicKey).toString('hex'),
    encryptedSeed: encryptSeed(seed, campaignId),
  };
}

/** Signs a transaction body hash with a campaign wallet's key. */
export function signWithClaimWallet(encrypted, campaignId, messageBytes) {
  const seed = decryptSeed(encrypted, campaignId);
  try {
    const { secretKey } = nacl.sign.keyPair.fromSeed(seed);
    return Buffer.from(nacl.sign.detached(messageBytes, secretKey));
  } finally {
    seed.fill(0);
  }
}
