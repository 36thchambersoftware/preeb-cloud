import { applyCors, checkRateLimit, getClientIp, rejectRateLimited } from '../_lib/security.js';
import {
  buildDiscordAuthorizeUrl,
  createOAuthState,
  setOAuthStateCookie,
} from '../_lib/discord-auth.js';

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

  const rateLimit = checkRateLimit(`discord-login:${getClientIp(req)}`, { limit: 20, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    rejectRateLimited(res, rateLimit.retryAfterSeconds);
    return;
  }

  try {
    const returnTo = Array.isArray(req.query.returnTo) ? req.query.returnTo[0] : req.query.returnTo;
    const state = createOAuthState(returnTo);
    setOAuthStateCookie(req, res, state);
    res.redirect(302, buildDiscordAuthorizeUrl(state, req));
  } catch (error) {
    console.error('[PREEB] Discord login configuration failed:', error);
    res.status(503).json({ error: 'Discord login is not configured.' });
  }
}
