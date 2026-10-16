import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'tweetnacl';
import { generateClaimWallet, signWithClaimWallet } from '../api/_lib/claim-wallet.js';
import {
  FUNDING_FEE_BUFFER,
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
