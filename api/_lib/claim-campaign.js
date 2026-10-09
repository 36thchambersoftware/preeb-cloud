import crypto from 'node:crypto';
import { addressBelongsToStake } from './cardano-address.js';
import { generateClaimWallet } from './claim-wallet.js';
import {
  SnapshotError,
  buildEntitlements,
  fetchKoiosHolders,
  parseHolderJson,
  parseTokenAmount,
} from './claim-snapshot.js';

export const CAMPAIGNS_COLLECTION = 'claim_campaigns';
export const WALLETS_COLLECTION = 'claim_wallets';
export const ENTITLEMENTS_COLLECTION = 'claim_entitlements';

export const PUBLIC_LIST_LIMIT = 12;
const MAX_OPEN_CAMPAIGNS_PER_OWNER = 5;
const MAX_SNAPSHOT_ATTEMPTS = 3;
const STALE_SNAPSHOT_MS = 10 * 60 * 1000;
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export class ClaimInputError extends Error {}

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
    ]);
    globalThis.__preebClaimIndexesReady = true;
  } catch (error) {
    console.error('[PREEB] Could not create claim indexes:', error);
  }
}

function text(value, fieldName, { min = 0, max }) {
  const result = String(value ?? '').trim();
  if (result.length < min) throw new ClaimInputError(`${fieldName} is required.`);
  if (result.length > max) throw new ClaimInputError(`${fieldName} must be at most ${max} characters.`);
  return result;
}

function hex(value, fieldName, { exactLength, maxLength, allowEmpty = false }) {
  const result = String(value ?? '').trim().toLowerCase();
  if (allowEmpty && result === '') return '';
  const lengthOk = exactLength ? result.length === exactLength : result.length <= maxLength && result.length % 2 === 0;
  if (!/^[0-9a-f]*$/.test(result) || !lengthOk || result === '') {
    throw new ClaimInputError(`${fieldName} is not valid.`);
  }
  return result;
}

function date(value, fieldName, now) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ClaimInputError(`${fieldName} is not a valid date.`);
  if (parsed.getTime() > now.getTime() + MAX_FUTURE_MS) {
    throw new ClaimInputError(`${fieldName} must be within a year from now.`);
  }
  return parsed;
}

export function normalizeImageUrl(value) {
  const url = String(value ?? '').trim();
  if (!url) return null;
  if (url.length > 500) throw new ClaimInputError('The image URL is too long.');
  if (url.startsWith('ipfs://')) {
    const path = url.slice('ipfs://'.length).replace(/^ipfs\//, '');
    if (!/^[A-Za-z0-9._\-/]+$/.test(path)) throw new ClaimInputError('The IPFS image link is not valid.');
    return `ipfs://${path}`;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ClaimInputError('The image URL is not valid.');
  }
  if (parsed.protocol !== 'https:') throw new ClaimInputError('Image URLs must start with https:// or ipfs://.');
  return parsed.toString();
}

export function resolveImageUrl(value) {
  if (!value) return null;
  return value.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${value.slice('ipfs://'.length)}` : value;
}

/** Validates the creation request and turns it into a campaign document (minus wallet fields). */
export function parseCampaignInput(body, { ownerStake, now = new Date(), network = getClaimNetwork() } = {}) {
  if (!body || typeof body !== 'object') throw new ClaimInputError('Request body is required.');

  const decimals = Number(body.tokenY?.decimals ?? 0);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 19) {
    throw new ClaimInputError('Token decimals must be between 0 and 19.');
  }

  const tokenY = {
    policyId: hex(body.tokenY?.policyId, 'Token policy ID', { exactLength: 56 }),
    assetNameHex: hex(body.tokenY?.assetNameHex, 'Token asset name', { maxLength: 64, allowEmpty: true }),
    decimals,
    ticker: text(body.tokenY?.ticker, 'Ticker', { max: 12 }),
  };

  const mode = body.distribution?.mode;
  if (!['fixed', 'proportional', 'manual'].includes(mode)) {
    throw new ClaimInputError('Distribution mode must be fixed, proportional or manual.');
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
    if (error instanceof SnapshotError) throw new ClaimInputError(error.message);
    throw error;
  }

  const source = body.snapshot?.source;
  if (source !== 'koios' && source !== 'json') {
    throw new ClaimInputError('Snapshot source must be koios or json.');
  }
  if (source === 'json' && !Array.isArray(body.snapshot.holders) && typeof body.snapshot.holders !== 'string') {
    throw new ClaimInputError('A holder list is required.');
  }
  if (source === 'koios' && mode === 'manual') {
    throw new ClaimInputError('Manual amounts need an uploaded holder list.');
  }

  const snapshot = { source };
  let tokenX = null;
  if (source === 'koios') {
    tokenX = {
      policyId: hex(body.tokenX?.policyId, 'Token X policy ID', { exactLength: 56 }),
      assetNameHex: hex(body.tokenX?.assetNameHex, 'Token X asset name', { maxLength: 64, allowEmpty: true }),
    };
  }
  const scheduledFor = date(body.snapshot.at, 'Snapshot date', now);
  snapshot.scheduledFor = scheduledFor && scheduledFor > now ? scheduledFor : now;

  const claimStartsAt = date(body.claimStartsAt, 'Claim start', now);
  const claimEndsAt = date(body.claimEndsAt, 'Claim end', now);
  const earliestClaim = claimStartsAt || snapshot.scheduledFor;
  if (claimEndsAt && claimEndsAt <= earliestClaim) {
    throw new ClaimInputError('The claim period must end after the snapshot and claim start.');
  }
  if (claimStartsAt && claimStartsAt < snapshot.scheduledFor) {
    throw new ClaimInputError('Claims cannot start before the snapshot is taken.');
  }

  const minBalanceText = String(body.filters?.minBalance ?? '').trim();
  if (minBalanceText && !/^\d+$/.test(minBalanceText)) {
    throw new ClaimInputError('Minimum balance must be a whole number.');
  }
  const exclude = Array.isArray(body.filters?.exclude)
    ? body.filters.exclude.map((item) => String(item).trim()).filter(Boolean).slice(0, 500)
    : [];

  const payoutAddress = String(body.payoutAddress ?? '').trim();
  if (!addressBelongsToStake(payoutAddress, ownerStake)) {
    throw new ClaimInputError('The reclaim address must be an address of your connected wallet.');
  }
  const payoutNetwork = payoutAddress.startsWith('addr_test') ? 'preprod' : 'mainnet';
  if (payoutNetwork !== network) {
    throw new ClaimInputError(`The reclaim address must be a ${network} address.`);
  }

  let image = null;
  if (body.image?.url) {
    image = normalizeImageUrl(body.image.url);
  }

  return {
    title: text(body.title, 'Title', { min: 3, max: 80 }),
    description: text(body.description, 'Description', { max: 1000 }),
    image,
    network,
    owner: { stake: ownerStake, payoutAddress },
    tokenX,
    tokenY,
    distribution,
    filters: {
      minBalance: minBalanceText || '0',
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
  const rows = input.holders ? parseHolderJson(input.holders) : null;
  if (rows && rows.length > 25_000) throw new ClaimInputError('The holder list is too large.');

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
  if (campaign.reclaimedAt || (endsAt !== null && time >= endsAt)) {
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

export function toPublicCampaign(campaign, now = new Date(), { viewerStakes = [] } = {}) {
  const { status, countdownTo } = deriveStatus(campaign, now);
  const snapshot = campaign.snapshot || {};
  const iso = (value) => (value ? new Date(value).toISOString() : null);

  return {
    id: campaign._id,
    title: campaign.title,
    description: campaign.description,
    imageUrl: resolveImageUrl(campaign.image),
    network: campaign.network,
    status,
    countdownTo,
    owner: campaign.owner.stake,
    viewerIsOwner: viewerStakes.includes(campaign.owner.stake),
    tokenX: campaign.tokenX,
    tokenY: campaign.tokenY,
    distribution: campaign.distribution,
    filters: campaign.filters,
    walletAddress: campaign.wallet.address,
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

export async function getPublicCampaign(db, id, now = new Date(), viewerStakes = []) {
  const campaign = await db.collection(CAMPAIGNS_COLLECTION).findOne(
    { _id: id },
    { projection: { 'snapshot.rows': 0 } },
  );
  if (!campaign) return null;

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
          status: 'unclaimed',
          createdAt: now,
        })),
        { ordered: false },
      );
    }

    await campaigns.updateOne({ _id: campaignId }, {
      $set: {
        'snapshot.status': 'taken',
        'snapshot.takenAt': new Date(),
        'snapshot.error': null,
        'snapshot.eligibleCount': result.entitlements.length,
        'snapshot.holderCount': result.entitlements.length + Object.values(result.skipped).reduce((a, b) => a + b, 0),
        'snapshot.totalBalance': result.totalBalance,
        'snapshot.totalAmount': result.totalAmount,
        'snapshot.skipped': result.skipped,
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
