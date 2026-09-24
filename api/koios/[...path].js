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
  'asset_addresses',
  'asset_list',
  'policy_holders',
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

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.status(405).json({ error: 'Method not allowed.' });
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

  if (endpointName === 'policy_holders') {
    const policyId = String(req.query._asset_policy || '').trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{56}$/.test(policyId)) {
      res.status(400).json({ error: 'A valid 56-character policy ID is required.' });
      return;
    }

    try {
      const assetListResponse = await fetch(`${KOIOS_BASE}/asset_list?_asset_policy=${policyId}`, {
        headers: { Accept: 'application/json' },
      });
      if (!assetListResponse.ok) {
        const text = await assetListResponse.text();
        res.status(assetListResponse.status).send(text);
        return;
      }

      const assets = await assetListResponse.json();
      const quantitiesByAddress = new Map();
      const failedAssets = [];
      const requestIntervalMs = 160;
      let lastRequestAt = 0;

      async function waitForRequestSlot() {
        const waitMs = Math.max(0, requestIntervalMs - (Date.now() - lastRequestAt));
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        lastRequestAt = Date.now();
      }

      async function fetchAssetAddresses(assetName) {
        const url = `${KOIOS_BASE}/asset_addresses?_asset_policy=${policyId}&_asset_name=${encodeURIComponent(assetName)}&limit=1000`;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await waitForRequestSlot();
          const response = await fetch(url, { headers: { Accept: 'application/json' } });
          if (response.ok) {
            const rows = await response.json();
            return Array.isArray(rows) ? rows : [];
          }

          if (response.status !== 429 && response.status < 500) {
            return null;
          }

          const retryAfter = Number(response.headers.get('retry-after'));
          const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 10_000;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        return null;
      }

      for (const asset of assets) {
        const assetName = typeof asset?.asset_name === 'string' ? asset.asset_name : '';
        if (!assetName) continue;

        const rows = await fetchAssetAddresses(assetName);
        if (rows === null) {
          failedAssets.push(assetName);
          continue;
        }

        rows.forEach((row) => {
          const address = typeof row?.payment_address === 'string' ? row.payment_address.trim() : '';
          const quantity = Number(row?.quantity || 0);
          if (!address || !Number.isFinite(quantity) || quantity <= 0) return;
          quantitiesByAddress.set(address, (quantitiesByAddress.get(address) || 0) + quantity);
        });
      }

      if (failedAssets.length > 0) {
        res.status(502).json({
          error: `Koios could not resolve ${failedAssets.length} of ${assets.length} assets. No partial holder list was returned. Please try again.`,
        });
        return;
      }

      res.status(200).json(Array.from(quantitiesByAddress, ([payment_address, quantity]) => ({
        payment_address,
        quantity: String(quantity),
      })));
      return;
    } catch (error) {
      res.status(502).json({
        error: 'Failed to resolve policy holders from Koios',
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
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
