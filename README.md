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

## Notes

- `script.js` already prefers `/api/koios` first.
- Optional override: set `window.PREEB_KOIOS_BASE` before loading `script.js`.