import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'tweetnacl';
import { generateClaimWallet, signWithClaimWallet } from '../api/_lib/claim-wallet.js';
import { enterpriseAddressFromPublicKey } from '../api/_lib/cardano-address.js';
import {
  FUNDING_FEE_BUFFER,
  assembleClaimTransaction,
  assertClaimTransaction,
  buildClaimTransaction,
  buildSweepTransaction,
  campaignVkeyWitness,
  LANE_LOVELACE_ESTIMATE,
  MAX_LANES,
  attachWalletWitness,
  buildLaneTransaction,
  computeLaneAmounts,
  evaluateFunding,
  fundingRequirements,
  laneCountFor,
  laneIndexFor,
  laneOf,
  assignLanes,
  depositLovelaceFor,
  isValidClaimUtxoCount,
  loadCsl,
} from '../api/_lib/claim-funding.js';
import { summarizeUtxos } from '../api/_lib/cardano-chain.js';

process.env.CLAIM_WALLET_KEY_SECRET = 'test-claim-wallet-secret-0123456789abcdef';

const PROTOCOL = {
  txFeePerByte: 44,
  txFeeFixed: 155381,
  utxoCostPerByte: 4310,
  maxTxSize: 16384,
  maxValueSize: 5000,
  stakePoolDeposit: 500000000,
  stakeAddressDeposit: 2000000,
};
const TOKEN = { policyId: 'b'.repeat(56), assetNameHex: '706565' };

test('laneCountFor scales with claimants and is capped', () => {
  assert.equal(laneCountFor(1), 1);
  assert.equal(laneCountFor(10), 1);
  assert.equal(laneCountFor(11), 2);
  assert.equal(laneCountFor(100000), MAX_LANES);
});

test('the owner\'s UTxO choice sizes the lanes: one per wallet, up to the chosen number', () => {
  assert.equal(laneCountFor(5, 40), 5);
  assert.equal(laneCountFor(40, 40), 40);
  assert.equal(laneCountFor(1000, 40), 40);
  assert.equal(laneCountFor(1000, 100), 100);
  assert.equal(laneCountFor(1, 20), 1);
  assert.equal(isValidClaimUtxoCount(20), true);
  assert.equal(isValidClaimUtxoCount(100), true);
  assert.equal(isValidClaimUtxoCount(19), false);
  assert.equal(isValidClaimUtxoCount(101), false);
  assert.equal(isValidClaimUtxoCount(30.5), false);
});

test('assigned lanes are even, stable and sum to every entitlement', () => {
  const wallets = Array.from({ length: 250 }, (_, index) => ({ key: `stake1w${String(index).padStart(3, '0')}`, amount: String(index + 1) }));
  const assigned = assignLanes(wallets, 100);
  const sizes = new Map();
  for (const row of assigned) sizes.set(row.lane, (sizes.get(row.lane) || 0) + 1);
  assert.equal(sizes.size, 100);
  assert.ok([...sizes.values()].every((size) => size === 2 || size === 3));
  assert.deepEqual(assignLanes([...wallets].reverse(), 100), assigned);

  const total = computeLaneAmounts(assigned, 100).reduce((sum, lane) => sum + lane.amount, 0n);
  assert.equal(total, wallets.reduce((sum, row) => sum + BigInt(row.amount), 0n));

  const own = assignLanes(wallets.slice(0, 30), 100);
  assert.equal(new Set(own.map((row) => row.lane)).size, 30);
});

test('older campaigns without a stored lane keep their hash-based assignment', () => {
  assert.equal(laneOf({ key: 'stake1abc' }, 7), laneIndexFor('stake1abc', 7));
  assert.equal(laneOf({ key: 'stake1abc', lane: 3 }, 7), 3);
});

test('the deposit is 1.5 ADA per UTxO plus 1.5 ADA for fees, and the site shows the same numbers', async () => {
  assert.equal(depositLovelaceFor(20), 31_500_000n);
  assert.equal(depositLovelaceFor(100), 151_500_000n);
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../claim.js', import.meta.url), 'utf8');
  assert.match(page, new RegExp(`UTXO_DEPOSIT_LOVELACE = ${LANE_LOVELACE_ESTIMATE.toString().replace(/(\d)(?=(\d{3})+$)/g, '$1_')}`));
  assert.match(page, new RegExp(`DEPOSIT_FEE_BUFFER_LOVELACE = ${FUNDING_FEE_BUFFER.toString().replace(/(\d)(?=(\d{3})+$)/g, '$1_')}`));
});

test('100 lanes plus a full-size sweep fit comfortably in a transaction', async () => {
  const csl = await loadCsl();
  const address = enterpriseAddressFromPublicKey(Buffer.alloc(32, 7), 'mainnet');
  const tokenY = { policyId: 'b'.repeat(56), assetNameHex: 'a'.repeat(64) };
  const utxos = [{
    tx_hash: '1'.repeat(64), tx_index: 0, address, value: '400000000',
    asset_list: [{ policy_id: tokenY.policyId, asset_name: tokenY.assetNameHex, quantity: '1000000' }],
  }];
  const lanes = Array.from({ length: 100 }, (_, index) => ({ index, amount: 10_000n }));
  const built = buildLaneTransaction({ csl, protocol: PROTOCOL, address, utxos, lanes, tokenY });
  assert.ok(built.transaction.to_bytes().length < 12_000, 'the setup transaction stays well under 16 KB');
  const outputs = built.transaction.body().outputs();
  // Every lane's ADA is within what the owner is asked to deposit for it.
  for (let index = 0; index < 100; index += 1) assert.ok(BigInt(outputs.get(index).amount().coin().to_str()) <= LANE_LOVELACE_ESTIMATE);
  assert.ok(built.fee < FUNDING_FEE_BUFFER);

  const wallet = Array.from({ length: 101 }, (_, index) => ({ tx_hash: String(index % 10).repeat(64), tx_index: index, address, value: '1500000', asset_list: [] }));
  const sweep = buildSweepTransaction({ csl, protocol: PROTOCOL, address, utxos: wallet, destination: address });
  assert.equal(sweep.moreRemain, false);
  assert.ok(sweep.transaction.to_bytes().length < 8_000);
});

test('laneIndexFor is stable and lane amounts add up to the entitlements', () => {
  assert.equal(laneIndexFor('stake1abc', 7), laneIndexFor('stake1abc', 7));

  const entitlements = Array.from({ length: 200 }, (_, index) => ({ key: `stake1holder${index}`, amount: String(index + 1) }));
  const lanes = computeLaneAmounts(entitlements, 5);
  const total = lanes.reduce((sum, lane) => sum + lane.amount, 0n);
  assert.equal(total, entitlements.reduce((sum, item) => sum + BigInt(item.amount), 0n));
  assert.ok(lanes.every((lane) => lane.index >= 0 && lane.index < 5 && lane.amount > 0n));
});

test('evaluateFunding reports unfunded, partial and funded wallets', () => {
  const requirements = fundingRequirements({ snapshot: { totalAmount: '1000' }, lanes: { count: 3 } });
  assert.equal(requirements.lovelace, 3n * LANE_LOVELACE_ESTIMATE + FUNDING_FEE_BUFFER);

  assert.equal(evaluateFunding(requirements, { tokens: 0n, lovelace: 0n }).status, 'unfunded');
  assert.equal(evaluateFunding(requirements, { tokens: 1000n, lovelace: 1n }).status, 'partial');
  assert.equal(evaluateFunding(requirements, { tokens: 999n, lovelace: 99_000_000n }).status, 'partial');
  assert.equal(evaluateFunding(requirements, { tokens: 1500n, lovelace: requirements.lovelace }).status, 'funded');
});

test('a proportional campaign asks for the full announced total, not the rounded-down shares', () => {
  const requirements = fundingRequirements({
    distribution: { mode: 'proportional', totalAmount: '106000000000' },
    snapshot: { totalAmount: '105999999483' },
    lanes: { count: 2 },
  });
  assert.equal(requirements.tokens, 106000000000n);
});

test('summarizeUtxos totals ADA and one asset only', () => {
  const summary = summarizeUtxos([
    { value: '3000000', asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '40' }] },
    { value: '2000000', asset_list: [{ policy_id: TOKEN.policyId, asset_name: '00', quantity: '9' }, { policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '2' }] },
  ], TOKEN);
  assert.deepEqual(summary, { lovelace: 5_000_000n, tokens: 42n });
});

test('the lane transaction splits the wallet into lanes and signs with the campaign key', async () => {
  const csl = await loadCsl();
  const wallet = generateClaimWallet('preprod', 'abcdefghjk');
  const utxos = [
    {
      tx_hash: 'a'.repeat(64),
      tx_index: 0,
      value: '60000000',
      asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '1000' }],
    },
    { tx_hash: 'c'.repeat(64), tx_index: 1, value: '5000000', asset_list: [] },
  ];
  const lanes = [{ index: 0, amount: 400n }, { index: 2, amount: 350n }, { index: 3, amount: 250n }];

  const built = buildLaneTransaction({
    csl, protocol: PROTOCOL, address: wallet.address, utxos, lanes, tokenY: TOKEN,
  });

  const outputs = built.transaction.body().outputs();
  assert.equal(outputs.len(), 4);
  lanes.forEach((lane, position) => {
    const output = outputs.get(position);
    const multiAsset = output.amount().multiasset();
    const policy = csl.ScriptHash.from_hex(TOKEN.policyId);
    const quantity = multiAsset.get(policy).get(csl.AssetName.new(Buffer.from(TOKEN.assetNameHex, 'hex')));
    assert.equal(quantity.to_str(), String(lane.amount));
    assert.ok(BigInt(output.amount().coin().to_str()) >= 1_000_000n);
  });
  assert.equal(built.lanes[2].txIndex, 2);

  const inputsTotal = 65_000_000n;
  const outputsTotal = Array.from({ length: outputs.len() }, (_, i) => BigInt(outputs.get(i).amount().coin().to_str()))
    .reduce((sum, value) => sum + value, 0n);
  assert.equal(outputsTotal + built.fee, inputsTotal);

  const signature = signWithClaimWallet(wallet.encryptedSeed, 'abcdefghjk', Buffer.from(built.txHash, 'hex'));
  const signed = attachWalletWitness(csl, built.transaction, wallet.publicKeyHex, signature);
  assert.equal(signed.witness_set().vkeys().len(), 1);
  assert.equal(nacl.sign.detached.verify(Buffer.from(built.txHash, 'hex'), signature, Buffer.from(wallet.publicKeyHex, 'hex')), true);

  const minimumFee = BigInt(PROTOCOL.txFeeFixed) + BigInt(PROTOCOL.txFeePerByte) * BigInt(signed.to_bytes().length);
  assert.ok(built.fee >= minimumFee, `fee ${built.fee} must cover the signed size (${minimumFee})`);
});

test('the lane transaction fails when the wallet lacks the tokens', async () => {
  const csl = await loadCsl();
  const wallet = generateClaimWallet('preprod', 'abcdefghjk');
  assert.throws(() => buildLaneTransaction({
    csl,
    protocol: PROTOCOL,
    address: wallet.address,
    utxos: [{ tx_hash: 'a'.repeat(64), tx_index: 0, value: '60000000', asset_list: [] }],
    lanes: [{ index: 0, amount: 10n }],
    tokenY: TOKEN,
  }));
});

// A UTxO as the chain reports it (Koios format).
function walletUtxo(csl, address, txHash, index, lovelace, tokens = null) {
  return {
    tx_hash: txHash,
    tx_index: index,
    address,
    value: String(lovelace),
    asset_list: tokens ? [{ policy_id: 'c'.repeat(56), asset_name: '7777', quantity: String(tokens) }] : [],
  };
}

test('a claim moves the claimed tokens to the claimer, keeps the rest in the lane, and the claimer pays the fee', async () => {
  const csl = await loadCsl();
  const campaign = generateClaimWallet('preprod', 'abcdefghjk');
  const claimerSeed = Buffer.alloc(32, 9);
  const { publicKey } = nacl.sign.keyPair.fromSeed(claimerSeed);
  const claimerAddress = enterpriseAddressFromPublicKey(publicKey, 0);

  const lane = {
    tx_hash: 'a'.repeat(64),
    tx_index: 2,
    value: '2000000',
    asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '1000' }],
  };
  const claimerUtxos = [
    walletUtxo(csl, claimerAddress, 'd'.repeat(64), 0, 3_000_000),
    walletUtxo(csl, claimerAddress, 'e'.repeat(64), 1, 9_000_000),
    walletUtxo(csl, claimerAddress, 'f'.repeat(64), 0, 1_500_000, 5),
  ];

  const built = buildClaimTransaction({
    csl,
    protocol: PROTOCOL,
    campaignAddress: campaign.address,
    lane,
    claimerAddress,
    claimerUtxos,
    tokenY: TOKEN,
    amount: 150n,
    ttl: 123456,
  });

  const body = built.transaction.body();
  assert.equal(body.ttl_bignum().to_str(), '123456');
  const outputs = body.outputs();
  const policy = csl.ScriptHash.from_hex(TOKEN.policyId);
  const name = csl.AssetName.new(Buffer.from(TOKEN.assetNameHex, 'hex'));
  const tokensIn = (output) => output.amount().multiasset()?.get(policy)?.get(name)?.to_str();

  assert.equal(outputs.get(0).address().to_bech32(), claimerAddress);
  assert.equal(tokensIn(outputs.get(0)), '150');
  assert.equal(outputs.get(1).address().to_bech32(), campaign.address);
  assert.equal(tokensIn(outputs.get(1)), '850');
  assert.equal(outputs.get(1).amount().coin().to_str(), '2000000');
  assert.equal(built.laneOutputIndex, 1);

  // The campaign wallet pays nothing: its ADA comes back whole, and every other ADA is the claimer's.
  const claimerOut = BigInt(outputs.get(0).amount().coin().to_str());
  const changeOut = BigInt(outputs.get(2).amount().coin().to_str());
  assert.equal(outputs.get(2).address().to_bech32(), claimerAddress);
  // The biggest plain-ADA UTxO is enough; the smaller one and the one carrying other tokens are left alone.
  assert.equal(claimerOut + changeOut + built.fee, 9_000_000n);
  assert.equal(body.inputs().len(), 2);

  // Campaign signature first, then the claimer's wallet signs the same body.
  const campaignSignature = signWithClaimWallet(campaign.encryptedSeed, 'abcdefghjk', Buffer.from(built.txHash, 'hex'));
  const campaignWitness = campaignVkeyWitness(csl, campaign.publicKeyHex, campaignSignature);
  const claimerWitness = csl.make_vkey_witness(csl.hash_transaction(body), csl.PrivateKey.from_normal_bytes(claimerSeed));
  const claimerSet = csl.TransactionWitnessSet.new();
  const claimerKeys = csl.Vkeywitnesses.new();
  claimerKeys.add(claimerWitness);
  claimerSet.set_vkeys(claimerKeys);

  const signed = assembleClaimTransaction(csl, Buffer.from(body.to_bytes()).toString('hex'), campaignWitness, claimerSet.to_hex());
  assert.equal(signed.witness_set().vkeys().len(), 2);
  assert.equal(Buffer.from(csl.hash_transaction(signed.body()).to_bytes()).toString('hex'), built.txHash);

  const minimumFee = BigInt(PROTOCOL.txFeeFixed) + BigInt(PROTOCOL.txFeePerByte) * BigInt(signed.to_bytes().length);
  assert.ok(built.fee >= minimumFee, `fee ${built.fee} must cover the signed size (${minimumFee})`);
});

test('a claim is refused when the wallet cannot cover the tokens\' ADA, the fee and its change', async () => {
  const csl = await loadCsl();
  const campaign = generateClaimWallet('preprod', 'abcdefghjk');
  const { publicKey } = nacl.sign.keyPair.fromSeed(Buffer.alloc(32, 9));
  const claimerAddress = enterpriseAddressFromPublicKey(publicKey, 0);
  const lane = { tx_hash: 'a'.repeat(64), tx_index: 0, value: '2000000', asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '10' }] };

  assert.throws(() => buildClaimTransaction({
    csl, protocol: PROTOCOL, campaignAddress: campaign.address, lane, claimerAddress,
    claimerUtxos: [walletUtxo(csl, claimerAddress, 'd'.repeat(64), 0, 2_000_000)],
    tokenY: TOKEN, amount: 5n, ttl: 1,
  }), (error) => error.code === 'insufficient-ada');

  assert.throws(() => buildClaimTransaction({
    csl, protocol: PROTOCOL, campaignAddress: campaign.address, lane, claimerAddress,
    claimerUtxos: [walletUtxo(csl, claimerAddress, 'd'.repeat(64), 0, 20_000_000)],
    tokenY: TOKEN, amount: 11n, ttl: 1,
  }), /does not hold enough tokens/);
});

test('a sweep sends every ADA and token in the campaign wallet to the owner', async () => {
  const csl = await loadCsl();
  const campaign = generateClaimWallet('preprod', 'abcdefghjk');
  const { publicKey } = nacl.sign.keyPair.fromSeed(Buffer.alloc(32, 4));
  const owner = enterpriseAddressFromPublicKey(publicKey, 0);

  const utxos = [
    { tx_hash: 'a'.repeat(64), tx_index: 0, value: '2000000', asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '400' }] },
    { tx_hash: 'b'.repeat(64), tx_index: 3, value: '2000000', asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '350' }, { policy_id: 'd'.repeat(56), asset_name: '', quantity: '1' }] },
    { tx_hash: 'c'.repeat(64), tx_index: 1, value: '40000000', asset_list: [] },
  ];
  const built = buildSweepTransaction({ csl, protocol: PROTOCOL, address: campaign.address, utxos, destination: owner });

  const outputs = built.transaction.body().outputs();
  assert.equal(outputs.len(), 1);
  assert.equal(outputs.get(0).address().to_bech32(), owner);
  const policy = csl.ScriptHash.from_hex(TOKEN.policyId);
  assert.equal(outputs.get(0).amount().multiasset().get(policy).get(csl.AssetName.new(Buffer.from(TOKEN.assetNameHex, 'hex'))).to_str(), '750');
  assert.equal(BigInt(outputs.get(0).amount().coin().to_str()) + built.fee, 44_000_000n);
  assert.equal(built.moreRemain, false);

  const signature = signWithClaimWallet(campaign.encryptedSeed, 'abcdefghjk', Buffer.from(built.txHash, 'hex'));
  const signed = attachWalletWitness(csl, built.transaction, campaign.publicKeyHex, signature);
  const minimumFee = BigInt(PROTOCOL.txFeeFixed) + BigInt(PROTOCOL.txFeePerByte) * BigInt(signed.to_bytes().length);
  assert.ok(built.fee >= minimumFee);

  assert.throws(() => buildSweepTransaction({ csl, protocol: PROTOCOL, address: campaign.address, utxos: [], destination: owner }), /empty/);
});

test('the signing guard refuses a claim that spends anything of the campaign wallet\'s other than the lane', async () => {
  const csl = await loadCsl();
  const campaign = generateClaimWallet('preprod', 'abcdefghjk');
  const attacker = enterpriseAddressFromPublicKey(nacl.sign.keyPair.fromSeed(Buffer.alloc(32, 9)).publicKey, 0);
  const lane = { tx_hash: 'a'.repeat(64), tx_index: 0, value: '2000000', asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '1000' }] };
  // Another UTxO at the campaign address, presented as if it were the claimer's.
  const foreign = { tx_hash: 'e'.repeat(64), tx_index: 3, address: campaign.address, value: '50000000', asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '99999' }] };

  const built = buildClaimTransaction({
    csl, protocol: PROTOCOL, campaignAddress: campaign.address, lane, claimerAddress: attacker,
    claimerUtxos: [foreign], tokenY: TOKEN, amount: 10n, ttl: 5,
  });
  const guard = (overrides = {}) => assertClaimTransaction(csl, built.transaction, {
    campaignAddress: campaign.address, claimerAddress: attacker, lane, claimerInputs: built.claimerInputs,
    allowInput: () => true, tokenY: TOKEN, amount: 10n, ...overrides,
  });

  // The builder happily includes it, which is exactly why the guard exists.
  assert.throws(() => guard(), /is not the claimer's/);

  // A claim whose outputs were tampered with (more tokens to the claimer) is refused too.
  const honest = buildClaimTransaction({
    csl, protocol: PROTOCOL, campaignAddress: campaign.address, lane, claimerAddress: attacker,
    claimerUtxos: [walletUtxo(csl, attacker, 'd'.repeat(64), 0, 20_000_000)], tokenY: TOKEN, amount: 10n, ttl: 5,
  });
  const check = (overrides) => assertClaimTransaction(csl, honest.transaction, {
    campaignAddress: campaign.address, claimerAddress: attacker, lane, claimerInputs: honest.claimerInputs,
    allowInput: () => true, tokenY: TOKEN, amount: 10n, ...overrides,
  });
  assert.doesNotThrow(() => check({}));
  assert.throws(() => check({ amount: 11n }), /not exactly the entitled amount/);
  assert.throws(() => check({ claimerAddress: campaign.address }), /not the claimer|first output/);
  assert.throws(() => check({ allowInput: () => false }), /is not the claimer's/);
  assert.throws(() => check({ maxFee: 1n }), /fee too high/);
});
