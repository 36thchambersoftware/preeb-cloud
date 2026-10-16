import crypto from 'node:crypto';
import { getDb } from '../_lib/mongo.js';
import { readWalletSession } from '../_lib/discord-auth.js';
import { applyCors, checkRateLimit, getClientIp, rejectRateLimited } from '../_lib/security.js';
import {
  CAMPAIGNS_COLLECTION,
  ClaimInputError,
  createCampaign,
  getClaimNetwork,
  getPublicCampaign,
  isCampaignId,
  listPublicCampaigns,
  parseCampaignInput,
  parseTokenReference,
  retrySnapshot,
  runDueSnapshots,
  runSnapshot,
} from '../_lib/claim-campaign.js';
import { TokenInfoError, fetchRegistryLogo, resolveHolderToken, resolveToken } from '../_lib/token-info.js';
import { resolveHandle } from '../_lib/handle.js';
import { prepareLanes, refreshFunding } from '../_lib/claim-prepare.js';

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

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const segments = getSegments(req);
  const route = segments[0] || '';

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
      const reference = parseTokenReference({
        policyId: req.query?.policyId,
        assetNameHex: req.query?.assetName,
      });
      const info = await resolveToken(reference.policyId, reference.assetNameHex, { network: getClaimNetwork() });
      if (!info) {
        res.status(404).json({ error: 'No token was found for that policy ID.', field: 'y-policy' });
        return;
      }
      res.status(200).json(info);
      return;
    }

    if (route === 'holder-token' && req.method === 'GET') {
      const reference = parseTokenReference({ policyId: req.query?.policyId }, 'x-policy');
      const info = await resolveHolderToken(reference.policyId, { network: getClaimNetwork() });
      if (!info) {
        res.status(404).json({ error: 'No token was found for that policy ID.', field: 'x-policy' });
        return;
      }
      res.status(200).json(info);
      return;
    }

    if (route === 'token-image' && req.method === 'GET') {
      const reference = parseTokenReference({
        policyId: req.query?.policyId,
        assetNameHex: req.query?.assetName,
      });
      const logo = await fetchRegistryLogo(reference.policyId, reference.assetNameHex, { network: getClaimNetwork() });
      if (!logo) {
        res.status(404).json({ error: 'No image found.' });
        return;
      }
      res.setHeader('Content-Type', logo.contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
      res.status(200).send(logo.bytes);
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

      const network = getClaimNetwork();
      const reference = parseTokenReference(body.tokenY);
      const tokenInfo = await resolveToken(reference.policyId, reference.assetNameHex, { network });
      if (!tokenInfo) {
        throw new ClaimInputError('No token was found for that policy ID. Check it and try again.', 'y-policy');
      }
      if (tokenInfo.needsChoice) {
        throw new ClaimInputError('That policy holds several tokens. Choose which one to give away.', 'y-asset');
      }

      let holderToken = null;
      if (body.snapshot?.source === 'koios') {
        const holderReference = parseTokenReference(body.tokenX, 'x-policy');
        holderToken = await resolveHolderToken(holderReference.policyId, { network });
        if (!holderToken) {
          throw new ClaimInputError('No token was found for the holder policy ID. Check it and try again.', 'x-policy');
        }
      }

      const input = parseCampaignInput(body, { ownerStake, tokenInfo, holderToken });
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

    if (isCampaignId(route) && ['prepare', 'snapshot'].includes(segments[1]) && req.method === 'POST') {
      const db = await getDb();
      const existing = await db.collection(CAMPAIGNS_COLLECTION).findOne({ _id: route }, { projection: { 'owner.stake': 1 } });
      if (!existing) {
        res.status(404).json({ error: 'Campaign not found.' });
        return;
      }
      const viewerStakes = readWalletSession(req);
      if (!viewerStakes.includes(existing.owner.stake)) {
        res.status(403).json({ error: 'Only the campaign owner can do this.' });
        return;
      }

      const result = segments[1] === 'prepare' ? await prepareLanes(db, route) : await retrySnapshot(db, route);
      const campaign = await getPublicCampaign(db, route, new Date(), viewerStakes);
      res.status(200).json({ campaign, ...result });
      return;
    }

    if (isCampaignId(route) && req.method === 'GET') {
      const db = await getDb();
      // Snapshots are normally run by the scheduler. Whoever is watching the countdown
      // also nudges a due one along, so a late scheduler does not delay it. The
      // scheduled -> running step is atomic, so this can never snapshot twice.
      try {
        await runSnapshot(db, route);
      } catch (error) {
        console.error('[PREEB] Could not run a due snapshot while viewing a campaign:', error);
      }
      const campaign = await getPublicCampaign(db, route, new Date(), readWalletSession(req), {
        refresh: (current) => refreshFunding(db, current),
      });
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found.' });
        return;
      }
      campaign.ownerHandle = await resolveHandle(campaign.owner, { network: campaign.network });
      res.status(200).json({ campaign });
      return;
    }

    res.status(404).json({ error: 'Not found' });
  } catch (error) {
    if (error instanceof ClaimInputError) {
      res.status(400).json({ error: error.message, field: error.field });
      return;
    }
    if (error instanceof TokenInfoError) {
      console.error('[PREEB] Token lookup failed:', error);
      res.status(503).json({ error: 'Could not read the token details from the chain right now. Please try again in a moment.' });
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
