const KOIOS_BASE = 'https://api.koios.rest/api/v1';

function toHeaderObject(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const pathParam = req.query.path;
  const querySegments = Array.isArray(pathParam)
    ? pathParam
    : [pathParam].filter(Boolean);

  // Fallback for environments where catch-all params are not exposed on req.query.
  const rawUrl = typeof req.url === 'string' ? req.url : '';
  const pathname = rawUrl.split('?')[0] || '';
  const prefix = '/api/koios/';
  const fromUrl = pathname.startsWith(prefix)
    ? pathname.slice(prefix.length).split('/').filter(Boolean)
    : [];

  const segments = querySegments.length > 0 ? querySegments : fromUrl;
  const targetPath = segments.join('/');

  if (!targetPath) {
    res.status(400).json({ error: 'Missing Koios path. Use /api/koios/<endpoint>' });
    return;
  }

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path') continue;
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
