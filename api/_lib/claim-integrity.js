import {
  CAMPAIGNS_COLLECTION,
  ClaimInputError,
  ENTITLEMENTS_COLLECTION,
} from './claim-campaign.js';
import {
  campaignSealIsValid,
  entitlementSealIsValid,
  sealCampaign,
  sealEntitlement,
} from './claim-seal.js';

export class IntegrityError extends ClaimInputError {
  constructor() {
    super('This campaign failed an integrity check and has been paused. Please contact the site owner.');
  }
}

/**
 * Verifies a campaign before the server signs for it. A campaign created before seals
 * existed is sealed once, here, together with its entitlements (trust on first use);
 * from then on any change to the sealed fields is caught.
 */
export async function ensureCampaignSealed(db, campaign) {
  if (campaign.seal) {
    if (!campaignSealIsValid(campaign)) {
      console.error('[PREEB] Campaign failed its integrity seal:', campaign._id);
      throw new IntegrityError();
    }
    return;
  }

  await db.collection(CAMPAIGNS_COLLECTION).updateOne(
    { _id: campaign._id, seal: { $exists: false } },
    { $set: { seal: sealCampaign(campaign) } },
  );

  const entitlements = db.collection(ENTITLEMENTS_COLLECTION);
  const unsealed = await entitlements.find({ campaignId: campaign._id, seal: { $exists: false } })
    .project({ campaignId: 1, key: 1, amount: 1, lane: 1 }).toArray();
  for (let start = 0; start < unsealed.length; start += 1000) {
    await Promise.all(unsealed.slice(start, start + 1000).map((row) => entitlements.updateOne(
      { _id: row._id, seal: { $exists: false } },
      { $set: { seal: sealEntitlement(row.campaignId, row.key, row.amount, row.lane) } },
    )));
  }
}

/** Refuses an entitlement whose amount or owner was changed after the snapshot wrote it. */
export function assertEntitlementSealed(entitlement) {
  if (!entitlement || !entitlementSealIsValid(entitlement)) {
    console.error('[PREEB] Entitlement failed its integrity seal:', entitlement?.campaignId, entitlement?.key);
    throw new IntegrityError();
  }
}
