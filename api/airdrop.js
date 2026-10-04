import { getDb } from './_lib/mongo.js';
import { applyCors, checkRateLimit, getClientIp, rejectRateLimited } from './_lib/security.js';

const AIRDROPS_COLLECTION = 'signed_airdrops';
const TX_HASH_RE = /^[0-9a-f]{64}$/i;
const MAX_RECIPIENTS = 10_000;
const KOIOS_BASE = 'https://api.koios.rest/api/v1';
const PREEB_AIRDROP_SIGNATURE = 'Airdrop courtesy of PREEB';
const PREEB_AIRDROP_METADATA_VERSION = 'v1';
const REMAINDER_WALLET = 'addr1qxpxx5xgkqxm42sw2pzx68hjf3v8n6d3nhv7leyxgnre0n2rq7ll2fcjhuqdrtfdwufjmcx42mtgsgz299gmv74w3w5q6zeyv2';
const PENDING_AIRDROP_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_AIRDROP_RECHECK_LIMIT = 20;

class TrackingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function ensureIndexes(db) {
  if (globalThis.__preebAirdropIndexesReady) return;
  try {
    await db.collection(AIRDROPS_COLLECTION).createIndex({ txHash: 1 }, { unique: true });
    await db.collection(AIRDROPS_COLLECTION).createIndex({ status: 1, submittedAt: -1 });
    await db.collection(AIRDROPS_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  } catch (err) {
    console.warn('[PREEB] Could not ensure airdrop indexes (non-fatal):', err.message);
  }
  globalThis.__preebAirdropIndexesReady = true;
}

function parseNonNegativeInteger(value, fieldName, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return parsed;
}

function parseLovelace(value, fieldName) {
  const parsed = String(value ?? '').trim();
  if (!/^(0|[1-9]\d{0,19})$/.test(parsed)) throw new Error(`Invalid ${fieldName}`);
  return parsed;
}

function parseTrackingRequest(body) {
  const txHash = String(body.txHash || '').trim().toLowerCase();
  if (!TX_HASH_RE.test(txHash)) throw new TrackingError('Invalid transaction hash');
  return txHash;
}

async function fetchKoiosTransactionData(endpoint, txHash) {
  const response = await fetch(`${KOIOS_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ _tx_hashes: [txHash] }),
  });
  if (!response.ok) {
    throw new TrackingError('Unable to verify the transaction on Cardano right now. Please retry shortly.', 502);
  }
  return response.json();
}

function findAirdropMetadata(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAirdropMetadata(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (value.preeb_airdrop === PREEB_AIRDROP_METADATA_VERSION) return value;
  for (const item of Object.values(value)) {
    const found = findAirdropMetadata(item);
    if (found) return found;
  }
  return null;
}

function includesMetadataText(value, expectedText) {
  if (typeof value === 'string') return value === expectedText;
  if (Array.isArray(value)) return value.some((item) => includesMetadataText(item, expectedText));
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((item) => includesMetadataText(item, expectedText));
}

async function verifyAirdropOnChain(txHash) {
  const [txInfoRows, metadataRows, utxoRows] = await Promise.all([
    fetchKoiosTransactionData('tx_info', txHash),
    fetchKoiosTransactionData('tx_metadata', txHash),
    fetchKoiosTransactionData('tx_utxos', txHash),
  ]);
  const txInfo = Array.isArray(txInfoRows) ? txInfoRows[0] : null;
  const metadata = Array.isArray(metadataRows) ? metadataRows[0]?.metadata : null;
  const utxos = Array.isArray(utxoRows) ? utxoRows[0] : null;

  if (!txInfo || !utxos) {
    throw new TrackingError('Transaction has not been indexed on Cardano yet. Tracking will retry automatically.', 409);
  }
  if (!includesMetadataText(metadata, PREEB_AIRDROP_SIGNATURE)) {
    throw new TrackingError('Transaction is missing the PREEB airdrop marker.');
  }
  const tracking = findAirdropMetadata(metadata);
  if (!tracking) {
    throw new TrackingError('Transaction is missing verified PREEB airdrop tracking metadata.');
  }

  const inputAddresses = new Set(
    (utxos.inputs || []).map((input) => input?.payment_addr?.bech32).filter(Boolean)
  );
  // Change is appended as the final output, so excluding it by index (not by address)
  // keeps a payout to a sender who is also a recipient of their own airdrop.
  const orderedOutputs = [...(utxos.outputs || [])].sort((left, right) => left.tx_index - right.tx_index);
  const finalOutput = orderedOutputs[orderedOutputs.length - 1];
  const changeIndex = finalOutput && inputAddresses.has(finalOutput?.payment_addr?.bech32)
    ? finalOutput.tx_index
    : null;
  const payoutOutputs = orderedOutputs.filter((output) => {
    const address = output?.payment_addr?.bech32;
    return address && address !== REMAINDER_WALLET && output.tx_index !== changeIndex;
  });
  const recipientCount = payoutOutputs.length;
  const paidLovelace = payoutOutputs.reduce((total, output) => total + BigInt(output.value || 0), 0n).toString();
  const policyId = tracking.policy_id ? String(tracking.policy_id).toLowerCase() : null;
  const poolId = tracking.pool_id ? String(tracking.pool_id).toLowerCase() : null;

  if (recipientCount === 0 || recipientCount > MAX_RECIPIENTS) {
    throw new TrackingError('Transaction has no verifiable airdrop recipient outputs.');
  }
  if (
    parseNonNegativeInteger(tracking.recipient_count, 'metadata recipient count', MAX_RECIPIENTS) !== recipientCount ||
    parseLovelace(tracking.payout_lovelace, 'metadata payout') !== paidLovelace ||
    !['upload', 'policy', 'pool'].includes(tracking.mode) ||
    (policyId && !/^[0-9a-f]{56}$/.test(policyId)) ||
    (poolId && !/^pool1[0-9a-z]{51}$/.test(poolId))
  ) {
    throw new TrackingError('On-chain airdrop metadata does not match the verified transaction outputs.');
  }

  return {
    txHash,
    status: 'submitted',
    signedAt: new Date(Number(txInfo.tx_timestamp || txInfo.block_time || 0) * 1000),
    submittedAt: new Date(Number(txInfo.tx_timestamp || txInfo.block_time || 0) * 1000),
    recipientCount,
    paidLovelace,
    feeLovelace: parseLovelace(txInfo.fee, 'transaction fee'),
    mode: tracking.mode,
    policyId,
    poolId,
    delegatedToPreeb: Array.isArray(txInfo.certificates) && txInfo.certificates.length > 0,
  };
}

async function getPublicAirdropData(db) {
  const collection = db.collection(AIRDROPS_COLLECTION);
  const [result] = await collection.aggregate([
    {
      $facet: {
        totals: [
          { $match: { status: 'submitted' } },
          {
            $group: {
              _id: null,
              totalAirdrops: { $sum: 1 },
              totalRecipients: { $sum: '$recipientCount' },
              totalLovelace: { $sum: { $toDecimal: '$paidLovelace' } },
              totalFeeLovelace: { $sum: { $toDecimal: '$feeLovelace' } },
              delegatedAirdrops: { $sum: { $cond: ['$delegatedToPreeb', 1, 0] } },
              policyIds: { $addToSet: '$policyId' },
            },
          },
        ],
        pending: [
          { $match: { status: 'pending' } },
          { $count: 'count' },
        ],
        recent: [
          { $match: { status: 'submitted' } },
          { $sort: { submittedAt: -1 } },
          { $limit: 12 },
          {
            $project: {
              _id: 0,
              txHash: 1,
              submittedAt: 1,
              recipientCount: 1,
              paidLovelace: 1,
              policyId: 1,
              poolId: 1,
              mode: 1,
              delegatedToPreeb: 1,
            },
          },
        ],
      },
    },
  ]).toArray();

  const totals = result?.totals?.[0] || {};
  const policyIds = (totals.policyIds || []).filter(Boolean).sort();
  return {
    stats: {
      totalAirdrops: totals.totalAirdrops || 0,
      totalRecipients: totals.totalRecipients || 0,
      totalLovelace: totals.totalLovelace?.toString?.() || '0',
      totalFeeLovelace: totals.totalFeeLovelace?.toString?.() || '0',
      delegatedAirdrops: totals.delegatedAirdrops || 0,
      pendingVerification: result?.pending?.[0]?.count || 0,
      policyIds,
    },
    airdrops: result?.recent || [],
  };
}

async function saveVerifiedAirdrop(collection, event) {
  // $set (not $setOnInsert) so promoting an existing pending record also stores its details.
  await collection.updateOne(
    { txHash: event.txHash },
    {
      $setOnInsert: { createdAt: new Date() },
      $set: { ...event, updatedAt: new Date() },
      $unset: { expiresAt: '' },
    },
    { upsert: true }
  );
}

async function savePendingAirdrop(collection, txHash) {
  const now = new Date();
  await collection.updateOne(
    { txHash },
    {
      $setOnInsert: {
        txHash,
        status: 'pending',
        createdAt: now,
        expiresAt: new Date(now.getTime() + PENDING_AIRDROP_TTL_MS),
      },
    },
    { upsert: true }
  );
}

async function promotePendingAirdrops(db) {
  const collection = db.collection(AIRDROPS_COLLECTION);
  // Also repairs submitted records saved without details by the earlier promotion bug.
  const pending = await collection.find(
    { $or: [{ status: 'pending' }, { status: 'submitted', paidLovelace: { $exists: false } }] },
    { projection: { txHash: 1 } }
  )
    .limit(PENDING_AIRDROP_RECHECK_LIMIT)
    .toArray();

  for (const record of pending) {
    try {
      await saveVerifiedAirdrop(collection, await verifyAirdropOnChain(record.txHash));
    } catch (err) {
      if (err instanceof TrackingError && err.status === 400) {
        await collection.deleteOne({ _id: record._id, status: 'pending' });
      }
    }
  }
}

export default async function handler(req, res) {
  applyCors(req, res, 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (!['GET', 'POST'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rateLimit = checkRateLimit(`airdrop:${req.method}:${getClientIp(req)}`, {
    limit: req.method === 'GET' ? 60 : 30,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    rejectRateLimited(res, rateLimit.retryAfterSeconds);
    return;
  }

  try {
    const db = await getDb();
    await ensureIndexes(db);

    if (req.method === 'GET') {
      await promotePendingAirdrops(db);
      res.status(200).json(await getPublicAirdropData(db));
      return;
    }

    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const txHash = parseTrackingRequest(body || {});
    const collection = db.collection(AIRDROPS_COLLECTION);

    try {
      await saveVerifiedAirdrop(collection, await verifyAirdropOnChain(txHash));
    } catch (err) {
      if (!(err instanceof TrackingError) || err.status !== 409) throw err;
      await savePendingAirdrop(collection, txHash);
      res.status(202).json({ tracked: false, pending: true, txHash });
      return;
    }

    res.status(202).json({ tracked: true, txHash });
  } catch (err) {
    console.error('[PREEB] /api/airdrop request failed:', err.message);
    res.status(err.status || 400).json({ error: err.message || 'Unable to track signed airdrop' });
  }
}