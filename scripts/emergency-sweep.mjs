#!/usr/bin/env node
/**
 * Emergency recovery for a claim campaign wallet, independent of the website.
 *
 *   node scripts/emergency-sweep.mjs <campaignId>           show what would be sent (dry run)
 *   node scripts/emergency-sweep.mjs <campaignId> --send    sign and submit the sweep
 *
 * Needs MONGODB_URI, MONGODB_DB and CLAIM_WALLET_KEY_SECRET (from .env.local or the
 * environment) and, like the site, CLAIM_NETWORK for preprod. Everything in the wallet
 * goes to the campaign owner's payout address, which was fixed when the campaign was
 * created. This skips the claim-period rules, so only use it if the website cannot be
 * used; sweeping while claims are open will stop holders from claiming.
 */
import '../api/_lib/discord-auth.js';

const [campaignId, flag] = process.argv.slice(2);
if (!campaignId) {
  console.error('Usage: node scripts/emergency-sweep.mjs <campaignId> [--send]');
  process.exit(1);
}

const { getDb } = await import('../api/_lib/mongo.js');
const { fetchAddressUtxos, fetchProtocolParams, submitTransaction } = await import('../api/_lib/cardano-chain.js');
const { attachWalletWitness, buildSweepTransaction, loadCsl } = await import('../api/_lib/claim-funding.js');
const { signWithClaimWallet } = await import('../api/_lib/claim-wallet.js');

const db = await getDb();
const campaign = await db.collection('claim_campaigns').findOne({ _id: campaignId });
const wallet = await db.collection('claim_wallets').findOne({ _id: campaignId });
if (!campaign || !wallet) {
  console.error(`No campaign or wallet found for ${campaignId}.`);
  process.exit(1);
}

const utxos = await fetchAddressUtxos(campaign.wallet.address, campaign.network);
console.log(`Campaign:    ${campaign.title} (${campaign._id}, ${campaign.network})`);
console.log(`Wallet:      ${campaign.wallet.address}`);
console.log(`Destination: ${campaign.owner.payoutAddress}`);
console.log(`UTxOs:       ${utxos.length}`);
if (utxos.length === 0) process.exit(0);

const [csl, protocol] = await Promise.all([loadCsl(), fetchProtocolParams(campaign.network)]);
const built = buildSweepTransaction({
  csl,
  protocol,
  address: campaign.wallet.address,
  utxos,
  destination: campaign.owner.payoutAddress,
});
console.log(`Sweeping ${built.inputCount} UTxO(s), fee ${Number(built.fee) / 1e6} ADA${built.moreRemain ? ' (more remain; run again afterwards)' : ''}.`);

if (flag !== '--send') {
  console.log('Dry run only. Add --send to submit.');
  process.exit(0);
}

const signature = signWithClaimWallet(wallet.encryptedSeed, campaignId, Buffer.from(built.txHash, 'hex'));
const signed = attachWalletWitness(csl, built.transaction, wallet.publicKeyHex, signature);
const hash = await submitTransaction(Buffer.from(signed.to_bytes()), campaign.network);
console.log(`Submitted: ${hash}`);
process.exit(0);
