export default function handler(req, res) {
  res.status(200).json({
    hasMongoUri: Boolean(process.env.MONGODB_URI),
    hasOidc: Boolean(process.env.VERCEL_OIDC_TOKEN),
    mongoDb: process.env.MONGODB_DB || null,
    testVar: process.env.TEST_DEBUG_VAR || null,
  });
}
