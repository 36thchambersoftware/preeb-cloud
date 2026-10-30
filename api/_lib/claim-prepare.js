import {
  CAMPAIGNS_COLLECTION,
  ClaimInputError,
  ENTITLEMENTS_COLLECTION,
  LANES_COLLECTION,
  WALLETS_COLLECTION,
  deriveStatus,
} from './claim-campaign.js';
import {
  FINALITY_CONFIRMATIONS,
  fetchAddressUtxos,
  fetchConfirmations,
  fetchProtocolParams,
  submitTransaction,
  summarizeUtxos,
} from './cardano-chain.js';
import {
  attachWalletWitness,
  buildLaneTransaction,
  computeLaneAmounts,
  evaluateFunding,
  fundingRequirements,
  loadCsl,
} from './claim-funding.js';
import { signWithClaimWallet } from './claim-wallet.js';
import { ensureCampaignSealed } from './claim-integrity.js';
import { countInFlightClaims, settleClaims } from './claim-claims.js';
import { settleReclaim } from './claim-reclaim.js';

const FUNDING_CACHE_MS = 30_000;
const STALE_PREPARE_MS = 10 * 60 * 1000;

export async function readFunding(campaign, fetchImpl) {
  const utxos = await fetchAddressUtxos(campaign.wallet.address, campaign.network, fetchImpl);
  const balances = summarizeUtxos(utxos, campaign.tokenY);
  return { utxos, funding: evaluateFunding(fundingRequirements(campaign), balances) };
}

/**
 * Moves lane preparation forward: a submitted transaction becomes "ready" once
 * Koios sees it on chain, and a preparation that never produced one is reset so
 * the owner can try again.
 */
async function settleLanes(db, campaign, now, fetchImpl) {
  const lanes = campaign.lanes || {};
  if (lanes.status !== 'preparing' && lanes.status !== 'submitted') return null;

  if (lanes.txHash) {
    const confirmations = await fetchConfirmations([lanes.txHash], campaign.network, fetchImpl);
    if ((confirmations.get(lanes.txHash) || 0) >= FINALITY_CONFIRMATIONS) {
      await db.collection(CAMPAIGNS_COLLECTION).updateOne(
        { _id: campaign._id, 'lanes.status': { $in: ['preparing', 'submitted'] } },
        { $set: { 'lanes.status': 'ready', 'lanes.readyAt': now } },
      );
      return 'ready';
    }
  }

  const startedAt = lanes.startedAt ? new Date(lanes.startedAt).getTime() : 0;
  // Once a transaction hash is recorded the transaction may be in the mempool, so only
  // an attempt that never got that far is safe to reset.
  if (lanes.status === 'preparing' && !lanes.txHash && now.getTime() - startedAt > STALE_PREPARE_MS) {
    await resetLanes(db, campaign._id, 'Preparation did not complete. Please try again.');
    return 'none';
  }
  return null;
}

async function resetLanes(db, campaignId, error = null) {
  await db.collection(LANES_COLLECTION).deleteMany({ campaignId });
  await db.collection(CAMPAIGNS_COLLECTION).updateOne({ _id: campaignId }, {
    $set: { 'lanes.status': 'none', 'lanes.error': error },
    $unset: { 'lanes.txHash': '' },
  });
}

const AUTO_PREPARE_RETRY_MS = 60_000;

/**
 * Keeps a campaign moving without anyone pressing anything: confirms claims and
 * reclaims as they land on chain, re-reads the campaign wallet (cached briefly so
 * page views don't each hit Koios), and as soon as the wallet is fully funded
 * splits it into claim lanes so claims can open. Returns the campaign with fresh
 * state. Chain lookups that fail keep the last known state.
 */
export async function refreshFunding(db, campaign, { now = new Date(), force = false, fetchImpl } = {}) {
  if (campaign.snapshot?.status !== 'taken') return campaign;

  try {
    let changed = false;

    // Confirmations are time-sensitive and cheap to check, so they ignore the funding cache.
    if (campaign.lanes?.status === 'ready' && await countInFlightClaims(db, campaign) > 0) {
      await settleClaims(db, campaign._id, { now, fetchImpl });
      changed = true;
    }
    let reclaimSettled = null;
    if (campaign.reclaim?.status === 'submitted') {
      reclaimSettled = await settleReclaim(db, campaign, { now, fetchImpl });
      changed = true;
    }

    const checkedAt = campaign.funding?.checkedAt ? new Date(campaign.funding.checkedAt).getTime() : 0;
    let stored = campaign.funding;
    // A reclaim that just landed changes the wallet's balance, so the cached balance is not trusted then.
    if (force || reclaimSettled === 'confirmed' || now.getTime() - checkedAt >= FUNDING_CACHE_MS) {
      const settled = await settleLanes(db, campaign, now, fetchImpl);
      if (settled === 'ready') await settleClaims(db, campaign._id, { now, fetchImpl });
      const { funding } = await readFunding(campaign, fetchImpl);
      stored = { ...funding, checkedAt: now };
      await db.collection(CAMPAIGNS_COLLECTION).updateOne({ _id: campaign._id }, { $set: { funding: stored } });
      changed = true;

      // Fully funded and not yet split: do it now, no button needed.
      const lanesStarted = campaign.lanes?.startedAt ? new Date(campaign.lanes.startedAt).getTime() : 0;
      if (
        funding.status === 'funded'
        && (settled ?? campaign.lanes?.status) === 'none'
        && deriveStatus(campaign, now).status !== 'closed'
        && now.getTime() - lanesStarted > AUTO_PREPARE_RETRY_MS
      ) {
        try {
          await prepareLanes(db, campaign._id, { now, fetchImpl });
        } catch (error) {
          if (!(error instanceof ClaimInputError)) console.error('[PREEB] Automatic claim preparation failed:', error);
        }
      }
    }

    if (!changed) return campaign;
    const fresh = await db.collection(CAMPAIGNS_COLLECTION).findOne({ _id: campaign._id }, { projection: { 'snapshot.rows': 0 } });
    return { ...(fresh || campaign), funding: stored };
  } catch (error) {
    console.error('[PREEB] Could not refresh campaign funding:', error);
    return campaign;
  }
}

/** Runs refreshFunding for every campaign still in play, for the scheduler. */
export async function advanceCampaigns(db, { now = new Date(), fetchImpl, limit = 20 } = {}) {
  const active = await db.collection(CAMPAIGNS_COLLECTION)
    .find({ 'snapshot.status': 'taken', reclaimedAt: { $exists: false } }, { projection: { 'snapshot.rows': 0 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  const results = [];
  for (const campaign of active) {
    const refreshed = await refreshFunding(db, campaign, { now, force: true, fetchImpl });
    results.push({ id: campaign._id, lanes: refreshed.lanes?.status, funding: refreshed.funding?.status });
  }
  return results;
}

/**
 * Splits the campaign wallet into claim lanes. Only the owner may call it, it
 * only runs once funding is complete, and the preparing state is taken
 * atomically so two requests cannot both build the transaction.
 */
export async function prepareLanes(db, campaignId, { now = new Date(), fetchImpl } = {}) {
  const campaigns = db.collection(CAMPAIGNS_COLLECTION);
  const campaign = await campaigns.findOneAndUpdate(
    {
      _id: campaignId,
      'snapshot.status': 'taken',
      'lanes.status': 'none',
      reclaimedAt: { $exists: false },
    },
    { $set: { 'lanes.status': 'preparing', 'lanes.startedAt': now, 'lanes.error': null } },
    { returnDocument: 'after' },
  );
  if (!campaign) throw new ClaimInputError('This campaign cannot be prepared right now.');
  if (campaign.claimEndsAt && new Date(campaign.claimEndsAt) <= now) {
    await resetLanes(db, campaignId);
    throw new ClaimInputError('This campaign has already closed.');
  }

  let submitted = false;
  let built = null;
  try {
    await ensureCampaignSealed(db, campaign);
    const { utxos, funding } = await readFunding(campaign, fetchImpl);
    if (funding.status !== 'funded') {
      await resetLanes(db, campaignId);
      throw new ClaimInputError('The campaign wallet does not hold the required tokens and ADA yet.');
    }

    const entitlements = await db.collection(ENTITLEMENTS_COLLECTION)
      .find({ campaignId }, { projection: { key: 1, amount: 1, lane: 1 } })
      .toArray();
    const laneAmounts = computeLaneAmounts(entitlements, campaign.lanes.count);

    const [csl, protocol, wallet] = await Promise.all([
      loadCsl(),
      fetchProtocolParams(campaign.network, fetchImpl),
      db.collection(WALLETS_COLLECTION).findOne({ _id: campaignId }),
    ]);
    built = buildLaneTransaction({
      csl,
      protocol,
      address: campaign.wallet.address,
      utxos,
      lanes: laneAmounts,
      tokenY: campaign.tokenY,
    });
    const signature = signWithClaimWallet(wallet.encryptedSeed, campaignId, Buffer.from(built.txHash, 'hex'));
    const signed = attachWalletWitness(csl, built.transaction, wallet.publicKeyHex, signature);

    // Lane records exist before submission so a crash cannot lose track of the outputs.
    await db.collection(LANES_COLLECTION).insertMany(built.lanes.map((lane) => ({
      _id: `${campaignId}:${lane.index}`,
      campaignId,
      index: lane.index,
      amount: lane.amount.toString(),
      utxo: { txHash: built.txHash, txIndex: lane.txIndex },
      status: 'free',
      createdAt: now,
    })));
    await campaigns.updateOne({ _id: campaignId }, { $set: { 'lanes.txHash': built.txHash } });

    await submitTransaction(Buffer.from(signed.to_bytes()), campaign.network, fetchImpl);
    submitted = true;
    await campaigns.updateOne({ _id: campaignId }, {
      $set: { 'lanes.status': 'submitted', 'lanes.submittedAt': new Date(), 'lanes.fee': built.fee.toString() },
    });
    return { txHash: built.txHash, laneCount: built.lanes.length };
  } catch (error) {
    if (submitted) {
      // The transaction is on its way; the recorded hash lets the next refresh finish the job.
      console.error('[PREEB] Claim lanes were submitted but not recorded:', error);
      return { txHash: built.txHash, laneCount: built.lanes.length };
    }
    if (!(error instanceof ClaimInputError)) {
      console.error('[PREEB] Could not prepare claim lanes:', error);
      await resetLanes(db, campaignId, 'The preparation transaction was not accepted. Please try again.');
      throw new ClaimInputError('The preparation transaction could not be submitted. Please try again shortly.');
    }
    throw error;
  }
}
