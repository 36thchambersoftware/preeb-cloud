import { applyCors, checkRateLimit, getClientIp, rejectRateLimited } from '../_lib/security.js';

const KOIOS_BASE = 'https://api.koios.rest/api/v1';

// Only these Koios endpoints are ever called by script.js/profile.js. This
// keeps the proxy from being usable as a generic, key-less Koios mirror for
// unrelated traffic (which would otherwise eat our Koios rate limits/costs).
const ALLOWED_ENDPOINTS = new Set([
  'tip',
  'pool_info',
  'pool_list',
  'pool_history',
  'account_info',
  'account_stake_history',
  'account_rewards',
  'account_assets',
  'cli_protocol_params',
]);

function toHeaderObject(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

function normalizeSegments(input) {
  const placeholderSegment = /^(\[?\.\.\.path\]?|\(\.\.\.path\)|path)$/i;

  return input
    .map((segment) => String(segment || '').trim())
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
    .filter((segment) => !placeholderSegment.test(segment));
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const rateLimit = checkRateLimit(`koios:${getClientIp(req)}`, { limit: 60, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    rejectRateLimited(res, rateLimit.retryAfterSeconds);
    return;
  }

  const candidatePathParam =
    req.query.path ??
    req.query['...path'] ??
    req.query['[...path]'] ??
    req.query.endpoint;

  const querySegments = normalizeSegments(
    Array.isArray(candidatePathParam)
      ? candidatePathParam
      : [candidatePathParam].filter(Boolean)
  );

  // Fallback for environments where catch-all params are not exposed on req.query.
  const rawUrl = typeof req.url === 'string' ? req.url : '';
  const pathname = rawUrl.split('?')[0] || '';
  const prefix = '/api/koios/';
  const fromUrl = pathname.startsWith(prefix)
    ? normalizeSegments(pathname.slice(prefix.length).split('/').filter(Boolean))
    : [];

  const segments = querySegments.length > 0 ? querySegments : fromUrl;
  const targetPath = segments.join('/');

  if (!targetPath) {
    res.status(400).json({ error: 'Missing Koios path. Use /api/koios/<endpoint>' });
    return;
  }

  const endpointName = segments[0];
  if (!ALLOWED_ENDPOINTS.has(endpointName)) {
    res.status(403).json({ error: `Koios endpoint "${endpointName}" is not permitted through this proxy.` });
    return;
  }

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path' || key === '...path' || key === '[...path]' || key === 'endpoint') continue;
    if (Array.isArray(value)) {
      for (const v of value) query.append(key, String(v));
    } else if (value != null) {
      query.append(key, String(value));
    }
  }

  const url = `${KOIOS_BASE}/${targetPath}${query.toString() ? `?${query.toString()}` : ''}`;

  const upstreamHeaders = {
    Accept: req.headers.accept || 'application/json',
  };

  let body;
  if (req.method === 'POST') {
    upstreamHeaders['Content-Type'] = 'application/json';
    if (typeof req.body === 'string') {
      body = req.body;
    } else if (req.body == null) {
      body = undefined;
    } else {
      body = JSON.stringify(req.body);
    }
  }

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: upstreamHeaders,
      body,
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Upstream-Status', String(upstream.status));
    res.setHeader('X-Upstream-Headers', JSON.stringify(toHeaderObject(upstream.headers)));
    res.send(text);
  } catch (error) {
    res.status(502).json({
      error: 'Failed to reach Koios upstream',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
