import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'tweetnacl';
import { generateClaimWallet, signWithClaimWallet } from '../api/_lib/claim-wallet.js';
import { enterpriseAddressFromPublicKey } from '../api/_lib/cardano-address.js';
import {
  FUNDING_FEE_BUFFER,
  assembleClaimTransaction,
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

function walletUtxo(csl, address, txHash, index, lovelace, tokens = null) {
  const value = csl.Value.new(csl.BigNum.from_str(String(lovelace)));
  if (tokens) {
    const assets = csl.Assets.new();
    assets.insert(csl.AssetName.new(Buffer.from('7777', 'hex')), csl.BigNum.from_str(String(tokens)));
    const multiAsset = csl.MultiAsset.new();
    multiAsset.insert(csl.ScriptHash.from_hex('c'.repeat(56)), assets);
    value.set_multiasset(multiAsset);
  }
  const utxo = csl.TransactionUnspentOutput.new(
    csl.TransactionInput.new(csl.TransactionHash.from_hex(txHash), index),
    csl.TransactionOutput.new(csl.Address.from_bech32(address), value),
  );
  return utxo.to_hex();
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
    claimerUtxoHexes: claimerUtxos,
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
    claimerUtxoHexes: [walletUtxo(csl, claimerAddress, 'd'.repeat(64), 0, 2_000_000)],
    tokenY: TOKEN, amount: 5n, ttl: 1,
  }), (error) => error.code === 'insufficient-ada');

  assert.throws(() => buildClaimTransaction({
    csl, protocol: PROTOCOL, campaignAddress: campaign.address, lane, claimerAddress,
    claimerUtxoHexes: [walletUtxo(csl, claimerAddress, 'd'.repeat(64), 0, 20_000_000)],
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
