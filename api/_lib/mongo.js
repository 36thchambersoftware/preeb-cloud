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

  const clientPromise = globalThis.__preebMongoClientPromise;
  try {
    const client = await clientPromise;
    return client.db(DB_NAME);
  } catch (error) {
    if (globalThis.__preebMongoClientPromise === clientPromise) {
      globalThis.__preebMongoClientPromise = null;
    }
    throw error;
  }
}

export async function resetMongoConnection() {
  const clientPromise = globalThis.__preebMongoClientPromise;
  globalThis.__preebMongoClientPromise = null;
  if (!clientPromise) return;

  try {
    const client = await clientPromise;
    await client.close();
  } catch {
    // A failed connection has nothing usable to close.
  }
}
