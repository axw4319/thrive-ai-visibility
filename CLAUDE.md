# thrive-ai-visibility

**What it is:** Backend API for the AI visibility scanner embedded on Thrive's Google Ads landing pages (`ai-search-optimization`, `ai-search-strategy`). Scans a domain across Google AI Overview, ChatGPT, Gemini, Perplexity and returns scores + a snippet card. Forked 2026-05-22 from `ai-visibility-report-app` (Aaron's personal Render service) into Thrive's Render workspace for ownership + reliability.

**Stack:** Node 20 • Express 4 • better-sqlite3 • OpenAI + Gemini SDKs • Cheerio • node-fetch
**Deploy:** Render Starter plan (no sleep) via [render.yaml](render.yaml) — Thrive Render workspace, repo `axw4319/thrive-ai-visibility`.
**Live URL:** `https://thrive-ai-visibility.onrender.com` (set after first deploy)

## Frontend caller
[thrive-landing-pages/public/script.js:3](../Thrive/landing-pages/thrive-landing-pages/public/script.js#L3) — `AI_VIS_API` constant. Update both when the Render URL changes.

## Env vars (Render → single PUT per var)
- `OPENAI_API_KEY`, `GEMINI_API_KEY`, `SERPAPI_KEY`, `PERPLEXITY_API_KEY` — Thrive's own keys
- `ADMIN_PASSWORD` — admin UI gate
- `EXTRA_ALLOWED_ORIGINS` — comma-sep extra CORS origins (e.g. staging Astro preview)

## CORS
Hard allowlist in [server.js](server.js): `https://thriveagency.com`, `https://www.thriveagency.com`, plus anything in `EXTRA_ALLOWED_ORIGINS`. No reflection. Update the Set when LP moves origins.

## Run locally
```bash
npm install
npm start         # node server.js, port 3000
```

## Layout
- `server.js` — Express server, auth, CORS, scan + public scan + report endpoints
- `database.js` — SQLite init / schema
- `lib/` — AI clients, scraper, brand extraction, metrics, prompt generation, technical audit, report data
- `data/` — SQLite DB (Render persistent disk)
- `public/` — admin UI for generating branded reports

## Watch
- Heavy AI API spend potential — set budget alerts on OpenAI + Gemini + SerpAPI + Perplexity dashboards.
- Public scan rate limits live in [server.js](server.js): `PUBLIC_PER_IP_HOUR`, `PUBLIC_PER_IP_DAY`, `PUBLIC_PER_URL_DAY`.
- `data/*.db` lives on Render persistent disk. Don't delete.
