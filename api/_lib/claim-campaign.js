import crypto from 'node:crypto';
import { addressBelongsToStake, parseAddress } from './cardano-address.js';
import { lookupHandle, resolveHandleStake } from './handle.js';
import { generateClaimWallet } from './claim-wallet.js';
import { laneCountFor } from './claim-funding.js';
import {
  SnapshotError,
  buildEntitlements,
  fetchKoiosHolders,
  parseHolderJson,
  parseTokenAmount,
} from './claim-snapshot.js';
import { TokenInfoError, imageSourcesFor, normalizeImageRef } from './token-info.js';

export const CAMPAIGNS_COLLECTION = 'claim_campaigns';
export const WALLETS_COLLECTION = 'claim_wallets';
export const ENTITLEMENTS_COLLECTION = 'claim_entitlements';
export const LANES_COLLECTION = 'claim_lanes';

export const PUBLIC_LIST_LIMIT = 12;
const MAX_OPEN_CAMPAIGNS_PER_OWNER = 5;
const MAX_SNAPSHOT_ATTEMPTS = 3;
const STALE_SNAPSHOT_MS = 10 * 60 * 1000;
export const MIN_CLAIM_DELAY_MS = 15 * 60 * 1000;
export const MIN_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;
// Form times only have minute precision, so allow a little slack against the exact minimums.
const TIMING_TOLERANCE_MS = 60 * 1000;
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A problem with the creator's input. `field` names the form control to highlight. */
export class ClaimInputError extends Error {
  constructor(message, field = null) {
    super(message);
    this.field = field;
  }
}

export function getClaimNetwork() {
  return process.env.CLAIM_NETWORK === 'preprod' ? 'preprod' : 'mainnet';
}

export function generateCampaignId() {
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}

export async function ensureClaimIndexes(db) {
  if (globalThis.__preebClaimIndexesReady) return;
  try {
    await Promise.all([
      db.collection(CAMPAIGNS_COLLECTION).createIndex({ createdAt: -1 }),
      db.collection(CAMPAIGNS_COLLECTION).createIndex({ 'owner.stake': 1 }),
      db.collection(CAMPAIGNS_COLLECTION).createIndex({ 'snapshot.status': 1, 'snapshot.scheduledFor': 1 }),
      db.collection(ENTITLEMENTS_COLLECTION).createIndex({ campaignId: 1, key: 1 }, { unique: true }),
      db.collection(ENTITLEMENTS_COLLECTION).createIndex({ campaignId: 1, amountNum: -1, key: 1 }),
      db.collection(ENTITLEMENTS_COLLECTION).createIndex({ campaignId: 1, balanceNum: -1, key: 1 }),
      db.collection(LANES_COLLECTION).createIndex({ campaignId: 1, index: 1 }, { unique: true }),
      db.collection('claim_claims').createIndex({ campaignId: 1, status: 1 }),
    ]);
    globalThis.__preebClaimIndexesReady = true;
  } catch (error) {
    console.error('[PREEB] Could not create claim indexes:', error);
  }
}

function text(value, label, field, { min = 0, max }) {
  const result = String(value ?? '').trim();
  if (result.length < min) throw new ClaimInputError(`${label} is required.`, field);
  if (result.length > max) throw new ClaimInputError(`${label} must be at most ${max} characters.`, field);
  return result;
}

function hex(value, label, field, { exactLength, maxLength, allowEmpty = false }) {
  const result = String(value ?? '').trim().toLowerCase();
  if (allowEmpty && result === '') return '';
  const lengthOk = exactLength ? result.length === exactLength : result.length <= maxLength && result.length % 2 === 0;
  if (!/^[0-9a-f]*$/.test(result) || !lengthOk || result === '') {
    throw new ClaimInputError(
      exactLength ? `${label} must be ${exactLength} hex characters.` : `${label} must be a valid hex value.`,
      field,
    );
  }
  return result;
}

function date(value, label, field, now) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ClaimInputError(`${label} is not a valid date.`, field);
  if (parsed.getTime() > now.getTime() + MAX_FUTURE_MS) {
    throw new ClaimInputError(`${label} must be within a year from now.`, field);
  }
  return parsed;
}

export function normalizeImageUrl(value) {
  try {
    return normalizeImageRef(value);
  } catch (error) {
    if (error instanceof TokenInfoError) throw new ClaimInputError(error.message, 'image');
    throw error;
  }
}

const formatWhen = (value) => value.toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');

/** Validates the token the creator wants to give away, before it is looked up on chain. */
export function parseTokenReference(token, field = 'y-policy') {
  const policyId = hex(token?.policyId, 'The policy ID', field, { exactLength: 56 });
  // The asset name is only sent when a policy holds several tokens and the user picked one.
  const picked = token?.assetNameHex;
  const assetNameHex = picked === undefined || picked === null
    ? null
    : hex(picked, 'The token', 'y-asset', { maxLength: 64, allowEmpty: true });
  return { policyId, assetNameHex };
}

/**
 * Validates the creation request and turns it into a campaign document (minus
 * wallet fields). Token decimals, ticker and artwork come from `tokenInfo`, which
 * the server read from the chain; anything the client sends for them is ignored.
 */
export function parseCampaignInput(body, { ownerStake, tokenInfo, holderToken = null, now = new Date(), network = getClaimNetwork() } = {}) {
  if (!body || typeof body !== 'object') throw new ClaimInputError('Request body is required.');
  if (!tokenInfo) throw new ClaimInputError('The token could not be read from the chain.', 'y-policy');

  const decimals = tokenInfo.decimals;
  const tokenY = {
    policyId: tokenInfo.policyId,
    assetNameHex: tokenInfo.assetNameHex,
    decimals,
    decimalsSource: tokenInfo.decimalsSource,
    ticker: tokenInfo.ticker,
    name: tokenInfo.name,
    website: tokenInfo.website || null,
  };

  const mode = body.distribution?.mode;
  if (!['fixed', 'proportional', 'manual'].includes(mode)) {
    throw new ClaimInputError('Choose how each person\'s amount is decided.', 'distribution-mode');
  }
  const distribution = { mode };
  try {
    if (mode === 'fixed') {
      const amount = parseTokenAmount(body.distribution.amountPerHolder, decimals, 'Amount per holder');
      if (amount <= 0n) throw new SnapshotError('Amount per holder must be greater than zero.');
      distribution.amountPerHolder = amount.toString();
    } else if (mode === 'proportional') {
      const amount = parseTokenAmount(body.distribution.totalAmount, decimals, 'Total amount');
      if (amount <= 0n) throw new SnapshotError('Total amount must be greater than zero.');
      distribution.totalAmount = amount.toString();
    }
  } catch (error) {
    if (error instanceof SnapshotError) throw new ClaimInputError(error.message, 'distribution-amount');
    throw error;
  }

  const source = body.snapshot?.source;
  if (source !== 'koios' && source !== 'json') {
    throw new ClaimInputError('Choose where the list of eligible holders comes from.', 'source');
  }
  if (source === 'json' && !Array.isArray(body.snapshot.holders) && typeof body.snapshot.holders !== 'string') {
    throw new ClaimInputError('Upload or paste the holder list.', 'holder-json');
  }
  if (source === 'json' && !String(Array.isArray(body.snapshot.holders) ? body.snapshot.holders.length : body.snapshot.holders).trim()) {
    throw new ClaimInputError('Upload or paste the holder list.', 'holder-json');
  }
  if (source === 'koios' && mode === 'manual') {
    throw new ClaimInputError('Amounts from a list need an uploaded holder list.', 'distribution-mode');
  }

  const snapshot = { source };
  let tokenX = null;
  if (source === 'koios') {
    if (!holderToken) throw new ClaimInputError('The holder token could not be read from the chain.', 'x-policy');
    tokenX = {
      policyId: holderToken.policyId,
      name: holderToken.name,
      ticker: holderToken.ticker,
      website: holderToken.website || null,
      decimals: holderToken.decimals,
      multiAsset: Boolean(holderToken.multiAsset),
    };
  }
  const scheduledFor = date(body.snapshot.at, 'The snapshot time', 'snapshot-at', now);
  const snapshotIsImmediate = !scheduledFor || scheduledFor <= now;
  snapshot.scheduledFor = snapshotIsImmediate ? now : scheduledFor;

  const requestedStart = date(body.claimStartsAt, 'The claim start', 'claim-start', now);
  const claimEndsAt = date(body.claimEndsAt, 'The claim end', 'claim-end', now);

  // Holders get a quiet gap after the snapshot, and a minimum window to actually claim.
  const earliestStart = new Date(snapshot.scheduledFor.getTime() + MIN_CLAIM_DELAY_MS);
  if (requestedStart && requestedStart.getTime() < earliestStart.getTime() - TIMING_TOLERANCE_MS) {
    throw new ClaimInputError(
      `Claims must open at least 15 minutes after the snapshot. The earliest is ${formatWhen(earliestStart)}, or leave it empty to use that.`,
      'claim-start',
    );
  }
  const claimStartsAt = requestedStart && requestedStart > earliestStart ? requestedStart : earliestStart;

  if (claimEndsAt && claimEndsAt.getTime() < claimStartsAt.getTime() + MIN_CLAIM_WINDOW_MS - TIMING_TOLERANCE_MS) {
    throw new ClaimInputError(
      `Claims must stay open for at least 24 hours. With claims opening ${formatWhen(claimStartsAt)}, the earliest close is ${formatWhen(new Date(claimStartsAt.getTime() + MIN_CLAIM_WINDOW_MS))}.`,
      'claim-end',
    );
  }

  // The creator types a balance in whole tokens; the chain counts the smallest unit.
  const minBalanceText = String(body.filters?.minBalance ?? '').replace(/,/g, '').trim();
  let minBalance = 0n;
  if (minBalanceText) {
    try {
      minBalance = parseTokenAmount(minBalanceText, tokenX?.decimals ?? 0, 'The minimum balance');
    } catch (error) {
      if (error instanceof SnapshotError) throw new ClaimInputError(error.message, 'min-balance');
      throw error;
    }
  }
  const exclude = Array.isArray(body.filters?.exclude)
    ? body.filters.exclude.map((item) => String(item).trim()).filter(Boolean).slice(0, 500)
    : [];

  const payoutAddress = String(body.payoutAddress ?? '').trim();
  if (!addressBelongsToStake(payoutAddress, ownerStake)) {
    throw new ClaimInputError('The reclaim address must be an address of your connected wallet.', 'wallet');
  }
  const payoutNetwork = payoutAddress.startsWith('addr_test') ? 'preprod' : 'mainnet';
  if (payoutNetwork !== network) {
    throw new ClaimInputError(`This site is running on ${network}, so the reclaim address must be a ${network} address.`, 'wallet');
  }

  // Without an explicit choice, fall back to the token's own artwork.
  const image = body.image?.url ? normalizeImageUrl(body.image.url) : tokenInfo.images?.[0]?.ref || null;

  return {
    title: text(body.title, 'The title', 'f-title', { min: 3, max: 80 }),
    description: text(body.description, 'The description', 'f-description', { max: 1000 }),
    image,
    network,
    owner: { stake: ownerStake, payoutAddress },
    tokenX,
    tokenY,
    distribution,
    filters: {
      minBalance: minBalance.toString(),
      excludeScripts: body.filters?.excludeScripts !== false,
      exclude,
    },
    snapshot,
    claimStartsAt,
    claimEndsAt,
    holders: source === 'json' ? body.snapshot.holders : null,
  };
}

export async function createCampaign(db, input, { now = new Date() } = {}) {
  await ensureClaimIndexes(db);

  const open = await db.collection(CAMPAIGNS_COLLECTION).countDocuments({
    'owner.stake': input.owner.stake,
    $or: [{ claimEndsAt: null }, { claimEndsAt: { $gt: now } }],
    reclaimedAt: { $exists: false },
  });
  if (open >= MAX_OPEN_CAMPAIGNS_PER_OWNER) {
    throw new ClaimInputError(`You can have at most ${MAX_OPEN_CAMPAIGNS_PER_OWNER} open campaigns at a time.`);
  }

  // Parse the holder list up front so a bad upload fails before any wallet exists.
  let rows = null;
  try {
    rows = input.holders ? parseHolderJson(input.holders) : null;
  } catch (error) {
    if (error instanceof SnapshotError) throw new ClaimInputError(error.message, 'holder-json');
    throw error;
  }
  if (rows && rows.length > 25_000) throw new ClaimInputError('The holder list is too large (25,000 addresses at most).', 'holder-json');

  const id = generateCampaignId();
  const wallet = generateClaimWallet(input.network, id);
  const { holders, ...fields } = input;
  const campaign = {
    _id: id,
    ...fields,
    wallet: { address: wallet.address },
    snapshot: {
      ...input.snapshot,
      status: 'scheduled',
      attempts: 0,
      takenAt: null,
      error: null,
      ...(rows ? { rows } : {}),
    },
    lanes: { status: 'none', count: 0 },
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(WALLETS_COLLECTION).insertOne({
    _id: id,
    address: wallet.address,
    publicKeyHex: wallet.publicKeyHex,
    encryptedSeed: wallet.encryptedSeed,
    createdAt: now,
  });
  await db.collection(CAMPAIGNS_COLLECTION).insertOne(campaign);
  return campaign;
}

/**
 * The state a visitor sees, derived from dates so campaigns open and close on
 * time even if no background job has run.
 */
export function deriveStatus(campaign, now = new Date()) {
  const time = now.getTime();
  const endsAt = campaign.claimEndsAt ? new Date(campaign.claimEndsAt).getTime() : null;
  // Until the snapshot succeeds the claim window has not really started, so it cannot have ended either.
  const snapshotTaken = campaign.snapshot?.status === 'taken';
  if (campaign.reclaimedAt || (snapshotTaken && endsAt !== null && time >= endsAt)) {
    return { status: 'closed', countdownTo: null };
  }

  if (campaign.snapshot?.status === 'failed') {
    return { status: 'upcoming', countdownTo: null };
  }
  if (campaign.snapshot?.status !== 'taken') {
    return { status: 'upcoming', countdownTo: new Date(campaign.snapshot.scheduledFor).toISOString() };
  }

  const startsAt = campaign.claimStartsAt ? new Date(campaign.claimStartsAt).getTime() : 0;
  if (time < startsAt) {
    return { status: 'upcoming', countdownTo: new Date(startsAt).toISOString() };
  }
  return { status: 'active', countdownTo: endsAt === null ? null : new Date(endsAt).toISOString() };
}

/** What an open campaign is waiting on: funding, lane preparation, or nothing (claims are live). */
export function derivePhase(campaign, status) {
  if (status !== 'active') return status;
  if (campaign.lanes?.status === 'ready') return 'claiming';
  if (campaign.lanes?.status === 'preparing' || campaign.lanes?.status === 'submitted') return 'preparing';
  return campaign.funding?.status === 'funded' ? 'ready-to-prepare' : 'awaiting-funding';
}

export function toPublicCampaign(campaign, now = new Date(), { viewerStakes = [] } = {}) {
  const { status, countdownTo } = deriveStatus(campaign, now);
  const snapshot = campaign.snapshot || {};
  const iso = (value) => (value ? new Date(value).toISOString() : null);

  return {
    id: campaign._id,
    title: campaign.title,
    description: campaign.description,
    imageUrl: imageSourcesFor(campaign.image)[0] || null,
    imageSources: imageSourcesFor(campaign.image),
    network: campaign.network,
    status,
    phase: derivePhase(campaign, status),
    countdownTo,
    funding: campaign.funding
      ? { ...campaign.funding, checkedAt: new Date(campaign.funding.checkedAt).toISOString() }
      : null,
    lanes: { status: campaign.lanes?.status || 'none', count: campaign.lanes?.count || 0 },
    owner: campaign.owner.stake,
    viewerIsOwner: viewerStakes.includes(campaign.owner.stake),
    tokenX: campaign.tokenX,
    tokenY: campaign.tokenY,
    distribution: campaign.distribution,
    filters: campaign.filters,
    walletAddress: campaign.wallet.address,
    reclaimed: Boolean(campaign.reclaimedAt),
    reclaim: campaign.reclaim
      ? { status: campaign.reclaim.status, txHash: campaign.reclaim.txHash || null, destination: campaign.reclaim.destination || null, error: campaign.reclaim.error || null }
      : null,
    claimStartsAt: iso(campaign.claimStartsAt),
    claimEndsAt: iso(campaign.claimEndsAt),
    createdAt: iso(campaign.createdAt),
    snapshot: {
      source: snapshot.source,
      status: snapshot.status,
      scheduledFor: iso(snapshot.scheduledFor),
      takenAt: iso(snapshot.takenAt),
      eligibleCount: snapshot.eligibleCount ?? null,
      totalAmount: snapshot.totalAmount ?? null,
      error: snapshot.status === 'failed' ? snapshot.error : null,
    },
  };
}

export async function listPublicCampaigns(db, now = new Date()) {
  const campaigns = await db.collection(CAMPAIGNS_COLLECTION)
    .find({}, { projection: { 'snapshot.rows': 0 } })
    .sort({ createdAt: -1 })
    .limit(PUBLIC_LIST_LIMIT)
    .toArray();
  return campaigns.map((campaign) => toPublicCampaign(campaign, now));
}

/** `refresh` lets the caller update chain-derived state (funding, lanes) before the campaign is described. */
export async function getPublicCampaign(db, id, now = new Date(), viewerStakes = [], { refresh } = {}) {
  let campaign = await db.collection(CAMPAIGNS_COLLECTION).findOne(
    { _id: id },
    { projection: { 'snapshot.rows': 0 } },
  );
  if (!campaign) return null;
  if (refresh) campaign = await refresh(campaign);

  const totals = await db.collection(ENTITLEMENTS_COLLECTION).aggregate([
    { $match: { campaignId: id } },
    {
      $group: {
        _id: null,
        eligible: { $sum: 1 },
        claimed: { $sum: { $cond: [{ $eq: ['$status', 'claimed'] }, 1, 0] } },
      },
    },
  ]).toArray();

  return {
    ...toPublicCampaign(campaign, now, { viewerStakes }),
    stats: {
      eligible: totals[0]?.eligible || 0,
      claimed: totals[0]?.claimed || 0,
    },
  };
}

/** Whether `value` looks like a valid campaign id (guards route params). */
export function isCampaignId(value) {
  return typeof value === 'string' && /^[a-z0-9]{10}$/.test(value);
}

async function loadHolderRows(campaign, fetchImpl) {
  if (campaign.snapshot.source === 'json') return campaign.snapshot.rows || [];
  return fetchKoiosHolders({ ...campaign.tokenX, network: campaign.network }, fetchImpl);
}

/**
 * Takes the snapshot for one campaign. The scheduled -> running transition is
 * atomic, so overlapping cron runs cannot snapshot the same campaign twice.
 */
export async function runSnapshot(db, campaignId, { now = new Date(), fetchImpl = fetch } = {}) {
  const campaigns = db.collection(CAMPAIGNS_COLLECTION);
  const campaign = await campaigns.findOneAndUpdate(
    { _id: campaignId, 'snapshot.status': 'scheduled', 'snapshot.scheduledFor': { $lte: now } },
    { $set: { 'snapshot.status': 'running', 'snapshot.startedAt': now }, $inc: { 'snapshot.attempts': 1 } },
    { returnDocument: 'after' },
  );
  if (!campaign) return { ran: false };

  const entitlementsCollection = db.collection(ENTITLEMENTS_COLLECTION);
  try {
    const rows = await loadHolderRows(campaign, fetchImpl);
    const decimals = campaign.tokenY.decimals;
    const result = buildEntitlements({
      rows,
      filters: campaign.filters,
      distribution: campaign.distribution,
      decimals,
      excludeAddresses: [campaign.wallet.address],
    });
    if (result.entitlements.length === 0) {
      throw new SnapshotError('No eligible holders were found for this campaign.');
    }

    await entitlementsCollection.deleteMany({ campaignId });
    for (let start = 0; start < result.entitlements.length; start += 1000) {
      await entitlementsCollection.insertMany(
        result.entitlements.slice(start, start + 1000).map((entitlement) => ({
          campaignId,
          ...entitlement,
          // Only used to sort the public snapshot table; amounts themselves stay exact strings.
          amountNum: Number(entitlement.amount),
          balanceNum: Number(entitlement.balance),
          status: 'unclaimed',
          createdAt: now,
        })),
        { ordered: false },
      );
    }

    // A snapshot that ran late must not leave holders less than 15 minutes of notice;
    // the whole claim window moves by the delay and keeps its length.
    const takenAt = new Date();
    const earliestStart = takenAt.getTime() + MIN_CLAIM_DELAY_MS;
    const plannedStart = campaign.claimStartsAt ? new Date(campaign.claimStartsAt).getTime() : earliestStart;
    const shift = Math.max(0, earliestStart - plannedStart);
    const window = {};
    if (shift > 0 || !campaign.claimStartsAt) {
      window.claimStartsAt = new Date(plannedStart + shift);
      if (campaign.claimEndsAt) window.claimEndsAt = new Date(new Date(campaign.claimEndsAt).getTime() + shift);
    }

    await campaigns.updateOne({ _id: campaignId }, {
      $set: {
        ...window,
        'snapshot.status': 'taken',
        'snapshot.takenAt': takenAt,
        'snapshot.error': null,
        'snapshot.eligibleCount': result.entitlements.length,
        'snapshot.holderCount': result.entitlements.length + Object.values(result.skipped).reduce((a, b) => a + b, 0),
        'snapshot.totalBalance': result.totalBalance,
        'snapshot.totalAmount': result.totalAmount,
        'snapshot.skipped': result.skipped,
        'lanes.count': laneCountFor(result.entitlements.length),
        updatedAt: new Date(),
      },
      $unset: { 'snapshot.rows': '' },
    });
    return { ran: true, status: 'taken', eligibleCount: result.entitlements.length };
  } catch (error) {
    const message = error instanceof SnapshotError || error instanceof ClaimInputError
      ? error.message
      : 'The snapshot could not be completed.';
    if (!(error instanceof SnapshotError)) console.error('[PREEB] Claim snapshot failed:', error);
    const retry = campaign.snapshot.attempts < MAX_SNAPSHOT_ATTEMPTS;
    await campaigns.updateOne({ _id: campaignId }, {
      $set: {
        'snapshot.status': retry ? 'scheduled' : 'failed',
        'snapshot.error': message,
        updatedAt: new Date(),
      },
    });
    return { ran: true, status: retry ? 'scheduled' : 'failed', error: message };
  }
}

/** Lets the owner rerun a snapshot that exhausted its automatic retries. */
export async function retrySnapshot(db, campaignId, { now = new Date(), fetchImpl } = {}) {
  const reset = await db.collection(CAMPAIGNS_COLLECTION).updateOne(
    { _id: campaignId, 'snapshot.status': 'failed' },
    { $set: { 'snapshot.status': 'scheduled', 'snapshot.scheduledFor': now, 'snapshot.attempts': 0, 'snapshot.error': null } },
  );
  if (!reset.matchedCount) throw new ClaimInputError('Only a failed snapshot can be rerun.');
  return runSnapshot(db, campaignId, { now, fetchImpl });
}

export async function runDueSnapshots(db, { now = new Date(), fetchImpl = fetch, limit = 5 } = {}) {
  // A function that died mid-snapshot leaves the campaign "running"; hand it back to the queue.
  await db.collection(CAMPAIGNS_COLLECTION).updateMany(
    { 'snapshot.status': 'running', 'snapshot.startedAt': { $lt: new Date(now.getTime() - STALE_SNAPSHOT_MS) } },
    { $set: { 'snapshot.status': 'scheduled' } },
  );

  const due = await db.collection(CAMPAIGNS_COLLECTION)
    .find({ 'snapshot.status': 'scheduled', 'snapshot.scheduledFor': { $lte: now } }, { projection: { _id: 1 } })
    .sort({ 'snapshot.scheduledFor': 1 })
    .limit(limit)
    .toArray();

  const results = [];
  for (const { _id } of due) {
    results.push({ id: _id, ...(await runSnapshot(db, _id, { now, fetchImpl })) });
  }
  return results;
}

export const SNAPSHOT_PAGE_SIZE = 25;

/** Turns what someone typed into an entitlement filter: a wallet, a $handle, or an address prefix. */
async function snapshotFilterFor(query, fetchImpl) {
  const text = query.trim();
  if (!text || text.length > 120) return { empty: true };

  const parsed = parseAddress(text);
  if (parsed) {
    const keys = [text];
    if (parsed.stakeAddress) keys.push(parsed.stakeAddress);
    return { filter: { key: { $in: keys } } };
  }

  if (text.startsWith('$') || (!/^(stake|addr)/i.test(text) && /^[a-z0-9_.-]{2,40}$/i.test(text))) {
    const stake = await resolveHandleStake(text, { fetchImpl });
    return stake ? { filter: { key: stake } } : { empty: true, note: `No wallet found for the handle ${text.startsWith('$') ? text : `$${text}`}.` };
  }

  if (/^(stake|addr)[0-9a-z_]{3,}$/i.test(text)) {
    return { filter: { key: { $regex: `^${text.replace(/[^0-9a-zA-Z_]/g, '')}` } } };
  }
  return { empty: true, note: 'Enter a stake address, a payment address or an ADA Handle.' };
}

const HANDLE_TTL_MS = 24 * 60 * 60 * 1000;
const SORT_FIELDS = { claim: 'amountNum', holding: 'balanceNum' };
const sortableCampaigns = globalThis.__preebSortableCampaigns || new Set();
globalThis.__preebSortableCampaigns = sortableCampaigns;

// Rows from before the sortable number columns existed get them filled in once.
async function ensureSortableNumbers(collection, campaignId) {
  if (sortableCampaigns.has(campaignId) || typeof collection.updateMany !== 'function') return;
  for (const [field, source] of [['amountNum', '$amount'], ['balanceNum', '$balance']]) {
    await collection.updateMany({ campaignId, [field]: { $exists: false } }, [{ $set: { [field]: { $toDouble: source } } }]);
  }
  sortableCampaigns.add(campaignId);
}

/**
 * Adds each visible wallet's ADA Handle. Answers are stored on the entitlement
 * for a day, and lookups stop after a short time budget, so one page view never
 * waits on the Handle API for long. Wallets not answered yet are reported as pending.
 */
async function attachHandles(collection, rows, { fetchImpl, budgetMs = 3500, concurrency = 4, now = Date.now() } = {}) {
  const queue = rows.filter((row) => /^stake1/.test(row.key) && !(row.handleCheckedAt && now - new Date(row.handleCheckedAt).getTime() < HANDLE_TTL_MS));
  const deadline = Date.now() + budgetMs;
  let pending = 0;

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      if (Date.now() > deadline) {
        pending += 1;
        continue;
      }
      const handle = await lookupHandle(row.key, { fetchImpl });
      if (handle === undefined) {
        pending += 1;
        continue;
      }
      row.handle = handle;
      row.handleCheckedAt = new Date(now);
      await collection.updateOne({ _id: row._id }, { $set: { handle, handleCheckedAt: row.handleCheckedAt } });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return pending;
}

/** One page of a campaign's snapshot, optionally narrowed to a wallet and sorted by claim or holding. */
export async function listSnapshot(db, campaignId, { query = '', page = 0, sort = 'claim', dir = 'desc', handles = false, fetchImpl = fetch } = {}) {
  const base = { campaignId };
  let filter = base;

  if (query.trim()) {
    const target = await snapshotFilterFor(query, fetchImpl);
    if (target.empty) return { entries: [], total: 0, page: 0, pageSize: SNAPSHOT_PAGE_SIZE, note: target.note || null, pendingHandles: 0 };
    filter = { ...base, ...target.filter };
  }

  const collection = db.collection(ENTITLEMENTS_COLLECTION);
  const sortField = SORT_FIELDS[sort] || SORT_FIELDS.claim;
  const direction = dir === 'asc' ? 1 : -1;
  await ensureSortableNumbers(collection, campaignId);

  const safePage = Math.min(Math.max(Number.parseInt(page, 10) || 0, 0), 1000);
  const [total, rows] = await Promise.all([
    collection.countDocuments(filter),
    collection.find(filter, { projection: { key: 1, balance: 1, amount: 1, status: 1, claimedAt: 1, handle: 1, handleCheckedAt: 1 } })
      .sort({ [sortField]: direction, key: 1 })
      .skip(safePage * SNAPSHOT_PAGE_SIZE)
      .limit(SNAPSHOT_PAGE_SIZE)
      .toArray(),
  ]);

  const pendingHandles = handles ? await attachHandles(collection, rows, { fetchImpl }) : 0;

  return {
    entries: rows.map((row) => ({
      key: row.key,
      handle: row.handle || null,
      balance: row.balance,
      amount: row.amount,
      status: row.status,
      claimedAt: row.claimedAt ? new Date(row.claimedAt).toISOString() : null,
    })),
    total,
    page: safePage,
    pageSize: SNAPSHOT_PAGE_SIZE,
    note: query.trim() && total === 0 ? 'That wallet is not in the snapshot.' : null,
    pendingHandles,
  };
}
