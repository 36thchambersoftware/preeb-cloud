import { getDb } from './_lib/mongo.js';
import { getRoleForLovelace, getRoleSummary } from './_lib/roles.js';
import { applyCors, checkRateLimit, getClientIp, rejectRateLimited } from './_lib/security.js';

const POOL_ID_BECH32 = 'pool19peeq2czwunkwe3s70yuvwpsrqcyndlqnxvt67usz98px57z7fk';
const POOL_ID_HEX = '2873902b027727676630f3c9c63830183049b7e09998bd7b90114e13';
const KOIOS_BASE = 'https://api.koios.rest/api/v1';
const CACHE_COLLECTION = 'leaderboard_cache';
const CACHE_KEY = 'preeb';
const CACHE_TTL_MS = 60 * 60 * 1000; // recompute at most once per hour
const STAKE_HISTORY_BATCH = 50;
const MAX_DELEGATORS = 5000;

function isPreebPool(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === POOL_ID_BECH32 || normalized === POOL_ID_HEX;
}

async function fetchKoios(path, options = {}) {
  const response = await fetch(`${KOIOS_BASE}/${path}`, {
    ...options,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!response.ok) {
    throw new Error(`Koios ${path} responded with HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchPoolDelegators() {
  const delegators = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchKoios(
      `pool_delegators?_pool_bech32=${encodeURIComponent(POOL_ID_BECH32)}&limit=${pageSize}&offset=${offset}`
    );
    const rows = Array.isArray(page) ? page : [];
    for (const row of rows) {
      const stake = typeof row?.stake_address === 'string' ? row.stake_address.trim() : '';
      const amount = String(row?.amount ?? '').trim();
      if (!stake || !/^(0|[1-9]\d*)$/.test(amount)) continue;
      delegators.push({ stake, activeStake: amount });
      if (delegators.length >= MAX_DELEGATORS) return delegators;
    }
    if (rows.length < pageSize) break;
  }
  return delegators;
}

async function fetchCurrentEpoch() {
  const rows = await fetchKoios('tip');
  const tip = Array.isArray(rows) ? rows[0] : rows;
  const epoch = Number(tip?.epoch_no ?? tip?.epoch ?? NaN);
  if (!Number.isFinite(epoch)) throw new Error('Koios tip did not return an epoch number');
  return epoch;
}

/**
 * Epochs delegated = currentEpoch - first PREEB epoch + 1, matching the
 * profile page's "Epochs Delegated to PREEB" formula so both surfaces agree.
 */
async function attachEpochsDelegated(delegators, currentEpoch) {
  const firstEpochByStake = new Map();
  for (let i = 0; i < delegators.length; i += STAKE_HISTORY_BATCH) {
    const batch = delegators.slice(i, i + STAKE_HISTORY_BATCH).map((d) => d.stake);
    const rows = await fetchKoios('account_stake_history', {
      method: 'POST',
      body: JSON.stringify({ _stake_addresses: batch }),
    });
    for (const row of Array.isArray(rows) ? rows : []) {
      const stake = typeof row?.stake_address === 'string' ? row.stake_address.trim() : '';
      const pool = String(row?.pool_id_bech32 ?? row?.pool_id ?? '').trim().toLowerCase();
      const epochNo = Number(row?.epoch_no ?? row?.epoch ?? NaN);
      if (!stake || !isPreebPool(pool) || !Number.isFinite(epochNo) || epochNo <= 0) continue;
      const existing = firstEpochByStake.get(stake);
      if (existing == null || epochNo < existing) firstEpochByStake.set(stake, epochNo);
    }
  }

  for (const delegator of delegators) {
    const firstEpoch = firstEpochByStake.get(delegator.stake);
    delegator.epochsDelegated = Number.isFinite(firstEpoch)
      ? Math.max(1, Math.floor(currentEpoch - firstEpoch + 1))
      : 0;
  }
}

async function computeLeaderboard() {
  const [delegators, currentEpoch] = await Promise.all([fetchPoolDelegators(), fetchCurrentEpoch()]);
  await attachEpochsDelegated(delegators, currentEpoch);

  const entries = delegators.map(({ stake, activeStake, epochsDelegated }) => {
    const role = getRoleForLovelace(activeStake);
    return {
      stake,
      activeStake,
      epochsDelegated,
      role: role ? role.name : null,
    };
  });

  const counts = {};
  for (const entry of entries) {
    if (entry.role) counts[entry.role] = (counts[entry.role] || 0) + 1;
  }

  return {
    epoch: currentEpoch,
    generatedAt: new Date(),
    totalStake: entries.reduce((total, entry) => total + BigInt(entry.activeStake), 0n).toString(),
    roleSummary: getRoleSummary(counts),
    delegators: entries,
  };
}

async function readCache(db) {
  if (!db) return null;
  try {
    return await db.collection(CACHE_COLLECTION).findOne({ _id: CACHE_KEY });
  } catch (err) {
    console.warn('[PREEB] Could not read leaderboard cache:', err.message);
    return null;
  }
}

// In-memory fallback so the leaderboard keeps serving when Mongo is blocked
// (permissions/outage). Warm instances reuse it; it is per-instance only.
function readMemoryCache() {
  const cached = globalThis.__preebLeaderboardMemCache;
  return cached && Date.now() - new Date(cached.generatedAt).getTime() < CACHE_TTL_MS
    ? cached
    : null;
}

function writeMemoryCache(data) {
  globalThis.__preebLeaderboardMemCache = data;
}

async function writeCache(db, data) {
  try {
    await db.collection(CACHE_COLLECTION).updateOne(
      { _id: CACHE_KEY },
      { $set: { ...data, generatedAt: data.generatedAt } },
      { upsert: true }
    );
  } catch (err) {
    console.warn('[PREEB] Could not write leaderboard cache (non-fatal):', err.message);
  }
}

/**
 * Handles are opt-in: a delegator's $handle shows on the leaderboard only
 * after they sign the guest wall. Joined at read time so new wall signers
 * appear without waiting for the hourly recompute.
 */
async function attachHandles(db, delegators) {
  if (!db || delegators.length === 0) return;
  try {
    const stakes = delegators.map((d) => d.stake);
    const wallDocs = await db.collection('guest_wall')
      .find({ stakeAddress: { $in: stakes }, handle: { $ne: null } }, { projection: { stakeAddress: 1, handle: 1 } })
      .toArray();
    const handleByStake = new Map(wallDocs.map((doc) => [doc.stakeAddress, doc.handle]));
    for (const entry of delegators) {
      const handle = handleByStake.get(entry.stake);
      if (handle) entry.handle = handle;
    }
  } catch (err) {
    console.warn('[PREEB] Could not join guest wall handles (non-fatal):', err.message);
  }
}

function toPublicShape(data) {
  return {
    epoch: data.epoch,
    generatedAt: data.generatedAt,
    totalStake: data.totalStake,
    roleSummary: data.roleSummary || [],
    delegators: (data.delegators || []).map((entry) => ({
      stake: entry.stake,
      handle: entry.handle || null,
      activeStake: entry.activeStake,
      epochsDelegated: entry.epochsDelegated || 0,
      role: entry.role || null,
    })),
  };
}

export default async function handler(req, res) {
  applyCors(req, res, 'GET,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rateLimit = checkRateLimit(`leaderboard:${getClientIp(req)}`, { limit: 60, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    rejectRateLimited(res, rateLimit.retryAfterSeconds);
    return;
  }

  let db = null;
  try {
    db = await getDb();
  } catch (err) {
    console.warn('[PREEB] Mongo unavailable for leaderboard:', err.message);
  }

  try {
    const memCached = readMemoryCache();
    const dbCached = db ? await readCache(db) : null;
    const cached = dbCached || memCached;
    const freshEnough = cached && Date.now() - new Date(cached.generatedAt).getTime() < CACHE_TTL_MS;

    let data = cached;
    if (!freshEnough) {
      // Recompute is expensive (paginated Koios calls) — a single global
      // in-flight lock per warm instance prevents concurrent cache-miss
      // stampedes from multiplying upstream requests.
      if (!globalThis.__preebLeaderboardRecomputing) {
        globalThis.__preebLeaderboardRecomputing = true;
        try {
          data = await computeLeaderboard();
          writeMemoryCache(data);
          if (db) await writeCache(db, data);
        } catch (err) {
          if (cached) {
            console.warn('[PREEB] Leaderboard recompute failed, serving stale cache:', err.message);
            data = cached;
          } else {
            throw err;
          }
        } finally {
          globalThis.__preebLeaderboardRecomputing = false;
        }
      } else if (cached) {
        // Another request is already recomputing — serve what we have.
        data = cached;
      } else {
        throw new Error('Leaderboard is warming up');
      }
    }

    if (!data) throw new Error('Leaderboard is not available yet');
    await attachHandles(db, data.delegators || []);

    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json(toPublicShape(data));
  } catch (err) {
    console.error('[PREEB] /api/leaderboard request failed:', err.message);
    res.status(502).json({ error: 'Unable to load the leaderboard right now. Please try again shortly.' });
  }
}
