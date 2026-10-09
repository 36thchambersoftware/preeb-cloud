/**
 * Identity storage shared by the Discord auth routes and /api/profile.
 *
 * An identity is a person. It can exist with only a Discord account, with
 * only wallets, or with both:
 *
 *   - Logging in with Discord stores `discordId` immediately. No wallet is
 *     required, and no signature is involved, because Discord's OAuth code
 *     exchange already proves who the Discord user is.
 *   - Linking a wallet still requires a CIP-8 signature, because that is the
 *     only thing that proves the wallet belongs to the person doing it.
 *
 * `wallets` is grouped by chain (only `cardano` today) so other chains can be
 * added later, and there is no "primary" wallet — every linked wallet is an
 * equal entry point into the same identity.
 */

export const IDENTITIES_COLLECTION = 'identities';

export function findIdentityByStake(db, stake) {
  return db.collection(IDENTITIES_COLLECTION).findOne({
    [`wallets.cardano.${stake}`]: { $exists: true },
  });
}

export function findIdentityByDiscordId(db, discordId) {
  return db.collection(IDENTITIES_COLLECTION).findOne({ discordId });
}

export function listWallets(identity) {
  return Object.keys(identity?.wallets?.cardano || {});
}

function discordProfile(discordUser, linkedAt, now) {
  return {
    id: discordUser.id,
    username: discordUser.username || '',
    globalName: discordUser.globalName || null,
    avatar: discordUser.avatar || null,
    linkedAt,
    lastLoginAt: now,
  };
}

/**
 * Record a successful Discord login. Called right after OAuth succeeds, so the
 * Discord id is persisted whether or not any wallet is connected.
 *
 * `verifiedStakes` are wallets this browser has already proven it owns (from
 * the signed wallet-session cookie). If one of them already has an identity,
 * the Discord account is attached to THAT identity instead of creating a
 * second document. Only when no verified wallet identity exists is a new
 * Discord-only identity created.
 */
export async function saveDiscordLogin(db, discordUser, now = new Date(), verifiedStakes = []) {
  const discordIdentity = await findIdentityByDiscordId(db, discordUser.id);

  const walletIdentities = [];
  for (const stake of verifiedStakes) {
    const identity = await findIdentityByStake(db, stake);
    if (!identity || walletIdentities.some((item) => String(item._id) === String(identity._id))) continue;
    // An identity already tied to some other Discord account is never touched.
    if (identity.discordId && identity.discordId !== discordUser.id) continue;
    walletIdentities.push(identity);
  }

  let target = discordIdentity;

  if (!target && walletIdentities.length > 0) {
    target = walletIdentities.shift();
    await db.collection(IDENTITIES_COLLECTION).updateOne(
      { _id: target._id },
      {
        $set: {
          discordId: discordUser.id,
          discord: discordProfile(discordUser, now, now),
          updatedAt: now,
        },
      }
    );
  } else if (target) {
    await db.collection(IDENTITIES_COLLECTION).updateOne(
      { _id: target._id },
      {
        $set: {
          discord: discordProfile(discordUser, target.discord?.linkedAt || now, now),
          updatedAt: now,
        },
      }
    );
  } else {
    await db.collection(IDENTITIES_COLLECTION).updateOne(
      { discordId: discordUser.id },
      {
        $set: {
          discord: discordProfile(discordUser, now, now),
          updatedAt: now,
        },
        $setOnInsert: {
          discordId: discordUser.id,
          telegramId: null,
          xHandle: null,
          wallets: { cardano: {} },
          createdAt: now,
        },
      },
      { upsert: true }
    );
  }

  let result = await findIdentityByDiscordId(db, discordUser.id);
  for (const other of walletIdentities) {
    if (String(other._id) === String(result._id)) continue;
    await absorbIdentity(db, result, other, now);
  }
  if (walletIdentities.length > 0) result = await findIdentityByDiscordId(db, discordUser.id);
  return result;
}

/**
 * Move every wallet from `source` onto `target`, then remove the now-empty
 * source identity. Used when someone proves a wallet that already had its own
 * wallet-only identity while they are logged in with Discord.
 */
async function absorbIdentity(db, target, source, now) {
  const merged = { ...(target.wallets?.cardano || {}) };
  for (const [stake, paymentAddress] of Object.entries(source.wallets?.cardano || {})) {
    merged[stake] = paymentAddress ?? merged[stake] ?? null;
  }

  await db.collection(IDENTITIES_COLLECTION).updateOne(
    { _id: target._id },
    {
      $set: {
        'wallets.cardano': merged,
        telegramId: target.telegramId ?? source.telegramId ?? null,
        xHandle: target.xHandle ?? source.xHandle ?? null,
        updatedAt: now,
      },
    }
  );
  await db.collection(IDENTITIES_COLLECTION).deleteOne({ _id: source._id });
}

/**
 * Attach a wallet whose ownership has already been proven by signature.
 *
 * `discordId` is the logged-in Discord account, if any. When present the
 * wallet is stored on that Discord identity so wallets and Discord end up on
 * one document. `anchorStake` is an already-linked wallet of the identity the
 * new wallet should join, used when adding a second wallet to a profile.
 */
export async function linkVerifiedWallet(
  db,
  { stake, paymentAddress = null, discordId = null, anchorStake = null },
  now = new Date()
) {
  const walletIdentity = await findIdentityByStake(db, stake);
  const discordIdentity = discordId ? await findIdentityByDiscordId(db, discordId) : null;
  const anchorIdentity =
    anchorStake && anchorStake !== stake ? await findIdentityByStake(db, anchorStake) : null;

  if (walletIdentity?.discordId && discordId && walletIdentity.discordId !== discordId) {
    throw new Error('This wallet is already linked to a different Discord account.');
  }

  const target = discordIdentity || anchorIdentity || walletIdentity;

  if (walletIdentity && target && String(walletIdentity._id) !== String(target._id)) {
    if (walletIdentity.discordId && walletIdentity.discordId !== target.discordId) {
      throw new Error('This wallet is already linked to a different profile.');
    }
    if (!discordIdentity && anchorIdentity) {
      throw new Error('This wallet is already linked to a different profile.');
    }
  }

  if (!target) {
    const insert = await db.collection(IDENTITIES_COLLECTION).insertOne({
      discordId: null,
      telegramId: null,
      xHandle: null,
      wallets: { cardano: { [stake]: paymentAddress } },
      createdAt: now,
      updatedAt: now,
    });
    return db.collection(IDENTITIES_COLLECTION).findOne({ _id: insert.insertedId });
  }

  if (walletIdentity && String(walletIdentity._id) !== String(target._id)) {
    await absorbIdentity(db, target, walletIdentity, now);
  }

  await db.collection(IDENTITIES_COLLECTION).updateOne(
    { _id: target._id },
    {
      $set: {
        [`wallets.cardano.${stake}`]: paymentAddress ?? target.wallets?.cardano?.[stake] ?? null,
        updatedAt: now,
      },
    }
  );

  return db.collection(IDENTITIES_COLLECTION).findOne({ _id: target._id });
}

export async function ensureIdentityIndexes(db) {
  if (globalThis.__preebIdentityIndexesReady) return;
  try {
    await db.collection(IDENTITIES_COLLECTION).createIndex(
      { discordId: 1 },
      { unique: true, partialFilterExpression: { discordId: { $type: 'string' } } }
    );
  } catch (err) {
    console.warn('[PREEB] Could not ensure identity indexes (non-fatal):', err.message);
  }
  globalThis.__preebIdentityIndexesReady = true;
}
