import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDiscordAuthorizeUrl,
  createDiscordSession,
  createOAuthState,
  clearOAuthStateCookie,
  getDiscordRedirectUri,
  isSafeReturnTo,
  readDiscordSession,
  setDiscordSessionCookie,
  setOAuthStateCookie,
  verifyOAuthState,
  verifySignedToken,
} from '../api/_lib/discord-auth.js';

process.env.SESSION_SECRET = 'test-only-session-secret-that-is-long-enough';
process.env.DISCORD_CLIENT_ID = '123456789';
process.env.DISCORD_REDIRECT_URI = 'https://preeb.cloud/api/auth/discord/callback';

function createResponse() {
  const headers = new Map();
  return {
    getHeader: (name) => headers.get(name),
    setHeader: (name, value) => headers.set(name, value),
    headers,
  };
}

test('signed Discord sessions round-trip and reject tampering or expiration', () => {
  const now = Date.now();
  const token = createDiscordSession({
    id: '42',
    username: 'shark',
    globalName: 'Shark',
    avatar: null,
  }, now);

  assert.equal(verifySignedToken(token, now)?.user.id, '42');
  assert.equal(verifySignedToken(`${token.slice(0, -1)}x`, now), null);
  assert.equal(verifySignedToken(token, now + (8 * 24 * 60 * 60 * 1000)), null);
});

test('OAuth state binds a safe local return path to the browser cookie', () => {
  const now = Date.now();
  const state = createOAuthState('/profile/stake_test', now);

  assert.equal(verifyOAuthState(state, state, now)?.returnTo, '/profile/stake_test');
  assert.equal(verifyOAuthState(state, `${state}x`, now), null);
  assert.equal(isSafeReturnTo('//evil.example'), false);
  assert.equal(isSafeReturnTo('/profile'), true);
});

test('unsafe OAuth return URLs are replaced with the profile path', () => {
  const now = Date.now();
  const state = createOAuthState('https://evil.example', now);
  assert.equal(verifyOAuthState(state, state, now)?.returnTo, '/profile');
});

test('Discord authorization URL requests identity and guild membership scopes', () => {
  const url = new URL(buildDiscordAuthorizeUrl('state-token'));
  const scopes = url.searchParams.get('scope').split(' ');

  assert.equal(url.origin, 'https://discord.com');
  assert.equal(url.searchParams.get('state'), 'state-token');
  assert.deepEqual(scopes, ['identify', 'guilds', 'guilds.members.read']);
});

test('local requests use their own callback instead of a cloud redirect setting', () => {
  const req = {
    headers: {
      host: 'localhost:3000',
      'x-forwarded-proto': 'http',
    },
  };
  const url = new URL(buildDiscordAuthorizeUrl('state-token', req));

  assert.equal(
    getDiscordRedirectUri(req),
    'http://localhost:3000/api/auth/discord/callback'
  );
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'http://localhost:3000/api/auth/discord/callback'
  );
});

test('session cookie is HTTP-only and can be read from a request', () => {
  const req = { headers: { 'x-forwarded-proto': 'https' } };
  const res = createResponse();
  setDiscordSessionCookie(req, res, { id: '42', username: 'shark' });

  const setCookie = res.headers.get('Set-Cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);

  const cookiePair = setCookie.split(';')[0];
  const session = readDiscordSession({ headers: { cookie: cookiePair } });
  assert.equal(session.user.id, '42');
});

test('OAuth callback can set a session and clear state in one response', () => {
  const req = { headers: { 'x-forwarded-proto': 'https' } };
  const res = createResponse();
  setDiscordSessionCookie(req, res, { id: '42', username: 'shark' });
  clearOAuthStateCookie(req, res);

  const cookies = res.headers.get('Set-Cookie');
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /^preeb_discord_session=/);
  assert.match(cookies[1], /^preeb_discord_oauth_state=;/);

  const stateRes = createResponse();
  setOAuthStateCookie(req, stateRes, createOAuthState('/profile'));
  assert.match(stateRes.headers.get('Set-Cookie'), /^preeb_discord_oauth_state=/);
});

test('wallet session cookie round-trips verified stakes and rejects tampering', async () => {
  const { addWalletToSession, readWalletSession } = await import('../api/_lib/discord-auth.js');
  const headers = {};
  const res = {
    getHeader: (name) => headers[name],
    setHeader: (name, value) => { headers[name] = value; },
  };

  addWalletToSession({ headers: {} }, res, 'stake1');
  const first = String(headers['Set-Cookie']).split(';')[0];
  addWalletToSession({ headers: { cookie: first } }, res, 'stake2');
  const second = String(headers['Set-Cookie'].at(-1)).split(';')[0];

  assert.deepEqual(readWalletSession({ headers: { cookie: second } }), ['stake1', 'stake2']);
  assert.deepEqual(readWalletSession({ headers: { cookie: `${second}x` } }), []);
  assert.deepEqual(readWalletSession({ headers: {} }), []);
});
