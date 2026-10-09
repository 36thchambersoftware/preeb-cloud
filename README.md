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
covers what exists so far: campaigns, encrypted funding wallets, and snapshots.
Funding checks, the claim transaction, the `/claim` pages and the owner reclaim
sweep are still to come.

- **Funding wallet:** each campaign gets its own enterprise wallet. Its seed is
  stored in `claim_wallets`, encrypted with AES-256-GCM using
  `CLAIM_WALLET_KEY_SECRET` (32+ characters, server-only) and bound to the
  campaign id. Losing that secret means losing access to every campaign wallet,
  so keep a backup of it.
- **Snapshot:** taken from Koios (a policy or one asset) or from an uploaded
  holder list. Holders are grouped by stake address, script addresses are
  skipped, and each person's amount is stored (`fixed`, `proportional` or
  `manual`) in `claim_entitlements`. Koios only serves current balances, so a
  scheduled snapshot reflects the chain when it actually runs.
- **Scheduled snapshots:** `.github/workflows/claim-snapshots.yml` calls
  `POST /api/claim/run-snapshots` every 5 minutes (GitHub's schedule is
  best-effort and can lag by several minutes). Add the same value as a GitHub
  repository secret named `CLAIM_CRON_SECRET` and as a Vercel environment
  variable; the endpoint rejects requests without it.
- **Owner:** creating a campaign requires a wallet verified in this browser
  (the signed wallet-session cookie). The reclaim address must be a base
  address of that same wallet.
- **Environment:** `CLAIM_WALLET_KEY_SECRET`, `CLAIM_CRON_SECRET` (both 32+
  characters) and optionally `CLAIM_NETWORK=preprod` (default `mainnet`).
- **MongoDB access:** the database user needs read/write and index access on
  `claim_campaigns`, `claim_wallets` and `claim_entitlements`.

Run the tests with `node --test tests/claim.test.js`.

## Airdrop transaction funding

The airdrop builder adds recipient and PREEB outputs before selecting wallet
UTxOs. The funding check includes the actual outputs (including any budget
remainder and thank-you payment) and any stake registration deposit. Transaction
fees and minimum ADA for token change are checked when balancing the transaction;
the displayed wallet balance alone does not guarantee it can be balanced.

Run the funding regression tests with `node --test tests/airdrop.test.js`.