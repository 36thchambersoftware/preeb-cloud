# preeb-cloud

PREEB pool landing page with live Cardano pool stats.

## Live Stats Architecture

Browser -> /api/koios/* (same-origin proxy) -> https://api.koios.rest/api/v1/*

This avoids Koios CORS restrictions in browsers.

## What Is Included

- Frontend live-stats client in `script.js`
- Serverless Koios proxy in `api/koios/[...path].js`

## Deploy (Vercel)

1. Import this repo into Vercel.
2. Deploy without extra build settings.
3. Verify proxy endpoint works:

	`/api/koios/pool_list?ticker=eq.PREEB`

4. Open the site and confirm the hero ticker + pool stats cards populate.

## Local Development

Use Vercel dev so the API route is available locally:

1. `npm i -g vercel`
2. `vercel dev`
3. Open the local URL shown by Vercel and test stats loading.

## Discord identity login

The profile page can link a Discord account to one or more wallets. This first
phase uses a Discord **OAuth application**; it does not require a Discord bot.

Logging in with Discord stores the Discord id in the `identities` collection
immediately — no wallet and no signature are involved, because the OAuth code
exchange already proves who the Discord user is. Wallets are linked separately:
each wallet still requires a CIP-8 signature, since that is the only proof the
wallet belongs to the person linking it. The two can be done in either order.

A successful wallet signature also sets a signed, HttpOnly `preeb_wallet_session`
cookie listing the wallets verified in that browser (30 days). When you log in
with Discord, the callback uses it to attach the Discord id to the identity those
wallets already belong to instead of creating a second document. If a Discord-only
document already exists, the wallet identity is merged into it. A wallet identity
already tied to a different Discord account is never modified. Linking another
wallet to a profile requires that profile to be in the wallet session.

Configure these environment variables in Vercel and in `.env.local`:

- `DISCORD_CLIENT_ID`: OAuth application's Application ID
- `DISCORD_CLIENT_SECRET`: OAuth application's client secret
- `DISCORD_REDIRECT_URI`: Exact callback URL, such as
  `https://preeb.cloud/api/auth/discord/callback`
- `SESSION_SECRET`: At least 32 random characters used to sign short-lived OAuth
  state and session cookies

The local Vercel function runtime loads `.env.local` directly for this
framework-less project. A request served on `localhost` or `127.0.0.1` always
uses that request's origin for the OAuth callback, so a production callback
setting cannot accidentally redirect a local login to the deployed site.

Add the same callback URL under **OAuth2 > Redirects** in the Discord developer
portal. The login currently requests `identify`, `guilds`, and
`guilds.members.read`. These scopes do not create or install a bot.

### Optional Discord bot for server role operations

The bot is a separate, later integration. It is needed only when PREEB must
inspect arbitrary members/roles in a guild or assign roles. Creating the OAuth
application does not automatically create a usable bot.

When we implement that integration, create the bot under **Developer Portal >
your application > Bot > Add Bot**, then install it into each participating
server with the required permissions. Its bot token must be stored separately
as a server-only secret; it must never be sent to the browser or committed to
Git. No `DISCORD_BOT_TOKEN` setting is needed for the current login/linking
phase because the current code does not call Discord's bot API.

## Notes

- `script.js` already prefers `/api/koios` first.
- Optional override: set `window.PREEB_KOIOS_BASE` before loading `script.js`.

## Claim campaigns (in progress)

A claim campaign lets token X holders claim token Y from a per-campaign wallet,
instead of the project paying minimum ADA for every recipient. This section
covers the `/claim` pages, campaigns, encrypted funding wallets, snapshots,
funding checks, claim lanes, the claim transaction and the owner reclaim.

- **Pages:** `/claim` lists the 12 most recent campaigns (open first, upcoming
  ones with a live countdown, closed ones greyed out), `/claim/new` creates one,
  and `/claim/<id>` is the shareable page for a single campaign.
- **API:** `GET/POST /api/claim/campaigns`, `GET /api/claim/<id>`,
  `GET /api/claim/snapshot?id=<id>` (the public snapshot table), `GET /api/claim/token-info`,
  `POST /api/claim/claim-challenge|claim-start|claim-finish?id=<id>` (claiming),
  `POST /api/claim/retry-snapshot|reclaim|end-claims?id=<id>` (owner only), and
  `POST /api/claim/run-snapshots` (cron only).
- **Token details come from the chain:** the server looks up the token when a
  campaign is created and ignores any decimals or ticker sent by the browser.
  Decimals come from the CIP-68 datum, then the Cardano Token Registry, and are
  0 when neither publishes any. Artwork is offered in the order CIP-68, CIP-25
  mint metadata, then the registry logo (served through
  `/api/claim/token-image`, raster formats only). `ipfs://` links are tried
  against several gateways, and `ar://` and bare CIDs are understood. If the
  creator picks nothing, the first artwork found is used.
- **Funding:** after the snapshot the owner sends the total token amount plus a
  small ADA deposit (about 2 ADA per lane, refundable) to the campaign wallet.
  Viewing a campaign re-reads the wallet from Koios (cached for 30 seconds).
- **Automatic:** nothing needs a button. Once the wallet is fully funded, the next
  refresh (a page view or the scheduler's `run-snapshots` call) splits it into
  lanes by itself, and claims and reclaims are confirmed as they land on chain.
  Open pages update themselves too: every few seconds while something is in
  flight, and they pause while the tab is hidden.
- **Lanes:** one claim spends and recreates a wallet UTxO, so a single UTxO would
  allow one claim at a time. Preparing splits the wallet in one
  transaction into up to 20 lanes, each holding exactly what its claimants are
  owed. A claimant's lane is a hash of their snapshot key. The campaign is
  ready once that transaction is confirmed.

- **Funding wallet:** each campaign gets its own enterprise wallet. Its seed is
  stored in `claim_wallets`, encrypted with AES-256-GCM using
  `CLAIM_WALLET_KEY_SECRET` (32+ characters, server-only) and bound to the
  campaign id. Losing that secret means losing access to every campaign wallet,
  so keep a backup of it.
- **Snapshot:** taken from Koios (every token under a policy ID) or from an uploaded
  holder list. Holders are grouped by stake address, script addresses are
  skipped, and each person's amount is stored (`fixed`, `proportional` or
  `manual`) in `claim_entitlements`. Koios only serves current balances, so a
  scheduled snapshot reflects the chain when it actually runs.
- **Claim timing:** claims open at least 15 minutes after the snapshot (empty
  means exactly 15 minutes after) and stay open for at least 24 hours. If a
  snapshot runs late, the whole claim window moves by the delay and keeps its
  length. Until the snapshot succeeds, claims stay closed.
- **Scheduled snapshots:** `POST /api/claim/run-snapshots` (protected by
  `CLAIM_CRON_SECRET` as a bearer token) takes every snapshot that is due. It
  needs a scheduler that actually fires every minute or two: GitHub's scheduled
  workflows (`.github/workflows/claim-snapshots.yml`) are best-effort and in
  practice run every few hours, so use an external cron service such as
  cron-job.org as the primary trigger and keep the workflow as a backstop.
  Anyone viewing a campaign page also nudges a due snapshot along; taking it is
  atomic, so it can never run twice.
- **Failed snapshots:** a failed snapshot is retried automatically three times,
  then marked failed. The owner gets a **Retry snapshot** button on the campaign
  page (`POST /api/claim/retry-snapshot?id=<id>`).
- **Snapshot table:** a collapsed section on the campaign page lists the whole
  snapshot (25 per page, sortable by holding or claim, largest claim first by
  default). ADA Handles replace addresses where a wallet has one (looked up with
  a short time budget and stored on the row for a day; Copy still copies the
  address). It has a filter for a stake address, payment address or ADA
  Handle. A wallet connected in the site header is looked up automatically and
  shown as "You qualify for ...". The header remembers the connected wallet
  (`localStorage`) and silently reconnects when the wallet already trusts the
  site; `window.PreebNavigation` exposes `getConnectedWallet()` and a
  `preeb:wallet` event for pages that need it.
- **Claiming:** the holder's wallet proves it owns the stake address (a CIP-8
  signature over a short-lived challenge, skipped if the browser already
  verified that wallet), the server reserves the entitlement and the holder's
  lane, builds one transaction and signs it with the campaign wallet, the holder
  signs it in their wallet, and the server submits it. The holder spends only the
  network fee: the ADA that carries the tokens is their own and comes back in the
  same transaction. A transaction is valid for 5 minutes, so an abandoned attempt
  frees its lane after that. Only one claim per lane is in flight at a time.
- **Getting funds back:** the owner can reclaim (sweep the whole campaign wallet,
  tokens and ADA, to the payout address fixed at creation) before claims open and
  after they close plus 15 minutes. While claims are open it is refused. A
  campaign without an end date can be ended by its owner after claims have been
  open 24 hours. If the website is unavailable,
  `node scripts/emergency-sweep.mjs <campaignId> [--send]` does the same from a
  machine that has the environment variables. Funds are only recoverable while
  `CLAIM_WALLET_KEY_SECRET` and the database (`claim_wallets`) both survive, so
  back both up.
- **Owner:** creating a campaign requires a wallet verified in this browser
  (the signed wallet-session cookie). The reclaim address must be a base
  address of that same wallet.
- **Environment:** `CLAIM_WALLET_KEY_SECRET`, `CLAIM_CRON_SECRET` (both 32+
  characters) and optionally `CLAIM_NETWORK=preprod` (default `mainnet`).
- **MongoDB access:** the database user needs read/write and index access on
  `claim_campaigns`, `claim_wallets`, `claim_entitlements`, `claim_lanes` and
  `claim_claims`.

Run the tests with `node --test "tests/*.test.js"`.

## Airdrop transaction funding

The airdrop builder adds recipient and PREEB outputs before selecting wallet
UTxOs. The funding check includes the actual outputs (including any budget
remainder and thank-you payment) and any stake registration deposit. Transaction
fees and minimum ADA for token change are checked when balancing the transaction;
the displayed wallet balance alone does not guarantee it can be balanced.

Run the funding regression tests with `node --test tests/airdrop.test.js`.