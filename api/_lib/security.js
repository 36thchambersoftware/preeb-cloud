/**
 * Lightweight abuse-mitigation helpers shared by the serverless API routes.
 *
 * Rate limiting here is in-memory per warm function instance — it is NOT a
 * distributed limiter (Vercel can run multiple concurrent instances), but it
 * meaningfully raises the bar against casual scripted abuse without adding
 * new infrastructure or Mongo permissions. Pair with the CORS allowlist below
 * and, if abuse becomes serious, a real edge/WAF rate limiter.
 */

const ALLOWED_ORIGINS = new Set([
  'https://preeb.cloud',
  'https://www.preeb.cloud',
]);

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

export function resolveCorsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (LOCAL_ORIGIN_RE.test(origin)) return origin;
  return null;
}

export function applyCors(req, res, methods = 'GET,POST,OPTIONS') {
  const corsOrigin = resolveCorsOrigin(req);
  if (corsOrigin) res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

const buckets = globalThis.__preebRateLimitBuckets || new Map();
globalThis.__preebRateLimitBuckets = buckets;

/**
 * Fixed-window counter keyed by an arbitrary string (route + client IP).
 * Returns { allowed, retryAfterSeconds }.
 */
export function checkRateLimit(key, { limit = 60, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || now >= entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (entry.count >= limit) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count += 1;
  return { allowed: true };
}

export function rejectRateLimited(res, retryAfterSeconds) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
}
