import crypto from 'node:crypto';
import { addressBelongsToStake } from './cardano-address.js';
import {
  ClaimInputError,
  ENTITLEMENTS_COLLECTION,
  LANES_COLLECTION,
  WALLETS_COLLECTION,
  deriveStatus,
} from './claim-campaign.js';
import {
  fetchConfirmations,
  fetchProtocolParams,
  fetchTipSlot,
  fetchUtxoInfo,
  isDefinitiveRejection,
  submitTransaction,
} from './cardano-chain.js';
import {
  assembleClaimTransaction,
  buildClaimTransaction,
  campaignVkeyWitness,
  laneIndexFor,
  loadCsl,
} from './claim-funding.js';
import { signWithClaimWallet } from './claim-wallet.js';
import { verifyCip8Signature } from './cip8.js';
import { createSignedToken, verifySignedToken } from './discord-auth.js';

export const CLAIMS_COLLECTION = 'claim_claims';

// A claim transaction is only valid for this many slots (seconds), which also bounds how
// long an abandoned attempt can hold a lane.
export const CLAIM_TTL_SLOTS = 300;
const CHALLENGE_TTL_SECONDS = 5 * 60;
const IN_FLIGHT = ['reserved', 'submitting', 'submitted'];

export class ClaimBusyError extends ClaimInputError {}

function challengeMessage(campaignId, stake, nonce) {
  return `PREEB Claim\ncampaign:${campaignId}\nstake:${stake}\nnonce:${nonce}`;
}

/** A short-lived challenge the claimer signs with their stake key to prove they own the wallet. */
export function createClaimChallenge(campaignId, stake, now = Date.now()) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const token = createSignedToken({
    type: 'claim_challenge',
    campaignId,
    stake,
    nonce,
    exp: Math.floor(now / 1000) + CHALLENGE_TTL_SECONDS,
  });
  return { token, message: challengeMessage(campaignId, stake, nonce) };
}

/**
 * Confirms the claimer controls `stake`: either this browser already verified it
 * (the signed wallet-session cookie), or the CIP-8 signature over a fresh challenge checks out.
 */
export function verifyClaimer({ campaignId, stake, verifiedStakes = [], token, signatureHex, keyHex, now = Date.now() }) {
  if (verifiedStakes.includes(stake)) return;

  const payload = verifySignedToken(token, now);
  if (payload?.type !== 'claim_challenge' || payload.campaignId !== campaignId || payload.stake !== stake) {
    throw new ClaimInputError('Your signing request expired. Please try again.');
  }
  try {
    const { stakeAddress } = verifyCip8Signature({
      signatureHex,
      keyHex,
      expectedPayload: challengeMessage(campaignId, stake, payload.nonce),
    });
    if (stakeAddress !== stake) throw new Error('wrong wallet');
  } catch {
    throw new ClaimInputError('The wallet signature could not be verified.');
  }
}

async function releaseReservation(db, claim) {
  await db.collection(CLAIMS_COLLECTION).updateOne({ _id: claim._id }, { $set: { status: 'released', releasedAt: new Date() } });
  await db.collection(ENTITLEMENTS_COLLECTION).updateOne(
    { campaignId: claim.campaignId, key: claim.key, reservationId: claim._id },
    { $set: { status: 'unclaimed' }, $unset: { reservationId: '' } },
  );
  await db.collection(LANES_COLLECTION).updateOne(
    { _id: `${claim.campaignId}:${claim.laneIndex}`, reservationId: claim._id },
    { $set: { status: 'free' }, $unset: { reservationId: '' } },
  );
}

async function confirmClaim(db, claim, now) {
  await db.collection(CLAIMS_COLLECTION).updateOne({ _id: claim._id }, { $set: { status: 'confirmed', confirmedAt: now } });
  await db.collection(ENTITLEMENTS_COLLECTION).updateOne(
    { campaignId: claim.campaignId, key: claim.key },
    { $set: { status: 'claimed', claimedAt: now, txHash: claim.txHash }, $unset: { reservationId: '' } },
  );
  // The lane's UTxO is now the remainder output of this claim.
  await db.collection(LANES_COLLECTION).updateOne(
    { _id: `${claim.campaignId}:${claim.laneIndex}` },
    { $set: { status: 'free', utxo: claim.newLaneUtxo }, $unset: { reservationId: '' } },
  );
}

/**
 * Brings in-flight claims up to date with the chain. A claim that is on chain
 * is confirmed. One whose expiry slot has passed can never be included any more,
 * so its entitlement and lane are released.
 */
export async function settleClaims(db, campaignId, { now = new Date(), fetchImpl } = {}) {
  const claims = db.collection(CLAIMS_COLLECTION);
  const open = await claims.find({ campaignId, status: { $in: IN_FLIGHT } }).limit(50).toArray();
  if (open.length === 0) return { settled: 0, inFlight: 0 };

  try {
    const confirmations = await fetchConfirmations(open.map((claim) => claim.txHash), open[0].network, fetchImpl);
    const unconfirmed = open.filter((claim) => !(confirmations.get(claim.txHash) > 0));
    const tip = unconfirmed.length ? await fetchTipSlot(open[0].network, fetchImpl) : 0;

    let inFlight = 0;
    for (const claim of open) {
      if (confirmations.get(claim.txHash) > 0) await confirmClaim(db, claim, now);
      else if (tip > claim.ttl) await releaseReservation(db, claim);
      else inFlight += 1;
    }
    return { settled: open.length - inFlight, inFlight };
  } catch (error) {
    console.error('[PREEB] Could not settle claims:', error);
    return { settled: 0, inFlight: open.length };
  }
}

/** Claims can only exist once lanes are ready, so earlier campaigns never touch the claims collection. */
export async function countInFlightClaims(db, campaign) {
  if (campaign.lanes?.status !== 'ready') return 0;
  return db.collection(CLAIMS_COLLECTION).countDocuments({ campaignId: campaign._id, status: { $in: IN_FLIGHT } });
}

const MAX_UTXO_CANDIDATES = 40;

/**
 * Wallets sometimes report UTxOs that were already spent. Spending one makes the
 * network reject the whole claim, so only UTxOs the chain still shows as unspent
 * are offered to the builder.
 */
async function keepUnspent(csl, utxoHexes, network, fetchImpl) {
  const candidates = utxoHexes
    .map((hex) => {
      try {
        const utxo = csl.TransactionUnspentOutput.from_hex(hex);
        const input = utxo.input();
        return {
          hex,
          ref: `${Buffer.from(input.transaction_id().to_bytes()).toString('hex')}#${input.index()}`,
          lovelace: BigInt(utxo.output().amount().coin().to_str()),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.lovelace > b.lovelace ? -1 : 1))
    .slice(0, MAX_UTXO_CANDIDATES);

  const live = new Set((await fetchUtxoInfo(candidates.map((candidate) => candidate.ref), network, fetchImpl))
    .map((row) => `${row.tx_hash}#${row.tx_index}`));
  return candidates.filter((candidate) => live.has(candidate.ref)).map((candidate) => candidate.hex);
}

function describeRejection(message) {
  if (/BadInputsUTxO/.test(message)) return 'Your wallet\'s list of funds was out of date, so the network refused the transaction. Nothing was spent. Please try again.';
  if (/FeeTooSmall|ValueNotConserved/.test(message)) return 'The network refused the transaction because of its fee. Nothing was spent. Please try again.';
  if (/OutsideValidityInterval/.test(message)) return 'The claim took too long and expired. Nothing was spent. Please try again.';
  return 'The network did not accept the transaction. Nothing was spent. Please try again.';
}

/**
 * Reserves the claimer's entitlement and lane, then builds the claim transaction
 * (already signed by the campaign wallet) for the claimer's wallet to sign.
 */
export async function startClaim(db, campaign, { stake, claimerAddress, utxoHexes, now = new Date(), fetchImpl } = {}) {
  const status = deriveStatus(campaign, now);
  if (status.status !== 'active' || campaign.lanes?.status !== 'ready') {
    throw new ClaimInputError('Claims are not open for this campaign right now.');
  }
  if (!addressBelongsToStake(claimerAddress, stake)) {
    throw new ClaimInputError('Your wallet address does not match the wallet you are claiming with.');
  }
  if ((campaign.network === 'preprod') !== claimerAddress.startsWith('addr_test')) {
    throw new ClaimInputError(`This campaign is on ${campaign.network}. Switch your wallet to that network.`);
  }
  if (!Array.isArray(utxoHexes) || utxoHexes.length === 0 || utxoHexes.length > 500) {
    throw new ClaimInputError('Your wallet did not share any funds. You need some ADA to claim.');
  }

  await settleClaims(db, campaign._id, { now, fetchImpl });

  // A claim this wallet started but never signed holds nothing the wallet could still use
  // (only the wallet's own signature completes it), so starting again replaces it.
  const abandoned = await db.collection(CLAIMS_COLLECTION).findOne({ campaignId: campaign._id, key: stake, status: 'reserved' });
  if (abandoned) await releaseReservation(db, abandoned);

  const reservationId = crypto.randomUUID();
  const entitlements = db.collection(ENTITLEMENTS_COLLECTION);
  const entitlement = await entitlements.findOneAndUpdate(
    { campaignId: campaign._id, key: stake, status: 'unclaimed' },
    { $set: { status: 'reserved', reservationId, reservedAt: now } },
    { returnDocument: 'after' },
  );
  if (!entitlement) {
    const existing = await entitlements.findOne({ campaignId: campaign._id, key: stake });
    throw new ClaimInputError(!existing
      ? 'This wallet is not in the snapshot.'
      : existing.status === 'claimed'
        ? 'This wallet has already claimed.'
        : 'A claim for this wallet is already in progress.');
  }

  const laneIndex = laneIndexFor(stake, campaign.lanes.count);
  const lane = await db.collection(LANES_COLLECTION).findOneAndUpdate(
    { _id: `${campaign._id}:${laneIndex}`, status: 'free' },
    { $set: { status: 'reserved', reservationId } },
    { returnDocument: 'after' },
  );
  const reservation = { _id: reservationId, campaignId: campaign._id, key: stake, laneIndex, network: campaign.network };
  if (!lane) {
    await releaseReservation(db, reservation);
    throw new ClaimBusyError('Another claim is being processed. Please try again in about a minute.');
  }

  try {
    const [laneUtxo] = await fetchUtxoInfo([`${lane.utxo.txHash}#${lane.utxo.txIndex}`], campaign.network, fetchImpl);
    if (!laneUtxo) throw new ClaimBusyError('The previous claim is still confirming. Please try again in about a minute.');

    const [csl, protocol, tip, wallet] = await Promise.all([
      loadCsl(),
      fetchProtocolParams(campaign.network, fetchImpl),
      fetchTipSlot(campaign.network, fetchImpl),
      db.collection(WALLETS_COLLECTION).findOne({ _id: campaign._id }),
    ]);
    const spendable = await keepUnspent(csl, utxoHexes, campaign.network, fetchImpl);
    if (spendable.length === 0) {
      throw new ClaimInputError('Your wallet\'s funds could not be confirmed on chain yet. Wait a minute and try again.');
    }

    const amount = BigInt(entitlement.amount);
    const ttl = tip + CLAIM_TTL_SLOTS;
    let built;
    try {
      built = buildClaimTransaction({
        csl,
        protocol,
        campaignAddress: campaign.wallet.address,
        lane: laneUtxo,
        claimerAddress,
        claimerUtxoHexes: spendable,
        tokenY: campaign.tokenY,
        amount,
        ttl,
      });
    } catch (error) {
      if (error.code === 'insufficient-ada') {
        throw new ClaimInputError(`Your wallet needs about ${(Number(error.requiredLovelace) / 1e6).toFixed(1)} ADA available to claim. The ADA that carries your tokens comes back to you; only the small network fee is spent.`);
      }
      throw error;
    }

    const signature = signWithClaimWallet(wallet.encryptedSeed, campaign._id, Buffer.from(built.txHash, 'hex'));
    const campaignWitness = campaignVkeyWitness(csl, wallet.publicKeyHex, signature);
    const forWallet = csl.Transaction.new(built.transaction.body(), (() => {
      const set = csl.TransactionWitnessSet.new();
      const keys = csl.Vkeywitnesses.new();
      keys.add(campaignWitness);
      set.set_vkeys(keys);
      return set;
    })());

    const expiresAt = new Date(now.getTime() + CLAIM_TTL_SLOTS * 1000);
    await db.collection(CLAIMS_COLLECTION).insertOne({
      ...reservation,
      amount: amount.toString(),
      status: 'reserved',
      bodyHex: Buffer.from(built.transaction.body().to_bytes()).toString('hex'),
      campaignWitnessHex: campaignWitness.to_hex(),
      txHash: built.txHash,
      ttl,
      fee: built.fee.toString(),
      claimerAddress,
      newLaneUtxo: { txHash: built.txHash, txIndex: built.laneOutputIndex },
      createdAt: now,
      expiresAt,
    });

    return {
      reservationId,
      txHex: forWallet.to_hex(),
      amount: amount.toString(),
      fee: built.fee.toString(),
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    await releaseReservation(db, reservation);
    throw error;
  }
}

/** Takes the claimer's signature, completes the transaction and submits it. */
export async function finishClaim(db, campaign, { reservationId, stake, witnessSetHex, fetchImpl }) {
  const claims = db.collection(CLAIMS_COLLECTION);
  const claim = await claims.findOneAndUpdate(
    { _id: String(reservationId), campaignId: campaign._id, key: stake, status: 'reserved' },
    { $set: { status: 'submitting', submittingAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!claim) throw new ClaimInputError('This claim is no longer active. Start again.');

  try {
    if (await fetchTipSlot(claim.network, fetchImpl) >= claim.ttl - 10) {
      await releaseReservation(db, claim);
      throw new ClaimInputError('The claim took too long and expired. Start again.');
    }

    const csl = await loadCsl();
    const campaignWitness = csl.Vkeywitness.from_hex(claim.campaignWitnessHex);
    let signed;
    try {
      signed = assembleClaimTransaction(csl, claim.bodyHex, campaignWitness, String(witnessSetHex || ''));
    } catch (error) {
      await claims.updateOne({ _id: claim._id }, { $set: { status: 'reserved' } });
      throw new ClaimInputError(error.message || 'The signature from your wallet was not usable.');
    }

    try {
      await submitTransaction(Buffer.from(signed.to_bytes()), claim.network, fetchImpl);
    } catch (error) {
      console.error('[PREEB] Claim submission was rejected:', error);
      await claims.updateOne({ _id: claim._id }, { $set: { lastError: String(error.message).slice(0, 300) } });
      if (isDefinitiveRejection(error)) {
        // The transaction body cannot change, so it can never be accepted: free the lane and entitlement now.
        await releaseReservation(db, claim);
        throw new ClaimInputError(describeRejection(String(error.message)));
      }
      await claims.updateOne({ _id: claim._id }, { $set: { status: 'reserved' } });
      throw new ClaimInputError('The network is not responding right now. Please try again in a moment.');
    }

    await claims.updateOne({ _id: claim._id }, { $set: { status: 'submitted', submittedAt: new Date() } });
    return { txHash: claim.txHash };
  } catch (error) {
    if (!(error instanceof ClaimInputError)) {
      await claims.updateOne({ _id: claim._id, status: 'submitting' }, { $set: { status: 'reserved' } });
    }
    throw error;
  }
}

