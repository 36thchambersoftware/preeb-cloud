import crypto from 'node:crypto';

/**
 * Claim lanes.
 *
 * A campaign wallet could hold all of token Y in one UTxO, but every claim
 * spends that UTxO and recreates it, so only one claim could be in flight at a
 * time. Instead the owner "prepares" the campaign once: a single transaction
 * splits the wallet into several lanes, each holding exactly the tokens owed to
 * the claimants assigned to it. A claimant's lane comes from a hash of their
 * entitlement key, so no per-claimant assignment has to be stored.
 */

export const LANE_TARGET_CLAIMS = 10;
export const MAX_LANES = 20;
// Minimum ADA for a token output is about 1.2-1.5 ADA; 2 ADA leaves headroom.
export const LANE_LOVELACE_ESTIMATE = 2_000_000n;
export const FUNDING_FEE_BUFFER = 1_000_000n;

export function laneCountFor(eligibleCount) {
  return Math.min(MAX_LANES, Math.max(1, Math.ceil(eligibleCount / LANE_TARGET_CLAIMS)));
}

export function laneIndexFor(key, laneCount) {
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % laneCount;
}

/** Sum of entitlement amounts per lane. Lanes nobody maps to are omitted. */
export function computeLaneAmounts(entitlements, laneCount) {
  const lanes = new Map();
  for (const entitlement of entitlements) {
    const index = laneIndexFor(entitlement.key, laneCount);
    lanes.set(index, (lanes.get(index) || 0n) + BigInt(entitlement.amount));
  }
  return [...lanes].map(([index, amount]) => ({ index, amount })).sort((a, b) => a.index - b.index);
}

export function fundingRequirements(campaign) {
  const laneCount = campaign.lanes?.count || 0;
  // A proportional split rounds each share down; the owner still funds the full amount they announced.
  const announced = campaign.distribution?.mode === 'proportional' ? campaign.distribution.totalAmount : null;
  return {
    tokens: BigInt(announced || campaign.snapshot?.totalAmount || 0),
    lovelace: BigInt(laneCount) * LANE_LOVELACE_ESTIMATE + FUNDING_FEE_BUFFER,
  };
}

export function evaluateFunding(requirements, balances) {
  const hasTokens = balances.tokens >= requirements.tokens;
  const hasLovelace = balances.lovelace >= requirements.lovelace;
  let status = 'funded';
  if (!hasTokens || !hasLovelace) {
    status = balances.tokens > 0n || balances.lovelace > 0n ? 'partial' : 'unfunded';
  }
  return {
    status,
    tokensRequired: requirements.tokens.toString(),
    tokensHeld: balances.tokens.toString(),
    lovelaceRequired: requirements.lovelace.toString(),
    lovelaceHeld: balances.lovelace.toString(),
  };
}

// Transaction building ------------------------------------------------------

export async function loadCsl() {
  const imported = await import('@emurgo/cardano-serialization-lib-nodejs');
  return imported.default || imported;
}

function protocolNumber(protocol, ...keys) {
  for (const key of keys) {
    const value = Number(protocol?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function buildConfig(csl, protocol) {
  const feePerByte = protocolNumber(protocol, 'txFeePerByte', 'tx_fee_per_byte');
  const feeFixed = protocolNumber(protocol, 'txFeeFixed', 'tx_fee_fixed');
  const coinsPerByte = protocolNumber(protocol, 'utxoCostPerByte', 'coins_per_utxo_byte');
  if (!feePerByte || !feeFixed || !coinsPerByte) {
    throw new Error('Koios returned incomplete protocol parameters.');
  }

  const config = csl.TransactionBuilderConfigBuilder.new()
    .fee_algo(csl.LinearFee.new(csl.BigNum.from_str(String(feePerByte)), csl.BigNum.from_str(String(feeFixed))))
    .pool_deposit(csl.BigNum.from_str(String(protocolNumber(protocol, 'stakePoolDeposit', 'pool_deposit') || 0)))
    .key_deposit(csl.BigNum.from_str(String(protocolNumber(protocol, 'stakeAddressDeposit', 'key_deposit') || 0)))
    .max_tx_size(protocolNumber(protocol, 'maxTxSize', 'max_tx_size') || 16384)
    .max_value_size(protocolNumber(protocol, 'maxValueSize', 'max_value_size') || 5000)
    .coins_per_utxo_byte(csl.BigNum.from_str(String(Math.trunc(coinsPerByte))))
    .build();
  return { config, coinsPerByte: Math.trunc(coinsPerByte) };
}

function valueFromKoiosUtxo(csl, utxo) {
  const value = csl.Value.new(csl.BigNum.from_str(String(utxo.value)));
  const assets = utxo.asset_list || [];
  if (assets.length === 0) return value;

  const multiAsset = csl.MultiAsset.new();
  for (const asset of assets) {
    const policy = csl.ScriptHash.from_hex(asset.policy_id);
    const existing = multiAsset.get(policy) || csl.Assets.new();
    existing.insert(csl.AssetName.new(Buffer.from(asset.asset_name || '', 'hex')), csl.BigNum.from_str(String(asset.quantity)));
    multiAsset.insert(policy, existing);
  }
  value.set_multiasset(multiAsset);
  return value;
}

function tokenMultiAsset(csl, tokenY, amount) {
  const assets = csl.Assets.new();
  assets.insert(csl.AssetName.new(Buffer.from(tokenY.assetNameHex, 'hex')), csl.BigNum.from_str(String(amount)));
  const multiAsset = csl.MultiAsset.new();
  multiAsset.insert(csl.ScriptHash.from_hex(tokenY.policyId), assets);
  return multiAsset;
}

/**
 * Builds the unsigned transaction that spends every UTxO in the campaign wallet
 * and recreates it as one output per lane (plus change). Lane outputs come
 * first, so lane i is output index i.
 */
export function buildLaneTransaction({ csl, protocol, address, utxos, lanes, tokenY }) {
  const { config, coinsPerByte } = buildConfig(csl, protocol);
  const builder = csl.TransactionBuilder.new(config);
  const walletAddress = csl.Address.from_bech32(address);

  for (const utxo of utxos) {
    builder.add_regular_input(
      walletAddress,
      csl.TransactionInput.new(csl.TransactionHash.from_hex(utxo.tx_hash), utxo.tx_index),
      valueFromKoiosUtxo(csl, utxo),
    );
  }

  const dataCost = csl.DataCost.new_coins_per_byte(csl.BigNum.from_str(String(coinsPerByte)));
  for (const lane of lanes) {
    builder.add_output(
      csl.TransactionOutputBuilder.new()
        .with_address(walletAddress)
        .next()
        .with_asset_and_min_required_coin_by_utxo_cost(tokenMultiAsset(csl, tokenY, lane.amount), dataCost)
        .build(),
    );
  }

  builder.add_change_if_needed(walletAddress);
  const transaction = builder.build_tx();
  return {
    transaction,
    txHash: Buffer.from(csl.hash_transaction(transaction.body()).to_bytes()).toString('hex'),
    fee: BigInt(transaction.body().fee().to_str()),
    lanes: lanes.map((lane, position) => ({ ...lane, txIndex: position })),
  };
}

/** Attaches a campaign-wallet signature (over the transaction hash) to an unsigned transaction. */
export function attachWalletWitness(csl, transaction, publicKeyHex, signature) {
  const witness = csl.Vkeywitness.new(
    csl.Vkey.new(csl.PublicKey.from_bytes(Buffer.from(publicKeyHex, 'hex'))),
    csl.Ed25519Signature.from_bytes(signature),
  );
  const vkeys = csl.Vkeywitnesses.new();
  vkeys.add(witness);
  const witnessSet = csl.TransactionWitnessSet.new();
  witnessSet.set_vkeys(vkeys);
  return csl.Transaction.new(transaction.body(), witnessSet, transaction.auxiliary_data());
}

// Sweep ----------------------------------------------------------------------

/**
 * Spends up to `maxInputs` UTxOs of the campaign wallet and sends everything
 * (all ADA and tokens, minus the fee) to `destination`. A wallet with more
 * UTxOs than that is emptied by running the sweep again.
 */
export function buildSweepTransaction({ csl, protocol, address, utxos, destination, maxInputs = 120 }) {
  if (utxos.length === 0) throw new Error('The campaign wallet is empty.');
  const { config } = buildConfig(csl, protocol);
  const builder = csl.TransactionBuilder.new(config);
  const walletAddress = csl.Address.from_bech32(address);

  const chosen = utxos.slice(0, maxInputs);
  for (const utxo of chosen) {
    builder.add_regular_input(
      walletAddress,
      csl.TransactionInput.new(csl.TransactionHash.from_hex(utxo.tx_hash), utxo.tx_index),
      valueFromKoiosUtxo(csl, utxo),
    );
  }

  builder.add_change_if_needed(csl.Address.from_bech32(destination));
  const transaction = builder.build_tx();
  return {
    transaction,
    txHash: Buffer.from(csl.hash_transaction(transaction.body()).to_bytes()).toString('hex'),
    fee: BigInt(transaction.body().fee().to_str()),
    inputCount: chosen.length,
    moreRemain: utxos.length > chosen.length,
  };
}

// Claim ----------------------------------------------------------------------

const CLAIMER_BUFFER_LOVELACE = 2_500_000n;
const MAX_CLAIMER_INPUTS = 20;

function multiAssetEntries(csl, multiAsset) {
  const entries = [];
  if (!multiAsset) return entries;
  const policies = multiAsset.keys();
  for (let p = 0; p < policies.len(); p += 1) {
    const policy = policies.get(p);
    const assets = multiAsset.get(policy);
    const names = assets.keys();
    for (let a = 0; a < names.len(); a += 1) {
      const name = names.get(a);
      entries.push({
        policyHex: Buffer.from(policy.to_bytes()).toString('hex'),
        nameHex: Buffer.from(name.name()).toString('hex'),
        quantity: BigInt(assets.get(name).to_str()),
      });
    }
  }
  return entries;
}

function multiAssetFrom(csl, entries) {
  const multiAsset = csl.MultiAsset.new();
  for (const entry of entries.filter((item) => item.quantity > 0n)) {
    const policy = csl.ScriptHash.from_hex(entry.policyHex);
    const assets = multiAsset.get(policy) || csl.Assets.new();
    assets.insert(csl.AssetName.new(Buffer.from(entry.nameHex, 'hex')), csl.BigNum.from_str(entry.quantity.toString()));
    multiAsset.insert(policy, assets);
  }
  return multiAsset;
}

/**
 * Builds the claim transaction: the claimer's lane UTxO is spent, the claimer
 * receives their tokens (with the ADA to carry them, which comes from their own
 * funds), the rest of the lane goes back to the campaign wallet, and the claimer
 * pays the fee. Output 0 is the claimer's tokens and output 1 the lane's remainder.
 */
export function buildClaimTransaction({
  csl, protocol, campaignAddress, lane, claimerAddress, claimerUtxoHexes, tokenY, amount, ttl,
}) {
  const { config, coinsPerByte } = buildConfig(csl, protocol);
  const builder = csl.TransactionBuilder.new(config);
  builder.set_ttl_bignum(csl.BigNum.from_str(String(ttl)));

  const campaign = csl.Address.from_bech32(campaignAddress);
  const claimer = csl.Address.from_bech32(claimerAddress);
  const dataCost = csl.DataCost.new_coins_per_byte(csl.BigNum.from_str(String(coinsPerByte)));

  // The lane UTxO, exactly as it is on chain.
  const laneValue = valueFromKoiosUtxo(csl, lane);
  const laneAssets = multiAssetEntries(csl, laneValue.multiasset());
  const tokenPolicyHex = tokenY.policyId;
  const tokenNameHex = tokenY.assetNameHex;
  const held = laneAssets.find((entry) => entry.policyHex === tokenPolicyHex && entry.nameHex === tokenNameHex);
  if (!held || held.quantity < amount) throw new Error('The claim lane does not hold enough tokens for this claim.');

  builder.add_regular_input(
    campaign,
    csl.TransactionInput.new(csl.TransactionHash.from_hex(lane.tx_hash), lane.tx_index),
    laneValue,
  );

  // Output 0: the claimer's tokens, with the minimum ADA the ledger requires for them.
  const claimerOutput = csl.TransactionOutputBuilder.new()
    .with_address(claimer)
    .next()
    .with_asset_and_min_required_coin_by_utxo_cost(tokenMultiAsset(csl, tokenY, amount), dataCost)
    .build();
  builder.add_output(claimerOutput);
  const claimerOutputLovelace = BigInt(claimerOutput.amount().coin().to_str());

  // Output 1: whatever the lane still holds, back to the campaign wallet.
  const remaining = laneAssets.map((entry) => (
    entry === held ? { ...entry, quantity: entry.quantity - amount } : entry
  ));
  const remainderValue = csl.Value.new(laneValue.coin());
  const remainderAssets = multiAssetFrom(csl, remaining);
  if (remainderAssets.len() > 0) remainderValue.set_multiasset(remainderAssets);
  builder.add_output(csl.TransactionOutput.new(campaign, remainderValue));

  // The claimer's own funds cover the tokens' ADA, the fee and a change output.
  const parsed = claimerUtxoHexes.map((hex) => csl.TransactionUnspentOutput.from_hex(hex));
  const spendable = parsed
    .map((utxo) => ({ utxo, lovelace: BigInt(utxo.output().amount().coin().to_str()), tokens: Boolean(utxo.output().amount().multiasset()) }))
    .sort((a, b) => (Number(a.tokens) - Number(b.tokens)) || (a.lovelace > b.lovelace ? -1 : 1));

  const required = claimerOutputLovelace + CLAIMER_BUFFER_LOVELACE;
  let gathered = 0n;
  let used = 0;
  for (const candidate of spendable) {
    if (gathered >= required || used >= MAX_CLAIMER_INPUTS) break;
    builder.add_regular_input(candidate.utxo.output().address(), candidate.utxo.input(), candidate.utxo.output().amount());
    gathered += candidate.lovelace;
    used += 1;
  }
  if (gathered < required) {
    const error = new Error('Not enough ADA in the connected wallet.');
    error.code = 'insufficient-ada';
    error.requiredLovelace = required;
    throw error;
  }

  builder.add_change_if_needed(claimer);
  const transaction = builder.build_tx();
  return {
    transaction,
    txHash: Buffer.from(csl.hash_transaction(transaction.body()).to_bytes()).toString('hex'),
    fee: BigInt(transaction.body().fee().to_str()),
    laneOutputIndex: 1,
    tokenOutputLovelace: claimerOutputLovelace,
  };
}

/**
 * Combines the campaign wallet's signature with the claimer's witnesses into a
 * submittable transaction. Only verification-key witnesses are taken from the
 * claimer's set, and the body always comes from what the server built.
 */
export function assembleClaimTransaction(csl, bodyHex, campaignWitness, claimerWitnessSetHex) {
  const body = csl.TransactionBody.from_hex(bodyHex);
  const vkeys = csl.Vkeywitnesses.new();
  vkeys.add(campaignWitness);

  const claimerSet = csl.TransactionWitnessSet.from_hex(claimerWitnessSetHex);
  const claimerKeys = claimerSet.vkeys();
  if (!claimerKeys || claimerKeys.len() === 0) throw new Error('The wallet did not return a signature.');
  for (let index = 0; index < claimerKeys.len(); index += 1) vkeys.add(claimerKeys.get(index));

  const witnessSet = csl.TransactionWitnessSet.new();
  witnessSet.set_vkeys(vkeys);
  return csl.Transaction.new(body, witnessSet);
}

export function campaignVkeyWitness(csl, publicKeyHex, signature) {
  return csl.Vkeywitness.new(
    csl.Vkey.new(csl.PublicKey.from_bytes(Buffer.from(publicKeyHex, 'hex'))),
    csl.Ed25519Signature.from_bytes(signature),
  );
}
