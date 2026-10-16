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
  listSnapshot,
  normalizeImageUrl,
  parseCampaignInput,
  retrySnapshot,
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

const HOLDER_TOKEN = { policyId: 'a'.repeat(56), name: 'CryptoSockz', ticker: 'SOCKZ', decimals: 6, website: null, multiAsset: false };

const TOKEN_INFO = {
  policyId: 'b'.repeat(56),
  assetNameHex: '706565',
  decimals: 2,
  decimalsSource: 'registry',
  ticker: 'PEE',
  name: 'Pee',
  images: [{ ref: 'ipfs://QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa', source: 'cip25' }],
};

function baseBody(overrides = {}) {
  return {
    title: 'Flowmass claim',
    description: 'Claim your tokens',
    tokenX: { policyId: 'a'.repeat(56), assetNameHex: '' },
    tokenY: { policyId: 'b'.repeat(56), assetNameHex: '706565' },
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
    tokenInfo: TOKEN_INFO, holderToken: HOLDER_TOKEN,
    now,
    network: 'mainnet',
  });
  assert.equal(parsed.distribution.amountPerHolder, '1000');
  assert.equal(parsed.snapshot.scheduledFor.getTime(), now.getTime());

  assert.throws(() => parseCampaignInput(baseBody({ payoutAddress: ENTERPRISE_ADDRESS }), {
    ownerStake: OWNER_STAKE, tokenInfo: TOKEN_INFO, holderToken: HOLDER_TOKEN, now, network: 'mainnet',
  }), ClaimInputError);
  assert.throws(() => parseCampaignInput(baseBody({ payoutAddress: BASE_ADDRESS }), {
    ownerStake: OWNER_STAKE, tokenInfo: TOKEN_INFO, holderToken: HOLDER_TOKEN, now, network: 'preprod',
  }), /preprod/);
  assert.throws(() => parseCampaignInput(baseBody({ claimEndsAt: '2025-12-31T00:00:00Z' }), {
    ownerStake: OWNER_STAKE, tokenInfo: TOKEN_INFO, holderToken: HOLDER_TOKEN, now, network: 'mainnet',
  }), /at least 24 hours/);
  assert.throws(() => parseCampaignInput(baseBody({ image: { url: 'http://x.test/a.png' } }), {
    ownerStake: OWNER_STAKE, tokenInfo: TOKEN_INFO, holderToken: HOLDER_TOKEN, now, network: 'mainnet',
  }), /https:\/\/, ipfs:\/\/ or ar:\/\//);
  assert.throws(() => parseCampaignInput(baseBody({ distribution: { mode: 'manual' } }), {
    ownerStake: OWNER_STAKE, tokenInfo: TOKEN_INFO, holderToken: HOLDER_TOKEN, now, network: 'mainnet',
  }), /uploaded holder list/);
});

test('parseCampaignInput ignores client decimals and defaults the image from the chain', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const body = baseBody({
    tokenY: { policyId: 'b'.repeat(56), assetNameHex: '706565', decimals: 18, ticker: 'SCAM' },
    distribution: { mode: 'fixed', amountPerHolder: '1.5' },
  });
  const parsed = parseCampaignInput(body, { ownerStake: OWNER_STAKE, tokenInfo: TOKEN_INFO, holderToken: HOLDER_TOKEN, now, network: 'mainnet' });
  assert.equal(parsed.tokenY.decimals, 2);
  assert.equal(parsed.tokenY.ticker, 'PEE');
  assert.equal(parsed.distribution.amountPerHolder, '150');
  assert.equal(parsed.image, 'ipfs://QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa');

  const tooPrecise = baseBody({ distribution: { mode: 'fixed', amountPerHolder: '1.555' } });
  assert.throws(
    () => parseCampaignInput(tooPrecise, { ownerStake: OWNER_STAKE, tokenInfo: TOKEN_INFO, holderToken: HOLDER_TOKEN, now, network: 'mainnet' }),
    (error) => error.field === 'distribution-amount' && /2 decimal places/.test(error.message),
  );
});

test('the minimum balance is typed in whole tokens and stored in base units', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const options = { ownerStake: OWNER_STAKE, tokenInfo: TOKEN_INFO, holderToken: HOLDER_TOKEN, now, network: 'mainnet' };
  const parsed = parseCampaignInput(baseBody({ filters: { minBalance: '1,500.5' } }), options);
  assert.equal(parsed.filters.minBalance, '1500500000');
  assert.equal(parsed.tokenX.name, 'CryptoSockz');
  assert.equal('assetNameHex' in parsed.tokenX, false);
  assert.throws(
    () => parseCampaignInput(baseBody({ filters: { minBalance: '1.1234567' } }), options),
    (error) => error.field === 'min-balance',
  );
});

test('claims open at least 15 minutes after the snapshot and stay open at least 24 hours', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const options = { ownerStake: OWNER_STAKE, tokenInfo: TOKEN_INFO, holderToken: HOLDER_TOKEN, now, network: 'mainnet' };

  // Empty start means exactly 15 minutes after the snapshot.
  const defaulted = parseCampaignInput(baseBody(), options);
  assert.equal(defaulted.claimStartsAt.toISOString(), '2026-01-01T12:15:00.000Z');

  const scheduled = (extra) => baseBody({ snapshot: { source: 'koios', at: '2026-01-05T00:00:00Z' }, ...extra });
  assert.equal(parseCampaignInput(scheduled(), options).claimStartsAt.toISOString(), '2026-01-05T00:15:00.000Z');

  assert.throws(
    () => parseCampaignInput(scheduled({ claimStartsAt: '2026-01-05T00:05:00Z' }), options),
    (error) => error.field === 'claim-start' && /at least 15 minutes after the snapshot/.test(error.message),
  );
  assert.throws(
    () => parseCampaignInput(baseBody({ claimStartsAt: '2026-01-01T11:00:00Z' }), options),
    (error) => error.field === 'claim-start',
  );
  assert.equal(
    parseCampaignInput(scheduled({ claimStartsAt: '2026-01-06T00:00:00Z' }), options).claimStartsAt.toISOString(),
    '2026-01-06T00:00:00.000Z',
  );

  assert.throws(
    () => parseCampaignInput(scheduled({ claimEndsAt: '2026-01-05T20:00:00Z' }), options),
    (error) => error.field === 'claim-end' && /at least 24 hours/.test(error.message),
  );
  const ok = parseCampaignInput(scheduled({ claimEndsAt: '2026-01-06T00:15:00Z' }), options);
  assert.equal(ok.claimEndsAt.toISOString(), '2026-01-06T00:15:00.000Z');
});

test('normalizeImageUrl only allows https and ipfs links', () => {
  assert.equal(
    normalizeImageUrl('ipfs://QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa'),
    'ipfs://QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa',
  );
  assert.equal(normalizeImageUrl('QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa/a.png'.split('/')[0]), 'ipfs://QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa');
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
        const doc = campaigns.find((item) => matches(item, filter));
        if (!doc) return { matchedCount: 0 };
        set(doc, update.$set || {});
        for (const path of Object.keys(update.$unset || {})) {
          const [parent, key] = path.split('.');
          delete doc[parent][key];
        }
        return { matchedCount: 1 };
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
    lanes: { status: 'none', count: 0 },
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
  assert.equal(db.campaigns[0].lanes.count, 1);
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

test('a late snapshot moves the claim window and keeps its length', async () => {
  const planned = new Date(Date.now() - 60 * 60 * 1000);
  const db = createClaimDb(snapshotCampaign({
    claimStartsAt: planned,
    claimEndsAt: new Date(planned.getTime() + 48 * 60 * 60 * 1000),
  }));
  await runSnapshot(db, 'abcdefghjk', { now: new Date() });

  const [campaign] = db.campaigns;
  const opensIn = campaign.claimStartsAt.getTime() - Date.now();
  assert.ok(opensIn > 14 * 60 * 1000 && opensIn <= 15 * 60 * 1000 + 1000);
  assert.equal(campaign.claimEndsAt.getTime() - campaign.claimStartsAt.getTime(), 48 * 60 * 60 * 1000);
});

test('an on-time snapshot leaves the planned claim window alone', async () => {
  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const db = createClaimDb(snapshotCampaign({ claimStartsAt: start, claimEndsAt: new Date(start.getTime() + 36e5 * 30) }));
  await runSnapshot(db, 'abcdefghjk', { now: new Date() });
  assert.equal(db.campaigns[0].claimStartsAt.getTime(), start.getTime());
});

test('claims stay closed while the snapshot has failed, and the owner can rerun it', async () => {
  const campaign = snapshotCampaign({ claimStartsAt: new Date('2026-01-01T00:15:00Z'), claimEndsAt: new Date('2026-01-03T00:00:00Z') });
  campaign.snapshot.rows = [{ address: 'garbage', quantity: null }];
  const db = createClaimDb(campaign);

  for (let attempt = 0; attempt < 3; attempt += 1) await runSnapshot(db, 'abcdefghjk', { now: new Date('2026-01-02T00:00:00Z') });
  assert.equal(db.campaigns[0].snapshot.status, 'failed');
  // Even though the planned close date has passed, nothing has opened or closed yet.
  assert.equal(deriveStatus(db.campaigns[0], new Date('2026-02-01T00:00:00Z')).status, 'upcoming');

  db.campaigns[0].snapshot.rows = [{ address: BASE_ADDRESS, quantity: null }];
  const result = await retrySnapshot(db, 'abcdefghjk', { now: new Date('2026-02-01T00:00:00Z') });
  assert.equal(result.status, 'taken');
  assert.equal(db.campaigns[0].snapshot.attempts, 1);
  assert.equal(db.campaigns[0].claimStartsAt.getTime() > Date.now() - 1000, true);

  await assert.rejects(() => retrySnapshot(db, 'abcdefghjk'), /Only a failed snapshot/);
});

function createSnapshotDb(entitlements) {
  const matches = (doc, filter) => Object.entries(filter).every(([key, expected]) => {
    const actual = doc[key];
    if (expected && typeof expected === 'object') {
      if ('$in' in expected) return expected.$in.includes(actual);
      if ('$regex' in expected) return new RegExp(expected.$regex).test(actual);
    }
    return actual === expected;
  });
  return {
    collection: () => ({
      countDocuments: async (filter) => entitlements.filter((doc) => matches(doc, filter)).length,
      updateOne: async (filter, update) => {
        Object.assign(entitlements.find((doc) => doc._id === filter._id), update.$set);
      },
      find: (filter) => {
        let rows = entitlements.filter((doc) => matches(doc, filter));
        const chain = {
          sort: (order) => {
            const [field, direction] = Object.entries(order)[0];
            rows = [...rows].sort((a, b) => ((a[field] - b[field]) * direction) || a.key.localeCompare(b.key));
            return chain;
          },
          skip: (count) => { rows = rows.slice(count); return chain; },
          limit: (count) => { rows = rows.slice(0, count); return chain; },
          toArray: async () => rows,
        };
        return chain;
      },
    }),
  };
}

test('the snapshot lists the largest shares first, in pages', async () => {
  const entitlements = Array.from({ length: 60 }, (_, index) => ({
    campaignId: 'abcdefghjk',
    key: `stake1holder${String(index).padStart(3, '0')}`,
    balance: String(index + 1),
    amount: String((index + 1) * 10),
    amountNum: (index + 1) * 10,
    status: 'unclaimed',
  }));
  const db = createSnapshotDb(entitlements);

  const first = await listSnapshot(db, 'abcdefghjk', {});
  assert.equal(first.total, 60);
  assert.equal(first.entries.length, 25);
  assert.equal(first.entries[0].amount, '600');

  const third = await listSnapshot(db, 'abcdefghjk', { page: 2 });
  assert.equal(third.entries.length, 10);
  assert.equal(third.entries.at(-1).amount, '10');
});

test('the snapshot can be searched by stake, payment address, handle or prefix', async () => {
  const entitlements = [
    { campaignId: 'abcdefghjk', key: STAKE_ADDRESS, balance: '5', amount: '50', amountNum: 50, status: 'unclaimed' },
    { campaignId: 'abcdefghjk', key: 'stake1other', balance: '1', amount: '10', amountNum: 10, status: 'claimed' },
  ];
  const db = createSnapshotDb(entitlements);

  assert.equal((await listSnapshot(db, 'abcdefghjk', { query: STAKE_ADDRESS })).entries[0].amount, '50');
  // A payment address resolves to the stake address it belongs to.
  assert.equal((await listSnapshot(db, 'abcdefghjk', { query: BASE_ADDRESS })).entries[0].key, STAKE_ADDRESS);
  assert.equal((await listSnapshot(db, 'abcdefghjk', { query: 'stake1other' })).entries[0].status, 'claimed');
  assert.equal((await listSnapshot(db, 'abcdefghjk', { query: 'stake1uy' })).total, 1);

  const missing = await listSnapshot(db, 'abcdefghjk', { query: 'stake1u8f3uqzv9lc84555ejzuq005lhaahfm3m9ytr68ke27k6hc9xy0kc' });
  assert.equal(missing.total, 0);
  assert.equal(missing.note, 'That wallet is not in the snapshot.');

  const handle = async () => ({ ok: true, json: async () => ({ resolved_addresses: { ada: BASE_ADDRESS } }) });
  assert.equal((await listSnapshot(db, 'abcdefghjk', { query: '$ockz', fetchImpl: handle })).entries[0].key, STAKE_ADDRESS);
  const noHandle = async () => ({ ok: false });
  assert.match((await listSnapshot(db, 'abcdefghjk', { query: '$nobody', fetchImpl: noHandle })).note, /No wallet found for the handle \$nobody/);
});

test('the snapshot sorts by claim or holding in either direction', async () => {
  const entitlements = [
    { _id: 1, campaignId: 'abcdefghjk', key: 'stake1a', balance: '5', amount: '300', balanceNum: 5, amountNum: 300, status: 'unclaimed' },
    { _id: 2, campaignId: 'abcdefghjk', key: 'stake1b', balance: '9', amount: '100', balanceNum: 9, amountNum: 100, status: 'unclaimed' },
    { _id: 3, campaignId: 'abcdefghjk', key: 'stake1c', balance: '1', amount: '200', balanceNum: 1, amountNum: 200, status: 'unclaimed' },
  ];
  const db = createSnapshotDb(entitlements);
  const keys = async (options) => (await listSnapshot(db, 'abcdefghjk', options)).entries.map((entry) => entry.key.slice(-1));

  assert.deepEqual(await keys({}), ['a', 'c', 'b']);
  assert.deepEqual(await keys({ sort: 'claim', dir: 'asc' }), ['b', 'c', 'a']);
  assert.deepEqual(await keys({ sort: 'holding' }), ['b', 'a', 'c']);
  assert.deepEqual(await keys({ sort: 'holding', dir: 'asc' }), ['c', 'a', 'b']);
  assert.deepEqual(await keys({ sort: 'bogus; drop' }), ['a', 'c', 'b']);
});

test('handles replace addresses, are stored once, and unanswered wallets are reported', async () => {
  const entitlements = [
    { _id: 1, campaignId: 'abcdefghjk', key: 'stake1withhandle', balance: '5', amount: '300', amountNum: 300, status: 'unclaimed' },
    { _id: 2, campaignId: 'abcdefghjk', key: 'stake1nohandle', balance: '5', amount: '200', amountNum: 200, status: 'unclaimed' },
    { _id: 3, campaignId: 'abcdefghjk', key: 'stake1blocked', balance: '5', amount: '100', amountNum: 100, status: 'unclaimed' },
    { _id: 4, campaignId: 'abcdefghjk', key: 'addr1enterprise', balance: '5', amount: '50', amountNum: 50, status: 'unclaimed' },
  ];
  const db = createSnapshotDb(entitlements);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('stake1withhandle')) return { ok: true, json: async () => ({ default_handle: 'ockz' }) };
    if (url.endsWith('stake1nohandle')) return { ok: false, status: 404 };
    return { ok: false, status: 429 };
  };

  const first = await listSnapshot(db, 'abcdefghjk', { handles: true, fetchImpl });
  assert.deepEqual(first.entries.map((entry) => entry.handle), ['$ockz', null, null, null]);
  assert.equal(first.pendingHandles, 1);
  assert.equal(calls.length, 3);

  // Answered wallets are served from storage; only the rate-limited one is asked again.
  calls.length = 0;
  await listSnapshot(db, 'abcdefghjk', { handles: true, fetchImpl });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('stake1blocked'));
});
