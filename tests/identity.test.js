import assert from 'node:assert/strict';
import test from 'node:test';
import { linkVerifiedWallet, listWallets, saveDiscordLogin } from '../api/_lib/identity.js';

function getPath(document, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), document);
}

function setPath(document, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let cursor = document;
  for (const key of keys) {
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[last] = value;
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = getPath(document, key);
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      return (actual !== undefined) === expected.$exists;
    }
    return String(actual) === String(expected);
  });
}

function createDb(initialDocuments = []) {
  let documents = initialDocuments.map((document) => structuredClone(document));
  let nextId = documents.length + 1;

  const collection = {
    async findOne(filter) {
      return structuredClone(documents.find((document) => matches(document, filter)) || null);
    },
    async insertOne(document) {
      const stored = { _id: `identity-${nextId++}`, ...structuredClone(document) };
      documents.push(stored);
      return { insertedId: stored._id };
    },
    async deleteOne(filter) {
      documents = documents.filter((document) => !matches(document, filter));
    },
    async updateOne(filter, update, options = {}) {
      let document = documents.find((item) => matches(item, filter));
      if (!document) {
        if (!options.upsert) return { matchedCount: 0 };
        document = { _id: `identity-${nextId++}`, ...structuredClone(update.$setOnInsert || {}) };
        documents.push(document);
      }
      for (const [path, value] of Object.entries(update.$set || {})) {
        setPath(document, path, structuredClone(value));
      }
      return { matchedCount: 1 };
    },
  };

  return { documents: () => documents, collection: () => collection };
}

const discordUser = {
  id: '123456789',
  username: 'flowmass',
  globalName: 'Flowmass',
  avatar: 'avatar-hash',
};

test('Discord login is saved without any wallet connected', async () => {
  const db = createDb();
  const now = new Date('2026-10-08T12:00:00Z');

  const identity = await saveDiscordLogin(db, discordUser, now);

  assert.equal(identity.discordId, discordUser.id);
  assert.equal(identity.discord.username, 'flowmass');
  assert.deepEqual(identity.discord.linkedAt, now);
  assert.deepEqual(listWallets(identity), []);
});

test('logging in again refreshes the profile without creating a second identity', async () => {
  const db = createDb();
  const linkedAt = new Date('2026-10-08T12:00:00Z');
  const later = new Date('2026-10-09T12:00:00Z');

  await saveDiscordLogin(db, discordUser, linkedAt);
  const identity = await saveDiscordLogin(db, { ...discordUser, username: 'renamed' }, later);

  assert.equal(db.documents().length, 1);
  assert.equal(identity.discord.username, 'renamed');
  assert.deepEqual(identity.discord.linkedAt, linkedAt);
  assert.deepEqual(identity.discord.lastLoginAt, later);
});

test('a verified wallet is attached to the logged-in Discord identity', async () => {
  const db = createDb();
  await saveDiscordLogin(db, discordUser);

  const identity = await linkVerifiedWallet(db, {
    stake: 'stake1',
    paymentAddress: 'addr1',
    discordId: discordUser.id,
  });

  assert.equal(identity.discordId, discordUser.id);
  assert.deepEqual(listWallets(identity), ['stake1']);
});

test('an existing wallet-only identity is merged into the Discord identity', async () => {
  const db = createDb([
    { _id: 'wallet-only', discordId: null, wallets: { cardano: { stake1: 'addr1', stake2: null } } },
  ]);
  await saveDiscordLogin(db, discordUser);

  const identity = await linkVerifiedWallet(db, {
    stake: 'stake1',
    paymentAddress: 'addr1',
    discordId: discordUser.id,
  });

  assert.equal(identity.discordId, discordUser.id);
  assert.deepEqual(listWallets(identity).sort(), ['stake1', 'stake2']);
  assert.equal(db.documents().some((document) => document._id === 'wallet-only'), false);
});

test('a wallet owned by another Discord account is rejected', async () => {
  const db = createDb([
    { _id: 'other', discordId: 'another-discord-user', wallets: { cardano: { stake1: 'addr1' } } },
  ]);
  await saveDiscordLogin(db, discordUser);

  await assert.rejects(
    linkVerifiedWallet(db, { stake: 'stake1', discordId: discordUser.id }),
    /already linked to a different Discord account/
  );
});

test('a wallet can be linked with no Discord session at all', async () => {
  const db = createDb();

  const identity = await linkVerifiedWallet(db, { stake: 'stake1', paymentAddress: 'addr1' });

  assert.equal(identity.discordId, null);
  assert.deepEqual(listWallets(identity), ['stake1']);
});

test('a second wallet joins the identity that owns the anchor wallet', async () => {
  const db = createDb();
  await linkVerifiedWallet(db, { stake: 'stake1', paymentAddress: 'addr1' });

  const identity = await linkVerifiedWallet(db, {
    stake: 'stake2',
    paymentAddress: 'addr2',
    anchorStake: 'stake1',
  });

  assert.equal(db.documents().length, 1);
  assert.deepEqual(listWallets(identity).sort(), ['stake1', 'stake2']);
});

test('a second wallet already owned by another profile is rejected', async () => {
  const db = createDb([
    { _id: 'a', discordId: null, wallets: { cardano: { stake1: 'addr1' } } },
    { _id: 'b', discordId: null, wallets: { cardano: { stake2: 'addr2' } } },
  ]);

  await assert.rejects(
    linkVerifiedWallet(db, { stake: 'stake2', anchorStake: 'stake1' }),
    /already linked to a different profile/
  );
});

test('Discord login attaches to the wallet identity already verified in this browser', async () => {
  const db = createDb([
    { _id: 'wallet-doc', discordId: null, telegramId: null, xHandle: null, wallets: { cardano: { stake1: 'addr1', stake2: 'addr2' } } },
  ]);

  const identity = await saveDiscordLogin(db, discordUser, new Date(), ['stake1']);

  assert.equal(db.documents().length, 1);
  assert.equal(identity._id, 'wallet-doc');
  assert.equal(identity.discordId, discordUser.id);
  assert.deepEqual(listWallets(identity).sort(), ['stake1', 'stake2']);
});

test('a stray Discord-only identity is merged into the wallet identity on next login', async () => {
  const db = createDb([
    { _id: 'wallet-doc', discordId: null, telegramId: null, xHandle: null, wallets: { cardano: { stake1: 'addr1' } } },
    { _id: 'stray', discordId: discordUser.id, telegramId: null, xHandle: null, wallets: { cardano: {} } },
  ]);

  const identity = await saveDiscordLogin(db, discordUser, new Date(), ['stake1']);

  assert.equal(db.documents().length, 1);
  assert.equal(identity.discordId, discordUser.id);
  assert.deepEqual(listWallets(identity), ['stake1']);
});

test('Discord login never takes over a wallet identity tied to another Discord account', async () => {
  const db = createDb([
    { _id: 'other', discordId: 'someone-else', wallets: { cardano: { stake1: 'addr1' } } },
  ]);

  const identity = await saveDiscordLogin(db, discordUser, new Date(), ['stake1']);

  assert.equal(db.documents().length, 2);
  assert.equal(db.documents().find((d) => d._id === 'other').discordId, 'someone-else');
  assert.deepEqual(listWallets(identity), []);
});
