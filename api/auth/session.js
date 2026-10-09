import { getDb } from '../_lib/mongo.js';
import { ensureIdentityIndexes, listWallets, saveDiscordLogin } from '../_lib/identity.js';
import { applyCors, checkRateLimit, getClientIp, rejectRateLimited } from '../_lib/security.js';
import {
  clearDiscordSessionCookie,
  readDiscordSession,
  readWalletSession,
} from '../_lib/discord-auth.js';

export default async function handler(req, res) {
  applyCors(req, res, 'GET,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const rateLimit = checkRateLimit(`auth-session:${getClientIp(req)}`, { limit: 60, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    rejectRateLimited(res, rateLimit.retryAfterSeconds);
    return;
  }

  if (req.method === 'DELETE') {
    clearDiscordSessionCookie(req, res);
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const session = readDiscordSession(req);
    const verifiedWallets = readWalletSession(req);
    if (!session) {
      res.status(200).json({ authenticated: false, verifiedWallets });
      return;
    }

    const db = await getDb();
    await ensureIdentityIndexes(db);
    // Re-save on read so a Mongo outage during the OAuth callback cannot leave
    // a logged-in user without a stored identity.
    const identity = await saveDiscordLogin(db, session.user, new Date(), verifiedWallets);
    res.status(200).json({
      authenticated: true,
      user: session.user,
      wallets: listWallets(identity),
      verifiedWallets,
    });
  } catch (error) {
    console.error('[PREEB] Could not load authenticated identity:', error);
    res.status(503).json({ error: 'Could not load your linked identity. Please try again shortly.' });
  }
}
