import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'tweetnacl';
import {
  addressBelongsToStake,
  enterpriseAddressFromPublicKey,
  parseAddress,
} from '../api/_lib/cardano-address.js';
import { decryptSeed, encryptSeed, generateClaimWallet, signWithClaimWallet } from '../api/_lib/claim-wallet.js';
import {
  buildEntitlements,
  fetchKoiosHolders,
  parseHolderJson,
  parseTokenAmount,
} from '../api/_lib/claim-snapshot.js';
import {
  ClaimInputError,
  deriveStatus,
  normalizeImageUrl,
  parseCampaignInput,
  runDueSnapshots,
  runSnapshot,
} from '../api/_lib/claim-campaign.js';

process.env.CLAIM_WALLET_KEY_SECRET = 'test-claim-wallet-secret-0123456789abcdef';

// Test vectors from CIP-19.
const BASE_ADDRESS = 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x';
const STAKE_ADDRESS = 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw';
const ENTERPRISE_ADDRESS = 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8';
const SCRIPT_ENTERPRISE_ADDRESS = 'addr1w9jx45flh83z6wuqypyash54mszwmdj8r64fydafxtfc6jgrw4rm3';

test('parseAddress derives the staking credential from base addresses', () => {
  const parsed = parseAddress(BASE_ADDRESS);
  assert.equal(parsed.stakeAddress, STAKE_ADDRESS);
  assert.equal(parsed.paymentIsScript, false);
  assert.equal(parseAddress(STAKE_ADDRESS).stakeAddress, STAKE_ADDRESS);
  assert.equal(parseAddress(ENTERPRISE_ADDRESS).stakeAddress, null);
  assert.equal(parseAddress(SCRIPT_ENTERPRISE_ADDRESS).paymentIsScript, true);
  assert.equal(parseAddress('not-an-address'), null);
  assert.equal(parseAddress('Ae2tdPwUPEZ5YSdE4n1tAjhnBrP1UiCgkKXFYhhD2k8ZEvmSjZvPYwDXWAd'), null);
});

test('addressBelongsToStake only accepts base addresses with that stake key', () => {
  assert.equal(addressBelongsToStake(BASE_ADDRESS, STAKE_ADDRESS), true);
  assert.equal(addressBelongsToStake(ENTERPRISE_ADDRESS, STAKE_ADDRESS), false);
  assert.equal(addressBelongsToStake(BASE_ADDRESS, 'stake1u9f466l6n33qaxarnztta56q7eugv05n2p5g66wxes0cskqzjrkxz'), false);
});

test('claim wallets use a valid enterprise address and sign with their key', () => {
  const wallet = generateClaimWallet('preprod', 'campaign01');
  assert.match(wallet.address, /^addr_test1v/);

  const seed = decryptSeed(wallet.encryptedSeed, 'campaign01');
  const { publicKey, secretKey } = nacl.sign.keyPair.fromSeed(seed);
  assert.equal(enterpriseAddressFromPublicKey(publicKey, 0), wallet.address);

  const message = Buffer.from('tx body hash');
  const signature = signWithClaimWallet(wallet.encryptedSeed, 'campaign01', message);
  assert.equal(nacl.sign.detached.verify(message, signature, publicKey), true);
  assert.ok(secretKey);
});

test('wallet seeds are bound to their campaign and detect tampering', () => {
  const seed = Buffer.alloc(32, 7);
  const encrypted = encryptSeed(seed, 'campaignaa');
  assert.deepEqual(decryptSeed(encrypted, 'campaignaa'), seed);
  assert.notEqual(encrypted.data, seed.toString('base64'));
  assert.throws(() => decryptSeed(encrypted, 'campaignbb'));
  assert.throws(() => decryptSeed({ ...encrypted, data: Buffer.alloc(32, 1).toString('base64') }, 'campaignaa'));
});

test('parseTokenAmount converts decimals to base units', () => {
  assert.equal(parseTokenAmount('1.5', 6), 1_500_000n);
  assert.equal(parseTokenAmount('10', 0), 10n);
  assert.throws(() => parseTokenAmount('1.5', 0));
  assert.throws(() => parseTokenAmount('-1', 0));
  assert.throws(() => parseTokenAmount('abc', 2));
});

const holderA = BASE_ADDRESS;
const holderB = 'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv';

test('buildEntitlements groups addresses by stake and supports fixed amounts', () => {
  const sameStakeScript = SCRIPT_ENTERPRISE_ADDRESS;
  const result = buildEntitlements({
    rows: [
      { address: holderA, quantity: '3' },
      { address: holderA, quantity: '2' },
      { address: holderB, quantity: '1' },
      { address: sameStakeScript, quantity: '50' },
      { address: 'garbage', quantity: '1' },
    ],
    filters: { minBalance: '0', excludeScripts: true },
    distribution: { mode: 'fixed', amountPerHolder: '100' },
    decimals: 0,
  });

  assert.equal(result.entitlements.length, 2);
  const first = result.entitlements.find((item) => item.key === STAKE_ADDRESS);
  assert.equal(first.balance, '5');
  assert.equal(first.amount, '100');
  assert.deepEqual(
    { script: result.skipped.script, invalid: result.skipped.invalid },
    { script: 1, invalid: 1 },
  );
  assert.equal(result.totalAmount, '200');
});

test('buildEntitlements splits a total proportionally without exceeding it', () => {
  const result = buildEntitlements({
    rows: [
      { address: holderA, quantity: '1' },
      { address: holderB, quantity: '2' },
    ],
    distribution: { mode: 'proportional', totalAmount: '100' },
    decimals: 0,
  });
  const amounts = result.entitlements.map((item) => BigInt(item.amount));
  assert.deepEqual(amounts.sort(), [33n, 66n]);
  assert.ok(BigInt(result.totalAmount) <= 100n);
});

test('buildEntitlements honours minimum balance, exclusions and manual amounts', () => {
  const filtered = buildEntitlements({
    rows: [
      { address: holderA, quantity: '1' },
      { address: holderB, quantity: '5' },
    ],
    filters: { minBalance: '2', exclude: [] },
    distribution: { mode: 'fixed', amountPerHolder: '1' },
    decimals: 0,
  });
  assert.equal(filtered.entitlements.length, 1);
  assert.equal(filtered.skipped.belowMinimum, 1);

  const excluded = buildEntitlements({
    rows: [{ address: holderA, quantity: '1' }, { address: holderB, quantity: '1' }],
    filters: { exclude: [STAKE_ADDRESS] },
    distribution: { mode: 'fixed', amountPerHolder: '1' },
    decimals: 0,
  });
  assert.equal(excluded.entitlements.length, 1);
  assert.equal(excluded.skipped.excluded, 1);

  const manual = buildEntitlements({
    rows: [{ address: holderA, quantity: '1.5' }],
    distribution: { mode: 'manual' },
    decimals: 2,
  });
  assert.equal(manual.entitlements[0].amount, '150');
});

test('parseHolderJson accepts strings and objects and rejects bad input', () => {
  assert.deepEqual(parseHolderJson(JSON.stringify([holderA, { address: holderB, amount: '4' }])), [
    { address: holderA, quantity: null },
    { address: holderB, quantity: '4' },
  ]);
  assert.throws(() => parseHolderJson('nope'));
  assert.throws(() => parseHolderJson([]));
  assert.throws(() => parseHolderJson([{ amount: 1 }]));
});

test('fetchKoiosHolders pages until a short page and picks the right endpoint', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const offset = Number(new URL(url).searchParams.get('offset'));
    const size = offset === 0 ? 1000 : 3;
    return {
      ok: true,
      json: async () => Array.from({ length: size }, (_, index) => ({
        payment_address: `addr${offset + index}`,
        quantity: '1',
      })),
    };
  };

  const policyId = 'a'.repeat(56);
  const rows = await fetchKoiosHolders({ policyId, assetNameHex: '', network: 'mainnet' }, fetchImpl);
  assert.equal(rows.length, 1003);
  assert.match(urls[0], /policy_asset_addresses\?_asset_policy=a{56}&limit=1000&offset=0/);

  await fetchKoiosHolders({ policyId, assetNameHex: '6162', network: 'preprod' }, fetchImpl);
  assert.match(urls.at(-1), /^https:\/\/preprod\.koios\.rest.*asset_addresses\?_asset_policy=a{56}&_asset_name=6162/);
});

const OWNER_STAKE = STAKE_ADDRESS;

function baseBody(overrides = {}) {
  return {
    title: 'Flowmass claim',
    description: 'Claim your tokens',
    tokenX: { policyId: 'a'.repeat(56), assetNameHex: '' },
    tokenY: { policyId: 'b'.repeat(56), assetNameHex: '706565', decimals: 2, ticker: 'PEE' },
    distribution: { mode: 'fixed', amountPerHolder: '10' },
    snapshot: { source: 'koios' },
    payoutAddress: BASE_ADDRESS,
    ...overrides,
  };
}

test('parseCampaignInput builds a campaign and enforces the owner payout address', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const parsed = parseCampaignInput(baseBody({ claimEndsAt: '2026-02-01T00:00:00Z' }), {
    ownerStake: OWNER_STAKE,
    now,
    network: 'mainnet',
  });
  assert.equal(parsed.distribution.amountPerHolder, '1000');
  assert.equal(parsed.snapshot.scheduledFor.getTime(), now.getTime());

  assert.throws(() => parseCampaignInput(baseBody({ payoutAddress: ENTERPRISE_ADDRESS }), {
    ownerStake: OWNER_STAKE, now, network: 'mainnet',
  }), ClaimInputError);
  assert.throws(() => parseCampaignInput(baseBody({ payoutAddress: BASE_ADDRESS }), {
    ownerStake: OWNER_STAKE, now, network: 'preprod',
  }), /preprod/);
  assert.throws(() => parseCampaignInput(baseBody({ claimEndsAt: '2025-12-31T00:00:00Z' }), {
    ownerStake: OWNER_STAKE, now, network: 'mainnet',
  }), /end after/);
  assert.throws(() => parseCampaignInput(baseBody({ image: { url: 'http://x.test/a.png' } }), {
    ownerStake: OWNER_STAKE, now, network: 'mainnet',
  }), /https/);
  assert.throws(() => parseCampaignInput(baseBody({ distribution: { mode: 'manual' } }), {
    ownerStake: OWNER_STAKE, now, network: 'mainnet',
  }), /uploaded holder list/);
});

test('normalizeImageUrl only allows https and ipfs links', () => {
  assert.equal(normalizeImageUrl('ipfs://bafy123/img.png'), 'ipfs://bafy123/img.png');
  assert.equal(normalizeImageUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.throws(() => normalizeImageUrl('javascript:alert(1)'));
  assert.equal(normalizeImageUrl(''), null);
});

test('deriveStatus counts down to the snapshot, then claim start, then close', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  const campaign = {
    snapshot: { status: 'scheduled', scheduledFor: new Date('2026-03-02T00:00:00Z') },
    claimStartsAt: null,
    claimEndsAt: new Date('2026-04-01T00:00:00Z'),
  };
  assert.deepEqual(deriveStatus(campaign, now), { status: 'upcoming', countdownTo: '2026-03-02T00:00:00.000Z' });

  campaign.snapshot.status = 'taken';
  assert.deepEqual(deriveStatus(campaign, now), { status: 'active', countdownTo: '2026-04-01T00:00:00.000Z' });

  campaign.claimStartsAt = new Date('2026-03-05T00:00:00Z');
  assert.equal(deriveStatus(campaign, now).status, 'upcoming');
  assert.equal(deriveStatus(campaign, new Date('2026-04-02T00:00:00Z')).status, 'closed');
  assert.equal(deriveStatus({ ...campaign, reclaimedAt: new Date() }, now).status, 'closed');
});

function createClaimDb(campaign) {
  const entitlements = [];
  const campaigns = [campaign];
  const matches = (doc, filter) => Object.entries(filter).every(([key, expected]) => {
    const actual = key.split('.').reduce((value, part) => value?.[part], doc);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('$lte' in expected) return actual <= expected.$lte;
      if ('$lt' in expected) return actual < expected.$lt;
    }
    return actual === expected;
  });
  const set = (doc, values) => {
    for (const [path, value] of Object.entries(values)) {
      const parts = path.split('.');
      const last = parts.pop();
      const target = parts.reduce((cursor, part) => cursor[part], doc);
      target[last] = value;
    }
  };

  const collections = {
    claim_campaigns: {
      async findOneAndUpdate(filter, update) {
        const doc = campaigns.find((item) => matches(item, { _id: filter._id, ...filter }));
        if (!doc) return null;
        set(doc, update.$set);
        for (const [path, amount] of Object.entries(update.$inc || {})) {
          const [parent, key] = path.split('.');
          doc[parent][key] += amount;
        }
        return structuredClone(doc);
      },
      async updateOne(filter, update) {
        const doc = campaigns.find((item) => item._id === filter._id);
        set(doc, update.$set || {});
        for (const path of Object.keys(update.$unset || {})) {
          const [parent, key] = path.split('.');
          delete doc[parent][key];
        }
      },
      async updateMany() {},
      find() {
        const chain = { sort: () => chain, limit: () => chain, toArray: async () => campaigns.filter((item) => item.snapshot.status === 'scheduled' && item.snapshot.scheduledFor <= new Date('2030-01-01')).map((item) => ({ _id: item._id })) };
        return chain;
      },
    },
    claim_entitlements: {
      async deleteMany() { entitlements.length = 0; },
      async insertMany(docs) { entitlements.push(...docs); },
    },
  };
  return { entitlements, campaigns, collection: (name) => collections[name] };
}

function snapshotCampaign(overrides = {}) {
  return {
    _id: 'abcdefghjk',
    wallet: { address: 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8' },
    tokenY: { decimals: 0 },
    network: 'mainnet',
    filters: { minBalance: '0', excludeScripts: true, exclude: [] },
    distribution: { mode: 'fixed', amountPerHolder: '5' },
    snapshot: {
      source: 'json',
      status: 'scheduled',
      attempts: 0,
      scheduledFor: new Date('2026-01-01T00:00:00Z'),
      rows: [{ address: BASE_ADDRESS, quantity: null }, { address: holderB, quantity: null }],
    },
    ...overrides,
  };
}

test('runSnapshot stores one entitlement per holder and drops the uploaded list', async () => {
  const db = createClaimDb(snapshotCampaign());
  const result = await runSnapshot(db, 'abcdefghjk', { now: new Date('2026-01-02T00:00:00Z') });

  assert.equal(result.status, 'taken');
  assert.equal(db.entitlements.length, 2);
  assert.equal(db.entitlements[0].status, 'unclaimed');
  assert.equal(db.campaigns[0].snapshot.status, 'taken');
  assert.equal(db.campaigns[0].snapshot.totalAmount, '10');
  assert.equal(db.campaigns[0].snapshot.rows, undefined);

  const again = await runSnapshot(db, 'abcdefghjk', { now: new Date('2026-01-02T00:00:00Z') });
  assert.equal(again.ran, false);
});

test('runSnapshot retries failures and eventually gives up', async () => {
  const campaign = snapshotCampaign();
  campaign.snapshot.rows = [{ address: 'garbage', quantity: null }];
  const db = createClaimDb(campaign);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await runSnapshot(db, 'abcdefghjk', { now: new Date('2026-01-02T00:00:00Z') });
    assert.equal(result.status, attempt < 3 ? 'scheduled' : 'failed');
  }
  assert.match(db.campaigns[0].snapshot.error, /No eligible holders/);
});

test('runDueSnapshots processes campaigns whose snapshot time has arrived', async () => {
  const db = createClaimDb(snapshotCampaign());
  const results = await runDueSnapshots(db, { now: new Date('2026-01-02T00:00:00Z') });
  assert.deepEqual(results.map((item) => item.status), ['taken']);
});
