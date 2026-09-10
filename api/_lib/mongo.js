import { MongoClient } from 'mongodb';

const DB_NAME = process.env.MONGODB_DB || 'preeb';

function createClient() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not configured');
  }

  // Serverless: each function instance keeps its own small pool. The
  // connect() promise is cached on globalThis so warm invocations reuse it
  // instead of opening a new connection per request.
  const client = new MongoClient(uri, {
    maxPoolSize: 5,
    minPoolSize: 0,
    maxIdleTimeMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 20_000,
  });

  return client.connect();
}

export async function getDb() {
  if (!globalThis.__preebMongoClientPromise) {
    globalThis.__preebMongoClientPromise = createClient();
  }

  const client = await globalThis.__preebMongoClientPromise;
  return client.db(DB_NAME);
}
