import crypto from 'node:crypto';
import { getDb } from './_lib/mongo.js';
import { verifyCip8Signature } from './_lib/cip8.js';
import { getRoleForLovelace } from './_lib/roles.js';
import { applyCors, checkRateLimit, getClientIp, rejectRateLimited } from './_lib/security.js';

const POOL_ID_BECH32 = 'pool19peeq2czwunkwe3s70yuvwpsrqcyndlqnxvt67usz98px57z7fk';
const POOL_ID_HEX = '2873902b027727676630f3c9c63830183049b7e09998bd7b90114e13';
const KOIOS_BASE = 'https://api.koios.rest/api/v1';
const WALL_COLLECTION = 'guest_wall';
const NONCES_COLLECTION = 'guest_wall_nonces';
const NONCE_TTL_SECONDS = 300;
const MAX_MESSAGE_LENGTH = 280;
const MAX_PUBLIC_ENTRIES = 200;
const HANDLE_POLICY_ID = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const STAKE_ADDRESS_RE = /^stake1[0-9a-z]{20,80}$/;
const PAYMENT_ADDRESS_RE = /^addr1[0-9a-z]{20,120}$/;

function buildChallengeMessage(stake, nonce, message) {
  return `PREEB Guest Wall\nstake:${stake}\nnonce:${nonce}\nmessage:${message}`;
}

function sanitizeMessage(value) {
  return String(value || '')
    // Strip control chars (keep \n for line breaks), cap length server-side.
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function shortenAddress(value, head = 12, tail = 6) {
  const text = String(value || '').trim();
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

async function ensureIndexes(db) {
  if (globalThis.__preebWallIndexesReady) return;
  // Index creation is best-effort — the Mongo user may lack createIndex.
  try {
    await db.collection(WALL_COLLECTION).createIndex({ stakeAddress: 1 }, { unique: true });
    await db.collection(WALL_COLLECTION).createIndex({ updatedAt: -1 });
    await db.collection(NONCES_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  } catch (err) {
    console.warn('[PREEB] Could not ensure guest wall indexes (non-fatal):', err.message);
  }
  globalThis.__preebWallIndexesReady = true;
}

async function fetchKoios(path, options = {}) {
  const response = await fetch(`${KOIOS_BASE}/${path}`, {
    ...options,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error(`Koios ${path} responded with HTTP ${response.status}`);
  return response.json();
}

function decodeHandleName(assetNameHex) {
  let hex = String(assetNameHex || '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return null;
  // Strip CIP-68 / handle labels — we only display plain owner handles.
  if (hex.startsWith('000643b0')) return null; // reference token, not the handle NFT
  if (hex.startsWith('000de140')) hex = hex.slice(8);
  if (hex.startsWith('0014df10')) hex = hex.slice(8);
  try {
    const decoded = Buffer.from(hex, 'hex').toString('utf8').trim();
    // Printable ASCII excluding backslash/angle brackets so a handle can't
    // inject markup when rendered or look like a URL fragment.
    if (!decoded || decoded.length > 32 || !/^[a-z0-9_.-]+$/i.test(decoded)) return null;
    return `$${decoded}`;
  } catch {
    return null;
  }
}

async function resolveHandle(stakeAddress) {
  try {
    const rows = await fetchKoios('account_assets', {
      method: 'POST',
      body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
    });
    for (const row of Array.isArray(rows) ? rows : []) {
      if (String(row?.policy_id || '').toLowerCase() !== HANDLE_POLICY_ID) continue;
      const handle = decodeHandleName(row?.asset_name);
      if (handle) return handle;
    }
  } catch (err) {
    console.warn('[PREEB] Could not resolve ADA Handle (non-fatal):', err.message);
  }
  return null;
}

async function resolveDelegation(stakeAddress) {
  try {
    const rows = await fetchKoios('account_info', {
      method: 'POST',
      body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
    });
    const account = Array.isArray(rows) ? rows[0] : null;
    if (!account) return { isDelegator: false, role: null };
    const pool = String(account.delegated_pool || '').trim().toLowerCase();
    const isDelegator = pool === POOL_ID_BECH32 || pool === POOL_ID_HEX;
    const balance = parseLovelace(
      account.total_balance ?? account.controlled_amount ?? account.balance ?? account.utxo ?? 0
    );
    const role = isDelegator ? getRoleForLovelace(balance) : null;
    return { isDelegator, role: role ? role.name : null, stakeLovelace: balance.toString() };
  } catch (err) {
    console.warn('[PREEB] Could not resolve delegation status (non-fatal):', err.message);
    return { isDelegator: false, role: null };
  }
}

function parseLovelace(value) {
  const trimmed = String(value ?? '0').trim();
  return /^\d+$/.test(trimmed) ? BigInt(trimmed) : 0n;
}

function toPublicEntry(doc) {
  return {
    handle: doc.handle || null,
    stakeDisplay: shortenAddress(doc.stakeAddress),
    message: doc.message,
    signedAt: doc.signedAt,
    updatedAt: doc.updatedAt,
    isDelegator: Boolean(doc.isDelegator),
    role: doc.role || null,
  };
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

  const clientIp = getClientIp(req);

  let db = null;
  try {
    db = await getDb();
    await ensureIndexes(db);
  } catch (err) {
    console.warn('[PREEB] Mongo unavailable for guest wall:', err.message);
  }

  try {
    if (req.method === 'GET' && req.query.nonce !== '1') {
      const rateLimit = checkRateLimit(`wall:get:${clientIp}`, { limit: 60, windowMs: 60_000 });
      if (!rateLimit.allowed) {
        rejectRateLimited(res, rateLimit.retryAfterSeconds);
        return;
      }
      if (!db) {
        // Mongo unreachable — show an empty wall rather than an error.
        res.status(200).json({ entries: [] });
        return;
      }
      let docs = [];
      try {
        docs = await db.collection(WALL_COLLECTION)
          .find({}, {
            projection: {
              stakeAddress: 1, handle: 1, message: 1, signedAt: 1, updatedAt: 1, isDelegator: 1, role: 1,
            },
          })
          .sort({ updatedAt: -1 })
          .limit(MAX_PUBLIC_ENTRIES)
          .toArray();
      } catch (err) {
        // DB read blocked (permissions/outage) — degrade to an empty wall.
        console.warn('[PREEB] Guest wall read unavailable, returning empty list:', err.message);
        docs = [];
      }
      res.status(200).json({ entries: docs.map(toPublicEntry) });
      return;
    }

    if (req.method === 'GET') {
      // Signing challenge issuance. The message is bound into both the nonce
      // record and the signed payload so it cannot be swapped after signing.
      const rateLimit = checkRateLimit(`wall:nonce:${clientIp}`, { limit: 12, windowMs: 60_000 });
      if (!rateLimit.allowed) {
        rejectRateLimited(res, rateLimit.retryAfterSeconds);
        return;
      }
      if (!db) {
        res.status(503).json({ error: 'The guest wall is temporarily unavailable. Please try again shortly.' });
        return;
      }

      const stake = String(req.query.stake || '').trim();
      const message = sanitizeMessage(req.query.message);
      if (!STAKE_ADDRESS_RE.test(stake)) {
        res.status(400).json({ error: 'Invalid stake address' });
        return;
      }
      if (!message) {
        res.status(400).json({ error: 'Message is required (max 280 characters)' });
        return;
      }

      const nonce = crypto.randomBytes(16).toString('hex');
      const expiresAt = new Date(Date.now() + NONCE_TTL_SECONDS * 1000);
      try {
        await db.collection(NONCES_COLLECTION).insertOne({ nonce, stake, message, expiresAt, used: false });
      } catch (err) {
        console.error('[PREEB] Could not store signing nonce:', err.message);
        res.status(503).json({ error: 'The guest wall is temporarily unavailable. Please try again shortly.' });
        return;
      }
      res.status(200).json({
        nonce,
        message: buildChallengeMessage(stake, nonce, message),
        expiresIn: NONCE_TTL_SECONDS,
      });
      return;
    }

    // POST — submit a signed wall entry.
    const rateLimit = checkRateLimit(`wall:post:${clientIp}`, { limit: 10, windowMs: 60_000 });
    if (!rateLimit.allowed) {
      rejectRateLimited(res, rateLimit.retryAfterSeconds);
      return;
    }
    if (!db) {
      res.status(503).json({ error: 'The guest wall is temporarily unavailable. Please try again shortly.' });
      return;
    }

    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    body = body || {};

    const stake = String(body.stake || '').trim();
    const nonce = String(body.nonce || '').trim();
    const message = sanitizeMessage(body.message);
    const signatureHex = String(body.signatureHex || '').trim();
    const keyHex = String(body.keyHex || '').trim();
    const paymentAddressRaw = body.paymentAddress ? String(body.paymentAddress).trim() : null;

    if (!STAKE_ADDRESS_RE.test(stake) || !nonce || !message || !signatureHex || !keyHex) {
      res.status(400).json({ error: 'Missing or invalid required fields' });
      return;
    }
    // Never persist a malformed payment address into the operator-facing store.
    const paymentAddress = paymentAddressRaw && PAYMENT_ADDRESS_RE.test(paymentAddressRaw)
      ? paymentAddressRaw
      : null;

    // Per-stake limiter so one wallet can't spam re-signs to hammer Koios.
    const stakeLimit = checkRateLimit(`wall:sign:${stake}`, { limit: 6, windowMs: 3_600_000 });
    if (!stakeLimit.allowed) {
      rejectRateLimited(res, stakeLimit.retryAfterSeconds);
      return;
    }

    const nonceDoc = await db.collection(NONCES_COLLECTION).findOne({ nonce, stake, used: false });
    if (!nonceDoc || nonceDoc.expiresAt < new Date() || nonceDoc.message !== message) {
      res.status(400).json({ error: 'Signing request expired or invalid. Please start over.' });
      return;
    }

    let verified;
    try {
      verified = verifyCip8Signature({
        signatureHex,
        keyHex,
        expectedPayload: buildChallengeMessage(stake, nonce, message),
      });
    } catch (err) {
      res.status(400).json({ error: 'Signature verification failed. Please try again.' });
      return;
    }
    if (verified.stakeAddress !== stake) {
      res.status(400).json({ error: 'Signature does not belong to the claimed stake address.' });
      return;
    }

    await db.collection(NONCES_COLLECTION).updateOne({ _id: nonceDoc._id }, { $set: { used: true } });

    // Best-effort enrichment — a Koios hiccup should never block a valid signature.
    const [handle, delegation] = await Promise.all([resolveHandle(stake), resolveDelegation(stake)]);

    const now = new Date();
    const update = {
      $set: {
        message,
        handle,
        isDelegator: delegation.isDelegator,
        role: delegation.role || null,
        stakeLovelace: delegation.stakeLovelace || '0',
        updatedAt: now,
      },
      $setOnInsert: { stakeAddress: stake, signedAt: now },
    };
    if (paymentAddress) {
      // Stored for the pool operator (reply-outs); never exposed by the public GET.
      update.$set.paymentAddress = paymentAddress;
    }

    await db.collection(WALL_COLLECTION).updateOne({ stakeAddress: stake }, update, { upsert: true });
    const saved = await db.collection(WALL_COLLECTION).findOne({ stakeAddress: stake });

    res.status(201).json({ signed: true, entry: toPublicEntry(saved) });
  } catch (err) {
    console.error('[PREEB] /api/wall request failed:', err.message);
    res.status(500).json({ error: 'Unable to sign the guest wall right now. Please try again shortly.' });
  }
}
