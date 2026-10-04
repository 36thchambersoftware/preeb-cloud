import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../api/airdrop.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export default async function handler', 'async function handler');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/airdrop-78ea2550.json', import.meta.url), 'utf8'));
const TX_HASH = fixture.tx_info[0].tx_hash;

// Minimal in-memory collection that applies MongoDB's $setOnInsert/$set/$unset semantics.
function createCollection(initial = []) {
  const docs = initial.map((doc, index) => ({ _id: index + 1, ...doc }));
  const matches = (doc, filter) => {
    if (filter.$or) return filter.$or.some((sub) => matches(doc, sub));
    return Object.entries(filter).every(([key, expected]) => (
      expected && typeof expected === 'object' && '$exists' in expected
        ? (key in doc) === expected.$exists
        : doc[key] === expected
    ));
  };
  return {
    docs,
    find: (filter) => ({ limit: () => ({ toArray: async () => docs.filter((doc) => matches(doc, filter)) }) }),
    async updateOne(filter, update, { upsert } = {}) {
      let doc = docs.find((item) => matches(item, filter));
      if (!doc && upsert) {
        doc = { _id: docs.length + 1, ...filter, ...update.$setOnInsert };
        docs.push(doc);
      }
      Object.assign(doc, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete doc[key];
    },
    async deleteOne(filter) {
      const index = docs.findIndex((doc) => matches(doc, filter));
      if (index >= 0) docs.splice(index, 1);
    },
  };
}

function load(collection) {
  const fetch = async (url) => ({
    ok: true,
    json: async () => fixture[url.split('/').pop()],
  });
  const db = { collection: () => collection };
  return new Function('fetch', 'db', `${source}; return { promote: () => promotePendingAirdrops(db) };`)(fetch, db);
}

const expected = {
  status: 'submitted',
  recipientCount: 28,
  paidLovelace: '605999991',
  feeLovelace: '257241',
  mode: 'policy',
  policyId: '1d0cf168b30d27c6619e7ca7c18e02c8cebc011bf056216a1ea829ff',
  delegatedToPreeb: false,
};

test('promoting a pending airdrop stores its verified details', async () => {
  const collection = createCollection([{ txHash: TX_HASH, status: 'pending', expiresAt: new Date() }]);
  await load(collection).promote();
  const [doc] = collection.docs;
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((key) => [key, doc[key]])),
    expected
  );
  assert.ok(!('expiresAt' in doc));
});

test('submitted records missing details are repaired', async () => {
  const collection = createCollection([{ txHash: TX_HASH, status: 'submitted', submittedAt: new Date() }]);
  await load(collection).promote();
  assert.equal(collection.docs[0].paidLovelace, expected.paidLovelace);
  assert.equal(collection.docs[0].recipientCount, expected.recipientCount);
});

test('complete submitted records are not rechecked', async () => {
  const collection = createCollection([{ txHash: TX_HASH, status: 'submitted', paidLovelace: '1' }]);
  await load(collection).promote();
  assert.equal(collection.docs[0].paidLovelace, '1');
});
