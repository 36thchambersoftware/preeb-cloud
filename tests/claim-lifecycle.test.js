import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAIM_TTL_SLOTS,
  ClaimBusyError,
  createClaimChallenge,
  startClaim,
  verifyClaimer,
} from '../api/_lib/claim-claims.js';
import { ClaimInputError } from '../api/_lib/claim-campaign.js';
import { MIN_OPEN_BEFORE_END_MS, RECLAIM_GRACE_MS, reclaimEligibility } from '../api/_lib/claim-reclaim.js';

process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdefghijkl';

const at = (iso) => new Date(iso);
const taken = { snapshot: { status: 'taken' } };

test('the owner cannot reclaim once the snapshot is taken until claims close and pending claims have had time to land', () => {
  const campaign = { ...taken, claimStartsAt: '2026-03-01T00:15:00Z', claimEndsAt: '2026-03-03T00:15:00Z' };

  const beforeOpening = reclaimEligibility(campaign, at('2026-02-28T12:00:00Z'));
  assert.equal(beforeOpening.allowed, false);
  assert.match(beforeOpening.reason, /run until/);
  assert.equal(beforeOpening.availableAt, new Date(at('2026-03-03T00:15:00Z').getTime() + RECLAIM_GRACE_MS).toISOString());
  assert.equal(reclaimEligibility({ snapshot: { status: 'scheduled' } }, at('2026-02-28T12:00:00Z')).allowed, true);
  assert.equal(reclaimEligibility({ snapshot: { status: 'failed' } }, at('2026-03-02T00:00:00Z')).allowed, true);

  const open = reclaimEligibility(campaign, at('2026-03-02T00:00:00Z'));
  assert.equal(open.allowed, false);
  assert.match(open.reason, /open until/);

  const justClosed = reclaimEligibility(campaign, at('2026-03-03T00:20:00Z'));
  assert.equal(justClosed.allowed, false);
  assert.equal(justClosed.availableAt, new Date(at('2026-03-03T00:15:00Z').getTime() + RECLAIM_GRACE_MS).toISOString());

  assert.equal(reclaimEligibility(campaign, at('2026-03-03T01:00:00Z')).allowed, true);
  assert.equal(reclaimEligibility(campaign, at('2026-03-03T01:00:00Z'), 2).allowed, false);
});

test('a campaign with no end date cannot be swept while open, but the owner can end it after 24 hours', () => {
  const campaign = { ...taken, claimStartsAt: '2026-03-01T00:00:00Z', claimEndsAt: null };

  const early = reclaimEligibility(campaign, at('2026-03-01T10:00:00Z'));
  assert.equal(early.allowed, false);
  assert.equal(early.canEndAt, new Date(at('2026-03-01T00:00:00Z').getTime() + MIN_OPEN_BEFORE_END_MS).toISOString());

  const later = reclaimEligibility(campaign, at('2026-03-02T01:00:00Z'));
  assert.equal(later.allowed, false);
  assert.match(later.reason, /End the claims first/);
});

test('a swept campaign can always be swept again if more funds arrive', () => {
  const campaign = { ...taken, claimStartsAt: '2026-03-01T00:00:00Z', claimEndsAt: null, reclaimed: true };
  assert.equal(reclaimEligibility(campaign, at('2026-06-01T00:00:00Z')).allowed, true);
});

test('claim challenges are bound to one campaign and wallet, and a verified browser skips them', () => {
  const stake = 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw';
  const { token, message } = createClaimChallenge('abcdefghjk', stake);
  assert.match(message, /^PREEB Claim\ncampaign:abcdefghjk\nstake:stake1/);

  // Already verified in this browser: no signature needed.
  assert.doesNotThrow(() => verifyClaimer({ campaignId: 'abcdefghjk', stake, verifiedStakes: [stake] }));

  // A token for another campaign, another wallet, or none at all does not work.
  assert.throws(() => verifyClaimer({ campaignId: 'zzzzzzzzzz', stake, token, signatureHex: '00', keyHex: '00' }), /expired/);
  assert.throws(() => verifyClaimer({ campaignId: 'abcdefghjk', stake: 'stake1other', token, signatureHex: '00', keyHex: '00' }), /expired/);
  assert.throws(() => verifyClaimer({ campaignId: 'abcdefghjk', stake, token: 'garbage', signatureHex: '00', keyHex: '00' }), /expired/);
  // A valid token with a bad signature is rejected too.
  assert.throws(() => verifyClaimer({ campaignId: 'abcdefghjk', stake, token, signatureHex: '00', keyHex: '00' }), /could not be verified/);
});

test('claims are refused before they open, without touching the database', async () => {
  const stake = 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw';
  const claimerAddress = 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x';
  const open = {
    _id: 'abcdefghjk',
    network: 'mainnet',
    snapshot: { status: 'taken', scheduledFor: '2026-01-01T00:00:00Z' },
    claimStartsAt: '2026-01-01T00:15:00Z',
    claimEndsAt: '2026-02-01T00:00:00Z',
    lanes: { status: 'ready', count: 1 },
  };
  const db = { collection: () => { throw new Error('database must not be used'); } };
  const attempt = (campaign, overrides = {}, now = at('2026-01-05T00:00:00Z')) => startClaim(db, campaign, {
    stake, claimerAddress, utxoHexes: ['00'], now, ...overrides,
  });

  await assert.rejects(() => attempt(open, {}, at('2026-01-01T00:05:00Z')), /not open/);
  await assert.rejects(() => attempt(open, {}, at('2026-03-01T00:00:00Z')), /not open/);
  await assert.rejects(() => attempt({ ...open, lanes: { status: 'none', count: 1 } }), /not open/);
  await assert.rejects(() => attempt({ ...open, snapshot: { status: 'failed' } }), /not open/);
  await assert.rejects(() => attempt(open, { claimerAddress: 'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv' }), /does not match/);
  await assert.rejects(() => attempt({ ...open, network: 'preprod' }), /preprod/);
  await assert.rejects(() => attempt(open, { utxoHexes: [] }), /did not share any funds/);
});

test('claim reservations expire quickly and busy errors are input errors', () => {
  assert.ok(CLAIM_TTL_SLOTS <= 600);
  assert.ok(new ClaimBusyError('x') instanceof ClaimInputError);
});
