import crypto from 'node:crypto';
import './discord-auth.js';

/**
 * Integrity seals.
 *
 * The campaign wallet's key is encrypted, so a copy of the database cannot sign anything.
 * But the facts that decide *what the server will sign* (where a sweep pays out, which
 * wallet is the campaign's, who is entitled to how much) are ordinary database fields.
 * Someone who could write to MongoDB, but never learned the encryption secret, could
 * change them and have the server sign on their behalf.
 *
 * So those facts carry an HMAC made with a key derived from the same server-only secret.
 * Writing the database is no longer enough: a forged value has no valid seal, and the
 * server refuses to sign.
 */

function sealKey() {
  const secret = process.env.CLAIM_WALLET_KEY_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('CLAIM_WALLET_KEY_SECRET must be configured with at least 32 characters');
  }
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'preeb-cloud', 'preeb-claim-seal-v1', 32));
}

function mac(parts) {
  return crypto.createHmac('sha256', sealKey()).update(JSON.stringify(parts)).digest('hex');
}

export function sealCampaign(campaign) {
  return mac([
    'campaign', campaign._id, campaign.wallet?.address, campaign.owner?.stake, campaign.owner?.payoutAddress,
    campaign.network, campaign.tokenY?.policyId, campaign.tokenY?.assetNameHex,
  ]);
}

// The lane is part of the seal when there is one, so a wallet cannot be moved to another
// lane by editing the database. Rows from before lanes were assigned have none.
export function sealEntitlement(campaignId, key, amount, lane) {
  const parts = ['entitlement', campaignId, key, String(amount)];
  if (Number.isInteger(lane)) parts.push(lane);
  return mac(parts);
}

function matches(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export function campaignSealIsValid(campaign) {
  return matches(sealCampaign(campaign), campaign.seal);
}

export function entitlementSealIsValid(entitlement) {
  return matches(sealEntitlement(entitlement.campaignId, entitlement.key, entitlement.amount, entitlement.lane), entitlement.seal);
}
