import { koiosBase } from './claim-snapshot.js';

/**
 * Token details come from the chain, never from the campaign creator.
 *
 * Decimals: Cardano has no protocol-level decimals. In order of authority we use
 *   1. the CIP-68 datum (stored on chain with the token),
 *   2. the Cardano Token Registry entry (CIP-26, an off-chain registry that Koios mirrors),
 *   3. otherwise 0, i.e. the raw on-chain quantity.
 *
 * Images are tried in the same spirit: CIP-68 datum, CIP-25 mint metadata,
 * then the registry logo.
 */

const LOOKUP_TIMEOUT_MS = 15_000;
const MAX_LOGO_BYTES = 300_000;
// The busiest public gateways (ipfs.io, dweb.link) rate-limit hard, so lighter ones go first.
const IPFS_GATEWAYS = [
  'https://ipfs.filebase.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
];
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|b[a-z2-7]{50,}|z[1-9A-HJ-NP-Za-km-z]{40,})$/;

export class TokenInfoError extends Error {}

const IPFS_GATEWAY_HOSTS = new Set([
  'ipfs.io', 'dweb.link', 'gateway.pinata.cloud', 'ipfs.filebase.io', 'nftstorage.link', 'w3s.link', 'cloudflare-ipfs.com',
]);

export function registryImageRef(policyId, assetNameHex) {
  return `registry:${policyId}.${assetNameHex}`;
}

/** Validates an image reference and returns its stored form (ipfs://, ar://, https:// or registry:). */
export function normalizeImageRef(value) {
  const ref = String(value ?? '').trim();
  if (!ref) return null;
  if (ref.length > 500) throw new TokenInfoError('The image link is too long.');

  if (/^registry:[0-9a-f]{56}\.([0-9a-f]{2}){0,32}$/.test(ref)) return ref;
  if (CID_RE.test(ref)) return `ipfs://${ref}`;

  if (ref.startsWith('ipfs://')) {
    const path = ref.slice('ipfs://'.length).replace(/^ipfs\//, '');
    if (!/^[A-Za-z0-9._\-/]+$/.test(path) || !CID_RE.test(path.split('/')[0])) {
      throw new TokenInfoError('The IPFS image link is not valid.');
    }
    return `ipfs://${path}`;
  }
  if (ref.startsWith('ar://')) {
    const id = ref.slice('ar://'.length);
    if (!/^[A-Za-z0-9_-]{43}(\/[A-Za-z0-9._-]+)*$/.test(id)) throw new TokenInfoError('The Arweave image link is not valid.');
    return `ar://${id}`;
  }

  let parsed;
  try {
    parsed = new URL(ref);
  } catch {
    throw new TokenInfoError('The image link is not valid.');
  }
  if (parsed.protocol !== 'https:') {
    throw new TokenInfoError('Image links must be ipfs://, ar:// or a link through a public IPFS or Arweave gateway.');
  }

  // Arbitrary web hosts are refused: whoever runs one sees the IP address of everyone who views
  // the campaign. Public gateways are fine; the content is addressed by hash, not by host.
  const gatewayPath = parsed.pathname.match(/^\/ipfs\/(.+)$/);
  if (IPFS_GATEWAY_HOSTS.has(parsed.hostname) && gatewayPath) return normalizeImageRef(`ipfs://${gatewayPath[1]}`);
  if (parsed.hostname === 'arweave.net' && /^\/[A-Za-z0-9_-]{43}(\/[A-Za-z0-9._-]+)*$/.test(parsed.pathname)) {
    return normalizeImageRef(`ar:/${parsed.pathname}`);
  }
  throw new TokenInfoError('Image links must be ipfs://, ar:// or a link through a public IPFS or Arweave gateway.');
}

/** Every URL worth trying for an image reference, best first. */
export function imageSourcesFor(ref) {
  if (!ref) return [];
  if (ref.startsWith('ipfs://')) return IPFS_GATEWAYS.map((gateway) => `${gateway}${ref.slice(7)}`);
  if (ref.startsWith('ar://')) return [`https://arweave.net/${ref.slice(5)}`];
  const registry = ref.match(/^registry:([0-9a-f]{56})\.([0-9a-f]*)$/);
  if (registry) return [`/api/claim/token-image?policyId=${registry[1]}&assetName=${registry[2]}`];
  return [ref];
}

function plutusValue(node) {
  if (!node || typeof node !== 'object') return undefined;
  if (typeof node.bytes === 'string') return Buffer.from(node.bytes, 'hex').toString('utf8');
  if (node.int !== undefined) return Number(node.int);
  // Long byte strings are stored as lists of chunks.
  if (Array.isArray(node.list)) return node.list.map((item) => plutusValue(item) ?? '').join('');
  return undefined;
}

/** Flattens the metadata map of a CIP-68 datum into { key: value }. */
export function parseCip68(cip68) {
  const result = {};
  for (const datum of Object.values(cip68 || {})) {
    for (const entry of datum?.fields?.[0]?.map || []) {
      const key = plutusValue(entry.k);
      const value = plutusValue(entry.v);
      if (typeof key === 'string' && value !== undefined && !(key in result)) result[key] = value;
    }
  }
  return result;
}

function cip25Image(asset) {
  const policyEntry = asset.minting_tx_metadata?.['721']?.[asset.policy_id];
  if (!policyEntry || typeof policyEntry !== 'object') return null;
  const entry = policyEntry[asset.asset_name_ascii] ?? policyEntry[asset.asset_name] ?? Object.values(policyEntry)[0];
  const image = Array.isArray(entry?.image) ? entry.image.join('') : entry?.image;
  return typeof image === 'string' ? image : null;
}

function cleanWebsite(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function cleanTicker(value) {
  const text = String(value ?? '').trim();
  return /^[\w$.\-]{1,12}$/.test(text) ? text : '';
}

function candidateImage(ref, source, images) {
  try {
    const normalized = normalizeImageRef(ref);
    if (normalized && !images.some((image) => image.ref === normalized)) images.push({ ref: normalized, source });
  } catch {
    // An unusable image link in token metadata is simply not offered.
  }
}

/** Reads decimals, ticker and image candidates for a token from Koios. Returns null for unknown tokens. */
export async function lookupTokenInfo(policyId, assetNameHex, { network, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${koiosBase(network)}/asset_info`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ _asset_list: [[policyId, assetNameHex]] }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TokenInfoError(`Could not reach the chain data service: ${error.message}`);
  }
  if (!response.ok) throw new TokenInfoError(`The chain data service responded with HTTP ${response.status}.`);

  const [asset] = await response.json();
  if (!asset) return null;

  const registry = asset.token_registry_metadata || {};
  const onChain = parseCip68(asset.cip68_metadata);

  let decimals = 0;
  let decimalsSource = 'default';
  if (Number.isInteger(onChain.decimals) && onChain.decimals >= 0 && onChain.decimals <= 19) {
    decimals = onChain.decimals;
    decimalsSource = 'cip68';
  } else if (Number.isInteger(registry.decimals) && registry.decimals >= 0 && registry.decimals <= 19) {
    decimals = registry.decimals;
    decimalsSource = 'registry';
  }

  const images = [];
  candidateImage(onChain.logo || onChain.image, 'cip68', images);
  candidateImage(cip25Image(asset), 'cip25', images);
  if (registry.logo) candidateImage(registryImageRef(policyId, assetNameHex), 'registry', images);

  return {
    policyId,
    assetNameHex,
    name: String(onChain.name || registry.name || asset.asset_name_ascii || '').slice(0, 80) || null,
    ticker: cleanTicker(onChain.ticker) || cleanTicker(registry.ticker)
      || cleanTicker(asset.asset_name_ascii) || String(asset.fingerprint || '').slice(0, 10),
    decimals,
    decimalsSource,
    website: cleanWebsite(onChain.url || onChain.website) || cleanWebsite(registry.url),
    totalSupply: String(asset.total_supply ?? ''),
    images: images.map((image) => ({ ...image, sources: imageSourcesFor(image.ref) })),
  };
}

/** The registry logo as bytes, or null. Only raster formats are served. */
export async function fetchRegistryLogo(policyId, assetNameHex, { network, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${koiosBase(network)}/asset_info`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ _asset_list: [[policyId, assetNameHex]] }),
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) return null;

  const [asset] = await response.json();
  const logo = asset?.token_registry_metadata?.logo;
  if (typeof logo !== 'string' || !logo) return null;

  const bytes = Buffer.from(logo, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { bytes, contentType: 'image/png' };
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return { bytes, contentType: 'image/jpeg' };
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return { bytes, contentType: 'image/gif' };
  return null;
}

const MAX_CHOICES = 50;

async function koiosPost(path, { network, fetchImpl }, body) {
  let response;
  try {
    response = await fetchImpl(`${koiosBase(network)}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TokenInfoError(`Could not reach the chain data service: ${error.message}`);
  }
  if (!response.ok) throw new TokenInfoError(`The chain data service responded with HTTP ${response.status}.`);
  return response.json();
}

/** Assets minted under a policy (a few more than we would ever list, so callers can tell "too many"). */
export async function listPolicyAssets(policyId, { network, fetchImpl = fetch } = {}) {
  const rows = await koiosPost(`asset_list?_asset_policy=${policyId}&limit=${MAX_CHOICES + 1}`, { network, fetchImpl });
  return rows.map((row) => ({
    assetNameHex: row.asset_name || '',
    name: row.asset_name_ascii && /^[\x20-\x7e]+$/.test(row.asset_name_ascii) ? row.asset_name_ascii : '',
  }));
}

/**
 * Finds the token for a policy ID. The asset name is only needed when a policy
 * holds several tokens; otherwise it is read from the chain.
 *   - null: nothing is minted under that policy
 *   - { needsChoice, assets }: several tokens, the caller must pick one
 *   - a token info object otherwise
 */
export async function resolveToken(policyId, assetNameHex, options = {}) {
  let name = assetNameHex;
  if (name === undefined || name === null) {
    const assets = await listPolicyAssets(policyId, options);
    if (assets.length === 0) return null;
    if (assets.length > 1) {
      return { policyId, needsChoice: true, tooMany: assets.length > MAX_CHOICES, assets: assets.slice(0, MAX_CHOICES) };
    }
    name = assets[0].assetNameHex;
  }
  return lookupTokenInfo(policyId, name, options);
}

/**
 * Display details for the token whose holders can claim. A policy with many
 * tokens (an NFT collection) is described by its first token's name without a
 * trailing number, and counts as whole units.
 */
export async function resolveHolderToken(policyId, options = {}) {
  const assets = await listPolicyAssets(policyId, options);
  if (assets.length === 0) return null;
  const [first] = assets;
  const info = await lookupTokenInfo(policyId, first.assetNameHex, options);
  if (assets.length === 1) return { ...info, multiAsset: false };

  const collection = (info?.name || first.name || '').replace(/[\s#_-]*\d+$/, '').trim();
  return {
    policyId,
    name: collection || null,
    ticker: info?.ticker || '',
    decimals: 0,
    website: info?.website || null,
    images: info?.images || [],
    multiAsset: true,
  };
}
