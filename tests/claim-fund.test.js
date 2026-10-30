import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import { bech32 } from 'bech32';
import { blake2b } from '@noble/hashes/blake2.js';
import { enterpriseAddressFromPublicKey } from '../api/_lib/cardano-address.js';
import { ClaimInputError } from '../api/_lib/claim-campaign.js';
import { assertFundingTransaction, depositLovelaceFor, loadCsl } from '../api/_lib/claim-funding.js';
import { buildFunding, submitFunding } from '../api/_lib/claim-fund.js';

process.env.CLAIM_WALLET_KEY_SECRET = 'test-claim-wallet-secret-0123456789abcdef';
const { sealCampaign } = await import('../api/_lib/claim-seal.js');
const csl = await loadCsl();

const PROTOCOL = { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310, maxTxSize: 16384, maxValueSize: 5000, stakePoolDeposit: 500000000, stakeAddressDeposit: 2000000 };
const TOKEN = { policyId: 'b'.repeat(56), assetNameHex: '706565', ticker: 'PEE' };
const hex = (bytes) => Buffer.from(bytes).toString('hex');

function wallet() {
  const pay = nacl.sign.keyPair.fromSeed(crypto.randomBytes(32));
  const stakeKey = nacl.sign.keyPair.fromSeed(crypto.randomBytes(32));
  const paymentHash = blake2b(pay.publicKey, { dkLen: 28 });
  const stakeHash = blake2b(stakeKey.publicKey, { dkLen: 28 });
  return {
    pay,
    address: bech32.encode('addr', bech32.toWords(Buffer.concat([Buffer.from([0x01]), paymentHash, stakeHash])), 200),
    stake: bech32.encode('stake', bech32.toWords(Buffer.concat([Buffer.from([0xe1]), stakeHash])), 200),
  };
}

const owner = wallet();
const stranger = wallet();
const campaignWallet = enterpriseAddressFromPublicKey(Buffer.alloc(32, 9), 1);

function makeCampaign(overrides = {}) {
  const campaign = {
    _id: 'abcdefghjk',
    network: 'mainnet',
    wallet: { address: campaignWallet },
    owner: { stake: owner.stake, payoutAddress: owner.address },
    tokenY: { ...TOKEN, decimals: 0 },
    snapshot: { status: 'taken', totalAmount: '1000' },
    distribution: { mode: 'fixed' },
    lanes: { status: 'none', count: 20 },
    claimStartsAt: new Date(Date.now() + 3_600_000),
    claimEndsAt: new Date(Date.now() + 3 * 86_400_000),
    ...overrides,
  };
  campaign.seal = sealCampaign(campaign);
  return campaign;
}

function makeChain({ walletUtxos = [], ownerUtxos } = {}) {
  const utxos = new Map();
  const add = (u) => utxos.set(`${u.tx_hash}#${u.tx_index}`, { is_spent: false, ...u });
  for (const u of ownerUtxos ?? [{
    tx_hash: '1'.repeat(64), tx_index: 0, address: owner.address, value: '200000000',
    asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '5000' }],
  }]) add(u);
  for (const u of walletUtxos) add(u);
  const submitted = [];
  const confirmations = new Map();
  const ok = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => '' });
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname.replace('/api/v1/', '');
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    if (path === 'cli_protocol_params') return ok(PROTOCOL);
    if (path === 'tip') return ok([{ abs_slot: 5000 }]);
    if (path === 'address_utxos') return ok([...utxos.values()].filter((u) => body._addresses.includes(u.address)));
    if (path === 'utxo_info') return ok(body._utxo_refs.map((r) => utxos.get(r)).filter(Boolean));
    if (path === 'tx_status') return ok(body._tx_hashes.map((h) => ({ tx_hash: h, num_confirmations: confirmations.get(h) ?? null })));
    if (path === 'submittx') { submitted.push(options.body); return ok('f'.repeat(64)); }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, submitted, confirmations, utxos };
}

const fakeDb = () => {
  const updates = [];
  return { updates, collection: () => ({ updateOne: async (filter, update) => { updates.push(update); } }) };
};

const hexOfUtxo = (u) => csl.TransactionUnspentOutput.new(
  csl.TransactionInput.new(csl.TransactionHash.from_hex(u.tx_hash), u.tx_index),
  csl.TransactionOutput.new(csl.Address.from_bech32(u.address), csl.Value.new(csl.BigNum.from_str(String(u.value)))),
).to_hex();

function sign(txHex, who) {
  const tx = csl.Transaction.from_hex(txHex);
  const witness = csl.make_vkey_witness(csl.hash_transaction(tx.body()), csl.PrivateKey.from_normal_bytes(who.pay.secretKey.slice(0, 32)));
  const set = csl.TransactionWitnessSet.new();
  const keys = csl.Vkeywitnesses.new();
  keys.add(witness);
  set.set_vkeys(keys);
  return set.to_hex();
}

function summarise(txHex) {
  const body = csl.Transaction.from_hex(txHex).body();
  const outputs = body.outputs();
  const rows = [];
  for (let index = 0; index < outputs.len(); index += 1) {
    const out = outputs.get(index);
    const assets = out.amount().multiasset();
    let tokens = 0n;
    if (assets) {
      const policy = assets.keys().get(0);
      const names = assets.get(policy);
      tokens = BigInt(names.get(names.keys().get(0)).to_str());
    }
    rows.push({ address: out.address().to_bech32(), lovelace: BigInt(out.amount().coin().to_str()), tokens });
  }
  return { rows, fee: BigInt(body.fee().to_str()) };
}

const ownerUtxoHexes = (chain) => [...chain.utxos.values()].filter((u) => u.address === owner.address).map(hexOfUtxo);

test('funding sends exactly what is missing to the campaign wallet and returns the rest to the owner', async () => {
  const chain = makeChain();
  const built = await buildFunding(fakeDb(), makeCampaign(), { address: owner.address, utxoHexes: ownerUtxoHexes(chain), fetchImpl: chain.fetchImpl });

  assert.equal(built.tokens, '1000');
  assert.equal(built.lovelace, depositLovelaceFor(20).toString());
  const { rows, fee } = summarise(built.txHex);
  assert.equal(rows[0].address, campaignWallet);
  assert.equal(rows[0].tokens, 1000n);
  assert.equal(rows[0].lovelace, depositLovelaceFor(20));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].address, owner.address);
  assert.equal(rows[1].tokens, 4000n);
  assert.equal(rows[0].lovelace + rows[1].lovelace + fee, 200_000_000n);
  assert.equal(BigInt(built.fee), fee);
});

test('only the missing part is requested when the campaign wallet is partly funded', async () => {
  const chain = makeChain({
    walletUtxos: [{
      tx_hash: '2'.repeat(64), tx_index: 0, address: campaignWallet, value: '10000000',
      asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '1000' }],
    }],
  });
  const built = await buildFunding(fakeDb(), makeCampaign(), { address: owner.address, utxoHexes: ownerUtxoHexes(chain), fetchImpl: chain.fetchImpl });
  assert.equal(built.tokens, '0');
  assert.equal(built.lovelace, (depositLovelaceFor(20) - 10_000_000n).toString());
  assert.equal(summarise(built.txHex).rows[0].tokens, 0n);
});

test('a fully funded campaign has nothing to build', async () => {
  const chain = makeChain({
    walletUtxos: [{
      tx_hash: '2'.repeat(64), tx_index: 0, address: campaignWallet, value: String(depositLovelaceFor(20)),
      asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '1000' }],
    }],
  });
  await assert.rejects(
    () => buildFunding(fakeDb(), makeCampaign(), { address: owner.address, utxoHexes: ownerUtxoHexes(chain), fetchImpl: chain.fetchImpl }),
    /already holds everything/,
  );
});

test('a wallet that cannot cover the tokens or the ADA gets a plain message and no transaction', async () => {
  const noTokens = makeChain({ ownerUtxos: [{ tx_hash: '1'.repeat(64), tx_index: 0, address: owner.address, value: '200000000', asset_list: [] }] });
  await assert.rejects(
    () => buildFunding(fakeDb(), makeCampaign(), { address: owner.address, utxoHexes: ownerUtxoHexes(noTokens), fetchImpl: noTokens.fetchImpl }),
    /does not hold enough PEE/,
  );
  const noAda = makeChain({
    ownerUtxos: [{ tx_hash: '1'.repeat(64), tx_index: 0, address: owner.address, value: '5000000', asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '5000' }] }],
  });
  await assert.rejects(
    () => buildFunding(fakeDb(), makeCampaign(), { address: owner.address, utxoHexes: ownerUtxoHexes(noAda), fetchImpl: noAda.fetchImpl }),
    /not hold enough ADA/,
  );
});

test('only UTxOs of the owner\'s own wallet are used, and only the owner\'s address may be the change address', async () => {
  const chain = makeChain({ ownerUtxos: [
    { tx_hash: '1'.repeat(64), tx_index: 0, address: stranger.address, value: '900000000', asset_list: [{ policy_id: TOKEN.policyId, asset_name: TOKEN.assetNameHex, quantity: '5000' }] },
  ] });
  await assert.rejects(
    () => buildFunding(fakeDb(), makeCampaign(), { address: owner.address, utxoHexes: ownerUtxoHexes({ utxos: new Map([...chain.utxos]) }).concat([...chain.utxos.values()].map(hexOfUtxo)), fetchImpl: chain.fetchImpl }),
    /could not be confirmed/,
  );
  await assert.rejects(
    () => buildFunding(fakeDb(), makeCampaign(), { address: stranger.address, utxoHexes: [...chain.utxos.values()].map(hexOfUtxo), fetchImpl: chain.fetchImpl }),
    /wallet that created this campaign/,
  );
});

test('a tampered campaign record is not funded', async () => {
  const chain = makeChain();
  const tampered = makeCampaign();
  tampered.wallet = { address: enterpriseAddressFromPublicKey(Buffer.alloc(32, 1), 1) };
  await assert.rejects(
    () => buildFunding(fakeDb(), tampered, { address: owner.address, utxoHexes: ownerUtxoHexes(chain), fetchImpl: chain.fetchImpl }),
    /integrity check/,
  );
});

test('a second funding transaction is held back while the first is still confirming', async () => {
  const chain = makeChain();
  const campaign = makeCampaign({ fundingTx: { txHash: 'a'.repeat(64), submittedAt: new Date(Date.now() - 60_000) } });
  await assert.rejects(
    () => buildFunding(fakeDb(), campaign, { address: owner.address, utxoHexes: ownerUtxoHexes(chain), fetchImpl: chain.fetchImpl }),
    /still confirming/,
  );
  chain.confirmations.set('a'.repeat(64), 2);
  await buildFunding(fakeDb(), campaign, { address: owner.address, utxoHexes: ownerUtxoHexes(chain), fetchImpl: chain.fetchImpl });
});

test('the signed funding transaction is forwarded as signed, and its hash is remembered', async () => {
  const chain = makeChain();
  const db = fakeDb();
  const campaign = makeCampaign();
  const built = await buildFunding(db, campaign, { address: owner.address, utxoHexes: ownerUtxoHexes(chain), fetchImpl: chain.fetchImpl });
  const { txHash } = await submitFunding(db, campaign, { txHex: built.txHex, witnessSetHex: sign(built.txHex, owner), fetchImpl: chain.fetchImpl });

  assert.equal(chain.submitted.length, 1);
  const sent = csl.Transaction.from_bytes(chain.submitted[0]);
  assert.equal(hex(csl.hash_transaction(sent.body()).to_bytes()), txHash);
  assert.equal(sent.witness_set().vkeys().len(), 1);
  assert.equal(db.updates.at(-1).$set.fundingTx.txHash, txHash);
});

test('the server refuses to forward anything that is not the owner funding this campaign', async () => {
  const chain = makeChain();
  const db = fakeDb();
  const campaign = makeCampaign();
  const built = await buildFunding(db, campaign, { address: owner.address, utxoHexes: ownerUtxoHexes(chain), fetchImpl: chain.fetchImpl });
  const witnessSetHex = sign(built.txHex, owner);

  // A transaction that pays someone else.
  const body = csl.Transaction.from_hex(built.txHex).body();
  const outputs = csl.TransactionOutputs.new();
  outputs.add(csl.TransactionOutput.new(csl.Address.from_bech32(stranger.address), body.outputs().get(0).amount()));
  const redirectedBody = csl.TransactionBody.new_tx_body(body.inputs(), outputs, body.fee());
  redirectedBody.set_ttl(body.ttl_bignum());
  // Everything else about it is fine, so it is the destination that gets it refused.
  assert.throws(() => assertFundingTransaction(csl, redirectedBody, { campaignAddress: campaignWallet, ownerStake: owner.stake, tokenY: TOKEN }), /not the campaign wallet/);
  const redirected = csl.Transaction.new(redirectedBody, csl.TransactionWitnessSet.new());
  await assert.rejects(() => submitFunding(db, campaign, { txHex: redirected.to_hex(), witnessSetHex, fetchImpl: chain.fetchImpl }), ClaimInputError);

  // No signature, junk, and a transaction spending someone else's UTxO.
  await assert.rejects(() => submitFunding(db, campaign, { txHex: built.txHex, witnessSetHex: csl.TransactionWitnessSet.new().to_hex(), fetchImpl: chain.fetchImpl }), ClaimInputError);
  await assert.rejects(() => submitFunding(db, campaign, { txHex: 'zz', witnessSetHex, fetchImpl: chain.fetchImpl }), ClaimInputError);
  chain.utxos.get(`${'1'.repeat(64)}#0`).address = stranger.address;
  await assert.rejects(() => submitFunding(db, campaign, { txHex: built.txHex, witnessSetHex, fetchImpl: chain.fetchImpl }), /not yours/);
  assert.equal(chain.submitted.length, 0);
});

test('assertFundingTransaction rejects foreign tokens, other destinations, other change addresses and high fees', async () => {
  const chain = makeChain();
  const built = await buildFunding(fakeDb(), makeCampaign(), { address: owner.address, utxoHexes: ownerUtxoHexes(chain), fetchImpl: chain.fetchImpl });
  const body = csl.Transaction.from_hex(built.txHex).body();
  const context = { campaignAddress: campaignWallet, ownerStake: owner.stake, tokenY: TOKEN };
  assert.doesNotThrow(() => assertFundingTransaction(csl, body, context));
  assert.throws(() => assertFundingTransaction(csl, body, { ...context, tokenY: { ...TOKEN, policyId: 'c'.repeat(56) } }), /different token/);
  assert.throws(() => assertFundingTransaction(csl, body, { ...context, campaignAddress: stranger.address }), /not the campaign wallet/);
  assert.throws(() => assertFundingTransaction(csl, body, { ...context, ownerStake: stranger.stake }), /change does not return/);
  assert.throws(() => assertFundingTransaction(csl, body, { ...context, maxFee: 1n }), /fee too high/);
});
