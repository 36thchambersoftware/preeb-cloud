import crypto from 'node:crypto';
import { getDb } from './_lib/mongo.js';
import { verifyCip8Signature } from './_lib/cip8.js';
import { applyCors, checkRateLimit, getClientIp, rejectRateLimited } from './_lib/security.js';

const NONCE_TTL_SECONDS = 300;
const IDENTITIES_COLLECTION = 'identities';
const NONCES_COLLECTION = 'identity_link_nonces';

function buildChallengeMessage(stake, nonce) {
  return `PREEB Profile Link\nstake:${stake}\nnonce:${nonce}`;
}

async function ensureIndexes(db) {
  if (globalThis.__preebProfileIndexesReady) return;
  // Index creation is an optimization, not a hard requirement — the Mongo
  // user may not have createIndex permission on this database. Don't let a
  // missing index take down the whole request.
  try {
    await db.collection(NONCES_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  } catch (err) {
    console.warn('[PREEB] Could not ensure Mongo indexes (non-fatal):', err.message);
  }
  globalThis.__preebProfileIndexesReady = true;
}

// Documents in `identities` are designed to eventually be shared with the
// preebot Discord bot's own user records (currently a separate `user`
// collection keyed by Discord snowflake id, with a `wallets: { stake:
// paymentAddress }` map). `wallets` here is grouped by chain (only `cardano`
// today) so other chains can be added later without a schema rewrite, and
// there is no "primary" wallet — every linked wallet is an equal entry point
// into the same identity. preeb.cloud never writes to the bot's existing
// collection.
function findIdentityByStake(db, stake) {
  return db.collection(IDENTITIES_COLLECTION).findOne({ [`wallets.cardano.${stake}`]: { $exists: true } });
}

async function getOrCreateIdentity(db, stake, paymentAddress) {
  const existing = await findIdentityByStake(db, stake);
  if (existing) return existing;

  const now = new Date();
  const insertResult = await db.collection(IDENTITIES_COLLECTION).insertOne({
    discordId: null,
    telegramId: null,
    xHandle: null,
    wallets: { cardano: { [stake]: paymentAddress || null } },
    createdAt: now,
    updatedAt: now,
  });

  return {
    _id: insertResult.insertedId,
    discordId: null,
    telegramId: null,
    xHandle: null,
    wallets: { cardano: { [stake]: paymentAddress || null } },
  };
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const clientIp = getClientIp(req);

  const baseRateLimit = checkRateLimit(`profile:${clientIp}`, { limit: 60, windowMs: 60_000 });
  if (!baseRateLimit.allowed) {
    rejectRateLimited(res, baseRateLimit.retryAfterSeconds);
    return;
  }

  let db = null;
  try {
    db = await getDb();
    await ensureIndexes(db);
  } catch (err) {
    console.warn('[PREEB] Mongo connection unavailable:', err.message);
    // db stays null; individual handlers below decide what's safe to degrade.
  }

  try {
    if (req.method === 'GET') {
      const stake = String(req.query.stake || '').trim();
      if (!stake) {
        res.status(400).json({ error: 'Missing stake address' });
        return;
      }

      if (req.query.nonce === '1') {
        const rateLimit = checkRateLimit(`profile-nonce:${clientIp}`, { limit: 12, windowMs: 60_000 });
        if (!rateLimit.allowed) {
          rejectRateLimited(res, rateLimit.retryAfterSeconds);
          return;
        }

        if (!db) {
          res.status(503).json({ error: 'Database unavailable, please try again shortly.' });
          return;
        }
        const nonce = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + NONCE_TTL_SECONDS * 1000);
        await db.collection(NONCES_COLLECTION).insertOne({ nonce, primaryStake: stake, expiresAt, used: false });
        res.status(200).json({
          nonce,
          message: buildChallengeMessage(stake, nonce),
          expiresIn: NONCE_TTL_SECONDS,
        });
        return;
      }

      // Reading linked wallets is best-effort — a DB hiccup shouldn't block
      // viewing a profile in single-wallet mode.
      let doc = null;
      if (db) {
        try {
          doc = await findIdentityByStake(db, stake);
        } catch (err) {
          console.warn('[PREEB] Could not read identity document:', err.message);
        }
      }

      if (!doc) {
        res.status(200).json({ primaryStake: stake, wallets: [stake], discordId: null });
        return;
      }

      res.status(200).json({
        primaryStake: stake,
        wallets: Object.keys(doc.wallets?.cardano || {}),
        discordId: doc.discordId || null,
      });
      return;
    }

    if (req.method === 'POST') {
      const rateLimit = checkRateLimit(`profile-post:${clientIp}`, { limit: 20, windowMs: 60_000 });
      if (!rateLimit.allowed) {
        rejectRateLimited(res, rateLimit.retryAfterSeconds);
        return;
      }

      if (!db) {
        res.status(503).json({ error: 'Database unavailable, please try again shortly.' });
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

      const primaryStake = String(body.primaryStake || '').trim();
      const nonce = String(body.nonce || '').trim();
      const signatureHex = String(body.signatureHex || '').trim();
      const keyHex = String(body.keyHex || '').trim();
      const paymentAddress = body.paymentAddress ? String(body.paymentAddress).trim() : null;
      const purpose = body.purpose === 'verify' ? 'verify' : 'link';

      if (!primaryStake || !nonce || !signatureHex || !keyHex) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }

      const nonceDoc = await db.collection(NONCES_COLLECTION).findOne({ nonce, primaryStake, used: false });
      if (!nonceDoc || nonceDoc.expiresAt < new Date()) {
        res.status(400).json({ error: 'Signing request expired or invalid. Please try again.' });
        return;
      }

      let verified;
      try {
        verified = verifyCip8Signature({
          signatureHex,
          keyHex,
          expectedPayload: buildChallengeMessage(primaryStake, nonce),
        });
      } catch (err) {
        res.status(400).json({ error: `Signature verification failed: ${err.message}` });
        return;
      }

      if (purpose === 'verify' && verified.stakeAddress !== primaryStake) {
        res.status(400).json({ error: 'This wallet does not match the profile you are trying to verify.' });
        return;
      }

      await db.collection(NONCES_COLLECTION).updateOne({ _id: nonceDoc._id }, { $set: { used: true } });

      const identity = await getOrCreateIdentity(db, primaryStake, purpose === 'verify' ? paymentAddress : null);

      if (purpose === 'link') {
        const conflict = await findIdentityByStake(db, verified.stakeAddress);
        if (conflict && String(conflict._id) !== String(identity._id)) {
          res.status(400).json({ error: 'This wallet is already linked to a different profile.' });
          return;
        }

        await db.collection(IDENTITIES_COLLECTION).updateOne(
          { _id: identity._id },
          {
            $set: {
              [`wallets.cardano.${verified.stakeAddress}`]: paymentAddress || null,
              updatedAt: new Date(),
            },
          }
        );
      } else {
        await db.collection(IDENTITIES_COLLECTION).updateOne(
          { _id: identity._id },
          { $set: { updatedAt: new Date() } }
        );
      }

      const updated = await db.collection(IDENTITIES_COLLECTION).findOne({ _id: identity._id });
      res.status(200).json({
        primaryStake,
        wallets: Object.keys(updated?.wallets?.cardano || {}),
        linkedWallet: verified.stakeAddress,
        verified: purpose === 'verify',
      });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[PREEB] /api/profile request failed:', err);
    res.status(500).json({ error: `Request failed: ${err.message}` });
  }
}

