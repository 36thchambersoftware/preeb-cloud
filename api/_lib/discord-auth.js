import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function parseLocalEnvValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, '');
}

function loadLocalEnvFile() {
  try {
    const envPath = path.resolve(process.cwd(), '.env.local');
    const contents = fs.readFileSync(envPath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, name, rawValue] = match;
      if (!process.env[name]) process.env[name] = parseLocalEnvValue(rawValue);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && process.env.NODE_ENV === 'development') {
      console.warn('[PREEB] Could not read local environment file:', error.message);
    }
  }
}

loadLocalEnvFile();

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const SESSION_COOKIE = 'preeb_discord_session';
const STATE_COOKIE = 'preeb_discord_oauth_state';
const WALLET_COOKIE = 'preeb_wallet_session';
const WALLET_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_WALLET_SESSION_STAKES = 25;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;
const OAUTH_SCOPES = ['identify', 'guilds', 'guilds.members.read'];

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be configured with at least 32 characters');
  }
  return secret;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function sign(encodedPayload) {
  return crypto.createHmac('sha256', getSessionSecret()).update(encodedPayload).digest('base64url');
}

export function createSignedToken(payload) {
  const encodedPayload = encodeJson(payload);
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifySignedToken(token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const encodedPayload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  const expectedSignature = sign(encodedPayload);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;

  try {
    const payload = decodeJson(encodedPayload);
    if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(now / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};

  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [part.trim(), ''];
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      return [name, decodeURIComponent(value)];
    } catch {
      return [name, value];
    }
  }));
}

function cookie(name, value, { maxAge = 0, secure = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
    return;
  }
  res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, value] : [existing, value]);
}

export function shouldUseSecureCookies(req) {
  const forwardedProto = req.headers?.['x-forwarded-proto'];
  if (forwardedProto) return String(forwardedProto).split(',')[0].trim() === 'https';
  return process.env.NODE_ENV === 'production';
}

export function isSafeReturnTo(value) {
  return typeof value === 'string'
    && value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('\\')
    && !/[\r\n]/.test(value);
}

export function createOAuthState(returnTo, now = Date.now()) {
  return createSignedToken({
    type: 'discord_oauth_state',
    nonce: crypto.randomBytes(24).toString('base64url'),
    returnTo: isSafeReturnTo(returnTo) ? returnTo : '/profile',
    exp: Math.floor(now / 1000) + STATE_TTL_SECONDS,
  });
}

export function verifyOAuthState(state, cookieState, now = Date.now()) {
  if (!state || !cookieState) return null;
  const supplied = Buffer.from(String(state));
  const expected = Buffer.from(String(cookieState));
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;

  const payload = verifySignedToken(state, now);
  return payload?.type === 'discord_oauth_state' ? payload : null;
}

export function setOAuthStateCookie(req, res, state) {
  appendSetCookie(res, cookie(STATE_COOKIE, state, {
    maxAge: STATE_TTL_SECONDS,
    secure: shouldUseSecureCookies(req),
  }));
}

export function clearOAuthStateCookie(req, res) {
  appendSetCookie(res, cookie(STATE_COOKIE, '', {
    maxAge: 0,
    secure: shouldUseSecureCookies(req),
  }));
}

export function getOAuthStateCookie(req) {
  return parseCookies(req)[STATE_COOKIE] || null;
}

function getLocalRequestOrigin(req) {
  const forwardedHost = req?.headers?.['x-forwarded-host'];
  const host = String(forwardedHost || req?.headers?.host || '').split(',')[0].trim();
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return null;

  const forwardedProto = req?.headers?.['x-forwarded-proto'];
  const protocol = String(forwardedProto || 'http').split(',')[0].trim();
  return protocol === 'http' || protocol === 'https' ? `${protocol}://${host}` : null;
}

export function getDiscordRedirectUri(req) {
  const localOrigin = getLocalRequestOrigin(req);
  if (localOrigin) return `${localOrigin}/api/auth/discord/callback`;

  const redirectUri = process.env.DISCORD_REDIRECT_URI?.trim();
  if (!redirectUri) throw new Error('DISCORD_REDIRECT_URI is not configured');
  return redirectUri;
}

export function buildDiscordAuthorizeUrl(state, req) {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  if (!clientId) throw new Error('DISCORD_CLIENT_ID is not configured');

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: getDiscordRedirectUri(req),
    scope: OAUTH_SCOPES.join(' '),
    state,
    prompt: 'consent',
  });
  return `${DISCORD_AUTHORIZE_URL}?${params}`;
}

export async function exchangeDiscordCode(code, fetchImpl = fetch, req) {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Discord OAuth client credentials are not configured');
  }

  const response = await fetchImpl(`${DISCORD_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: getDiscordRedirectUri(req),
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    throw new Error(body?.error_description || body?.message || 'Discord rejected the authorization code');
  }
  return body.access_token;
}

export async function fetchDiscordUser(accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(`${DISCORD_API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.id) {
    throw new Error(body?.message || 'Could not load the Discord account');
  }
  return {
    id: String(body.id),
    username: String(body.username || ''),
    globalName: body.global_name ? String(body.global_name) : null,
    avatar: body.avatar ? String(body.avatar) : null,
  };
}

export function createDiscordSession(user, now = Date.now()) {
  return createSignedToken({
    type: 'discord_session',
    user: {
      id: String(user.id),
      username: String(user.username || ''),
      globalName: user.globalName ? String(user.globalName) : null,
      avatar: user.avatar ? String(user.avatar) : null,
    },
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  });
}

export function setDiscordSessionCookie(req, res, user) {
  appendSetCookie(res, cookie(SESSION_COOKIE, createDiscordSession(user), {
    maxAge: SESSION_TTL_SECONDS,
    secure: shouldUseSecureCookies(req),
  }));
}

export function clearDiscordSessionCookie(req, res) {
  appendSetCookie(res, cookie(SESSION_COOKIE, '', {
    maxAge: 0,
    secure: shouldUseSecureCookies(req),
  }));
}

export function readDiscordSession(req, now = Date.now()) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const payload = verifySignedToken(token, now);
  return payload?.type === 'discord_session' && payload.user?.id ? payload : null;
}

/**
 * Server-side proof of which wallets this browser has signed for. The client's
 * localStorage flag cannot be trusted for this, so linking Discord to an
 * existing wallet identity relies on this signed cookie instead.
 */
export function readWalletSession(req, now = Date.now()) {
  const token = parseCookies(req)[WALLET_COOKIE];
  if (!token) return [];
  const payload = verifySignedToken(token, now);
  if (payload?.type !== 'wallet_session' || !Array.isArray(payload.stakes)) return [];
  return payload.stakes.filter((stake) => typeof stake === 'string' && stake);
}

export function addWalletToSession(req, res, stake, now = Date.now()) {
  const stakes = [...new Set([...readWalletSession(req, now), stake])].slice(-MAX_WALLET_SESSION_STAKES);
  const token = createSignedToken({
    type: 'wallet_session',
    stakes,
    exp: Math.floor(now / 1000) + WALLET_TTL_SECONDS,
  });
  appendSetCookie(res, cookie(WALLET_COOKIE, token, {
    maxAge: WALLET_TTL_SECONDS,
    secure: shouldUseSecureCookies(req),
  }));
  return stakes;
}
