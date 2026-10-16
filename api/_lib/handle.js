import { parseAddress } from './cardano-address.js';

/**
 * Looks up the ADA Handle for a stake address, to show "$name" instead of a
 * long address. Handles exist on mainnet only, a failed lookup is never an
 * error, and answers are cached for a while to stay within the Handle API's
 * rate limits.
 */

const HANDLE_API = 'https://api.handle.me/holders';
const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = globalThis.__preebHandleCache || new Map();
globalThis.__preebHandleCache = cache;

/**
 * The handle for a stake address: "$name", null when the wallet has none, and
 * undefined when the Handle API could not answer (rate limit, outage). Only
 * definite answers are cached.
 */
export async function lookupHandle(stakeAddress, { network = 'mainnet', fetchImpl = fetch, now = Date.now() } = {}) {
  if (network !== 'mainnet' || !/^stake1[0-9a-z]+$/.test(stakeAddress)) return null;

  const cached = cache.get(stakeAddress);
  if (cached && now - cached.at < CACHE_MS) return cached.handle;

  let handle = null;
  try {
    const response = await fetchImpl(`${HANDLE_API}/${stakeAddress}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (response.ok) {
      const data = await response.json();
      const name = data.default_handle || data.handles?.[0];
      if (typeof name === 'string' && /^[a-z0-9_.@-]{1,64}$/i.test(name)) handle = `$${name}`;
    } else if (response.status !== 404) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  cache.set(stakeAddress, { handle, at: now });
  return handle;
}

export async function resolveHandle(stakeAddress, options) {
  return (await lookupHandle(stakeAddress, options)) ?? null;
}

/** The stake address a handle currently resolves to, or null (mainnet only). */
export async function resolveHandleStake(name, { fetchImpl = fetch } = {}) {
  const clean = String(name || '').replace(/^\$/, '').toLowerCase();
  if (!/^[a-z0-9_.-]{1,60}$/.test(clean)) return null;
  try {
    const response = await fetchImpl(`https://api.handle.me/handles/${encodeURIComponent(clean)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const address = (await response.json())?.resolved_addresses?.ada;
    return parseAddress(address)?.stakeAddress || null;
  } catch {
    return null;
  }
}
