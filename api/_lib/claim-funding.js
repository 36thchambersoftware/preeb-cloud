import crypto from 'node:crypto';
import { addressBelongsToStake } from './cardano-address.js';

/**
 * Claim lanes (shown to people as "UTxOs").
 *
 * A campaign wallet could hold all of token Y in one UTxO, but every claim
 * spends that UTxO and recreates it, so only one claim could be in flight at a
 * time. Instead one transaction splits the wallet into several lanes, each
 * holding exactly the tokens owed to the claimants assigned to it. The owner
 * chooses how many (20-100); with fewer eligible wallets than that, every
 * wallet gets a lane of its own.
 *
 * Campaigns created before the owner could choose have no stored assignment:
 * their lane comes from a hash of the entitlement key (`laneIndexFor`).
 */

export const MIN_CLAIM_UTXOS = 20;
export const MAX_CLAIM_UTXOS = 100;
export const DEFAULT_CLAIM_UTXOS = 20;

// Campaigns created before the owner's choice existed.
export const LANE_TARGET_CLAIMS = 10;
export const MAX_LANES = 20;

// The ledger's minimum for a token output is 1.13-1.31 ADA (longer asset names need more);
// 1.5 ADA leaves headroom. A 100-output transaction costs about 0.64 ADA in fees.
export const LANE_LOVELACE_ESTIMATE = 1_500_000n;
export const FUNDING_FEE_BUFFER = 1_500_000n;

/** The ADA an owner sends for a given number of UTxOs. It is returned when the campaign ends. */
export function depositLovelaceFor(utxoCount) {
  return BigInt(utxoCount) * LANE_LOVELACE_ESTIMATE + FUNDING_FEE_BUFFER;
}

/** Accepts the owner's UTxO choice; anything else is rejected by the caller. */
export function isValidClaimUtxoCount(value) {
  return Number.isInteger(value) && value >= MIN_CLAIM_UTXOS && value <= MAX_CLAIM_UTXOS;
}

/** `requested` is the owner's choice; without one the pre-choice sizing applies. */
export function laneCountFor(eligibleCount, requested) {
  if (isValidClaimUtxoCount(requested)) return Math.max(1, Math.min(requested, eligibleCount));
  return Math.min(MAX_LANES, Math.max(1, Math.ceil(eligibleCount / LANE_TARGET_CLAIMS)));
}

export function laneIndexFor(key, laneCount) {
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % laneCount;
}

/** The stored assignment when there is one, otherwise the older hash-based one. */
export function laneOf(entitlement, laneCount) {
  return Number.isInteger(entitlement.lane) ? entitlement.lane : laneIndexFor(entitlement.key, laneCount);
}

/** Spreads wallets over the lanes evenly: lane sizes differ by at most one. */
export function assignLanes(entitlements, laneCount) {
  return [...entitlements]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entitlement, position) => ({ ...entitlement, lane: position % laneCount }));
}

/** Sum of entitlement amounts per lane. Lanes nobody maps to are omitted. */
export function computeLaneAmounts(entitlements, laneCount) {
  const lanes = new Map();
  for (const entitlement of entitlements) {
    const index = laneOf(entitlement, laneCount);
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
    lovelace: depositLovelaceFor(laneCount),
  };
}

/**
 * `prepared` is true once the claim UTxOs have been set up. That only happens after the wallet held
 * the full amount, and the setup transaction's fee (and later the claims themselves) take the balance
 * below the original requirement, so a prepared campaign must not be reported as under-funded.
 */
export function evaluateFunding(requirements, balances, { prepared = false } = {}) {
  const hasTokens = balances.tokens >= requirements.tokens;
  const hasLovelace = balances.lovelace >= requirements.lovelace;
  let status = 'funded';
  if (!prepared && (!hasTokens || !hasLovelace)) {
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
  csl, protocol, campaignAddress, lane, claimerAddress, claimerUtxos, tokenY, amount, ttl,
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

  // The claimer's own funds cover the tokens' ADA, the fee and a change output. These are
  // UTxOs the caller has already re-read from the chain and checked belong to the claimer.
  const spendable = claimerUtxos
    .map((utxo) => ({ utxo, lovelace: BigInt(utxo.value), tokens: (utxo.asset_list || []).length > 0 }))
    .sort((a, b) => (Number(a.tokens) - Number(b.tokens)) || (a.lovelace > b.lovelace ? -1 : 1));

  const required = claimerOutputLovelace + CLAIMER_BUFFER_LOVELACE;
  let gathered = 0n;
  const claimerInputRefs = [];
  const claimerInputs = [];
  for (const candidate of spendable) {
    if (gathered >= required || claimerInputRefs.length >= MAX_CLAIMER_INPUTS) break;
    builder.add_regular_input(
      csl.Address.from_bech32(candidate.utxo.address),
      csl.TransactionInput.new(csl.TransactionHash.from_hex(candidate.utxo.tx_hash), candidate.utxo.tx_index),
      valueFromKoiosUtxo(csl, candidate.utxo),
    );
    gathered += candidate.lovelace;
    claimerInputRefs.push(`${candidate.utxo.tx_hash}#${candidate.utxo.tx_index}`);
    claimerInputs.push(candidate.utxo);
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
    claimerInputRefs,
    claimerInputs,
  };
}

/**
 * Last line of defence before the campaign key signs anything: the transaction must
 * contain exactly what a claim is supposed to, and nothing else. The campaign key
 * signature is valid for every input at the campaign address, so a body that spent
 * anything extra from there, or paid anyone but the claimer and the campaign wallet,
 * would be a theft.
 */
export function assertClaimTransaction(csl, transaction, {
  campaignAddress, claimerAddress, lane, claimerInputs, allowInput, tokenY, amount, maxFee = 2_000_000n,
}) {
  const refuse = (reason) => { throw new Error(`Refusing to sign the claim: ${reason}`); };
  const body = transaction.body();

  // Every input besides the lane must be one the claimer is allowed to spend, judged by
  // what the chain says about it, and never anything at the campaign address.
  for (const utxo of claimerInputs) {
    if (utxo.address === campaignAddress || !allowInput(utxo)) refuse(`input ${utxo.tx_hash}#${utxo.tx_index} is not the claimer's`);
  }
  const claimerInputRefs = claimerInputs.map((utxo) => `${utxo.tx_hash}#${utxo.tx_index}`);

  const expectedInputs = new Set([`${lane.tx_hash}#${lane.tx_index}`, ...claimerInputRefs]);
  const inputs = body.inputs();
  if (inputs.len() !== expectedInputs.size) refuse('unexpected number of inputs');
  for (let i = 0; i < inputs.len(); i += 1) {
    const input = inputs.get(i);
    const ref = `${Buffer.from(input.transaction_id().to_bytes()).toString('hex')}#${input.index()}`;
    if (!expectedInputs.has(ref)) refuse(`unexpected input ${ref}`);
  }

  for (const part of ['certs', 'withdrawals', 'mint', 'collateral', 'script_data_hash', 'reference_inputs', 'required_signers',
    'auxiliary_data_hash', 'total_collateral', 'collateral_return', 'voting_procedures', 'voting_proposals', 'donation']) {
    if (typeof body[part] === 'function' && body[part]()) refuse(`unexpected ${part}`);
  }
  if (!body.ttl_bignum()) refuse('no expiry');
  if (BigInt(body.fee().to_str()) > maxFee) refuse('fee too high');

  const tokens = (output) => multiAssetEntries(csl, output.amount().multiasset());
  const outputs = body.outputs();
  if (outputs.len() < 2 || outputs.len() > 3) refuse('unexpected number of outputs');

  const first = outputs.get(0);
  const firstTokens = tokens(first);
  if (first.address().to_bech32() !== claimerAddress) refuse('first output is not the claimer');
  if (firstTokens.length !== 1 || firstTokens[0].policyHex !== tokenY.policyId
    || firstTokens[0].nameHex !== tokenY.assetNameHex || firstTokens[0].quantity !== amount) refuse('claimer output is not exactly the entitled amount');

  const laneValue = valueFromKoiosUtxo(csl, lane);
  const remainder = outputs.get(1);
  if (remainder.address().to_bech32() !== campaignAddress) refuse('lane remainder does not return to the campaign wallet');
  if (remainder.amount().coin().to_str() !== laneValue.coin().to_str()) refuse('lane ADA changed');
  const expectedRemainder = multiAssetEntries(csl, laneValue.multiasset())
    .map((entry) => (entry.policyHex === tokenY.policyId && entry.nameHex === tokenY.assetNameHex ? { ...entry, quantity: entry.quantity - amount } : entry))
    .filter((entry) => entry.quantity > 0n)
    .map((entry) => `${entry.policyHex}.${entry.nameHex}=${entry.quantity}`).sort();
  const actualRemainder = tokens(remainder).map((entry) => `${entry.policyHex}.${entry.nameHex}=${entry.quantity}`).sort();
  if (JSON.stringify(expectedRemainder) !== JSON.stringify(actualRemainder)) refuse('lane remainder tokens changed');

  if (outputs.len() === 3 && outputs.get(2).address().to_bech32() !== claimerAddress) refuse('change does not return to the claimer');
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

// Funding ---------------------------------------------------------------------

/** The smallest ADA-only output the ledger accepts is about 0.97 ADA; this leaves a margin. */
const MIN_ADA_ONLY_OUTPUT = 1_200_000n;
const FUNDING_TTL_SLOTS = 7200;

/**
 * Builds the unsigned transaction that funds a campaign from the owner's wallet: one
 * output to the campaign wallet carrying `tokens` and `lovelace`, change back to the
 * owner. `ownerUtxos` are Koios-format UTxOs the caller re-read from the chain. The
 * campaign key is not involved: only the owner's wallet signs this.
 */
export function buildFundingTransaction({
  csl, protocol, ownerUtxos, ownerAddress, campaignAddress, tokenY, tokens, lovelace, tip,
}) {
  const { config, coinsPerByte } = buildConfig(csl, protocol);
  const builder = csl.TransactionBuilder.new(config);
  builder.set_ttl_bignum(csl.BigNum.from_str(String(tip + FUNDING_TTL_SLOTS)));
  const dataCost = csl.DataCost.new_coins_per_byte(csl.BigNum.from_str(String(coinsPerByte)));
  const campaign = csl.Address.from_bech32(campaignAddress);

  let output;
  if (tokens > 0n) {
    const multiAsset = tokenMultiAsset(csl, tokenY, tokens);
    output = csl.TransactionOutputBuilder.new().with_address(campaign).next()
      .with_asset_and_min_required_coin_by_utxo_cost(multiAsset, dataCost).build();
    const minimum = BigInt(output.amount().coin().to_str());
    if (lovelace > minimum) {
      output = csl.TransactionOutputBuilder.new().with_address(campaign).next()
        .with_coin_and_asset(csl.BigNum.from_str(lovelace.toString()), multiAsset).build();
    }
  } else {
    const coin = lovelace > MIN_ADA_ONLY_OUTPUT ? lovelace : MIN_ADA_ONLY_OUTPUT;
    output = csl.TransactionOutput.new(campaign, csl.Value.new(csl.BigNum.from_str(coin.toString())));
  }
  builder.add_output(output);

  const available = csl.TransactionUnspentOutputs.new();
  for (const utxo of ownerUtxos) {
    available.add(csl.TransactionUnspentOutput.new(
      csl.TransactionInput.new(csl.TransactionHash.from_hex(utxo.tx_hash), utxo.tx_index),
      csl.TransactionOutput.new(csl.Address.from_bech32(utxo.address), valueFromKoiosUtxo(csl, utxo)),
    ));
  }
  builder.add_inputs_from(available, csl.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
  builder.add_change_if_needed(csl.Address.from_bech32(ownerAddress));

  const body = builder.build_tx().body();
  return {
    transaction: csl.Transaction.new(body, csl.TransactionWitnessSet.new()),
    fee: BigInt(body.fee().to_str()),
    lovelaceSent: BigInt(output.amount().coin().to_str()),
  };
}

/**
 * What the server insists on before it forwards an owner's funding transaction: it may only
 * pay the campaign wallet (with the campaign's own token) and the owner's own address, and
 * must not carry anything else (certificates, withdrawals, minting, scripts).
 */
export function assertFundingTransaction(csl, body, { campaignAddress, ownerStake, tokenY, maxFee = 3_000_000n }) {
  const refuse = (reason) => { throw new Error(`Funding transaction refused: ${reason}.`); };
  for (const part of ['certs', 'withdrawals', 'mint', 'collateral', 'script_data_hash', 'reference_inputs', 'required_signers',
    'auxiliary_data_hash', 'total_collateral', 'collateral_return', 'voting_procedures', 'voting_proposals', 'donation']) {
    if (typeof body[part] === 'function' && body[part]()) refuse(`unexpected ${part}`);
  }
  if (!body.ttl_bignum()) refuse('no expiry');
  if (BigInt(body.fee().to_str()) > maxFee) refuse('fee too high');

  const outputs = body.outputs();
  if (outputs.len() < 1 || outputs.len() > 2) refuse('unexpected number of outputs');
  const first = outputs.get(0);
  if (first.address().to_bech32() !== campaignAddress) refuse('first output is not the campaign wallet');
  for (const entry of multiAssetEntries(csl, first.amount().multiasset())) {
    if (entry.policyHex !== tokenY.policyId || entry.nameHex !== tokenY.assetNameHex) refuse('it carries a different token');
  }
  if (outputs.len() === 2) {
    const change = outputs.get(1).address().to_bech32();
    if (!addressBelongsToStake(change, ownerStake)) refuse('change does not return to the owner');
  }
}

/** Combines the owner's unsigned transaction with the witnesses their wallet produced. */
export function assembleFundingTransaction(csl, unsignedTxHex, witnessSetHex) {
  const body = csl.Transaction.from_hex(unsignedTxHex).body();
  const given = csl.TransactionWitnessSet.from_hex(witnessSetHex).vkeys();
  if (!given || given.len() === 0) throw new Error('The wallet did not return a signature.');
  const vkeys = csl.Vkeywitnesses.new();
  for (let index = 0; index < given.len(); index += 1) vkeys.add(given.get(index));
  const witnessSet = csl.TransactionWitnessSet.new();
  witnessSet.set_vkeys(vkeys);
  return csl.Transaction.new(body, witnessSet);
}
