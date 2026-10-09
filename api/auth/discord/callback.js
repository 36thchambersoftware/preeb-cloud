import { getDb } from '../../_lib/mongo.js';
import { ensureIdentityIndexes, saveDiscordLogin } from '../../_lib/identity.js';
import { applyCors, checkRateLimit, getClientIp, rejectRateLimited } from '../../_lib/security.js';
import {
  clearOAuthStateCookie,
  exchangeDiscordCode,
  fetchDiscordUser,
  getOAuthStateCookie,
  readWalletSession,
  setDiscordSessionCookie,
  verifyOAuthState,
} from '../../_lib/discord-auth.js';

export default async function handler(req, res) {
  applyCors(req, res, 'GET,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rateLimit = checkRateLimit(`discord-callback:${getClientIp(req)}`, { limit: 30, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    rejectRateLimited(res, rateLimit.retryAfterSeconds);
    return;
  }

  const code = Array.isArray(req.query.code) ? req.query.code[0] : req.query.code;
  const state = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state;
  const statePayload = verifyOAuthState(state, getOAuthStateCookie(req));
  if (!code || !statePayload) {
    clearOAuthStateCookie(req, res);
    res.status(400).json({ error: 'Discord login expired or could not be verified. Please try again.' });
    return;
  }

  try {
    const accessToken = await exchangeDiscordCode(String(code), fetch, req);
    const user = await fetchDiscordUser(accessToken);

    // Discord has already proven who this is, so the identity is saved now.
    // Wallets already verified in this browser join that same identity rather
    // than a new document being created next to them.
    try {
      const db = await getDb();
      await ensureIdentityIndexes(db);
      await saveDiscordLogin(db, user, new Date(), readWalletSession(req));
    } catch (storeError) {
      console.error('[PREEB] Could not save Discord identity on login:', storeError);
    }

    setDiscordSessionCookie(req, res, user);
    clearOAuthStateCookie(req, res);
    res.redirect(302, statePayload.returnTo);
  } catch (error) {
    console.error('[PREEB] Discord OAuth callback failed:', error);
    clearOAuthStateCookie(req, res);
    res.status(502).json({ error: 'Discord login failed. Please try again.' });
  }
}
