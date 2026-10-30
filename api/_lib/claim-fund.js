import { CAMPAIGNS_COLLECTION, ClaimInputError, deriveStatus } from './claim-campaign.js';
import {
  ChainError,
  fetchConfirmations,
  fetchProtocolParams,
  fetchTipSlot,
  fetchUtxoInfo,
  isDefinitiveRejection,
  submitTransaction,
  summarizeUtxos,
} from './cardano-chain.js';
import { addressBelongsToStake, parseAddress } from './cardano-address.js';
import {
  assembleFundingTransaction,
  assertFundingTransaction,
  buildFundingTransaction,
  loadCsl,
} from './claim-funding.js';
import { ensureCampaignSealed } from './claim-integrity.js';
import { verifiedClaimerUtxos } from './claim-claims.js';
import { readFunding } from './claim-prepare.js';

// A funding transaction that has not appeared on chain within this long is treated as lost.
const PENDING_FUNDING_MS = 20 * 60 * 1000;
const MAX_FUNDING_INPUTS = 60;
const MAX_HEX_LENGTH = 200_000;

function assertFundable(campaign) {
  if (campaign.snapshot?.status !== 'taken') throw new ClaimInputError('The campaign can be funded once its snapshot has been taken.');
  if (deriveStatus(campaign).status === 'closed' || campaign.reclaim?.status === 'submitted' || campaign.reclaimedAt) {
    throw new ClaimInputError('This campaign has ended, so it no longer needs funding.');
  }
  if (campaign.lanes?.status && campaign.lanes.status !== 'none') {
    throw new ClaimInputError('This campaign is already set up for claims.');
  }
}

async function assertNoPendingFunding(campaign, now, fetchImpl) {
  const pending = campaign.fundingTx;
  if (!pending?.txHash) return;
  const age = now.getTime() - new Date(pending.submittedAt).getTime();
  if (age >= PENDING_FUNDING_MS) return;
  let confirmations = 0;
  try {
    confirmations = (await fetchConfirmations([pending.txHash], campaign.network, fetchImpl)).get(pending.txHash) || 0;
  } catch {
    confirmations = 0;
  }
  if (confirmations === 0) {
    throw new ClaimInputError('Your funding transaction is still confirming. Give it a few minutes before sending another.');
  }
}

/**
 * Builds the transaction that tops the campaign wallet up to what it needs, from the
 * owner's own wallet: only the missing tokens and ADA are sent, so it can never overfund
 * and an already-funded campaign has nothing to build. Nothing is signed or sent here.
 */
export async function buildFunding(db, campaign, { address, utxoHexes, now = new Date(), fetchImpl } = {}) {
  assertFundable(campaign);
  await ensureCampaignSealed(db, campaign);

  const parsed = parseAddress(address);
  const networkId = campaign.network === 'mainnet' ? 1 : 0;
  if (!parsed || parsed.paymentIsScript || parsed.networkId !== networkId || !addressBelongsToStake(address, campaign.owner.stake)) {
    throw new ClaimInputError('Use the wallet that created this campaign.');
  }
  if (!Array.isArray(utxoHexes) || utxoHexes.length === 0 || utxoHexes.length > 1000) {
    throw new ClaimInputError('Your wallet did not share its funds. Reconnect it and try again.');
  }

  await assertNoPendingFunding(campaign, now, fetchImpl);
  const { funding } = await readFunding(campaign, fetchImpl);
  if (funding.status === 'funded') throw new ClaimInputError('The campaign wallet already holds everything it needs.');
  const missing = (required, held) => (BigInt(required) > BigInt(held) ? BigInt(required) - BigInt(held) : 0n);
  const tokens = missing(funding.tokensRequired, funding.tokensHeld);
  const lovelace = missing(funding.lovelaceRequired, funding.lovelaceHeld);

  const [csl, protocol, tip] = await Promise.all([
    loadCsl(),
    fetchProtocolParams(campaign.network, fetchImpl),
    fetchTipSlot(campaign.network, fetchImpl),
  ]);
  const ownerUtxos = await verifiedClaimerUtxos(csl, utxoHexes, { stake: campaign.owner.stake, campaign, fetchImpl, max: 100 });
  if (ownerUtxos.length === 0) throw new ClaimInputError('Your wallet\'s funds could not be confirmed on chain yet. Wait a minute and try again.');

  const owned = summarizeUtxos(ownerUtxos, campaign.tokenY);
  const ticker = campaign.tokenY.ticker || 'tokens';
  if (owned.tokens < tokens) {
    throw new ClaimInputError(`Your connected wallet does not hold enough ${ticker} to fund this campaign. It may be in a different wallet.`);
  }

  let built;
  try {
    built = buildFundingTransaction({
      csl,
      protocol,
      ownerUtxos,
      ownerAddress: address,
      campaignAddress: campaign.wallet.address,
      tokenY: campaign.tokenY,
      tokens,
      lovelace,
      tip,
    });
  } catch (error) {
    console.error('[PREEB] Could not build the funding transaction:', error?.message || error);
    throw new ClaimInputError('Your wallet does not hold enough ADA to send the deposit and pay the fee.');
  }

  assertFundingTransaction(csl, built.transaction.body(), {
    campaignAddress: campaign.wallet.address,
    ownerStake: campaign.owner.stake,
    tokenY: campaign.tokenY,
  });
  return {
    txHex: built.transaction.to_hex(),
    tokens: tokens.toString(),
    lovelace: built.lovelaceSent.toString(),
    fee: built.fee.toString(),
  };
}

/**
 * Forwards the transaction the owner signed. The server adds nothing: it re-checks that the
 * transaction only pays the campaign wallet and the owner, and that every input really is
 * one of the owner's UTxOs, then submits it and remembers its hash so a second click does
 * not send the same funds twice.
 */
export async function submitFunding(db, campaign, { txHex, witnessSetHex, now = new Date(), fetchImpl } = {}) {
  assertFundable(campaign);
  await ensureCampaignSealed(db, campaign);
  for (const value of [txHex, witnessSetHex]) {
    if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value) || value.length > MAX_HEX_LENGTH) {
      throw new ClaimInputError('The signed transaction was not understood. Please try again.');
    }
  }

  const csl = await loadCsl();
  let transaction;
  try {
    const unsigned = csl.Transaction.from_hex(txHex);
    assertFundingTransaction(csl, unsigned.body(), {
      campaignAddress: campaign.wallet.address,
      ownerStake: campaign.owner.stake,
      tokenY: campaign.tokenY,
    });
    transaction = assembleFundingTransaction(csl, txHex, witnessSetHex);
  } catch (error) {
    console.error('[PREEB] Funding transaction refused:', error?.message || error);
    throw new ClaimInputError('That transaction is not the funding transaction for this campaign.');
  }

  const inputs = transaction.body().inputs();
  if (inputs.len() === 0 || inputs.len() > MAX_FUNDING_INPUTS) throw new ClaimInputError('That transaction is not the funding transaction for this campaign.');
  const refs = [];
  for (let index = 0; index < inputs.len(); index += 1) {
    refs.push(`${Buffer.from(inputs.get(index).transaction_id().to_bytes()).toString('hex')}#${inputs.get(index).index()}`);
  }
  const rows = await fetchUtxoInfo(refs, campaign.network, fetchImpl);
  if (rows.length !== refs.length || !rows.every((row) => addressBelongsToStake(row.address, campaign.owner.stake))) {
    throw new ClaimInputError('That transaction spends funds that are not yours, or funds that were already spent. Please start again.');
  }

  await assertNoPendingFunding(campaign, now, fetchImpl);
  const txHash = Buffer.from(csl.hash_transaction(transaction.body()).to_bytes()).toString('hex');
  // Recorded before submitting so a lost response can never lose track of it.
  await db.collection(CAMPAIGNS_COLLECTION).updateOne(
    { _id: campaign._id },
    { $set: { fundingTx: { txHash, submittedAt: now } } },
  );
  try {
    await submitTransaction(Buffer.from(transaction.to_bytes()), campaign.network, fetchImpl);
  } catch (error) {
    if (error instanceof ChainError && isDefinitiveRejection(error)) {
      await db.collection(CAMPAIGNS_COLLECTION).updateOne({ _id: campaign._id, 'fundingTx.txHash': txHash }, { $unset: { fundingTx: '' } });
      throw new ClaimInputError('The network did not accept the funding transaction. Nothing was sent. Please try again.');
    }
    throw error;
  }
  return { txHash };
}
