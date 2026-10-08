import assert from 'node:assert/strict';
import test from 'node:test';
import { getDb, resetMongoConnection } from '../api/_lib/mongo.js';

test('a rejected cached Mongo connection is cleared for the next request', async () => {
  const connectionError = new Error('temporary connection failure');
  globalThis.__preebMongoClientPromise = Promise.reject(connectionError);

  await assert.rejects(getDb(), connectionError);
  assert.equal(globalThis.__preebMongoClientPromise, null);
});

test('resetMongoConnection closes and removes the cached client', async () => {
  let closed = false;
  globalThis.__preebMongoClientPromise = Promise.resolve({
    close: async () => {
      closed = true;
    },
  });

  await resetMongoConnection();

  assert.equal(closed, true);
  assert.equal(globalThis.__preebMongoClientPromise, null);
});
