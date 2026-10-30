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
  listSnapshot,
  parseCampaignInput,
  parseTokenReference,
  retrySnapshot,
  runDueSnapshots,
  runSnapshot,
} from '../_lib/claim-campaign.js';
import { TokenInfoError, fetchRegistryLogo, resolveHolderToken, resolveToken } from '../_lib/token-info.js';
import { resolveHandle } from '../_lib/handle.js';
import { advanceCampaigns, refreshFunding } from '../_lib/claim-prepare.js';
import {
  ClaimBusyError,
  countInFlightClaims,
  createClaimChallenge,
  finishClaim,
  startClaim,
  verifyClaimer,
} from '../_lib/claim-claims.js';
import { fetchAddressUtxos } from '../_lib/cardano-chain.js';
import { endClaims, reclaimEligibility, reclaimFunds } from '../_lib/claim-reclaim.js';
import { buildFunding, submitFunding } from '../_lib/claim-fund.js';

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
      const db = await getDb();
      const results = await runDueSnapshots(db);
      // The same call keeps funded campaigns moving: lanes get prepared, claims and reclaims confirmed.
      const campaigns = await advanceCampaigns(db);
      res.status(200).json({ results, campaigns });
      return;
    }

    // Creating campaigns is tightly limited; claiming and owner actions get a normal allowance.
    let limit = { limit: 120, windowMs: 60_000 };
    if (req.method === 'POST') limit = route === 'campaigns' ? { limit: 5, windowMs: 60 * 60_000 } : { limit: 40, windowMs: 60_000 };
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

    // Vercel's catch-all only matches one path segment, so campaign actions take the id as a query parameter.
    if (['retry-snapshot', 'snapshot', 'reclaim', 'end-claims', 'fund-build', 'fund-submit'].includes(route)) {
      const id = String(req.query?.id || '');
      if (!isCampaignId(id)) {
        res.status(400).json({ error: 'A valid campaign id is required.' });
        return;
      }

      if (route === 'snapshot' && req.method === 'GET') {
        const result = await listSnapshot(await getDb(), id, {
          query: String(req.query?.q || ''),
          page: req.query?.page,
          sort: String(req.query?.sort || 'claim'),
          dir: String(req.query?.dir || 'desc'),
          handles: req.query?.handles !== '0',
        });
        res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
        res.status(200).json(result);
        return;
      }

      if (['retry-snapshot', 'reclaim', 'end-claims', 'fund-build', 'fund-submit'].includes(route) && req.method === 'POST') {
        const db = await getDb();
        const existing = await db.collection(CAMPAIGNS_COLLECTION).findOne({ _id: id }, { projection: { 'owner.stake': 1 } });
        if (!existing) {
          res.status(404).json({ error: 'Campaign not found.' });
          return;
        }
        const viewerStakes = readWalletSession(req);
        if (!viewerStakes.includes(existing.owner.stake)) {
          res.status(403).json({ error: 'Only the campaign owner can do this.' });
          return;
        }

        if (route === 'fund-build' || route === 'fund-submit') {
          const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
          const full = await db.collection(CAMPAIGNS_COLLECTION).findOne({ _id: id }, { projection: { 'snapshot.rows': 0 } });
          const result = route === 'fund-build'
            ? await buildFunding(db, full, { address: String(body.address || ''), utxoHexes: body.utxos })
            : await submitFunding(db, full, { txHex: body.txHex, witnessSetHex: body.witnessSet });
          res.status(200).json(result);
          return;
        }

        const actions = { 'retry-snapshot': retrySnapshot, reclaim: reclaimFunds, 'end-claims': endClaims };
        const result = await actions[route](db, id);
        const campaign = await getPublicCampaign(db, id, new Date(), viewerStakes);
        res.status(200).json({ campaign, ...result });
        return;
      }
    }

    if (['claim-challenge', 'claim-start', 'claim-finish'].includes(route) && req.method === 'POST') {
      const id = String(req.query?.id || '');
      if (!isCampaignId(id)) {
        res.status(400).json({ error: 'A valid campaign id is required.' });
        return;
      }
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const stake = String(body.stake || '').trim();
      if (!/^stake1[0-9a-z]+$|^stake_test1[0-9a-z]+$/.test(stake)) {
        res.status(400).json({ error: 'A valid stake address is required.' });
        return;
      }

      const db = await getDb();
      const campaign = await db.collection(CAMPAIGNS_COLLECTION).findOne({ _id: id }, { projection: { 'snapshot.rows': 0 } });
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found.' });
        return;
      }
      const verifiedStakes = readWalletSession(req);

      if (route === 'claim-challenge') {
        res.status(200).json(verifiedStakes.includes(stake) ? { verified: true } : createClaimChallenge(id, stake));
        return;
      }

      try {
        if (route === 'claim-start') {
          verifyClaimer({
            campaignId: id,
            stake,
            verifiedStakes,
            token: body.token,
            signatureHex: body.signatureHex,
            keyHex: body.keyHex,
          });
          const result = await startClaim(db, campaign, {
            stake,
            claimerAddress: String(body.address || ''),
            utxoHexes: body.utxos,
          });
          res.status(200).json(result);
          return;
        }

        const result = await finishClaim(db, campaign, {
          reservationId: body.reservationId,
          stake,
          witnessSetHex: body.witnessSet,
        });
        res.status(200).json(result);
        return;
      } catch (error) {
        if (error instanceof ClaimBusyError) {
          res.status(409).json({ error: error.message, busy: true });
          return;
        }
        throw error;
      }
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
      if (campaign.viewerIsOwner) {
        campaign.payoutAddress = (await db.collection(CAMPAIGNS_COLLECTION).findOne({ _id: route }, { projection: { 'owner.payoutAddress': 1 } }))?.owner?.payoutAddress || null;
        const raw = await db.collection(CAMPAIGNS_COLLECTION).findOne({ _id: route }, { projection: { lanes: 1 } });
        const inFlight = await countInFlightClaims(db, { _id: route, lanes: raw?.lanes });
        campaign.reclaimEligibility = reclaimEligibility({
          snapshot: campaign.snapshot,
          claimStartsAt: campaign.claimStartsAt,
          claimEndsAt: campaign.claimEndsAt,
          reclaimed: campaign.reclaimed,
        }, new Date(), inFlight);
        // Before a snapshot succeeds the wallet balance is never read, but the owner should not be
        // offered a reclaim of nothing.
        if (!campaign.funding) {
          try {
            campaign.walletEmpty = (await fetchAddressUtxos(campaign.walletAddress, campaign.network)).length === 0;
          } catch (error) {
            console.error('[PREEB] Could not read the campaign wallet balance:', error);
          }
        }
      }
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
