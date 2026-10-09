import crypto from 'node:crypto';
import { getDb, resetMongoConnection } from './_lib/mongo.js';
import { verifyCip8Signature } from './_lib/cip8.js';
import {
  ensureIdentityIndexes,
  findIdentityByStake,
  linkVerifiedWallet,
  listWallets,
} from './_lib/identity.js';
import { applyCors, checkRateLimit, getClientIp, rejectRateLimited } from './_lib/security.js';
import { addWalletToSession, readDiscordSession, readWalletSession } from './_lib/discord-auth.js';

const NONCE_TTL_SECONDS = 300;
const NONCES_COLLECTION = 'identity_link_nonces';

function buildChallengeMessage(stake, nonce) {
  return `PREEB Profile Link\nstake:${stake}\nnonce:${nonce}`;
}

async function createNonceChallenge(db, stake) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + NONCE_TTL_SECONDS * 1000);
  await db.collection(NONCES_COLLECTION).insertOne({ nonce, primaryStake: stake, expiresAt, used: false });
  return {
    nonce,
    message: buildChallengeMessage(stake, nonce),
    expiresIn: NONCE_TTL_SECONDS,
  };
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
  await ensureIdentityIndexes(db);
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

        try {
          res.status(200).json(await createNonceChallenge(db, stake));
          return;
        } catch (firstError) {
          console.warn('[PREEB] Retrying profile nonce after Mongo write failure:', firstError.message);
          try {
            await resetMongoConnection();
            const retryDb = await getDb();
            res.status(200).json(await createNonceChallenge(retryDb, stake));
            return;
          } catch (retryError) {
            console.error('[PREEB] /api/profile nonce challenge failed after retry:', retryError);
            res.status(503).json({ error: 'Profile verification is temporarily unavailable. Please try again in a moment.' });
            return;
          }
        }
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
        res.status(200).json({
          primaryStake: stake,
          wallets: [stake],
          discordId: null,
          discordLinked: false,
        });
        return;
      }

      res.status(200).json({
        primaryStake: stake,
        wallets: Object.keys(doc.wallets?.cardano || {}),
        discordId: doc.discordId || null,
        discordLinked: Boolean(doc.discordId),
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

      const discordId = readDiscordSession(req)?.user?.id || null;

      // Adding a wallet to a profile requires having already proven ownership
      // of that profile; otherwise anyone could attach wallets to a stranger's.
      if (purpose === 'link' && !readWalletSession(req).includes(primaryStake)) {
        res.status(403).json({ error: 'Verify ownership of this profile before linking another wallet.' });
        return;
      }

      let updated;
      try {
        if (purpose === 'verify') {
          updated = await linkVerifiedWallet(db, { stake: primaryStake, paymentAddress, discordId });
        } else {
          // Linking a second wallet: the freshly signed wallet joins whatever
          // identity already owns the profile being viewed.
          await linkVerifiedWallet(db, { stake: primaryStake, discordId });
          updated = await linkVerifiedWallet(db, {
            stake: verified.stakeAddress,
            paymentAddress,
            discordId,
            anchorStake: primaryStake,
          });
        }
      } catch (linkError) {
        res.status(400).json({ error: linkError.message });
        return;
      }

      addWalletToSession(req, res, verified.stakeAddress);
      if (purpose === 'link') addWalletToSession(req, res, primaryStake);

      res.status(200).json({
        primaryStake,
        wallets: listWallets(updated),
        linkedWallet: verified.stakeAddress,
        verified: purpose === 'verify',
        discordLinked: Boolean(updated?.discordId),
      });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[PREEB] /api/profile request failed:', err);
    res.status(500).json({ error: `Request failed: ${err.message}` });
  }
}
