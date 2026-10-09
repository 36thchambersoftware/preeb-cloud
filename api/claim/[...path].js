import crypto from 'node:crypto';
import { getDb } from '../_lib/mongo.js';
import { readWalletSession } from '../_lib/discord-auth.js';
import { applyCors, checkRateLimit, getClientIp, rejectRateLimited } from '../_lib/security.js';
import {
  ClaimInputError,
  createCampaign,
  getClaimNetwork,
  getPublicCampaign,
  isCampaignId,
  listPublicCampaigns,
  parseCampaignInput,
  runDueSnapshots,
  runSnapshot,
} from '../_lib/claim-campaign.js';
import { koiosBase } from '../_lib/claim-snapshot.js';

function getSegments(req) {
  const fromQuery = req.query?.path;
  if (Array.isArray(fromQuery)) return fromQuery.filter(Boolean);
  if (typeof fromQuery === 'string' && fromQuery) return [fromQuery];

  const pathname = String(req.url || '').split('?')[0];
  const prefix = '/api/claim';
  return pathname.startsWith(prefix)
    ? pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent)
    : [];
}

function isAuthorizedCron(req) {
  const secret = process.env.CLAIM_CRON_SECRET?.trim();
  if (!secret || secret.length < 32) return false;
  const header = String(req.headers.authorization || '');
  const provided = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function joinImage(value) {
  const text = Array.isArray(value) ? value.join('') : value;
  return typeof text === 'string' && text ? text : null;
}

/** Decimals, ticker and CIP-25 image candidates for a token, from Koios. */
async function lookupTokenInfo(policyId, assetNameHex) {
  const response = await fetch(`${koiosBase(getClaimNetwork())}/asset_info`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ _asset_list: [[policyId, assetNameHex]] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Koios responded with HTTP ${response.status}`);

  const [asset] = await response.json();
  if (!asset) return null;

  const nft = asset.minting_tx_metadata?.['721']?.[policyId];
  const nftEntry = nft?.[asset.asset_name_ascii] ?? (nft ? Object.values(nft)[0] : null);
  const image = joinImage(nftEntry?.image);
  const registry = asset.token_registry_metadata;

  return {
    policyId,
    assetNameHex,
    name: registry?.name || asset.asset_name_ascii || null,
    ticker: registry?.ticker || null,
    decimals: Number.isInteger(registry?.decimals) ? registry.decimals : 0,
    images: image ? [image] : [],
  };
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const route = getSegments(req)[0] || '';

  try {
    if (route === 'run-snapshots') {
      if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
      }
      if (!isAuthorizedCron(req)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const results = await runDueSnapshots(await getDb());
      res.status(200).json({ results });
      return;
    }

    const limit = req.method === 'POST' ? { limit: 5, windowMs: 60 * 60_000 } : { limit: 120, windowMs: 60_000 };
    const rate = checkRateLimit(`claim:${req.method}:${getClientIp(req)}`, limit);
    if (!rate.allowed) {
      rejectRateLimited(res, rate.retryAfterSeconds);
      return;
    }

    if (route === 'token-info' && req.method === 'GET') {
      const policyId = String(req.query?.policyId || '').trim().toLowerCase();
      const assetNameHex = String(req.query?.assetName || '').trim().toLowerCase();
      if (!/^[0-9a-f]{56}$/.test(policyId) || !/^([0-9a-f]{2}){0,32}$/.test(assetNameHex)) {
        res.status(400).json({ error: 'A valid policy ID and hex asset name are required.' });
        return;
      }
      const info = await lookupTokenInfo(policyId, assetNameHex);
      if (!info) {
        res.status(404).json({ error: 'Token not found.' });
        return;
      }
      res.status(200).json(info);
      return;
    }

    if (route === 'campaigns' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
      res.status(200).json({ campaigns: await listPublicCampaigns(await getDb()) });
      return;
    }

    if (route === 'campaigns' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const ownerStake = String(body?.ownerStake || '').trim();
      if (!ownerStake || !readWalletSession(req).includes(ownerStake)) {
        res.status(403).json({ error: 'Verify wallet ownership on your profile before creating a campaign.' });
        return;
      }

      const input = parseCampaignInput(body, { ownerStake });
      const db = await getDb();
      const campaign = await createCampaign(db, input);

      // Run right away when the snapshot is already due; the cron retries on failure.
      let snapshot = { ran: false };
      if (campaign.snapshot.scheduledFor <= new Date()) {
        snapshot = await runSnapshot(db, campaign._id);
      }
      const stored = await getPublicCampaign(db, campaign._id, new Date(), [ownerStake]);
      res.status(201).json({ campaign: stored, snapshot });
      return;
    }

    if (isCampaignId(route) && req.method === 'GET') {
      const campaign = await getPublicCampaign(await getDb(), route, new Date(), readWalletSession(req));
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found.' });
        return;
      }
      res.status(200).json({ campaign });
      return;
    }

    res.status(404).json({ error: 'Not found' });
  } catch (error) {
    if (error instanceof ClaimInputError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'Request body must be valid JSON.' });
      return;
    }
    console.error('[PREEB] Claim API error:', error);
    res.status(500).json({ error: 'Something went wrong. Please try again shortly.' });
  }
}
