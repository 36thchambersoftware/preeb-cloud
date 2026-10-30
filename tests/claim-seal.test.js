import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CLAIM_WALLET_KEY_SECRET = 'seal-test-secret-0123456789abcdefghij';
const { sealCampaign, sealEntitlement, campaignSealIsValid, entitlementSealIsValid } = await import('../api/_lib/claim-seal.js');
const { assertEntitlementSealed, IntegrityError } = await import('../api/_lib/claim-integrity.js');

const campaign = () => ({
  _id: 'abc',
  wallet: { address: 'addr1wallet' },
  owner: { stake: 'stake1owner', payoutAddress: 'addr1payout' },
  network: 'mainnet',
  tokenY: { policyId: 'a'.repeat(56), assetNameHex: '' },
});

test('a campaign seal covers everything that decides where funds can go', () => {
  const sealed = { ...campaign(), seal: sealCampaign(campaign()) };
  assert.equal(campaignSealIsValid(sealed), true);
  const tampered = [
    (c) => { c.owner.payoutAddress = 'addr1attacker'; },
    (c) => { c.wallet.address = 'addr1attacker'; },
    (c) => { c.owner.stake = 'stake1attacker'; },
    (c) => { c.network = 'preprod'; },
    (c) => { c.tokenY.policyId = 'b'.repeat(56); },
  ];
  for (const change of tampered) {
    const copy = structuredClone(sealed);
    change(copy);
    assert.equal(campaignSealIsValid(copy), false);
  }
});

test('a missing or malformed seal is never valid', () => {
  assert.equal(campaignSealIsValid(campaign()), false);
  assert.equal(campaignSealIsValid({ ...campaign(), seal: 'zz' }), false);
  assert.equal(campaignSealIsValid({ ...campaign(), seal: 42 }), false);
});

test('an entitlement seal binds the campaign, the holder and the amount', () => {
  const entitlement = { campaignId: 'abc', key: 'stake1holder', amount: '100', seal: sealEntitlement('abc', 'stake1holder', '100') };
  assert.equal(entitlementSealIsValid(entitlement), true);
  assert.equal(entitlementSealIsValid({ ...entitlement, amount: '101' }), false);
  assert.equal(entitlementSealIsValid({ ...entitlement, key: 'stake1other' }), false);
  assert.equal(entitlementSealIsValid({ ...entitlement, campaignId: 'xyz' }), false);
  assert.throws(() => assertEntitlementSealed({ ...entitlement, amount: '101' }), IntegrityError);
  assert.doesNotThrow(() => assertEntitlementSealed(entitlement));
});

test('a seal that includes a lane cannot be moved to another lane', () => {
  const entitlement = { campaignId: 'abc', key: 'stake1holder', amount: '100', lane: 4, seal: sealEntitlement('abc', 'stake1holder', '100', 4) };
  assert.equal(entitlementSealIsValid(entitlement), true);
  assert.equal(entitlementSealIsValid({ ...entitlement, lane: 5 }), false);
  assert.equal(entitlementSealIsValid({ ...entitlement, lane: undefined }), false);
  // Rows from before lanes were assigned keep their original seal.
  const legacy = { campaignId: 'abc', key: 'stake1old', amount: '7', seal: sealEntitlement('abc', 'stake1old', '7') };
  assert.equal(entitlementSealIsValid(legacy), true);
  assert.equal(entitlementSealIsValid({ ...legacy, lane: 0 }), false);
});

test('seals made with a different secret do not verify', () => {
  const seal = sealEntitlement('abc', 'stake1holder', '100');
  process.env.CLAIM_WALLET_KEY_SECRET = 'a-different-secret-0123456789abcdefgh';
  try {
    assert.equal(entitlementSealIsValid({ campaignId: 'abc', key: 'stake1holder', amount: '100', seal }), false);
  } finally {
    process.env.CLAIM_WALLET_KEY_SECRET = 'seal-test-secret-0123456789abcdefghij';
  }
});
