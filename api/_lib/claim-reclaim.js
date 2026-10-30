import {
  CAMPAIGNS_COLLECTION,
  ClaimInputError,
  WALLETS_COLLECTION,
} from './claim-campaign.js';
import {
  FINALITY_CONFIRMATIONS,
  fetchAddressUtxos,
  fetchConfirmations,
  fetchProtocolParams,
  submitTransaction,
} from './cardano-chain.js';
import { attachWalletWitness, buildSweepTransaction, loadCsl } from './claim-funding.js';
import { countInFlightClaims, settleClaims } from './claim-claims.js';
import { signWithClaimWallet } from './claim-wallet.js';
import { ensureCampaignSealed } from './claim-integrity.js';

/** After claims close, pending claim transactions get this long to land before a sweep is allowed. */
export const RECLAIM_GRACE_MS = 15 * 60 * 1000;
/** Claims can be ended early by the owner, but only after they have been open this long. */
export const MIN_OPEN_BEFORE_END_MS = 24 * 60 * 60 * 1000;
const STALE_SWEEP_MS = 10 * 60 * 1000;

const when = (date) => date.toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');

/**
 * Whether the owner can take the funds out right now. The rule: never while
 * holders can claim, always before claims open or after they have closed.
 */
export function reclaimEligibility(campaign, now = new Date(), inFlight = 0) {
  // A campaign that has been swept is finished: claims can never open again.
  if (campaign.reclaimedAt || campaign.reclaimed) return { allowed: true, reason: 'This campaign has finished.' };

  const taken = campaign.snapshot?.status === 'taken';
  const start = campaign.claimStartsAt ? new Date(campaign.claimStartsAt) : null;
  const end = campaign.claimEndsAt ? new Date(campaign.claimEndsAt) : null;

  if (!taken || (start && now < start)) return { allowed: true, reason: 'Claims have not opened, so nothing has been claimed.' };

  if (end && now >= end) {
    const available = new Date(end.getTime() + RECLAIM_GRACE_MS);
    if (now < available) {
      return { allowed: false, availableAt: available.toISOString(), reason: `Claims just closed. Reclaiming opens at ${when(available)} so any claim in progress can finish.` };
    }
    if (inFlight > 0) return { allowed: false, reason: 'A claim is still being confirmed. Try again in a few minutes.' };
    return { allowed: true, reason: 'Claims have closed.' };
  }

  if (!end) {
    const canEndAt = new Date((start?.getTime() ?? now.getTime()) + MIN_OPEN_BEFORE_END_MS);
    return {
      allowed: false,
      canEndAt: canEndAt.toISOString(),
      reason: now >= canEndAt
        ? 'Claims are open with no end date. End the claims first, then reclaim.'
        : `Claims are open with no end date. You can end them from ${when(canEndAt)}, then reclaim.`,
    };
  }

  return { allowed: false, availableAt: new Date(end.getTime() + RECLAIM_GRACE_MS).toISOString(), reason: `Claims are open until ${when(end)}. You can reclaim after they close.` };
}

/** Closes claims early. Holders always get at least 24 hours of open claims first. */
export async function endClaims(db, campaignId, { now = new Date() } = {}) {
  const campaign = await db.collection(CAMPAIGNS_COLLECTION).findOne({ _id: campaignId });
  if (!campaign || campaign.snapshot?.status !== 'taken') throw new ClaimInputError('There are no open claims to end.');

  const start = campaign.claimStartsAt ? new Date(campaign.claimStartsAt) : now;
  const end = campaign.claimEndsAt ? new Date(campaign.claimEndsAt) : null;
  if (now < start || (end && now >= end)) throw new ClaimInputError('Claims are not open right now.');
  const earliest = new Date(start.getTime() + MIN_OPEN_BEFORE_END_MS);
  if (now < earliest) throw new ClaimInputError(`Claims must stay open for 24 hours. You can end them from ${when(earliest)}.`);

  await db.collection(CAMPAIGNS_COLLECTION).updateOne({ _id: campaignId }, { $set: { claimEndsAt: now, updatedAt: now } });
  return { endedAt: now.toISOString() };
}

/** Once a sweep is on chain the campaign is finished; a sweep that left UTxOs behind is run again. */
export async function settleReclaim(db, campaign, { now = new Date(), fetchImpl } = {}) {
  const reclaim = campaign.reclaim;
  if (reclaim?.status !== 'submitted' || !reclaim.txHash) return null;

  const confirmations = await fetchConfirmations([reclaim.txHash], campaign.network, fetchImpl);
  if (!(confirmations.get(reclaim.txHash) >= FINALITY_CONFIRMATIONS)) {
    // A sweep that never reached the chain can be retried once it is clearly stale.
    if (!(confirmations.get(reclaim.txHash) > 0) && now.getTime() - new Date(reclaim.submittedAt).getTime() > STALE_SWEEP_MS) {
      await db.collection(CAMPAIGNS_COLLECTION).updateOne(
        { _id: campaign._id, 'reclaim.txHash': reclaim.txHash },
        { $set: { 'reclaim.status': 'none' } },
      );
      return 'none';
    }
    return null;
  }

  const update = { 'reclaim.status': 'confirmed', 'reclaim.confirmedAt': now };
  if (!reclaim.moreRemain) update.reclaimedAt = now;
  await db.collection(CAMPAIGNS_COLLECTION).updateOne({ _id: campaign._id, 'reclaim.txHash': reclaim.txHash }, { $set: update });
  return 'confirmed';
}

/**
 * Sends everything in the campaign wallet to the owner's payout address. That
 * address was fixed at creation, from a wallet the owner proved they control,
 * so the funds can only ever go back to the owner.
 */
export async function reclaimFunds(db, campaignId, { now = new Date(), fetchImpl } = {}) {
  const campaigns = db.collection(CAMPAIGNS_COLLECTION);
  const campaign = await campaigns.findOne({ _id: campaignId });
  if (!campaign) throw new ClaimInputError('Campaign not found.');
  // The sweep pays out to whatever the database says the payout address is, so that must be
  // what the server recorded at creation.
  await ensureCampaignSealed(db, campaign);

  if (campaign.lanes?.status === 'ready') await settleClaims(db, campaignId, { now, fetchImpl });
  const eligibility = reclaimEligibility(campaign, now, await countInFlightClaims(db, campaign));
  if (!eligibility.allowed) throw new ClaimInputError(eligibility.reason);

  // An empty wallet is reported without touching any state, so a finished reclaim stays finished.
  const utxos = await fetchAddressUtxos(campaign.wallet.address, campaign.network, fetchImpl);
  if (utxos.length === 0) throw new ClaimInputError('The campaign wallet is empty, so there is nothing to reclaim.');

  // One sweep at a time; a stuck one is released after a while.
  const claimed = await campaigns.findOneAndUpdate(
    {
      _id: campaignId,
      $or: [
        { 'reclaim.status': { $exists: false } },
        { 'reclaim.status': { $in: ['none', 'confirmed'] } },
        { 'reclaim.status': 'sweeping', 'reclaim.startedAt': { $lt: new Date(now.getTime() - STALE_SWEEP_MS) } },
      ],
    },
    { $set: { 'reclaim.status': 'sweeping', 'reclaim.startedAt': now, 'reclaim.error': null } },
    { returnDocument: 'after' },
  );
  if (!claimed) throw new ClaimInputError('A reclaim is already in progress. Give it a few minutes to confirm.');

  const fail = async (message) => {
    await campaigns.updateOne({ _id: campaignId }, { $set: { 'reclaim.status': 'none', 'reclaim.error': message } });
  };

  let submitted = false;
  try {
    const [csl, protocol, wallet] = await Promise.all([
      loadCsl(),
      fetchProtocolParams(campaign.network, fetchImpl),
      db.collection(WALLETS_COLLECTION).findOne({ _id: campaignId }),
    ]);
    const built = buildSweepTransaction({
      csl,
      protocol,
      address: campaign.wallet.address,
      utxos,
      destination: campaign.owner.payoutAddress,
    });
    const signature = signWithClaimWallet(wallet.encryptedSeed, campaignId, Buffer.from(built.txHash, 'hex'));
    const signed = attachWalletWitness(csl, built.transaction, wallet.publicKeyHex, signature);

    // The hash is stored before submitting so a crash can never lose track of the sweep.
    await campaigns.updateOne({ _id: campaignId }, {
      $set: { 'reclaim.txHash': built.txHash, 'reclaim.moreRemain': built.moreRemain, 'reclaim.destination': campaign.owner.payoutAddress },
    });
    await submitTransaction(Buffer.from(signed.to_bytes()), campaign.network, fetchImpl);
    submitted = true;
    await campaigns.updateOne({ _id: campaignId }, { $set: { 'reclaim.status': 'submitted', 'reclaim.submittedAt': new Date() } });
    return { txHash: built.txHash, destination: campaign.owner.payoutAddress, moreRemain: built.moreRemain };
  } catch (error) {
    if (submitted) {
      console.error('[PREEB] Reclaim was submitted but not recorded:', error);
      return { txHash: campaign.reclaim?.txHash, destination: campaign.owner.payoutAddress };
    }
    if (error instanceof ClaimInputError) throw error;
    console.error('[PREEB] Reclaim failed:', error);
    await fail('The sweep transaction was not accepted.');
    throw new ClaimInputError('The reclaim transaction could not be submitted. Nothing was moved. Please try again shortly.');
  }
}
