import crypto from 'node:crypto';
import { addressBelongsToStake, parseAddress } from './cardano-address.js';
import {
  ClaimInputError,
  ENTITLEMENTS_COLLECTION,
  LANES_COLLECTION,
  WALLETS_COLLECTION,
  deriveStatus,
} from './claim-campaign.js';
import {
  FINALITY_CONFIRMATIONS,
  fetchConfirmations,
  fetchProtocolParams,
  fetchTipSlot,
  fetchUtxoInfo,
  isDefinitiveRejection,
  submitTransaction,
} from './cardano-chain.js';
import {
  assembleClaimTransaction,
  assertClaimTransaction,
  buildClaimTransaction,
  campaignVkeyWitness,
  laneOf,
  loadCsl,
} from './claim-funding.js';
import { signWithClaimWallet } from './claim-wallet.js';
import { assertEntitlementSealed, ensureCampaignSealed, IntegrityError } from './claim-integrity.js';
import { verifyCip8Signature } from './cip8.js';
import { createSignedToken, verifySignedToken } from './discord-auth.js';

export const CLAIMS_COLLECTION = 'claim_claims';

// A claim transaction is only valid for this many slots (seconds), which also bounds how
// long an abandoned attempt can hold a lane.
export const CLAIM_TTL_SLOTS = 180;
const CHALLENGE_TTL_SECONDS = 5 * 60;
// Extra slots to wait past a transaction's expiry before treating it as dead, to absorb indexer lag.
const TTL_SAFETY_SLOTS = 60;
const IN_FLIGHT = ['pending', 'reserved', 'submitting', 'submitted'];
// A claim record is written before anything is reserved. If the function dies before the
// transaction is built, this is how long the orphaned reservation lives.
const PENDING_WINDOW_MS = 120_000;
// A wallet that keeps starting claims and never signs them is not given more and more lane time.
const MAX_ABANDONED_CLAIMS = 4;
const ABANDONED_WINDOW_MS = 6 * 60 * 60 * 1000;

export class ClaimBusyError extends ClaimInputError {}

/** Shown while another claim holds the UTxO this wallet's claim has to use. */
function waitingForUtxoMessage(campaign, confirming = false) {
  const count = campaign.lanes?.count;
  const setting = count
    ? ` The campaign administrator set this campaign up with ${count} claim UTxO${count === 1 ? '' : 's'}, which decides how many people can claim at once.`
    : '';
  return confirming
    ? `Waiting for a free UTxO: the previous claim on yours is still confirming.${setting} Please try again in about a minute.`
    : `Waiting for a free UTxO: another claim is using the one yours needs.${setting} Please try again in about a minute.`;
}

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

async function releaseReservation(db, claim, reason = 'expired') {
  await db.collection(CLAIMS_COLLECTION).updateOne({ _id: claim._id }, { $set: { status: 'released', releasedAt: new Date(), releaseReason: reason } });
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
 * Brings in-flight claims up to date with the chain. A claim is final once it has a few
 * confirmations (a single block can still be rolled back). One whose expiry slot has passed
 * without it landing can never be included any more, so its entitlement and lane are released.
 * A claim that never got as far as a transaction is released when its short window ends.
 */
export async function settleClaims(db, campaignId, { now = new Date(), fetchImpl } = {}) {
  const claims = db.collection(CLAIMS_COLLECTION);
  const open = await claims.find({ campaignId, status: { $in: IN_FLIGHT } }).limit(200).toArray();
  if (open.length === 0) return { settled: 0, inFlight: 0 };

  try {
    const withTx = open.filter((claim) => claim.txHash);
    const confirmations = withTx.length
      ? await fetchConfirmations(withTx.map((claim) => claim.txHash), withTx[0].network, fetchImpl)
      : new Map();
    const stillOpen = withTx.filter((claim) => !(confirmations.get(claim.txHash) > 0));
    const tip = stillOpen.length ? await fetchTipSlot(withTx[0].network, fetchImpl) : 0;

    let inFlight = 0;
    for (const claim of open) {
      if (!claim.txHash) {
        if (now.getTime() > new Date(claim.expiresAt).getTime()) await releaseReservation(db, claim, 'expired');
        else inFlight += 1;
        continue;
      }
      const depth = confirmations.get(claim.txHash) || 0;
      if (depth >= FINALITY_CONFIRMATIONS) await confirmClaim(db, claim, now);
      else if (depth === 0 && tip > claim.ttl + TTL_SAFETY_SLOTS) await releaseReservation(db, claim, 'expired');
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
 * The claimer's wallet tells us which UTxOs it has, but nothing it says is trusted: it
 * only nominates references. Each one is re-read from the chain and kept only if it is
 * still unspent and sits at a key-controlled address of the claiming stake. Value and
 * address always come from the chain. This matters because the campaign key signs the
 * transaction we build, and its signature is valid for any input at the campaign address.
 */
export async function verifiedClaimerUtxos(csl, utxoHexes, { stake, campaign, fetchImpl, max = MAX_UTXO_CANDIDATES }) {
  const refs = [];
  for (const hex of utxoHexes) {
    try {
      const input = csl.TransactionUnspentOutput.from_hex(hex).input();
      refs.push({
        ref: `${Buffer.from(input.transaction_id().to_bytes()).toString('hex')}#${input.index()}`,
        lovelace: BigInt(csl.TransactionUnspentOutput.from_hex(hex).output().amount().coin().to_str()),
      });
    } catch {
      // Unreadable entries are ignored.
    }
  }
  const nominated = [...new Map(refs.map((item) => [item.ref, item])).values()]
    .sort((a, b) => (a.lovelace > b.lovelace ? -1 : 1))
    .slice(0, max)
    .map((item) => item.ref);

  const campaignKeyHash = parseAddress(campaign.wallet.address)?.paymentHash?.toString('hex');
  const rows = await fetchUtxoInfo(nominated, campaign.network, fetchImpl);
  return rows.filter((row) => {
    const parsed = parseAddress(row.address);
    return Boolean(parsed)
      && addressBelongsToStake(row.address, stake)
      && !parsed.paymentIsScript
      && parsed.paymentHash.toString('hex') !== campaignKeyHash
      && row.address !== campaign.wallet.address
      && !row.reference_script;
  });
}

function describeRejection(message) {
  if (/BadInputsUTxO/.test(message)) return 'Your wallet\'s list of funds was out of date, so the network refused the transaction. Nothing was spent. Please try again.';
  if (/FeeTooSmall|ValueNotConserved/.test(message)) return 'The network refused the transaction because of its fee. Nothing was spent. Please try again.';
  if (/OutsideValidityInterval/.test(message)) return 'The claim took too long and expired. Nothing was spent. Please try again.';
  return 'The network did not accept the transaction. Nothing was spent. Please try again.';
}

/**
 * A lane whose recorded UTxO is gone from the chain means our records and the chain disagree:
 *  - a claim landed that we did not record (for example the claimer submitted their own
 *    transaction): find it, record it, and point the lane at the UTxO it left behind;
 *  - or a claim we recorded as final was rolled back: undo it and point the lane back at the
 *    UTxO the claim had spent.
 */
async function reconcileLane(db, campaign, lane, { reservationId, now, fetchImpl }) {
  const claims = await db.collection(CLAIMS_COLLECTION)
    .find({ campaignId: campaign._id, laneIndex: lane.index, txHash: { $exists: true } })
    .sort({ createdAt: -1 }).limit(500).toArray();
  if (claims.length === 0) return false;

  const confirmations = await fetchConfirmations(claims.map((claim) => claim.txHash), campaign.network, fetchImpl);
  let changed = false;

  const landed = claims.filter((claim) => confirmations.get(claim.txHash) > 0 && claim.status !== 'confirmed');
  for (const claim of landed) await confirmClaim(db, claim, now);
  changed ||= landed.length > 0;

  // Newest first, so a chain of rolled-back claims unwinds to the right UTxO.
  const rolledBack = claims.filter((claim) => claim.status === 'confirmed' && !(confirmations.get(claim.txHash) > 0));
  for (const claim of rolledBack) {
    if (!claim.inputLaneUtxo) continue;
    await db.collection(CLAIMS_COLLECTION).updateOne({ _id: claim._id }, { $set: { status: 'released', releasedAt: now, releaseReason: 'rolled-back' } });
    await db.collection(ENTITLEMENTS_COLLECTION).updateOne(
      { campaignId: claim.campaignId, key: claim.key },
      { $set: { status: 'unclaimed' }, $unset: { claimedAt: '', txHash: '' } },
    );
    await db.collection(LANES_COLLECTION).updateOne({ _id: lane._id }, { $set: { utxo: claim.inputLaneUtxo } });
    changed = true;
  }

  // Recording those claims moves the lane; take it back for the claim in progress.
  if (changed) {
    await db.collection(LANES_COLLECTION).updateOne({ _id: lane._id }, { $set: { status: 'reserved', reservationId } });
  }
  return changed;
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

  // The campaign key is about to sign for this campaign, so what the database says about it
  // must be what the server wrote.
  await ensureCampaignSealed(db, campaign);

  await settleClaims(db, campaign._id, { now, fetchImpl });

  // Starting again while an earlier attempt is still valid returns that same transaction
  // instead of building a new one. Its signed body stays valid until it expires, so the old
  // reservation must never be released early: if it were submitted anyway, the chain and our
  // records would disagree and the lane would be stuck for everyone.
  const existing = await db.collection(CLAIMS_COLLECTION).findOne({ campaignId: campaign._id, key: stake, status: 'reserved' });
  if (existing?.txHex) {
    return {
      reservationId: existing._id,
      txHex: existing.txHex,
      amount: existing.amount,
      fee: existing.fee,
      expiresAt: new Date(existing.expiresAt).toISOString(),
    };
  }

  // Wallets that keep starting claims without ever signing them stop being served for a while,
  // so one holder cannot keep a lane tied up.
  const abandoned = await db.collection(CLAIMS_COLLECTION).countDocuments({
    campaignId: campaign._id,
    key: stake,
    status: 'released',
    releaseReason: 'expired',
    releasedAt: { $gt: new Date(now.getTime() - ABANDONED_WINDOW_MS) },
  });
  if (abandoned >= MAX_ABANDONED_CLAIMS) {
    throw new ClaimInputError('Several of your earlier claim attempts were never completed. Please try again in a few hours.');
  }

  // The claim record exists before anything is reserved, so a crash cannot leave a reservation
  // that nothing will ever clean up.
  const reservationId = crypto.randomUUID();
  const target = await db.collection(ENTITLEMENTS_COLLECTION).findOne(
    { campaignId: campaign._id, key: stake },
    { projection: { lane: 1 } },
  );
  const laneIndex = laneOf({ key: stake, lane: target?.lane }, campaign.lanes.count);
  const reservation = { _id: reservationId, campaignId: campaign._id, key: stake, laneIndex, network: campaign.network };
  await db.collection(CLAIMS_COLLECTION).insertOne({
    ...reservation,
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + PENDING_WINDOW_MS),
  });

  const entitlements = db.collection(ENTITLEMENTS_COLLECTION);
  const entitlement = await entitlements.findOneAndUpdate(
    { campaignId: campaign._id, key: stake, status: 'unclaimed' },
    { $set: { status: 'reserved', reservationId, reservedAt: now } },
    { returnDocument: 'after' },
  );
  if (!entitlement) {
    await releaseReservation(db, reservation, 'rejected');
    const existing = await entitlements.findOne({ campaignId: campaign._id, key: stake });
    throw new ClaimInputError(!existing
      ? 'This wallet is not in the snapshot.'
      : existing.status === 'claimed'
        ? 'This wallet has already claimed.'
        : 'A claim for this wallet is already in progress.');
  }

  try {
    assertEntitlementSealed(entitlement);
    if (laneOf(entitlement, campaign.lanes.count) !== laneIndex) {
      console.error('[PREEB] Entitlement lane changed during reservation:', campaign._id, stake);
      throw new IntegrityError();
    }
  } catch (error) {
    await releaseReservation(db, reservation, 'rejected');
    throw error;
  }

  const lane = await db.collection(LANES_COLLECTION).findOneAndUpdate(
    { _id: `${campaign._id}:${laneIndex}`, status: 'free' },
    { $set: { status: 'reserved', reservationId } },
    { returnDocument: 'after' },
  );
  if (!lane) {
    await releaseReservation(db, reservation, 'rejected');
    throw new ClaimBusyError(waitingForUtxoMessage(campaign));
  }

  try {
    let [laneUtxo] = await fetchUtxoInfo([`${lane.utxo.txHash}#${lane.utxo.txIndex}`], campaign.network, fetchImpl);
    if (!laneUtxo && await reconcileLane(db, campaign, lane, { reservationId, now, fetchImpl })) {
      // Reconciling may have just recorded this very wallet's earlier claim as landed.
      const current = await entitlements.findOne({ _id: entitlement._id });
      if (current?.status === 'claimed') {
        await db.collection(LANES_COLLECTION).updateOne({ _id: lane._id }, { $set: { status: 'free' }, $unset: { reservationId: '' } });
        throw new ClaimInputError('This wallet has already claimed.');
      }
      const refreshed = await db.collection(LANES_COLLECTION).findOne({ _id: lane._id });
      [laneUtxo] = await fetchUtxoInfo([`${refreshed.utxo.txHash}#${refreshed.utxo.txIndex}`], campaign.network, fetchImpl);
    }
    if (!laneUtxo) throw new ClaimBusyError(waitingForUtxoMessage(campaign, true));

    const [csl, protocol, tip, wallet] = await Promise.all([
      loadCsl(),
      fetchProtocolParams(campaign.network, fetchImpl),
      fetchTipSlot(campaign.network, fetchImpl),
      db.collection(WALLETS_COLLECTION).findOne({ _id: campaign._id }),
    ]);
    const spendable = await verifiedClaimerUtxos(csl, utxoHexes, { stake, campaign, fetchImpl });
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
        claimerUtxos: spendable,
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

    // Whatever happened above, the campaign key signs nothing but a plain claim.
    const campaignKeyHash = parseAddress(campaign.wallet.address)?.paymentHash?.toString('hex');
    assertClaimTransaction(csl, built.transaction, {
      campaignAddress: campaign.wallet.address,
      claimerAddress,
      lane: laneUtxo,
      claimerInputs: built.claimerInputs,
      allowInput: (utxo) => {
        const parsed = parseAddress(utxo.address);
        return Boolean(parsed) && addressBelongsToStake(utxo.address, stake) && !parsed.paymentIsScript
          && parsed.paymentHash.toString('hex') !== campaignKeyHash;
      },
      tokenY: campaign.tokenY,
      amount,
    });

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
    await db.collection(CLAIMS_COLLECTION).updateOne({ _id: reservationId }, { $set: {
      amount: amount.toString(),
      status: 'reserved',
      bodyHex: Buffer.from(built.transaction.body().to_bytes()).toString('hex'),
      campaignWitnessHex: campaignWitness.to_hex(),
      txHash: built.txHash,
      ttl,
      fee: built.fee.toString(),
      claimerAddress,
      txHex: forWallet.to_hex(),
      newLaneUtxo: { txHash: built.txHash, txIndex: built.laneOutputIndex },
      inputLaneUtxo: { txHash: lane.utxo.txHash, txIndex: lane.utxo.txIndex },
      expiresAt,
    } });

    return {
      reservationId,
      txHex: forWallet.to_hex(),
      amount: amount.toString(),
      fee: built.fee.toString(),
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    await releaseReservation(db, reservation, 'rejected');
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
      // Too late to submit safely, but the transaction is still valid for a few more slots, so
      // the reservation is left alone: it is released only once it can no longer land.
      await claims.updateOne({ _id: claim._id }, { $set: { status: 'reserved' } });
      throw new ClaimInputError('The claim took too long and is about to expire. Start again in a few minutes.');
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
        // The node refuses it, but "inputs already spent" can also mean this very transaction was
        // submitted elsewhere and has landed. Only a transaction that is not on chain is released.
        const confirmations = await fetchConfirmations([claim.txHash], claim.network, fetchImpl).catch(() => new Map());
        if (confirmations.get(claim.txHash) > 0) {
          await claims.updateOne({ _id: claim._id }, { $set: { status: 'submitted', submittedAt: new Date() } });
          return { txHash: claim.txHash };
        }
        await releaseReservation(db, claim, 'rejected');
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

